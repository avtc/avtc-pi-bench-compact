// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import {
  type ArmBase,
  type Phase1Deps,
  type Phase1Ops,
  type Phase1Result,
  Phase1StoppedError,
} from "../../src/orchestrate/phase1.js";
import { type Phase2Deps, Phase2StoppedError } from "../../src/orchestrate/phase2.js";
import { type StartRunDeps, startRun } from "../../src/orchestrate/run.js";
import { clearRunState, getRunState } from "../../src/orchestrate/run-state.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";

function makeConfig(arms: BenchConfig["armsEnabled"]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    N: 3,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    outputDir: null,
    armsEnabled: arms,
  } as BenchConfig;
}

const MANIFEST: ScenarioManifest = {
  id: "scen-1",
  description: "an incremental economic tycoon",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build to the boundary" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "the game", testSpec: "npm test" },
  probes: [],
} as unknown as ScenarioManifest;

function makeDeps(opts: {
  arms: BenchConfig["armsEnabled"];
  root: string;
  scenarioRepo?: string;
  phase1?: ReturnType<typeof vi.fn<(deps: Phase1Deps) => Promise<Phase1Result>>>;
  continuations?: ReturnType<typeof vi.fn<(deps: Phase2Deps) => Promise<RunTrace[]>>>;
  now?: () => Date;
  notify?: (m: string) => void;
}): StartRunDeps {
  // The fresh pi + proxies are NOT passed to startRun — runPhase1 reads them from
  // globalThis inside each withSession (bench-ctx.ts). Only cmdCtx is threaded.
  return {
    cmdCtx: {},
    config: makeConfig(opts.arms),
    scenarioRepo: opts.scenarioRepo ?? "/repo/scenario-x",
    manifest: MANIFEST,
    root: opts.root,
    now: opts.now ?? (() => new Date("2026-08-11T10:00:00Z")),
    notify: opts.notify,
    phase1: opts.phase1,
    // Default = a no-op continuations stub so tests never run the real Phase 2.
    continuations: opts.continuations ?? continuationsMock(async () => []),
    versionResolver: {
      resolveRoot: () => "/fake",
      gitHead: () => "abcdef1234567890",
      npmVersion: () => null,
    },
  } as unknown as StartRunDeps;
}

function fakeBases(arms: BenchConfig["armsEnabled"]): ArmBase[] {
  return arms.map((arm, i) => ({
    arm,
    tool: `tool-${arm}`,
    ver: i === 0 ? undefined : "gabc123",
    cfgId: "cfg-x",
    branch: `branch-${arm}`,
    wallMs: 1000 + i,
    usage: undefined,
  }));
}

/** A distinct sentinel for the Phase-1 final ctx (so tests can assert it's threaded
 * into continuations, NOT the original cmdCtx which Phase-1 invalidated). */
const FINAL_CTX = { __finalCtx: true } as unknown as Phase1Result["finalCtx"];

/** A typed Phase-1 mock so `mock.calls[0][0]` is the Phase1Deps arg (not an empty tuple). */
function phase1Mock(
  impl: (deps: Phase1Deps) => Promise<Phase1Result>,
): ReturnType<typeof vi.fn<(deps: Phase1Deps) => Promise<Phase1Result>>> {
  return vi.fn(impl);
}

/** A typed Phase-2 mock so `mock.calls[0][0]` is the Phase2Deps arg. */
function continuationsMock(
  impl: (deps: Phase2Deps) => Promise<RunTrace[]>,
): ReturnType<typeof vi.fn<(deps: Phase2Deps) => Promise<RunTrace[]>>> {
  return vi.fn(impl);
}

function fakeTraces(arms: BenchConfig["armsEnabled"]): RunTrace[] {
  return arms.map((arm) => ({
    arm,
    attempt: 1,
    branch: `branch-${arm}-1`,
    entries: [],
    compactions: [],
    tracePath: "/repo/session.jsonl",
  }));
}

afterEach(() => {
  clearRunState();
});

