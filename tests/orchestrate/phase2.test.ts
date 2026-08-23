// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryProxies, type MemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { clearBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";
import type { ArmBase } from "../../src/orchestrate/phase1.js";
import {
  type ContinuationDriver,
  createDefaultSimulatorFactory,
  type MakeSimulatorArgs,
  type Phase2Ops,
  Phase2StoppedError,
  runContinuations,
} from "../../src/orchestrate/phase2.js";
import { clearRunState } from "../../src/orchestrate/run-state.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";
import { AgentSettledAbortedError } from "../../src/session/done.js";
import type { WidgetPort } from "../../src/widget/active-widget.js";

/** A capturing WidgetPort: records setArm/setDetail calls. */
function capturingWidget(): WidgetPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    show: () => {},
    startPhase: () => {},
    setStatus: () => {},
    setArm: (index, total, tool) => {
      calls.push(`setArm:${index}/${total}:${tool}`);
    },
    setDetail: (detail) => {
      calls.push(`setDetail:${detail ?? "-"}`);
    },
    clearArm: () => {
      calls.push("clearArm");
    },
    clearAgent: () => {},
    setCtxWindow: () => {},
    setJudgeUsages: () => {},
    onEvent: () => {},
    onValidatorEvent: () => {},
    setValidatorCtxWindow: () => {},
    clearValidator: () => {},
    hide: () => {},
  };
}

import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { appendAttempt, buildArmBaseBranch } from "../../src/storage/branches.js";
import { branchSessionFile } from "../../src/storage/paths.js";

const RESUME_MESSAGE = "Resume the Phase-C work — finish the remaining systems and run the tests.";

// --- fake builders ----------------------------------------------------------

/** A fake fresh pi: sendUserMessage (inject seam target) + the agent-event handler
 * surface (`pi.on` registration + `emit` firing them the way the extension runner
 * does) so the orchestration can register turn_end + compaction listeners and the
 * test can fire them. Models the post-switchSession re-activation pi. */
interface FreshPi {
  pi: ExtensionAPI;
  sendUserMessage: ReturnType<typeof vi.fn>;
  emit: (event: string, data: unknown) => void;
}

function makeFreshPi(): FreshPi {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const sendUserMessage = vi.fn();
  const on = (event: string, handler: (data: unknown) => void): void => {
    const list = handlers.get(event);
    if (list) list.push(handler);
    else handlers.set(event, [handler]);
  };
  const emit = (event: string, data: unknown): void => {
    const arr = handlers.get(event);
    if (arr) for (const h of [...arr]) h(data);
  };
  const pi = { sendUserMessage, setActiveTools: vi.fn(), on } as unknown as ExtensionAPI;
  return { pi, sendUserMessage, emit };
}

interface FakeOps {
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  commitCountAhead: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  copySeed: ReturnType<typeof vi.fn>;
  awaitSettled: ReturnType<typeof vi.fn>;
  makeMonitor: ReturnType<typeof vi.fn>;
  makeSimulator: ReturnType<typeof vi.fn>;
  captureTrace: ReturnType<typeof vi.fn>;
  freshPis: FreshPi[];
  freshCtxs: ExtensionCommandContext[];
  /** Per-call captured simulator args (the inject seam + fresh pi per attempt). */
  simulatorArgs: MakeSimulatorArgs[];
  /** Per-call captured monitor args (fresh pi + fresh ctx per attempt). */
  monitorArgs: Array<{ pi: ExtensionAPI; ctx: ExtensionCommandContext }>;
  /** Shared dispose spy for every monitor the fake creates (one call per attempt). */
  monitorDisposeSpy: ReturnType<typeof vi.fn>;
  /** Per-call captured captureTrace wallMs maps (the bench-timed compaction wall time). */
  traceWallMsMaps: Map<string, number>[];
}

