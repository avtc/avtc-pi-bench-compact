// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-2 continuation orchestration. For each arm's compacted base, fork N
// independent continuation attempts; each is driven by the user-simulator (resume
// the Phase-C work) until `agent_settled`, with Phase-2 auto-compactions allowed
// (monitored, not forced to a single window) + each captured precisely. Commit at
// the boundary; capture the structured trace (entries + every CompactionEntry with
// its bench-timed wall time) for Phase-3 scoring.
//
// fresh-pi / ctx-threading contract (load-bearing — same as Phase 1): switchSession
// invalidates BOTH the command-handler `pi` AND the ctx it's called on, BUT its
// createRuntime RE-ACTIVATES the extension (`activate(freshPi)` runs again, stashing
// the fresh pi via bench-ctx). So inside each `withSession` the FRESH pi is read via
// getBenchPi() + the fresh ctx is the withSession arg; the fresh ctx is threaded
// into the next attempt's switchSession. The SimulatorDriver is constructed/bound to
// the fresh ctx + fresh pi inside withSession (its inject + listeners target the
// ACTIVE session); binding it to the pre-switch ctx silently mis-targets the inject.
//
// Stop-and-surface: a run failure (simulator error) or run hang (the agent does not
// settle) HALTS the run — Phase2StoppedError; the run driver catches + notifies. No
// per-run turn-cap: the run is bounded by context monitoring (steer to wrap up as
// usage approaches the model's window) + the notification extension's idle-alert.

