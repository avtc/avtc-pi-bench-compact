// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmId, BenchConfig } from "../../src/config/types.js";
import { BenchJudgeError } from "../../src/judge/errors.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { type ArmBase, type Phase1Deps, type Phase1Result, Phase1StoppedError } from "../../src/orchestrate/phase1.js";
import { type Phase2Deps, type Phase2Result, Phase2StoppedError } from "../../src/orchestrate/phase2.js";
import { ProbeStoppedError } from "../../src/orchestrate/probes.js";
import { type StartRunDeps, startRun } from "../../src/orchestrate/run.js";
import { clearRunState, getRunState } from "../../src/orchestrate/run-state.js";
import type { TestSpecResult } from "../../src/orchestrate/testspec.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";
import type { WidgetPort } from "../../src/widget/active-widget.js";
import { setActiveWidget } from "../../src/widget/active-widget.js";

function makeConfig(arms: BenchConfig["armsEnabled"]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    judgesNumber: 1,
    judge2Model: null,
    judge2ThinkingLevel: "high",
    judge3Model: null,
    judge3ThinkingLevel: "high",
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
  continuations?: ReturnType<typeof vi.fn<(deps: Phase2Deps) => Promise<Phase2Result>>>;
  now?: () => Date;
  notify?: (m: string) => void;
  widget?: WidgetPort | null;
  probes?: ReturnType<typeof vi.fn>;
  testSpec?: ReturnType<typeof vi.fn>;
  score?: ReturnType<typeof vi.fn>;
  buildScoreDeps?: ReturnType<typeof vi.fn>;
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
    widget: opts.widget ?? null,
    phase1: opts.phase1,
    // Default = a no-op continuations stub so tests never run the real Phase 2.
    continuations: opts.continuations ?? continuationsMock(async () => ({ traces: [], finalCtx: FINAL_CTX })),
    probes: opts.probes ?? probesMock(async () => ({ traces: [], finalCtx: FINAL_CTX })),
    testSpec: opts.testSpec ?? testSpecMock(() => ({ kind: "skipped" })),
    score:
      opts.score ??
      scoreMock(async () => ({ resultJson: { schema: "bench-compact.result-v1" }, markdown: "# report" })),
    buildScoreDeps: opts.buildScoreDeps ?? buildScoreDepsMock(() => minimalScoreDeps()),
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
  impl: (deps: Phase2Deps) => Promise<Phase2Result>,
): ReturnType<typeof vi.fn<(deps: Phase2Deps) => Promise<Phase2Result>>> {
  return vi.fn(impl);
}

/** A typed Phase-2b probes mock. */
function probesMock(
  impl: (deps: {
    armBase: ArmBase;
    cmdCtx: unknown;
  }) => Promise<{ traces: unknown[]; finalCtx: Phase1Result["finalCtx"] }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(impl);
}

/** A typed testSpec mock. */
function testSpecMock(
  impl: (deps: { repo: string; branch: string; manifest: ScenarioManifest }) => TestSpecResult,
): ReturnType<typeof vi.fn> {
  return vi.fn(impl);
}

/** A typed score mock. */
function scoreMock(
  impl: (input: unknown, deps: unknown) => Promise<{ resultJson: unknown; markdown: string }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(impl);
}

/** A typed buildScoreDeps mock. */
function buildScoreDepsMock(impl: (args: { ctx: unknown }) => unknown): ReturnType<typeof vi.fn> {
  return vi.fn(impl);
}

/** A minimal ScoreRunDeps-shaped object (the score fake ignores it). */
function minimalScoreDeps(): unknown {
  return {};
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

/** A capturing WidgetPort: records every method call in order. */
function capturingWidget(): WidgetPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    show: () => {
      calls.push("show");
    },
    startPhase: (phase, detail) => {
      calls.push(`startPhase:${phase}:${detail ?? "-"}`);
    },
    setStatus: (status, hint) => {
      calls.push(`setStatus:${status}:${hint ?? "-"}`);
    },
    setArm: (index, total, tool) => {
      calls.push(`setArm:${index}/${total}:${tool}`);
    },
    setDetail: (detail) => {
      calls.push(`setDetail:${detail ?? "-"}`);
    },
    setCtxWindow: (w) => {
      calls.push(`setCtxWindow:${w ?? "-"}`);
    },
    onEvent: (event) => {
      calls.push(`onEvent:${event.type}`);
    },
    hide: () => {
      calls.push("hide");
    },
  };
}