/** How many simulator cycles before the fake driver signals stop (default 1 = kick-off only). */
function makeFakeOps(opts: { stopAfter?: number; emitCompaction?: boolean } = {}): FakeOps {
  const stopAfter = opts.stopAfter ?? 1;
  const freshPis: FreshPi[] = [];
  const freshCtxs: ExtensionCommandContext[] = [];
  const simulatorArgs: MakeSimulatorArgs[] = [];
  const monitorArgs: Array<{ pi: ExtensionAPI; ctx: ExtensionCommandContext }> = [];
  const monitorDisposeSpy = vi.fn();
  const traceWallMsMaps: Map<string, number>[] = [];
  let armIdx = 0;
  return {
    loadSession: vi.fn(async (_ctx: unknown, _path: string, cb: (c: ExtensionCommandContext) => Promise<unknown>) => {
      const fresh = makeFreshPi();
      const freshCtx = {
        id: `fresh-ctx-${freshCtxs.length + 1}`,
        // The real switched-session ctx exposes getContextUsage(); the fake must too so
        // runContinuations can read the model's window for Phase-2 pacing (not compactionBoundary).
        getContextUsage: () => ({ contextWindow: 200000, tokens: 1000 }),
      } as unknown as ExtensionCommandContext;
      freshPis.push(fresh);
      freshCtxs.push(freshCtx);
      setBenchPi(fresh.pi); // re-activation stashes the fresh pi BEFORE withSession runs
      setMemoryProxies({
        om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
        mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
      } as unknown as MemoryProxies);
      return cb(freshCtx);
    }),
    fork: vi.fn(),
    checkout: vi.fn(),
    branchExists: vi.fn(() => false),
    commit: vi.fn(),
    commitCountAhead: vi.fn(() => 0),
    deleteBranch: vi.fn(),
    copySeed: vi.fn(),
    awaitSettled: vi.fn(async () => {}),
    makeMonitor: vi.fn((pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
      monitorArgs.push({ pi, ctx });
      return { dispose: monitorDisposeSpy };
    }),
    makeSimulator: vi.fn((args: MakeSimulatorArgs): ContinuationDriver => {
      simulatorArgs.push(args);
      const ownArmIdx = armIdx++;
      let calls = 0;
      return {
        async onAgentSettled(): Promise<void> {
          calls += 1;
          // Faithful to the real SimulatorDriver: the pacing check fires BEFORE the
          // inject — a boundary-stop cycle injects NOTHING (it just signals stop).
          if (calls >= stopAfter) {
            args.onStop({ contextTokens: 0, reason: "boundary" });
            return;
          }
          // The kick-off cycle: voice the resume message via the inject seam
          // (the seam prepends ANTI_PEEK on the first call). The fake also lets the
          // test emit a compaction event pair on the fresh pi for the wallMs test.
          args.inject(RESUME_MESSAGE);
          if (opts.emitCompaction === true) {
            freshPis[ownArmIdx]?.emit("session_before_compact", { type: "session_before_compact" });
            freshPis[ownArmIdx]?.emit("session_compact", {
              type: "session_compact",
              compactionEntry: { id: "phase2-c1" },
            });
          }
        },
      };
    }),
    captureTrace: vi.fn((sessionPath: string, branch: string, wallMs: Map<string, number>): RunTrace => {
      traceWallMsMaps.push(wallMs);
      return { branch, entries: [], compactions: [], tracePath: sessionPath };
    }),
    freshPis,
    freshCtxs,
    simulatorArgs,
    monitorArgs,
    monitorDisposeSpy,
    traceWallMsMaps,
  };
}

function makeArmBase(arm: string, tool: string, ver: string | undefined): ArmBase {
  return {
    arm: arm as ArmBase["arm"],
    tool,
    ver,
    cfgId: "cfg-test1",
    branch: `bench-compact/run-2026-08-11-1/cfg-test1/arm-${tool}${ver === undefined ? "" : `-${ver}`}`,
    wallMs: 1000,
    usage: undefined,
  };
}