describe("startRun — identity + state + Phase-1 dispatch (inline, no driver)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes runId = <utc-date>-<id>, sets run-state phase-1, dispatches Phase-1 then Phase-2, returns phase2-done", async () => {
    const bases = fakeBases(["A1", "A3"]);
    const traces = fakeTraces(["A1", "A3"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => traces);
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1, continuations });

    const result = await startRun(deps);

    expect(result.kind).toBe("phase2-done");
    if (result.kind !== "phase2-done") return;
    expect(result.runId).toBe("2026-08-11-1");
    expect(result.cfgId).toMatch(/^cfg-/);
    expect(result.bases).toBe(bases);
    expect(result.traces).toBe(traces);

    // run-state set eagerly to phase-1, then advanced to phase-2 on Phase-1 success.
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
    expect(s?.phase).toBe("phase-2");
    expect(s?.cfgId).toBe(result.cfgId);

    // Phase-1 received the resolved identity + config-derived knobs.
    expect(phase1).toHaveBeenCalledTimes(1);
    const phase1Arg = phase1.mock.calls[0]?.[0];
    expect(phase1Arg?.date).toBe("2026-08-11");
    expect(phase1Arg?.id).toBe(1);
    expect(phase1Arg?.cfgId).toBe(result.cfgId);
    expect(phase1Arg?.armsEnabled).toEqual(["A1", "A3"]);
    expect(phase1Arg?.omFullReflectionThresholdTokens).toBe(4000);
    expect(phase1Arg?.scenarioRepo).toBe(deps.scenarioRepo);

    // Phase-2 continuations received the bases + the FINAL fresh ctx threaded from
    // Phase-1 (NOT deps.cmdCtx, which Phase-1's first arm already invalidated).
    expect(continuations).toHaveBeenCalledTimes(1);
    const phase2Arg = continuations.mock.calls[0]?.[0];
    expect(phase2Arg?.armBases).toBe(bases);
    expect(phase2Arg?.cmdCtx).toBe(FINAL_CTX);
    expect(phase2Arg?.cmdCtx).not.toBe(deps.cmdCtx);
    expect(phase2Arg?.manifest).toBe(MANIFEST);
    expect(phase2Arg?.repo).toBe(deps.scenarioRepo);
    expect(phase2Arg?.N).toBe(3);
  });

  it("writes the run-config snapshot (cfgId + toolVersions) once + reserves the run dir", async () => {
    const deps = makeDeps({
      arms: ["A1"],
      root,
      phase1: phase1Mock(async () => ({ bases: fakeBases(["A1"]), finalCtx: FINAL_CTX })),
    });
    await startRun(deps);
    const s = getRunState();
    expect(existsSync(join(root, "configs", `${s?.cfgId}.json`))).toBe(true);
    expect(existsSync(join(root, "runs", "2026-08-11-1"))).toBe(true);
  });

  it("same-day re-run increments the id (no collision with the reserved run dir)", async () => {
    await startRun(
      makeDeps({
        arms: ["A1"],
        root,
        phase1: phase1Mock(async () => ({ bases: fakeBases(["A1"]), finalCtx: FINAL_CTX })),
      }),
    );
    await startRun(
      makeDeps({
        arms: ["A1"],
        root,
        phase1: phase1Mock(async () => ({ bases: fakeBases(["A1"]), finalCtx: FINAL_CTX })),
      }),
    );
    expect(getRunState()?.runId).toBe("2026-08-11-2");
  });
});

describe("startRun — Phase-1 stop-and-surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-stop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a Phase1StoppedError from runPhase1 → stopped result + notify + run-state lastStopReason", async () => {
    const notify = vi.fn();
    const phase1 = phase1Mock(async () => {
      throw new Phase1StoppedError("A3", "cancelled", "arm A3 compaction cancelled");
    });
    const deps = makeDeps({ arms: ["A3"], root, notify, phase1 });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.arm).toBe("A3");
    expect(result.attempt).toBeNull(); // Phase-1 stops carry no attempt
    expect(result.reason).toBe("cancelled");
    expect(result.message).toContain("cancelled");
    expect(result.runId).toBe("2026-08-11-1");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*A3/i));
    expect(getRunState()?.lastStopReason).toContain("cancelled");
  });

  it("does NOT swallow non-Phase1StoppedError errors (unexpected failures re-throw)", async () => {
    const phase1 = phase1Mock(async () => {
      throw new Error("unexpected boom");
    });
    const deps = makeDeps({ arms: ["A1"], root, phase1 });
    await expect(startRun(deps)).rejects.toThrow("unexpected boom");
  });
});

describe("startRun — Phase-2 stop-and-surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-phase2-stop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a Phase2StoppedError from runContinuations → stopped result (with attempt) + notify + run-state lastStopReason", async () => {
    const notify = vi.fn();
    const phase1 = phase1Mock(async () => ({ bases: fakeBases(["A2"]), finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => {
      throw new Phase2StoppedError("A2", 2, "run-hung", "attempt 2 agent did not settle");
    });
    const deps = makeDeps({ arms: ["A2"], root, notify, phase1, continuations });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.arm).toBe("A2");
    expect(result.attempt).toBe(2);
    expect(result.reason).toBe("run-hung");
    expect(result.message).toContain("did not settle");
    expect(result.runId).toBe("2026-08-11-1");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*A2.*attempt 2/i));
    expect(getRunState()?.lastStopReason).toContain("did not settle");
    expect(continuations).toHaveBeenCalledTimes(1);
  });
});

// Phase 2b probes + Phase 3 scoring are appended by later tasks.
void (undefined as unknown as Phase1Ops);