afterEach(() => {
  clearRunState();
  setActiveWidget(null);
});

describe("startRun — identity + state + Phase-1 dispatch (inline, no driver)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes runId = <utc-date>-<id>, sets run-state phase-1, dispatches Phase-1 then Phase-2, returns done", async () => {
    const bases = fakeBases(["A1", "A3"]);
    const traces = fakeTraces(["A1", "A3"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces, finalCtx: FINAL_CTX }));
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1, continuations });

    const result = await startRun(deps);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.runId).toBe("2026-08-11-1");
    expect(result.cfgId).toMatch(/^cfg-/);
    expect(result.resultsPath).toContain("results.json");
    expect(result.reportPath).toContain("report.md");

    // run-state set eagerly to phase-1; the run advanced through every phase to done.
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
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

// Phase 2b probes + Phase 3 scoring.
describe("startRun — Phase 2b probes + testSpec", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-phase2b-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runProbes called once per arm with the arm base + the threaded final ctx", async () => {
    const bases = fakeBases(["A1", "A3"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A1", "A3"]), finalCtx: FINAL_CTX }));
    const probes = probesMock(async (d: { armBase: ArmBase }) => ({
      traces: [{ arm: d.armBase.arm, probeId: "1", branch: "pb", answer: "a", kept: true }],
      finalCtx: FINAL_CTX,
    }));
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1, continuations, probes });
    await startRun(deps);
    expect(probes).toHaveBeenCalledTimes(2);
    expect(probes.mock.calls[0]?.[0]?.armBase.arm).toBe("A1");
    expect(probes.mock.calls[1]?.[0]?.armBase.arm).toBe("A3");
    // the first probe call received the continuations final ctx (threaded across phases)
    expect(probes.mock.calls[0]?.[0]?.cmdCtx).toBe(FINAL_CTX);
  });

  it("testSpec called once per (arm, attempt) attempt branch", async () => {
    const bases = fakeBases(["A1"]);
    const traces = [
      { arm: "A1", attempt: 1, branch: "arm-a1-1", entries: [], compactions: [], tracePath: "/s.jsonl" },
      { arm: "A1", attempt: 2, branch: "arm-a1-2", entries: [], compactions: [], tracePath: "/s.jsonl" },
    ] as unknown as RunTrace[];
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces, finalCtx: FINAL_CTX }));
    const testSpec = testSpecMock(() => ({ kind: "skipped" }));
    const deps = makeDeps({ arms: ["A1"], root, phase1, continuations, testSpec });
    await startRun(deps);
    expect(testSpec).toHaveBeenCalledTimes(2);
    expect(testSpec.mock.calls[0]?.[0]?.branch).toBe("arm-a1-1");
    expect(testSpec.mock.calls[1]?.[0]?.branch).toBe("arm-a1-2");
  });
});

