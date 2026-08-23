// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArmId } from "../../src/config/types.js";
import type { LatentProbe } from "../../src/manifest/latent.js";
import { summaryDigest } from "../../src/storage/latent-pool.js";
import { branchSessionFile } from "../../src/storage/paths.js";
import { findPreservedArms, type PreserveSelectDeps } from "../../src/storage/preserve.js";

/**
 * Fixture layout per test: ONE sessions dir (flat, real shape) + a runs root.
 *  <dir>/sessions/bench-compact-run-<...>-arm-<tool>.jsonl   (source base sessions)
 *  <dir>/runs/<runId>/latent-pool-<arm>.json                  (source pools)
 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "preserve-"));
  const sessionsDir = join(dir, "sessions");
  // runsRoot = the bench root (runDir() itself appends "runs/<runId>")
  const runsRoot = dir;
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(runsRoot, "runs"), { recursive: true });
  return { dir, sessionsDir, runsRoot };
}

/** A minimal source branch's session file: span entry, anchor (tail start), compaction. */
function sourceSession(sessionsDir: string, branch: string, summary: string, anchor: string): string {
  const path = branchSessionFile(sessionsDir, branch);
  writeFileSync(
    path,
    [
      { id: "e1", type: "message", content: "span content with the fact" },
      { id: anchor, type: "message", content: "kept tail begins" },
      { id: "c1", type: "compaction", summary, firstKeptEntryId: anchor },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  return path;
}

function poolProbe(id: string, arm: ArmId): LatentProbe {
  return {
    id,
    question: `What exact fact number ${id} did the span record?`,
    accept: ["an acceptable answer"],
    entryIds: ["e1"],
    probeClass: "cued",
    note: "matters for the work",
    arm,
    verdicts: { [arm]: "absent" },
  };
}

/** A per-arm pool file matching a source session's summary + anchor. */
function sourcePool(runsRoot: string, runId: string, arm: ArmId, summary: string, anchor: string): string {
  mkdirSync(join(runsRoot, "runs", runId), { recursive: true });
  writeFileSync(
    join(runsRoot, "runs", runId, `latent-pool-${arm}.json`),
    JSON.stringify({
      mode: "per-arm",
      arm,
      tailStartsAtEntryId: anchor,
      summaryDigests: { [arm]: summaryDigest(summary) },
      probes: [poolProbe("l1", arm), poolProbe("l2", arm)],
    }),
  );
  return join(runsRoot, runId, `latent-pool-${arm}.json`);
}

interface FakeOps {
  branches: string[];
  ahead: Record<string, number>;
}

function depsFor(
  fx: ReturnType<typeof makeFixture>,
  ops: FakeOps,
  arms: readonly ArmId[],
  from: string | null,
): PreserveSelectDeps {
  return {
    repo: "/repo",
    sessionsDir: fx.sessionsDir,
    runsRoot: fx.runsRoot,
    armsEnabled: arms,
    from,
    ops: {
      newestBranches: (_repo: string, pattern: string): string[] => {
        const rx = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        return ops.branches.filter((b) => rx.test(b)); // array order = newest-first
      },
      commitCountAhead: (_repo: string, branch: string): number => ops.ahead[branch] ?? 0,
      exists: existsSync, // the fixture writes REAL files (sessions + pools)
    },
  };
}

describe("findPreservedArms", () => {
  it("selects the newest committed base with its run's matching pool", () => {
    const fx = makeFixture();
    const oldBranch = "bench-compact/run-2026-08-20-7/cfg-111111/arm-bare-pi";
    const newBranch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, newBranch, "new summary", "cut-1");
    sourceSession(fx.sessionsDir, oldBranch, "old summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "new summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-20-7", "A1", "old summary", "cut-1");
    const ops: FakeOps = {
      branches: [newBranch, oldBranch], // newest-first
      ahead: { [newBranch]: 1, [oldBranch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.misses).toEqual([]);
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.sourceRunId).toBe("2026-08-23-2");
    expect(result.found[0]?.sourceBranch).toBe(newBranch);
    expect(result.found[0]?.tool).toBe("bare-pi");
    expect(result.found[0]?.ver).toBeUndefined();
    expect(result.found[0]?.poolPath).toBe(join(fx.runsRoot, "runs", "2026-08-23-2", "latent-pool-A1.json"));
  });

  it("skips an uncommitted newest candidate and falls back to the older run", () => {
    const fx = makeFixture();
    const oldBranch = "bench-compact/run-2026-08-20-7/cfg-111111/arm-bare-pi";
    const newBranch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, newBranch, "new summary", "cut-1");
    sourceSession(fx.sessionsDir, oldBranch, "old summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "new summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-20-7", "A1", "old summary", "cut-1");
    const ops: FakeOps = {
      branches: [newBranch, oldBranch],
      ahead: { [newBranch]: 0, [oldBranch]: 2 }, // newest is an uncommitted leftover
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found[0]?.sourceRunId).toBe("2026-08-20-7");
  });

  it("parses a versioned base branch segment into ver", () => {
    const fx = makeFixture();
    const branch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-memkeeper-builder-g12ab34";
    sourceSession(fx.sessionsDir, branch, "summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A3", "summary", "cut-1");
    const ops: FakeOps = {
      branches: [branch],
      ahead: { [branch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A3"], null));

    expect(result.found[0]?.ver).toBe("g12ab34");
    expect(result.found[0]?.tool).toBe("memkeeper-builder");
  });

  it("honors a pinned source run id (from) and ignores newer runs", () => {
    const fx = makeFixture();
    const oldBranch = "bench-compact/run-2026-08-20-7/cfg-111111/arm-bare-pi";
    const newBranch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, newBranch, "new summary", "cut-1");
    sourceSession(fx.sessionsDir, oldBranch, "old summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "new summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-20-7", "A1", "old summary", "cut-1");
    const ops: FakeOps = {
      branches: [newBranch, oldBranch],
      ahead: { [newBranch]: 1, [oldBranch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], "2026-08-20-7"));

    expect(result.found[0]?.sourceRunId).toBe("2026-08-20-7");
  });

  it("misses with a reason when the pinned run has no artifacts", () => {
    const fx = makeFixture();
    const result = findPreservedArms(depsFor(fx, { branches: [], ahead: {} }, ["A1"], "1999-01-01-1"));
    expect(result.found).toEqual([]);
    expect(result.misses[0]?.reason).toContain("no committed base");
  });

  it("misses when the newest committed base's run has no latent pool", () => {
    const fx = makeFixture();
    const branch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, branch, "summary", "cut-1"); // session exists, pool does NOT
    const ops: FakeOps = {
      branches: [branch],
      ahead: { [branch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found).toEqual([]);
    expect(result.misses[0]?.reason).toContain("latent pool");
  });

  it("misses when the pool's summary digest does not match the session", () => {
    const fx = makeFixture();
    const branch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, branch, "the CURRENT summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "a DIFFERENT older summary", "cut-1");
    const ops: FakeOps = {
      branches: [branch],
      ahead: { [branch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found).toEqual([]);
    expect(result.misses[0]?.reason).toContain("digest");
  });

  it("misses when the pool's tail anchor disagrees with the session's compaction", () => {
    const fx = makeFixture();
    const branch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, branch, "summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "summary", "different-anchor");
    const ops: FakeOps = {
      branches: [branch],
      ahead: { [branch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found).toEqual([]);
    expect(result.misses[0]?.reason).toContain("anchor");
  });

  it("misses when the pool probes fail span validation (cited entries not in span)", () => {
    const fx = makeFixture();
    const branch = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    sourceSession(fx.sessionsDir, branch, "summary", "cut-1");
    mkdirSync(join(fx.runsRoot, "runs", "2026-08-23-2"), { recursive: true });
    writeFileSync(
      join(fx.runsRoot, "runs", "2026-08-23-2", "latent-pool-A1.json"),
      JSON.stringify({
        mode: "per-arm",
        arm: "A1",
        tailStartsAtEntryId: "cut-1",
        summaryDigests: { A1: summaryDigest("summary") },
        probes: [{ ...poolProbe("l1", "A1"), entryIds: ["ghost-entry"] }],
      }),
    );
    const ops: FakeOps = {
      branches: [branch],
      ahead: { [branch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found).toEqual([]);
    expect(result.misses[0]?.reason).toContain("span");
  });

  it("does not consider attempt/probe branches (shape filter)", () => {
    const fx = makeFixture();
    const base = "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi";
    const attempt = `${base}-2`;
    const probeBranch = `${base}-2-probe-l1`;
    sourceSession(fx.sessionsDir, base, "summary", "cut-1");
    sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "summary", "cut-1");
    const ops: FakeOps = {
      branches: [probeBranch, attempt, base], // newest-first: probe + attempt first
      ahead: { [base]: 1, [attempt]: 1, [probeBranch]: 1 },
    };

    const result = findPreservedArms(depsFor(fx, ops, ["A1"], null));

    expect(result.found[0]?.sourceBranch).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// materializePreservedArm
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import type { SessionRuntimePins } from "../../src/session/fork.js";
import { materializePreservedArm, type PreservedMaterializeDeps } from "../../src/storage/preserve.js";

const NO_PINS: SessionRuntimePins = { model: null, thinkingLevel: "off" };

/** A real source session file with a session header line (copySessionFork shape). */
function headeredSession(dir: string, name: string): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(
    path,
    [
      { type: "session", id: "11111111-1111-4111-8111-111111111111", model: "zai-proxy/glm-5.3" },
      { id: "e1", type: "message", role: "user", content: "hello span" },
      { id: "cut-1", type: "message", role: "assistant", content: "tail" },
      { type: "compaction", id: "c1", summary: "s", firstKeptEntryId: "cut-1" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  return path;
}

function matFixture() {
  const fx = makeFixture();
  const runPath = join(fx.dir, "runs", "2026-08-24-1");
  mkdirSync(runPath, { recursive: true });
  const sessionPath = headeredSession(fx.sessionsDir, "src-session");
  const poolPath = join(fx.runsRoot, "runs", "2026-08-23-2", "latent-pool-A1.json");
  mkdirSync(join(fx.runsRoot, "runs", "2026-08-23-2"), { recursive: true });
  sourcePool(fx.runsRoot, "2026-08-23-2", "A1", "s", "cut-1");
  return { fx, runPath, sessionPath, poolPath };
}

function sourceOf(_fx: ReturnType<typeof makeFixture>, sessionPath: string, poolPath: string) {
  return {
    arm: "A1" as const,
    tool: "bare-pi",
    ver: undefined,
    sourceBranch: "bench-compact/run-2026-08-23-2/cfg-680f35/arm-bare-pi",
    sourceRunId: "2026-08-23-2",
    sessionPath,
    poolPath,
  };
}

describe("materializePreservedArm", () => {
  it("forks the source base into the new namespace, copies the session (fresh id), pool, and walls", () => {
    const { fx, runPath, sessionPath, poolPath } = matFixture();
    // source run's walls carry the arm's compaction wall
    writeFileSync(join(fx.runsRoot, "runs", "2026-08-23-2", "phase1-walls.json"), JSON.stringify({ A1: 43210 }));
    const forks: Array<{ repo: string; from: string; to: string }> = [];
    const deps: PreservedMaterializeDeps = {
      repo: "/repo",
      sessionsDir: fx.sessionsDir,
      runPath,
      date: "2026-08-24",
      id: 1,
      cfgId: "cfg-999999",
      runtimePins: NO_PINS,
      ops: {
        fork: (repo: string, from: string, to: string): void => {
          forks.push({ repo, from, to });
        },
        branchExists: (): boolean => false,
      },
    };

    const result = materializePreservedArm(deps, sourceOf(fx, sessionPath, poolPath));

    const expectedBranch = "bench-compact/run-2026-08-24-1/cfg-999999/arm-bare-pi";
    expect(result.branch).toBe(expectedBranch);
    expect(result.sourceRunId).toBe("2026-08-23-2");
    expect(result.wallMs).toBe(43210);
    expect(result.usage).toBeUndefined();
    expect(forks).toEqual([
      { repo: "/repo", from: sourceOf(fx, sessionPath, poolPath).sourceBranch, to: expectedBranch },
    ]);
    // session copied with a FRESH header id, body verbatim
    const dest = branchSessionFile(fx.sessionsDir, expectedBranch);
    const copied = readFileSync(dest, "utf8").split("\n");
    const header = JSON.parse(copied[0] ?? "") as { id: string };
    expect(header.id).not.toBe("11111111-1111-4111-8111-111111111111");
    // body preserved verbatim (+ the runtime pin's own change entry appended)
    const srcBody = readFileSync(sessionPath, "utf8").split("\n").slice(1);
    for (const line of srcBody) expect(copied).toContain(line);
    expect(copied.length).toBeGreaterThan(srcBody.length);
    // pool copied verbatim into the new run dir
    expect(readFileSync(join(runPath, "latent-pool-A1.json"), "utf8")).toBe(readFileSync(poolPath, "utf8"));
  });

  it("uses wallMs 0 when the source run has no walls file", () => {
    const { fx, runPath, sessionPath, poolPath } = matFixture();
    const result = materializePreservedArm(
      {
        repo: "/repo",
        sessionsDir: fx.sessionsDir,
        runPath,
        date: "2026-08-24",
        id: 1,
        cfgId: "cfg-999999",
        runtimePins: NO_PINS,
        ops: { fork: (): void => {}, branchExists: (): boolean => false },
      },
      sourceOf(fx, sessionPath, poolPath),
    );
    expect(result.wallMs).toBe(0);
  });

  it("stops on a branch-name collision (foreign run id derived the same branch)", () => {
    const { fx, runPath, sessionPath, poolPath } = matFixture();
    expect(() =>
      materializePreservedArm(
        {
          repo: "/repo",
          sessionsDir: fx.sessionsDir,
          runPath,
          date: "2026-08-24",
          id: 1,
          cfgId: "cfg-999999",
          runtimePins: NO_PINS,
          ops: { fork: (): void => {}, branchExists: (): boolean => true },
        },
        sourceOf(fx, sessionPath, poolPath),
      ),
    ).toThrow(/already exists/);
  });
});