function makeConfig(n: number): BenchConfig {
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
    N: n,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    judgeMaxTokens: 32768,
    latentStageMaxTokens: null,
    judgeTurnTimeoutMs: 300000,
    testspecTimeoutMs: 120000,
    backgroundModel: null,
    backgroundThinkingLevel: null,
    backgroundMaxTokens: 32768,
    backgroundTimeoutMs: 1200000,
    authorModel: null,
    authorThinkingLevel: null,
    authorMaxTokens: null,
    authorTimeoutMs: null,
    probeValidateModel: null,
    probeValidateThinkingLevel: null,
    probeValidateMaxTokens: null,
    probeValidateTimeoutMs: null,
    simulatorModel: null,
    simulatorThinkingLevel: null,
    simulatorMaxTokens: null,
    simulatorTurnTimeoutMs: null,
    latentModel: null,
    latentThinkingLevel: null,
    latentTimeoutMs: null,
    armsEnabled: ["A1"],
  } as unknown as BenchConfig;
}

const MANIFEST: ScenarioManifest = {
  id: "scen-1",
  description: "an incremental economic tycoon with an AI theme",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build to the boundary" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "the game", testSpec: "npm test" },
  probes: [],
} as unknown as ScenarioManifest;

afterEach(() => {
  clearRunState();
  clearBenchPi();
  clearMemoryProxies();
});

// --- runContinuations (per arm × N attempts: fork → load → drive → capture → commit) ---