import type { ExtensionAPI, ExtensionCommandContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { runBenchStage } from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { AgentSettledAbortedError, awaitAgentSettled } from "../session/done.js";
import { type InjectMode, inject } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import { CONDITION_TOPICS } from "../simulator/condition-topics.js";
import { SimulatorDriver, type SimulatorHooks, type SimulatorSeams, type StopReason } from "../simulator/loop.js";
import { buildSimulatorSystemPrompt } from "../simulator/prompt.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { appendAttempt } from "../storage/branches.js";
import { branchExists, checkout, commitAll, forkBranch } from "../storage/repo.js";
import { getBenchPi } from "./bench-ctx.js";
import { type ContextMonitor, makeContextMonitor } from "./context-monitor.js";
import type { ArmBase } from "./phase1.js";
import { getRunState, updateRunState } from "./run-state.js";
import { captureTrace, type RunTrace } from "./trace.js";

/** Separator between the anti-peek preamble and the simulator's first resume message. */
const ANTI_PEEK_SEPARATOR = "\n\n";
/** Delivery mode for the continuation injects (queued after the current run settles). */
const DELIVER_AS_FOLLOW_UP: InjectMode = "followUp";
/** Per-call output cap for the continuation simulator's stage calls. */
const SIMULATOR_MAX_TOKENS = 1024;
/** A signal that never aborts — the default when the caller threads no run signal. */
const NEVER_ABORT_CONTROLLER = new AbortController();

/** Why a Phase-2 continuation halted (stop-and-surface). */
export type Phase2StopReason = "run-failed" | "run-hung";

/** Result of {@link runContinuations}: the captured traces (one per arm×attempt) + the
 *  FINAL fresh command ctx (the last arm's last attempt's `withSession`). The run
 *  driver threads `finalCtx` into the Phase-2b probe driver so its switchSession chain
 *  starts from a valid ctx — every switchSession invalidates the prior ctx, so only
 *  the last one survives. Mirrors {@link Phase1Result}. */
export interface Phase2Result {
  readonly traces: readonly RunTrace[];
  readonly finalCtx: ExtensionCommandContext;
}

/** Thrown/recorded when a Phase-2 continuation must stop-and-surface. The run driver
 *  catches it, records `lastStopReason`, notifies the operator, and yields — never
 *  auto-retries. A run failure is a simulator/drive error; a run hang is the agent
 *  failing to settle (bounded in production by the notification idle-alert). */
export class Phase2StoppedError extends Error {
  readonly arm: ArmId;
  readonly attempt: number;
  readonly reason: Phase2StopReason;
  constructor(arm: ArmId, attempt: number, reason: Phase2StopReason, message: string) {
    super(message);
    this.name = "Phase2StoppedError";
    this.arm = arm;
    this.attempt = attempt;
    this.reason = reason;
  }
}

/** The minimal driver surface the orchestration drives (the SimulatorDriver satisfies it). */
export interface ContinuationDriver {
  /** Run one simulator cycle (kick-off on the first call; observe + inject after). */
  onAgentSettled(): Promise<void>;
}

/** Args the simulator factory binds to the FRESH pi + fresh ctx (inside withSession). */
export interface MakeSimulatorArgs {
  /** The FRESH pi (post-switchSession re-activation) — the inject + listeners target it. */
  readonly pi: ExtensionAPI;
  /** The fresh session ctx (the withSession arg) — reads the branch + resolves the model. */
  readonly ctx: ExtensionCommandContext;
  /** The pacing boundary in tokens (the simulator signals stop as context approaches it). */
  readonly targetContext: number;
  /** The anti-peek-wrapped inject seam (prepends ANTI_PEEK on the FIRST call). */
  readonly inject: (text: string) => void;
  /** Cooperative-abort signal (the run/compaction signal). */
  readonly signal: AbortSignal;
  /** The driver's stop hook — fires on pacing-stop (boundary) or an error. */
  readonly onStop: NonNullable<SimulatorHooks["onStop"]>;
}

/** Injectable operations — the I/O / non-deterministic seams. Defaults are the real
 *  implementations; tests inject fakes. `makeSimulator` defaults to a factory that
 *  builds a real SimulatorDriver bound to the fresh pi + ctx (its live seams wired
 *  from the session ctx + the bench model resolver + the agent-loop runner). */
export interface Phase2Ops {
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  /** Check whether a branch already exists (idempotent re-run skips fork). Injectable
   * so unit tests avoid real git + can exercise the exists-skip path. */
  branchExists: typeof branchExists;
  commit: typeof commitAll;
  awaitSettled: typeof awaitAgentSettled;
  makeMonitor: typeof makeContextMonitor;
  captureTrace: typeof captureTrace;
  /** Construct the continuation driver bound to the fresh pi + ctx. */
  makeSimulator: (args: MakeSimulatorArgs) => ContinuationDriver;
}

/** Inputs to {@link runContinuations}. `cmdCtx` is threaded across attempts like
 *  runPhase1 (each switchSession invalidates the prior ctx; the fresh ctx from each
 *  withSession is threaded into the next attempt's switchSession). */
export interface Phase2Deps {
  /** The command context that starts the loop (the first attempt's switchSession). */
  readonly cmdCtx: ExtensionCommandContext;
  /** Each arm's compacted base (Phase-1 result) — the fork point for its N attempts. */
  readonly armBases: readonly ArmBase[];
  /** The bench config (evaluated model + compaction boundary → pacing target). */
  readonly config: BenchConfig;
  /** The scenario manifest (its description seeds the simulator's system prompt). */
  readonly manifest: ScenarioManifest;
  /** The scenario repo path (holds the branches + session.jsonl + project files). */
  readonly repo: string;
  /** Continuation attempts per arm (the bench's N). */
  readonly N: number;
  /** Run/compaction signal (default = a never-aborting signal). */
  readonly signal?: AbortSignal;
  /** Injectable seams (defaults = real implementations). */
  readonly ops?: Partial<Phase2Ops>;
}

// --- pure helpers ----------------------------------------------------------

/**
 * Build the continuation inject seam: the FIRST inject prepends the anti-peek
 * preamble (the agent sees the forbid-peek instruction before its first tool-bearing
 * turn — zero extra turns); subsequent injects pass the text through unchanged. Every
 * inject lands on the FRESH pi (captured in the closure) as a follow-up user message.
 */
export function makeContinuationInject(pi: ExtensionAPI): (text: string) => void {
  let firstInject = true;
  return (text: string): void => {
    const body = firstInject ? `${ANTI_PEEK_PROMPT}${ANTI_PEEK_SEPARATOR}${text}` : text;
    firstInject = false;
    inject(pi, body, DELIVER_AS_FOLLOW_UP);
  };
}

/**
 * Register a `session_before_compact` → `session_compact` timing pair on the FRESH pi.
 * Each Phase-2 compaction's wall time is measured as the span between those two events
 * (NOT the coarse turn_end → agent_settled span, which over-counts non-compaction work)
 * + keyed by the persisted CompactionEntry id. Returns the wall-time map + a disposer.
 */
export function makeCompactionTimer(pi: ExtensionAPI): { wallMsMap: Map<string, number>; dispose: () => void } {
  const wallMsMap = new Map<string, number>();
  let pendingStart: number | null = null;
  const disposeBefore = pi.events.on("session_before_compact", () => {
    pendingStart = Date.now();
  });
  const disposeAfter = pi.events.on("session_compact", (data: unknown) => {
    const event = data as SessionCompactEvent;
    if (pendingStart === null) return; // no before-compact seen (e.g. a compaction started before the timer armed)
    wallMsMap.set(event.compactionEntry.id, Date.now() - pendingStart);
    pendingStart = null;
  });
  return {
    wallMsMap,
    dispose: () => {
      disposeBefore();
      disposeAfter();
    },
  };
}

/**
 * Build the default simulator factory: a real SimulatorDriver whose live seams are
 * wired to the fresh session ctx (branch + model resolution) + the bench agent-loop
 * runner, using the anti-peek-wrapped inject seam. The system prompt is seeded from
 * the manifest description + the canonical condition topics.
 */
export function createDefaultSimulatorFactory(
  config: BenchConfig,
  manifest: ScenarioManifest,
): (args: MakeSimulatorArgs) => ContinuationDriver {
  return (args: MakeSimulatorArgs): ContinuationDriver => {
    const systemPrompt = buildSimulatorSystemPrompt({
      task: manifest.description,
      conditionTopics: CONDITION_TOPICS,
      targetContext: args.targetContext,
    });
    const seams: SimulatorSeams = {
      getBranch: () => args.ctx.sessionManager.getBranch(),
      resolveModel: (): Promise<ResolvedBenchModel> => resolveBenchModel(args.ctx, config.evaluatedModel),
      runStage: runBenchStage,
      inject: args.inject,
    };
    const hooks: SimulatorHooks = { onStop: args.onStop };
    return new SimulatorDriver({
      seams,
      systemPrompt,
      targetContext: args.targetContext,
      maxTokens: SIMULATOR_MAX_TOKENS,
      signal: args.signal,
      hooks,
    });
  };
}

// --- per-attempt drive helpers (throw Phase2StoppedError on failure/hang) ---

interface DriveStop {
  stopped: boolean;
  reason: StopReason | null;
  error: string | null;
}

/** Run one simulator cycle; throw run-failed if it signaled an error stop. */
async function driveCycle(driver: ContinuationDriver, stop: DriveStop, arm: ArmId, attempt: number): Promise<void> {
  await driver.onAgentSettled();
  if (stop.reason === "error") {
    throw new Phase2StoppedError(
      arm,
      attempt,
      "run-failed",
      `attempt ${attempt} simulator stopped with an error (${stop.error ?? "unknown"})`,
    );
  }
}

/** Await the agent settling; throw run-hung if it rejects (aborted/stalled). */
async function awaitSettle(
  awaitSettled: Phase2Ops["awaitSettled"],
  pi: ExtensionAPI,
  signal: AbortSignal,
  arm: ArmId,
  attempt: number,
): Promise<void> {
  try {
    await awaitSettled(pi, { signal });
  } catch (err) {
    if (err instanceof Phase2StoppedError) throw err;
    const cause =
      err instanceof AgentSettledAbortedError ? "run signal aborted" : err instanceof Error ? err.message : String(err);
    throw new Phase2StoppedError(arm, attempt, "run-hung", `attempt ${attempt} agent did not settle (${cause})`);
  }
}

// --- runContinuations -------------------------------------------------------

/**
 * Run the Phase-2 continuation attempts. For each arm base, for attempt 1..N: fork
 * the base into an attempt branch, checkout, load the session in-place (switchSession
 * re-activates the extension → fresh pi/ctx), drive the simulator until agent_settled
 * (the context monitor steers to wrap up as usage approaches the model's window), then
 * commit + capture the trace. Returns one {@link RunTrace} per attempt.
 *
 * @throws {Phase2StoppedError} on a run failure (simulator error) or hang (no settle).
 */
export async function runContinuations(deps: Phase2Deps): Promise<Phase2Result> {
  const makeSimulator = deps.ops?.makeSimulator ?? createDefaultSimulatorFactory(deps.config, deps.manifest);
  const ops: Phase2Ops = {
    loadSession: deps.ops?.loadSession ?? loadSession,
    fork: deps.ops?.fork ?? forkBranch,
    checkout: deps.ops?.checkout ?? checkout,
    branchExists: deps.ops?.branchExists ?? branchExists,
    commit: deps.ops?.commit ?? commitAll,
    awaitSettled: deps.ops?.awaitSettled ?? awaitAgentSettled,
    makeMonitor: deps.ops?.makeMonitor ?? makeContextMonitor,
    captureTrace: deps.ops?.captureTrace ?? captureTrace,
    makeSimulator,
  };
  const sessionPath = `${deps.repo}/session.jsonl`;
  const signal = deps.signal ?? NEVER_ABORT_CONTROLLER.signal;

  let currentCtx: ExtensionCommandContext = deps.cmdCtx;
  const traces: RunTrace[] = [];
  for (const base of deps.armBases) {
    for (let attempt = 1; attempt <= deps.N; attempt++) {
      // Attempt branch = arm-base branch + the -{attemptN} suffix (single source in branches.ts).
      const attemptBranch = appendAttempt(base.branch, attempt);
      if (!ops.branchExists(deps.repo, attemptBranch)) {
        ops.fork(deps.repo, base.branch, attemptBranch);
      }
      ops.checkout(deps.repo, attemptBranch);
      if (getRunState() !== null) updateRunState({ currentArm: base.arm, currentAttempt: attempt });

      const wallMsMap = await ops.loadSession(currentCtx, sessionPath, async (sessionCtx) => {
        currentCtx = sessionCtx;
        const pi = getBenchPi();
        // Phase-2 per-run budget = the model's resolved window, read live from the
        // switched session's context usage (NOT the Phase-0/1 compactionBoundary, which is
        // strictly below it). Pacing is OWNED by the context monitor (below) — it fires
        // `onApproachingWindow` near the window to set budgetReached + stop further injects.
        // `targetContext` itself feeds only the simulator's qualitative prompt guidance
        // (long vs moderate build); the window value keeps that guidance honest + lets the
        // run reach the natural auto-compactions the trace must capture. Fallback to
        // compactionBoundary only if the window is unavailable (degenerate model).
        const usage = sessionCtx.getContextUsage();
        const window = usage?.contextWindow ?? 0;
        const targetContext = window > 0 ? window : deps.config.compactionBoundary;
        const injectSeam = makeContinuationInject(pi);
        const stop: DriveStop = { stopped: false, reason: null, error: null };
        const onStop: NonNullable<SimulatorHooks["onStop"]> = (info) => {
          stop.stopped = true;
          stop.reason = info.reason;
          stop.error = info.error ?? null;
        };
        const driver = ops.makeSimulator({ pi, ctx: sessionCtx, targetContext, inject: injectSeam, signal, onStop });
        let budgetReached = false;
        const monitor: ContextMonitor = ops.makeMonitor(pi, sessionCtx, {
          onApproachingWindow: () => {
            budgetReached = true;
          },
        });
        const compaction = makeCompactionTimer(pi);
        try {
          // Kick-off: the simulator's first cycle injects the anti-peek-prefixed resume.
          // Note: setAgentQuestion/trackContext are deliberately unwired — the context
          // monitor (budgetReached) owns wrap-up pacing; the agent's own questions are
          // answered by its own reasoning (the simulator never short-circuits to a
          // stop on cycle 1, so the kick-off inject is always followed by a settle).
          await driveCycle(driver, stop, base.arm, attempt);
          // Drive until stop/budget: ALWAYS settle after an inject (even the kick-off),
          // so the agent's response to the last inject is awaited before returning.
          // Stops on a simulator stop, the context budget being reached, or an
          // error/hung (thrown by the helpers). driveCycle throws on a simulator error
          // (run-failed) before any settle, so the error path never reaches this loop.
          while (true) {
            await awaitSettle(ops.awaitSettled, pi, signal, base.arm, attempt);
            if (stop.stopped || budgetReached) break; // wrap up: do not inject past the budget/stop
            await driveCycle(driver, stop, base.arm, attempt);
          }
        } finally {
          monitor.dispose();
          compaction.dispose();
        }
        return compaction.wallMsMap;
      });

      ops.commit(deps.repo, `phase-2: continuation attempt ${attempt} for arm ${base.arm} (${base.tool})`);
      const trace = ops.captureTrace(deps.repo, attemptBranch, wallMsMap);
      traces.push({ ...trace, arm: base.arm, attempt });
      log.info(`phase-2: arm ${base.arm} attempt ${attempt} settled → ${attemptBranch}`);
    }
  }
  return { traces, finalCtx: currentCtx };
}
