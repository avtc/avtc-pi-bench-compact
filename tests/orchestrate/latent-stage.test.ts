// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { LatentProbe } from "../../src/manifest/latent.js";
import type { LatentAuthoringResult } from "../../src/manifest/latent-author.js";
import {
  activeLatentForArm,
  type LatentStageDeps,
  latentDetailFromCounts,
  latentProbesDigest,
  purgeLatentProbeArtifacts,
  runLatentStagePerArm,
  runLatentStageShared,
} from "../../src/orchestrate/latent-stage.js";
import { appendProbeAttempt } from "../../src/storage/branches.js";
import { readLatentPool, summaryDigest } from "../../src/storage/latent-pool.js";
import { branchSessionFile } from "../../src/storage/paths.js";
import { branchExists, forkBranch, initScenarioRepo, listBranches } from "../../src/storage/repo.js";

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
    question: `What exact ${probeClass} fact number ${id} did the span record?`,
    accept: ["an acceptable answer"],
    entryIds: ["e1"],
    probeClass,
    note: "matters for the work",
    arm: "A1",
    verdicts: { A1: "absent" },
  };
}

/** Shared-mode shape: no arm pin, an absent verdict for every enabled arm. */
function sharedProbe(id: string, probeClass: "cued" | "uncued"): LatentProbe {
  return { ...probe(id, probeClass), arm: undefined, verdicts: { A1: "absent", A3: "absent" } };
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
    thinking: null,
    timeoutMs: 120000,
    rateLimitOptions: null,
    probeValidate: null,
    widget: null,
    ...(over ?? {}),
  };
}

describe("runLatentStagePerArm — validator widget wiring", () => {
  it("deps.widget feeds the probe validator's live-progress hooks (second slot)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const validatorEvents: string[] = [];
    const widget = {
      onValidatorEvent: (e: { type: string }): void => {
        validatorEvents.push(e.type);
      },
      setValidatorCtxWindow: (): void => {
        validatorEvents.push("window");
      },
      clearValidator: (): void => {
        validatorEvents.push("clear");
      },
    };
    let stageOnEvent: ((e: { type: string }) => void) | null | undefined;
    const calls = { n: 0 };
    const author: LatentStageDeps["author"] = async (a) => {
      calls.n += 1;
      const validate = a.validate ?? null;
      if (validate !== null) {
        await validate({
          probeClass: "cued",
          question: "what fee applied before the change?",
          accept: ["the fee was 12 percent"],
          entryIds: ["e1"],
          note: "the fee drives every cost estimate later",
        });
      }
      return { kind: "completed", pool: [] };
    };
    const fakeSeams = {
      ...NO_SEAMS,
      runStage: (async (input: import("../../src/runtime/agent-loop.js").StageRunInput) => {
        stageOnEvent = input.onEvent as unknown as typeof stageOnEvent;
        input.onEvent?.({ type: "message_start" } as unknown as Parameters<NonNullable<typeof input.onEvent>>[0]);
        const tool = input.tools.find((t) => t.name === "report_verdict");
        if (!tool) throw new Error("report_verdict missing");
        await tool.execute("c1", { ok: true, problems: [] });
        return {
          aborted: false,
          timedOut: false,
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 0,
        };
      }) as unknown as typeof NO_SEAMS.runStage,
    } as typeof NO_SEAMS;
    const deps = baseDeps(dir, {
      author,
      widget: widget as unknown as import("../../src/widget/active-widget.js").WidgetPort,
      seams: fakeSeams,
      probeValidate: {
        budget: { thinking: null, maxTokens: 1024, timeoutMs: 60000 },
        resolveModel: async () =>
          ({
            ok: true as const,
            model: { id: "validator-model", contextWindow: 262144 },
            apiKey: "k",
          }) as unknown as import("../../src/runtime/model.js").ResolvedBenchModel,
      },
    });
    await runLatentStagePerArm(deps);
    expect(calls.n).toBeGreaterThan(0);
    // two arms in the fixture → the validator fires once per arm
    expect(validatorEvents).toEqual(["window", "message_start", "clear", "window", "message_start", "clear"]);
    expect(stageOnEvent).toBeDefined();
  });
});

