// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { LatentProbe } from "../../src/manifest/latent.js";
import type { LatentAuthoringResult } from "../../src/manifest/latent-author.js";
import {
  type LatentStageDeps,
  runLatentStagePerArm,
  runLatentStageShared,
} from "../../src/orchestrate/latent-stage.js";
import { readLatentPool, summaryDigest } from "../../src/storage/latent-pool.js";

const SIGNAL = new AbortController().signal;
const NO_SEAMS: JsonToolStageSeams = null as unknown as JsonToolStageSeams; // the fake author never uses them

function armSession(dir: string, name: string, summary: string, anchor: string): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(
    path,
    [
      { id: "e1", type: "message", content: "span content" },
      { id: anchor, type: "message", content: "tail" },
      { id: "c1", type: "compaction", summary, firstKeptEntryId: anchor },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  return path;
}

function probe(id: string, probeClass: "cued" | "uncued"): LatentProbe {
  return {
    id,
    question: `q ${id}`,
    accept: ["a"],
    entryIds: ["e1"],
    probeClass,
    note: "n",
    arm: "A1",
    verdicts: { A1: "absent" },
  };
}

/** A fake authoring agent returning a canned completed pool. */
function fakeAuthor(overrides: { result?: LatentAuthoringResult; calls: { n: number } }): {
  deps: LatentStageDeps["author"];
} {
  return {
    deps: async (): Promise<LatentAuthoringResult> => {
      overrides.calls.n += 1;
      return overrides.result ?? { kind: "completed", pool: [probe("l1", "cued"), probe("l2", "uncued")] };
    },
  };
}

function baseDeps(dir: string, over: Partial<LatentStageDeps> | null): LatentStageDeps {
  return {
    arms: [
      { arm: "A1", sessionPath: armSession(dir, "A1", "summary one", "cut-1") },
      { arm: "A3", sessionPath: armSession(dir, "A3", "summary three", "cut-1") },
    ],
    runPath: dir,
    cwd: dir,
    ui: null,
    seams: NO_SEAMS,
    signal: SIGNAL,
    maxTokens: 100,
    rateLimitOptions: null,
    ...(over ?? {}),
  };
}

describe("runLatentStagePerArm", () => {
  it("authors missing pools and persists them with digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(2); // one per arm
    if (r.kind !== "done") return;
    const pool = readLatentPool(join(dir, "latent-pool-A1.json"));
    expect(pool.arm).toBe("A1");
    expect(pool.summaryDigests.A1).toBe(summaryDigest("summary one"));
    expect(r.pools.A1?.probes).toHaveLength(2);
  });

  it("reuses a pool whose digest still matches (no authoring call)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    // pre-write both pools with the CURRENT digests
    for (const [arm, summary] of [
      ["A1", "summary one"],
      ["A3", "summary three"],
    ] as const) {
      writeFileSync(
        join(dir, `latent-pool-${arm}.json`),
        JSON.stringify({
          mode: "per-arm",
          arm,
          tailStartsAtEntryId: "cut-1",
          summaryDigests: { [arm]: summaryDigest(summary) },
          probes: [probe("l1", "cued")],
        }),
      );
    }
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(0);
    if (r.kind !== "done") return;
    expect(r.pools.A1?.probes).toHaveLength(1); // the PRE-written pool, not re-authored
  });

  it("re-authors an arm whose summary digest changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    writeFileSync(
      join(dir, "latent-pool-A1.json"),
      JSON.stringify({
        mode: "per-arm",
        arm: "A1",
        tailStartsAtEntryId: "cut-1",
        summaryDigests: { A1: "stale-digest" },
        probes: [probe("l1", "cued")],
      }),
    );
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(2); // A1 re-authored (stale) + A3 authored fresh (no pool)
    if (r.kind !== "done") return;
    expect(r.pools.A1?.probes).toHaveLength(2); // replaced by the fake author's pool
  });

  it("stopped outcome carries the approved message with arm + counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const r = await runLatentStagePerArm(
      baseDeps(dir, {
        author: fakeAuthor({ calls, result: { kind: "stopped", counts: { cued: 2, uncued: 3 } } }).deps,
      }),
    );
    expect(r).toEqual({
      kind: "stopped",
      arm: "A1",
      message: "latent: arm A1 stopped below minimum (cued 2, uncued 3) — run paused, resume to retry",
    });
  });

  it("throws when an arm session has no compaction record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    // a distinct filename — baseDeps' default-arm sessions must not overwrite this one
    const bare = join(dir, "bare.jsonl");
    writeFileSync(bare, `${JSON.stringify({ id: "e1", type: "message", content: "x" })}\n`);
    await expect(
      runLatentStagePerArm(
        baseDeps(dir, { arms: [{ arm: "A1", sessionPath: bare }], author: fakeAuthor({ calls: { n: 0 } }).deps }),
      ),
    ).rejects.toThrow("latent: arm A1 has no compaction record");
  });
});

describe("runLatentStageShared", () => {
  it("refuses when arms disagree on the tail anchor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const r = await runLatentStageShared(
      baseDeps(dir, {
        arms: [
          { arm: "A1", sessionPath: armSession(dir, "shared-a1", "s1", "cut-1") },
          { arm: "A3", sessionPath: armSession(dir, "shared-a3", "s3", "cut-2") },
        ],
        author: fakeAuthor({ calls }).deps,
      }),
    );
    expect(r).toEqual({
      kind: "stopped",
      arm: null,
      message: "latent: arms disagree on the tail anchor — cannot author a shared set",
    });
    expect(calls.n).toBe(0);
  });

  it("one authoring run → one pool under every arm key with all digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const r = await runLatentStageShared(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(calls.n).toBe(1);
    if (r.kind !== "done") throw new Error("expected done");
    const pool = readLatentPool(join(dir, "latent-pool.json"));
    expect(pool.mode).toBe("shared");
    expect(pool.summaryDigests).toEqual({
      A1: summaryDigest("summary one"),
      A3: summaryDigest("summary three"),
    });
    expect(r.pools.A1).toBe(r.pools.A3); // the SAME pool object for every arm
  });
});