describe("runContinuations — N attempts per arm, each driven + committed", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase2-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("forks arm-base → attempt branches (1..N), drives each, commits, returns N traces", async () => {
    const ops = makeFakeOps();
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(3),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 3,
      ops: ops as unknown as Phase2Ops,
    });

    expect(traces).toHaveLength(3);
    expect(ops.fork).toHaveBeenCalledTimes(3);
    expect(ops.checkout).toHaveBeenCalledTimes(3);
    expect(ops.loadSession).toHaveBeenCalledTimes(3);
    expect(ops.commit).toHaveBeenCalledTimes(3);
    // attempt branches are appendAttempt(buildArmBaseBranch(...), attemptN)
    for (let k = 1; k <= 3; k++) {
      const attemptBranch = appendAttempt(
        buildArmBaseBranch({
          date: "2026-08-11",
          id: 1,
          cfgId: "cfg-test1",
          tool: "bare-pi",
          ver: undefined,
        }),
        k,
      );
      expect(ops.fork.mock.calls[k - 1]).toEqual([repo, base.branch, attemptBranch]);
      expect(ops.checkout.mock.calls[k - 1]).toEqual([repo, attemptBranch]);
      // each attempt's session file is seeded from its arm base's + loadSession/captureTrace receive it
      expect(ops.copySeed.mock.calls[k - 1]).toEqual([
        branchSessionFile(join(repo, "sessions"), base.branch),
        branchSessionFile(join(repo, "sessions"), attemptBranch),
        { model: { provider: "test", modelId: "model" }, thinkingLevel: "high" },
      ]);
      expect(ops.loadSession.mock.calls[k - 1]?.[1]).toBe(branchSessionFile(join(repo, "sessions"), attemptBranch));
      expect(ops.captureTrace.mock.calls[k - 1]?.[0]).toBe(branchSessionFile(join(repo, "sessions"), attemptBranch));
      expect(ops.commit.mock.calls[k - 1]?.[0]).toBe(repo);
    }
  });

  it("calls widget.setArm + setDetail per arm×attempt", async () => {
    const ops = makeFakeOps();
    const base = makeArmBase("A1", "bare-pi", undefined);
    const widget = capturingWidget();
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(3),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 3,
      widget,
      ops: ops as unknown as Phase2Ops,
    });
    expect(widget.calls).toEqual([
      "setArm:1/1:bare-pi",
      "setDetail:1/3",
      "setArm:1/1:bare-pi",
      "setDetail:2/3",
      "setArm:1/1:bare-pi",
      "setDetail:3/3",
    ]);
  });

  it("a pre-existing attempt branch is a CONFLICT — Phase2StoppedError(branch-conflict), no re-seed/commit", async () => {
    // Branch names embed the runId; a fresh run never reuses one within an output
    // root. An existing attempt branch means a prior run derived the same id against
    // this shared scenario repo — re-seeding the session + stacking commits would
    // corrupt both runs' traces, so the bench stops + surfaces instead.
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    const base = makeArmBase("A1", "bare-pi", undefined);
    await expect(
      runContinuations({
        cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
        armBases: [base],
        config: makeConfig(2),
        manifest: MANIFEST,
        repo,
        sessionsDir: join(repo, "sessions"),
        N: 2,
        ops: ops as unknown as Phase2Ops,
      }),
    ).rejects.toMatchObject({ name: "Phase2StoppedError", arm: "A1", attempt: 1, reason: "branch-conflict" });
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.copySeed).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
  });

  it("threads the fresh ctx from each withSession into the next attempt's switchSession", async () => {
    // regression guard (mirrors phase1): switchSession invalidates the ctx
    // it's called on, so attempt 2+ MUST use the fresh ctx threaded from the prior
    // attempt's withSession, NOT the stale command-handler ctx.
    const ops = makeFakeOps();
    const cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
    await runContinuations({
      cmdCtx,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(3),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 3,
      ops: ops as unknown as Phase2Ops,
    });

    expect(ops.loadSession.mock.calls[0]?.[0]).toBe(cmdCtx); // attempt 1 starts from cmdCtx
    expect(ops.loadSession.mock.calls[1]?.[0]).toBe(ops.freshCtxs[0]); // attempt 2 threads attempt-1 fresh ctx
    expect(ops.loadSession.mock.calls[2]?.[0]).toBe(ops.freshCtxs[1]);
    expect(ops.loadSession.mock.calls[1]?.[0]).not.toBe(cmdCtx);
  });

  it("the simulator injects into the SWITCHED session (fresh pi), not the stale command-handler pi", async () => {
    // The inject seam MUST capture the FRESH pi (getBenchPi inside withSession). The
    // kick-off inject lands on the fresh pi's sendUserMessage, never a stale handle.
    // stopAfter=2: the kick-off injects (cycle 1), then cycle 2 boundary-stops (no inject).
    const ops = makeFakeOps({ stopAfter: 2 });
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(2),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 2,
      ops: ops as unknown as Phase2Ops,
    });

    expect(ops.freshPis).toHaveLength(2);
    // attempt 1's kick-off inject landed on fresh pi #1, NOT fresh pi #2 or anything stale.
    expect(ops.freshPis[0]?.sendUserMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliverAs: "followUp" }),
    );
    expect(ops.freshPis[1]?.sendUserMessage).toHaveBeenCalled();
    // the makeSimulator factory received the FRESH pi for each attempt
    expect(ops.simulatorArgs[0]?.pi).toBe(ops.freshPis[0]?.pi);
    expect(ops.simulatorArgs[1]?.pi).toBe(ops.freshPis[1]?.pi);
    // arm re-isolation: configureArm fires per attempt (setActiveTools on each fresh pi),
    // so the measurement phase keeps each arm's tool allowlist (A1 stays bare, memory arms keep recall).
    for (const fresh of ops.freshPis) {
      expect((fresh.pi as unknown as { setActiveTools: ReturnType<typeof vi.fn> }).setActiveTools).toHaveBeenCalled();
    }
  });

  it("paces toward the model's contextWindow, NOT the Phase-0/1 compactionBoundary", async () => {
    // The fake session ctx reports contextWindow=200000; makeConfig's compactionBoundary=140000.
    // Phase-2 must pace toward the window so the run can reach the natural auto-compactions
    // expect to capture (pacing at compactionBoundary would self-stop early +
    // make the window-based monitor dead code).
    const ops = makeFakeOps({ stopAfter: 1 });
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(1),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 1,
      ops: ops as unknown as Phase2Ops,
    });
    expect(ops.simulatorArgs[0]?.targetContext).toBe(200000);
    expect(ops.simulatorArgs[0]?.targetContext).not.toBe(140000);
  });

  it("the FIRST agent-facing message carries the anti-peek preamble (prepended before the first tool-bearing turn)", async () => {
    // stopAfter=3 → two injects within attempt 1: the kick-off (anti-peek prepended)
    // + a subsequent cycle (bare resume), then the third cycle boundary-stops. Anti-peek
    // is first-inject only.
    const ops = makeFakeOps({ stopAfter: 3 });
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(1),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 1,
      ops: ops as unknown as Phase2Ops,
    });

    const calls = ops.freshPis[0]?.sendUserMessage.mock.calls ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First inject = ANTI_PEEK + resume message.
    const firstBody = calls[0]?.[0] as string;
    expect(firstBody.startsWith(ANTI_PEEK_PROMPT)).toBe(true);
    expect(firstBody).toContain(RESUME_MESSAGE);
    // Second inject = bare resume (anti-peek is first-inject only).
    const secondBody = calls[1]?.[0] as string;
    expect(secondBody.startsWith(ANTI_PEEK_PROMPT)).toBe(false);
    expect(secondBody).toBe(RESUME_MESSAGE);
  });

  it("the context monitor is wired to the FRESH pi + fresh ctx each attempt + disposed", async () => {
    const ops = makeFakeOps();
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(2),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 2,
      ops: ops as unknown as Phase2Ops,
    });

    expect(ops.makeMonitor).toHaveBeenCalledTimes(2);
    expect(ops.monitorArgs[0]?.pi).toBe(ops.freshPis[0]?.pi);
    expect(ops.monitorArgs[0]?.ctx).toBe(ops.freshCtxs[0]);
    expect(ops.monitorArgs[1]?.pi).toBe(ops.freshPis[1]?.pi);
    expect(ops.monitorArgs[1]?.ctx).toBe(ops.freshCtxs[1]);
    // Each attempt's monitor is disposed in the finally (no listener leak across attempts).
    expect(ops.monitorDisposeSpy).toHaveBeenCalledTimes(2);
  });

  it("awaits agent_settled between simulator cycles (multi-cycle driving hits the fresh pi)", async () => {
    // stopAfter=3 → kick-off inject (cycle 1) → awaitSettled → cycle 2 inject → awaitSettled
    // → cycle 3 boundary-stops WITHOUT injecting → the loop exits WITHOUT awaiting (a
    // boundary-stop cycle injects nothing, so awaiting the settle afterwards would hang
    // forever — awaitAgentSettled resolves only on the NEXT agent_settled event). So
    // awaitSettled is called once per INJECTING cycle, never after a stop cycle.
    const ops = makeFakeOps({ stopAfter: 3 });
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(1),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 1,
      ops: ops as unknown as Phase2Ops,
    });

    expect(ops.awaitSettled).toHaveBeenCalledTimes(2);
    // awaitSettled received the FRESH pi (not the stale command-handler pi)
    expect(ops.awaitSettled.mock.calls[0]?.[0]).toBe(ops.freshPis[0]?.pi);
  });

  it("Phase-2 compaction wallMs is measured via the before→after compact event pair (keyed by compaction id)", async () => {
    const ops = makeFakeOps({ stopAfter: 2, emitCompaction: true });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    // first loadSession re-activation; control Date.now across the compact pair per attempt
    let callCount = 0;
    const originals = [10_000, 14_200]; // before_compact → compact delta = 4200
    nowSpy.mockImplementation(() => originals[Math.min(callCount++, originals.length - 1)] ?? 0);

    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(1),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 1,
      ops: ops as unknown as Phase2Ops,
    });

    nowSpy.mockRestore();
    // captureTrace received a wallMs map keyed by the compaction id with the event-pair delta.
    expect(ops.traceWallMsMaps).toHaveLength(1);
    const map = ops.traceWallMsMaps[0];
    expect(map?.get("phase2-c1")).toBe(4200);
  });

  it("steers to wrap up when the context monitor fires onApproachingWindow (no further injects, no hang)", async () => {
    // The monitor fires during the agent's turn (simulated by the fake awaitSettled
    // invoking the captured onApproachingWindow). The loop MUST stop injecting after
    // that turn settles — it must NOT inject again or await a non-existent settle.
    const ops = makeFakeOps({ stopAfter: 99 }); // simulator never self-stops; the budget stops it
    let approaching: (() => void) | null = null;
    ops.makeMonitor.mockImplementation(
      (_pi: ExtensionAPI, _ctx: ExtensionCommandContext, opts: { onApproachingWindow: () => void }) => {
        approaching = opts.onApproachingWindow;
        return { dispose: () => {} };
      },
    );
    ops.awaitSettled.mockImplementation(async () => {
      // the monitor fires mid-turn (usage crossed the window during the agent's work)
      if (approaching !== null) approaching();
    });
    await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [makeArmBase("A1", "bare-pi", undefined)],
      config: makeConfig(1),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 1,
      ops: ops as unknown as Phase2Ops,
    });

    // Only the kick-off inject ran (no second inject after the budget was reached).
    expect(ops.freshPis[0]?.sendUserMessage).toHaveBeenCalledTimes(1);
    // awaitSettled ran exactly once (the turn during which the monitor fired) — no extra settle.
    expect(ops.awaitSettled).toHaveBeenCalledTimes(1);
    expect(ops.awaitSettled.mock.calls[0]?.[0]).toBe(ops.freshPis[0]?.pi);
    // the attempt still committed (wrap-up → commit, no hang).
    expect(ops.commit).toHaveBeenCalledTimes(1);
  });

  it("the run trace carries arm + attempt + branch for each continuation", async () => {
    const ops = makeFakeOps();
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(2),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 2,
      ops: ops as unknown as Phase2Ops,
    });

    expect(traces[0]?.arm).toBe("A1");
    expect(traces[0]?.attempt).toBe(1);
    expect(traces[1]?.arm).toBe("A1");
    expect(traces[1]?.attempt).toBe(2);
    expect(traces[0]?.branch).toBe(
      appendAttempt(
        buildArmBaseBranch({
          date: "2026-08-11",
          id: 1,
          cfgId: "cfg-test1",
          tool: "bare-pi",
          ver: undefined,
        }),
        1,
      ),
    );
  });
});