describe("runLatentStagePerArm", () => {
  it("fires onArm per arm (1-based index + total) and forwards onAdd to the authoring agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const arms: { arm: string; index: number; total: number }[] = [];
    let onAddSeen: ((counts: { cued: number; uncued: number }) => void) | null = null;
    const calls = { n: 0 };
    const author: LatentStageDeps["author"] = async (a) => {
      calls.n += 1;
      onAddSeen = a.onAdd ?? null;
      a.onAdd?.({ cued: 1, uncued: 2 }); // simulate an accepted probe
      return { kind: "completed", pool: [probe("l1", "cued")] };
    };
    const r = await runLatentStagePerArm(
      baseDeps(dir, {
        author,
        onArm: (arm, index, total) => arms.push({ arm, index, total }),
        onAdd: (counts) => arms.push({ arm: `add:${counts.cued}:${counts.uncued}`, index: 0, total: 0 }),
      }),
    );
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(2);
    // onArm fired once per arm with the 1-based index + total (reuse OR author)
    expect(arms.filter((a) => a.index > 0).map((a) => `${a.arm}:${a.index}/${a.total}`)).toEqual(["A1:1/2", "A3:2/2"]);
    // onAdd was forwarded to the authoring agent AND reached the stage's onAdd
    expect(onAddSeen).not.toBeNull();
    expect(arms).toContainEqual({ arm: "add:1:2", index: 0, total: 0 });
  });

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
          probes: [
            probe("l1", "cued"),
            probe("l2", "cued"),
            probe("l3", "cued"),
            probe("l4", "uncued"),
            probe("l5", "uncued"),
            probe("l6", "uncued"),
          ],
        }),
      );
    }
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(0);
    if (r.kind !== "done") return;
    expect(r.pools.A1?.probes).toHaveLength(6); // the PRE-written complete pool, not re-authored
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
    expect(r.reAuthored).toEqual(["A1"]); // the caller purges this arm's stale l-probe artifacts
  });

  it("reports no re-authored arms on a full reuse (nothing to purge)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
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
          probes: [
            probe("l1", "cued"),
            probe("l2", "cued"),
            probe("l3", "cued"),
            probe("l4", "uncued"),
            probe("l5", "uncued"),
            probe("l6", "uncued"),
          ],
        }),
      );
    }
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    if (r.kind !== "done") throw new Error("expected done");
    expect(r.reAuthored).toEqual([]);
  });

  it("latentProbesDigest: null when empty; changes with any probe field", () => {
    const p = probe("l1", "cued");
    expect(latentProbesDigest(new Map())).toBe(null);
    const d1 = latentProbesDigest(new Map([["A1:l1", p]]));
    expect(d1).toMatch(/^[0-9a-f]{16}$/);
    expect(latentProbesDigest(new Map([["A1:l1", { ...p, probeClass: "uncued" }]]))).not.toBe(d1);
    expect(
      latentProbesDigest(
        new Map([
          ["A1:l1", p],
          ["A3:l1", probe("l1", "cued")],
        ]),
      ),
    ).not.toBe(d1);
  });

  it("purgeLatentProbeArtifacts deletes only the arm's l-probe branches + session files", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-purge-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    initScenarioRepo(repo);
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir);
    const base = "bench-compact/run-1/cfg-a/arm-bare-pi";
    // stale latent probe branch + session, a manifest-probe branch + session, another arm's
    forkBranch(repo, "main", appendProbeAttempt(base, "l1", 1));
    forkBranch(repo, "main", appendProbeAttempt(base, "l2", 2));
    forkBranch(repo, "main", appendProbeAttempt(base, "3", 1));
    const other = "bench-compact/run-1/cfg-a/arm-om-default";
    forkBranch(repo, "main", appendProbeAttempt(other, "l1", 1));
    writeFileSync(branchSessionFile(sessionsDir, appendProbeAttempt(base, "l1", 1)), "{}");
    writeFileSync(branchSessionFile(sessionsDir, appendProbeAttempt(base, "2", 1)), "{}");
    purgeLatentProbeArtifacts(repo, sessionsDir, [{ arm: "A1", branch: base }]);
    expect(listBranches(repo, `${base}-probe-l*`)).toEqual([]);
    expect(branchExists(repo, appendProbeAttempt(base, "3", 1))).toBe(true); // numeric probe kept
    expect(branchExists(repo, appendProbeAttempt(other, "l1", 1))).toBe(true); // other arm kept
    expect(existsSync(branchSessionFile(sessionsDir, appendProbeAttempt(base, "l1", 1)))).toBe(false);
    expect(existsSync(branchSessionFile(sessionsDir, appendProbeAttempt(base, "2", 1)))).toBe(true);
  });

  it("a persisted pool failing validation on reuse stops with the remediation message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    writeFileSync(
      join(dir, "latent-pool-A1.json"),
      JSON.stringify({
        mode: "per-arm",
        arm: "A1",
        tailStartsAtEntryId: "cut-1",
        summaryDigests: { A1: summaryDigest("summary one") },
        probes: [
          { ...probe("l1", "cued"), entryIds: ["not-in-span"] },
          probe("l2", "cued"),
          probe("l3", "cued"),
          probe("l4", "uncued"),
          probe("l5", "uncued"),
          probe("l6", "uncued"),
        ],
      }),
    );
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls }).deps }));
    expect(r).toEqual({
      kind: "stopped",
      arm: "A1",
      message:
        'latent: latent-pool-A1.json failed validation (latent probe l1 cites entryId "not-in-span" not in the pre-sliced (in-span) set) — delete the file to re-author',
    });
    expect(calls.n).toBe(0); // no authoring attempted — the operator must intervene
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

  it("stops instead of persisting an invalid fresh pool (add-time gates bypassed — regression net)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const author: LatentStageDeps["author"] = async () => {
      calls.n += 1;
      // a seam-injected (or future-regression) author completing with a
      // placeholder-grade probe — must never reach phase-2b probing
      return { kind: "completed", pool: [{ ...probe("l1", "cued"), question: "Test4" }] };
    };
    const r = await runLatentStagePerArm(baseDeps(dir, { author }));
    expect(r).toEqual({
      kind: "stopped",
      arm: "A1",
      message:
        "latent: arm A1 authoring produced invalid probes (latent probe l1: question shorter than 12 chars (placeholder-grade — re-author)) — run paused, resume to retry",
    });
    expect(existsSync(join(dir, "latent-pool-A1.json"))).toBe(false); // never persisted
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