describe("startRun — Phase 3 scoring", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-phase3-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ScoreRunInput: one entry per (arm, attempt); probes on the FIRST attempt only; testSpec attached", async () => {
    const bases = fakeBases(["A1", "A3"]);
    const traces = [
      ...fakeTraces(["A1"]),
      { arm: "A1", attempt: 2, branch: "b-a1-2", entries: [], compactions: [], tracePath: "/s" },
      ...fakeTraces(["A3"]),
      { arm: "A3", attempt: 2, branch: "b-a3-2", entries: [], compactions: [], tracePath: "/s" },
    ] as unknown as RunTrace[];
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces, finalCtx: FINAL_CTX }));
    const probes = probesMock(async (d: { armBase: ArmBase }) => ({
      traces: [
        { arm: d.armBase.arm, probeId: "1", branch: "pb", answer: "a1", kept: true },
        { arm: d.armBase.arm, probeId: "2", branch: "pb", answer: "a2", kept: true },
      ],
      finalCtx: FINAL_CTX,
    }));
    let capturedInput: unknown = null;
    const score = scoreMock(async (input: unknown) => {
      capturedInput = input;
      return { resultJson: { schema: "bench-compact.result-v1" }, markdown: "# report" };
    });
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1, continuations, probes, score });
    await startRun(deps);

    const input = capturedInput as Array<{
      arm: string;
      attempt: number;
      probes: unknown[];
      testSpecResult: { kind: string };
    }>;
    expect(input).toHaveLength(4); // 2 arms × 2 attempts
    // probes ONLY on the first attempt of each arm (graded once, not duplicated)
    const a1Attempt1 = input.find((r) => r.arm === "A1" && r.attempt === 1);
    const a1Attempt2 = input.find((r) => r.arm === "A1" && r.attempt === 2);
    expect(a1Attempt1?.probes).toHaveLength(2);
    expect(a1Attempt2?.probes).toHaveLength(0);
    // testSpec attached to every attempt
    expect(input.every((r) => r.testSpecResult !== undefined)).toBe(true);
  });

  it("writes results.json + report.md from the score output under the run dir", async () => {
    const bases = fakeBases(["A1"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A1"]), finalCtx: FINAL_CTX }));
    const score = scoreMock(async () => ({
      resultJson: { schema: "bench-compact.result-v1", x: 1 },
      markdown: "# headline",
    }));
    const deps = makeDeps({ arms: ["A1"], root, phase1, continuations, score });
    const result = await startRun(deps);
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(existsSync(result.resultsPath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(result.resultsPath, "utf8")).toContain('"schema": "bench-compact.result-v1"');
    expect(readFileSync(result.reportPath, "utf8")).toBe("# headline");
  });

  it("a ProbeStoppedError from runProbes → stopped (probe phase) + notify", async () => {
    const notify = vi.fn();
    const bases = fakeBases(["A2"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A2"]), finalCtx: FINAL_CTX }));
    const probes = probesMock(async () => {
      throw new ProbeStoppedError("A2", "1", "probe-failed", "probe 1 inject error");
    });
    const deps = makeDeps({ arms: ["A2"], root, notify, phase1, continuations, probes });
    const result = await startRun(deps);
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.phase).toBe("probe");
    expect(result.arm).toBe("A2");
    expect(result.reason).toBe("probe-failed");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*A2.*probe 1/i));
  });

  it("a BenchJudgeError from scoreRun → stopped (score phase) + notify", async () => {
    const notify = vi.fn();
    const bases = fakeBases(["A1"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A1"]), finalCtx: FINAL_CTX }));
    const score = scoreMock(async () => {
      throw new BenchJudgeError("malformed-json", "judge emitted unparseable JSON");
    });
    const deps = makeDeps({ arms: ["A1"], root, notify, phase1, continuations, score });
    const result = await startRun(deps);
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.phase).toBe("score");
    expect(result.arm).toBeNull();
    expect(result.reason).toBe("malformed-json");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*scoring/i));
  });
});

describe("startRun — live-progress widget wiring", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-widget-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("shows on run start (compact), advances compact→resume→probe→score→done", async () => {
    const widget = capturingWidget();
    const phase1 = phase1Mock(async () => ({ bases: fakeBases(["A1"]), finalCtx: FINAL_CTX }));
    const deps = makeDeps({ arms: ["A1"], root, phase1, widget });

    await startRun(deps);

    // show + compact at start; resume/probe/score across phases; done on completion.
    expect(widget.calls).toEqual([
      "show",
      "startPhase:compact:-",
      "startPhase:resume:-",
      "startPhase:probe:-",
      "setArm:1/1:tool-A1",
      "startPhase:score:-",
      "setStatus:done:/bench-compact:results",
    ]);
  });

  it("Phase-1 stop → setStatus stopped with the resume hint (stays visible)", async () => {
    const widget = capturingWidget();
    const phase1 = phase1Mock(async () => {
      throw new Phase1StoppedError("A3", "cancelled", "arm A3 compaction cancelled");
    });
    const deps = makeDeps({ arms: ["A3"], root, phase1, widget });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    expect(widget.calls).toContain("setStatus:stopped:/bench-compact:resume");
    expect(widget.calls).not.toContain("setStatus:done:/bench-compact:results");
  });

  it("null widget (non-TUI) → run proceeds with no widget calls (no throw)", async () => {
    const phase1 = phase1Mock(async () => ({ bases: fakeBases(["A1"]), finalCtx: FINAL_CTX }));
    const deps = makeDeps({ arms: ["A1"], root, phase1, widget: null });
    await expect(startRun(deps)).resolves.toMatchObject({ kind: "done" });
  });
});