describe("runContinuations — stop-and-surface (run failure / hang)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase2-stop-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("a simulator error (onStop reason=error) → rejects Phase2StoppedError(reason=run-failed) + does NOT commit", async () => {
    const ops = makeFakeOps();
    ops.makeSimulator.mockImplementation((args: MakeSimulatorArgs): ContinuationDriver => {
      return {
        async onAgentSettled() {
          args.onStop({ contextTokens: 0, reason: "error", error: "simulator stage failed" });
        },
      };
    });
    await expect(
      runContinuations({
        cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
        armBases: [makeArmBase("A1", "bare-pi", undefined)],
        config: makeConfig(1),
        manifest: MANIFEST,
        repo,
        sessionsDir: join(repo, "sessions"),
        N: 1,
        ops: ops as unknown as Phase2Ops,
      }),
    ).rejects.toMatchObject({ arm: "A1", attempt: 1, reason: "run-failed" });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("an awaitAgentSettled rejection (aborted/stalled) → rejects Phase2StoppedError(reason=run-hung)", async () => {
    const ops = makeFakeOps({ stopAfter: 2 }); // kick-off does not stop → loop awaits settle
    ops.awaitSettled.mockRejectedValue(new AgentSettledAbortedError(new Error("signal aborted")));
    await expect(
      runContinuations({
        cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
        armBases: [makeArmBase("A1", "bare-pi", undefined)],
        config: makeConfig(1),
        manifest: MANIFEST,
        repo,
        sessionsDir: join(repo, "sessions"),
        N: 1,
        ops: ops as unknown as Phase2Ops,
      }),
    ).rejects.toMatchObject({ arm: "A1", attempt: 1, reason: "run-hung" });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("Phase2StoppedError carries arm + attempt + reason + message", () => {
    const err = new Phase2StoppedError("A2", 3, "run-failed", "boom");
    expect(err.arm).toBe("A2");
    expect(err.attempt).toBe(3);
    expect(err.reason).toBe("run-failed");
    expect(err.message).toBe("boom");
  });

  it("createDefaultSimulatorFactory wires a driver bound to the fresh pi + ctx (smoke)", () => {
    // The default factory (used when ops.makeSimulator isn't overridden) builds the
    // system prompt + a SimulatorDriver bound to the args. This smoke test verifies the
    // wiring constructs without error + exposes the driver contract (onAgentSettled).
    const factory = createDefaultSimulatorFactory(makeConfig(1), MANIFEST);
    const args: MakeSimulatorArgs = {
      pi: { events: { on: () => () => {} } } as unknown as MakeSimulatorArgs["pi"],
      ctx: { sessionManager: { getBranch: () => [] } } as unknown as MakeSimulatorArgs["ctx"],
      targetContext: 200000,
      inject: () => {},
      signal: new AbortController().signal,
      onStop: () => {},
    };
    const driver: ContinuationDriver = factory(args);
    expect(typeof driver.onAgentSettled).toBe("function");
  });
});

// --- crash resume ----------------------------------------------------------

describe("runContinuations — crash resume (skip committed attempts)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase2-resume-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("skips a committed attempt: trace re-captured off the session file, NO fork/load/commit", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 1);
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces, finalCtx } = await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(2),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 2,
      resume: true,
      ops: ops as unknown as Phase2Ops,
    });

    expect(traces).toHaveLength(2);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptBranch = appendAttempt(base.branch, attempt);
      expect(traces[attempt - 1]).toMatchObject({ arm: "A1", attempt, branch: attemptBranch });
      // the trace is re-captured off the attempt's EXISTING session file with an empty wall map
      expect(ops.captureTrace).toHaveBeenCalledWith(
        branchSessionFile(join(repo, "sessions"), attemptBranch),
        attemptBranch,
        new Map(),
      );
    }
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(ops.deleteBranch).not.toHaveBeenCalled();
    expect(finalCtx).toEqual({ id: "cmd-handler-ctx" }); // no switchSession ran
  });

  it("deletes + re-runs an attempt branch that exists but is NOT committed (crash mid-attempt)", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn((_repo: string, branch: string) => (branch.endsWith("-1") ? 1 : 0));
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runContinuations({
      cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
      armBases: [base],
      config: makeConfig(2),
      manifest: MANIFEST,
      repo,
      sessionsDir: join(repo, "sessions"),
      N: 2,
      resume: true,
      ops: ops as unknown as Phase2Ops,
    });

    expect(ops.deleteBranch).toHaveBeenCalledTimes(1);
    expect(ops.deleteBranch).toHaveBeenCalledWith(repo, appendAttempt(base.branch, 2));
    // attempt 1 skipped (re-captured), attempt 2 fully re-driven
    expect(ops.loadSession).toHaveBeenCalledTimes(1);
    expect(ops.loadSession.mock.calls[0]?.[1]).toBe(
      branchSessionFile(join(repo, "sessions"), appendAttempt(base.branch, 2)),
    );
    expect(ops.commit).toHaveBeenCalledTimes(1);
    expect(ops.fork).toHaveBeenCalledTimes(1);
    expect(traces).toHaveLength(2);
  });

  it("a pre-existing attempt branch on the NON-resume path is still a hard conflict", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    await expect(
      runContinuations({
        cmdCtx: { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext,
        armBases: [makeArmBase("A1", "bare-pi", undefined)],
        config: makeConfig(1),
        manifest: MANIFEST,
        repo,
        sessionsDir: join(repo, "sessions"),
        N: 1,
        ops: ops as unknown as Phase2Ops,
      }),
    ).rejects.toMatchObject({ arm: "A1", attempt: 1, reason: "branch-conflict" });
  });
});