describe("latentDetailFromCounts", () => {
  it("renders the cued/uncued tallies against the per-class minimum (3)", () => {
    expect(latentDetailFromCounts({ cued: 0, uncued: 0 })).toBe("cued 0/3 · uncued 0/3");
    expect(latentDetailFromCounts({ cued: 2, uncued: 5 })).toBe("cued 2/3 · uncued 5/3");
  });
});

describe("activeLatentForArm", () => {
  it("returns [] when off, or when no pool file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    expect(activeLatentForArm(dir, "off", "A1")).toEqual([]);
    expect(activeLatentForArm(dir, "per-arm", "A1")).toEqual([]);
    expect(activeLatentForArm(dir, "shared", "A1")).toEqual([]);
  });

  it("per-arm pool: only the owning arm's absent probes; shared pool: probes absent for THAT arm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const r = await runLatentStagePerArm(baseDeps(dir, { author: fakeAuthor({ calls: { n: 0 } }).deps }));
    if (r.kind !== "done") throw new Error("expected done");
    const active = activeLatentForArm(dir, "per-arm", "A1");
    expect(active.map((p) => p.id)).toEqual(["l1", "l2"]);
    expect(activeLatentForArm(dir, "per-arm", "A3")).toEqual([]); // wrong arm: pool is A1's

    // a flipped verdict deactivates
    const pool = r.pools.A1;
    if (pool === undefined) throw new Error("missing pool");
    writeFileSync(
      join(dir, "latent-pool-A1.json"),
      JSON.stringify({ ...pool, probes: [...pool.probes.map((p) => ({ ...p, verdicts: { A1: "answerable" } }))] }),
    );
    expect(activeLatentForArm(dir, "per-arm", "A1")).toEqual([]);
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

  it("stops instead of persisting an invalid fresh shared pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const author: LatentStageDeps["author"] = async () => {
      calls.n += 1;
      return {
        kind: "completed",
        pool: [sharedProbe("l1", "cued"), { ...sharedProbe("l2", "uncued"), question: "Test4" }],
      };
    };
    const r = await runLatentStageShared(baseDeps(dir, { author }));
    expect(r).toEqual({
      kind: "stopped",
      arm: "A1",
      message:
        "latent: shared authoring produced invalid probes (latent probe l2: question shorter than 12 chars (placeholder-grade — re-author)) — run paused, resume to retry",
    });
    expect(existsSync(join(dir, "latent-pool.json"))).toBe(false); // never persisted
  });

  it("one authoring run → one pool under every arm key with all digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-"));
    const calls = { n: 0 };
    const r = await runLatentStageShared(
      baseDeps(dir, {
        author: fakeAuthor({ calls, result: { kind: "completed", pool: [sharedProbe("l1", "cued")] } }).deps,
      }),
    );
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