describe("startRun — Phase 3 scoreDeps ctx-threading", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-ctxthread-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("buildScoreDeps receives the LAST probe's threaded final ctx (R1-8)", async () => {
    const PROBE_CTX_A = { __probeCtx: "A1" } as unknown as Phase1Result["finalCtx"];
    const PROBE_CTX_B = { __probeCtx: "A3" } as unknown as Phase1Result["finalCtx"];
    const bases = fakeBases(["A1", "A3"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A1", "A3"]), finalCtx: FINAL_CTX }));
    const probes = probesMock(async (d: { armBase: ArmBase }) => ({
      traces: [],
      finalCtx: d.armBase.arm === "A1" ? PROBE_CTX_A : PROBE_CTX_B,
    }));
    let capturedCtx: unknown = null;
    const buildScoreDeps = buildScoreDepsMock((args: { ctx: unknown }) => {
      capturedCtx = args.ctx;
      return minimalScoreDeps();
    });
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1, continuations, probes, buildScoreDeps });
    await startRun(deps);
    // the LAST arm's probe finalCtx (A3) threads into the scoring deps
    expect(capturedCtx).toBe(PROBE_CTX_B);
  });
});

describe("startRun — production scoreDeps (buildProductionScoreDeps)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-prodscore-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a missing pricing entry → BenchJudgeError(model-unavailable) stop-and-surface (R1-1)", async () => {
    const { buildProductionScoreDeps } = await import("../../src/orchestrate/run.js");
    const runConfig = {
      evaluatedModel: "provider/missing-model",
      judgeModel: null,
      judgeThinkingLevel: "high",
      judgesNumber: 1,
      judge2Model: null,
      judge2ThinkingLevel: "high",
      judge3Model: null,
      judge3ThinkingLevel: "high",
      evaluatedThinkingLevel: "high",
      N: 1,
      compactionBoundary: 140000,
      armsEnabled: ["A1"] as ArmId[],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build" as const,
      toolVersions: {},
    } as unknown as Parameters<typeof buildProductionScoreDeps>[0]["runConfig"];
    expect(() =>
      buildProductionScoreDeps({
        ctx: {} as ExtensionContext,
        runConfig,
        manifest: MANIFEST,
        meta: { runId: "x", cfgId: "cfg-x" } as unknown as Parameters<typeof buildProductionScoreDeps>[0]["meta"],
        signal: new AbortController().signal,
        modelsPath: join(root, "no-such-models.json"),
      }),
    ).toThrow(/model-unavailable|pricing for evaluated model/);
  });

  it("scoreWidgetHooks suppresses ctx/tok for K>1 (parallel judges would interleave) + forwards at K=1", async () => {
    const { scoreWidgetHooks } = await import("../../src/orchestrate/run.js");
    const widget = capturingWidget();
    // K=3 → undefined (suppressed); K=1 → the hook pair (forwards).
    expect(scoreWidgetHooks(3, widget)).toBeUndefined();
    expect(scoreWidgetHooks(1, widget)).toBeDefined();
    // a null/absent widget suppresses at every K (non-TUI).
    expect(scoreWidgetHooks(1, null)).toBeUndefined();
    expect(scoreWidgetHooks(1, undefined)).toBeUndefined();
  });
});

describe("startRun — testSpec harness fault (R2-1)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-testspec-fault-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a testSpec harness fault (runError) → stopped (probe phase, reason testspec-fault) + notify", async () => {
    const notify = vi.fn();
    const bases = fakeBases(["A1"]);
    const phase1 = phase1Mock(async () => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = continuationsMock(async () => ({ traces: fakeTraces(["A1"]), finalCtx: FINAL_CTX }));
    const testSpec = testSpecMock(() => ({ kind: "ran", pass: false, output: "spawn timeout", runError: true }));
    const deps = makeDeps({ arms: ["A1"], root, notify, phase1, continuations, testSpec });
    const result = await startRun(deps);
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.phase).toBe("probe");
    expect(result.reason).toBe("testspec-fault");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*testSpec/i));
  });
});