// ── partial pools: incremental persistence + resume continuation ──
describe("runLatentStage — partial pools (stopped pass, resume)", () => {
  it("a PARTIAL per-arm pool (below min, matching envelope) seeds the author + counts as re-authored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-partial-"));
    // A1 has a 2-cued/1-uncued partial pool with CURRENT digests (incremental writes)
    writeFileSync(
      join(dir, "latent-pool-A1.json"),
      JSON.stringify({
        mode: "per-arm",
        arm: "A1",
        tailStartsAtEntryId: "cut-1",
        summaryDigests: { A1: summaryDigest("summary one") },
        probes: [probe("l1", "cued"), probe("l2", "cued"), probe("l3", "uncued")],
      }),
    );
    const calls = { n: 0 };
    const seenSeeds: (readonly LatentProbe[] | undefined)[] = [];
    const author: LatentStageDeps["author"] = async (a) => {
      calls.n += 1;
      seenSeeds.push(a.seedProbes);
      return { kind: "completed", pool: [probe("l1", "cued")] };
    };
    const r = await runLatentStagePerArm(baseDeps(dir, { author }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(2); // A1 continued from the partial pool, A3 authored fresh
    if (r.kind !== "done") return;
    // A1's author call carried the kept probes as seeds; A3's carried none
    expect(seenSeeds[0]).toHaveLength(3);
    expect(seenSeeds[1]).toBeUndefined();
    // the seeded arm counts as re-authored (its pool ids may shift — stale probe
    // branches must be purged); A3 was unknown as Parameters<NonNullable<typeof input.onEvent>>[0] authored before, so nothing to purge
    expect(r.reAuthored).toContain("A1");
    expect(r.reAuthored).not.toContain("A3");
  });

  it("persistPartial writes the pool file with the envelope + kept probes (crash-safe collection)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-persist-"));
    const author: LatentStageDeps["author"] = async (a) => {
      a.persistPartial?.([probe("l1", "cued"), probe("l2", "uncued")]);
      return { kind: "stopped", counts: { cued: 1, uncued: 1 } };
    };
    const r = await runLatentStagePerArm(baseDeps(dir, { author }));
    expect(r.kind).toBe("stopped");
    // the partial pool SURVIVES the stop — resume seeds from it
    const pool = readLatentPool(join(dir, "latent-pool-A1.json"));
    expect(pool.probes).toHaveLength(2);
    expect(pool.summaryDigests.A1).toBe(summaryDigest("summary one"));
    expect(pool.tailStartsAtEntryId).toBe("cut-1");
  });

  it("a partial SHARED pool seeds the shared authoring run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-shared-"));
    const digests = { A1: summaryDigest("summary one"), A3: summaryDigest("summary three") };
    writeFileSync(
      join(dir, "latent-pool.json"),
      JSON.stringify({
        mode: "shared",
        arm: null,
        tailStartsAtEntryId: "cut-1",
        summaryDigests: digests,
        probes: [sharedProbe("l1", "cued"), sharedProbe("l2", "uncued")],
      }),
    );
    const calls = { n: 0 };
    let seeds: readonly LatentProbe[] | undefined;
    const author: LatentStageDeps["author"] = async (a) => {
      calls.n += 1;
      seeds = a.seedProbes;
      return { kind: "completed", pool: [sharedProbe("l1", "cued")] };
    };
    const r = await runLatentStageShared(baseDeps(dir, { author }));
    expect(r.kind).toBe("done");
    expect(calls.n).toBe(1);
    expect(seeds).toHaveLength(2);
  });

  it("a COMPLETE pool with matching digests is still reused (no seeds, no authoring)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-stage-complete-"));
    writeFileSync(
      join(dir, "latent-pool-A1.json"),
      JSON.stringify({
        mode: "per-arm",
        arm: "A1",
        tailStartsAtEntryId: "cut-1",
        summaryDigests: { A1: summaryDigest("summary one") },
        probes: [
          probe("l1", "cued"),
          probe("l2", "cued"),
          probe("l3", "cued"),
          probe("l4", "uncued"),
          probe("l5", "uncued"),
          probe("l6", "uncued"),
        ],
      }),
    );
    const calls = { n: 0 };
    const author: LatentStageDeps["author"] = async () => {
      calls.n += 1;
      return { kind: "completed", pool: [] };
    };
    const r = await runLatentStagePerArm(baseDeps(dir, { author }));
    expect(r.kind).toBe("done");
    if (r.kind !== "done") return;
    expect(r.pools.A1?.probes).toHaveLength(6); // reused untouched
    expect(r.reAuthored).not.toContain("A1");
    expect(calls.n).toBe(1); // only A3 authored
  });
});
