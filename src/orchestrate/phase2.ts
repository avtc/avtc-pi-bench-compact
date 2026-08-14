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

import { copyFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { isolateArmOrStop } from "../arms/switch.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { AgentSettledAbortedError, awaitAgentSettled } from "../session/done.js";
import { subscribeAgentEvent } from "../session/events.js";
import { makeAntiPeekInject } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import {
  buildSimulatorDriver,
  driveUntilStop,
  makeDriveStop,
  SIMULATOR_MAX_TOKENS,
  type SimulatorHooks,
} from "../simulator/loop.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { appendAttempt } from "../storage/branches.js";
import { branchSessionFile } from "../storage/paths.js";
import { branchExists, checkout, commitAll, forkBranch } from "../storage/repo.js";
import type { WidgetPort } from "../widget/active-widget.js";
import { widgetStageHooks } from "../widget/tracker.js";
import { getBenchPi } from "./bench-ctx.js";
import { type ContextMonitor, makeContextMonitor } from "./context-monitor.js";
import type { ArmBase } from "./phase1.js";
import { getRunState, updateRunState } from "./run-state.js";
import { captureTrace, type RunTrace } from "./trace.js";

/** A signal that never aborts — the default when the caller threads no run signal. */
const NEVER_ABORT_CONTROLLER = new AbortController();

/** Why a Phase-2 continuation halted (stop-and-surface). */
export type Phase2StopReason = "run-failed" | "run-hung" | "config-failed" | "branch-conflict";

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
  /** The live-progress widget (the factory wires its onEvent + ctx-window). Null/absent → no ctx/tok. */
  readonly widget?: WidgetPort | null;
}

/** Injectable operations — the I/O / non-deterministic seams. Defaults are the real
 *  implementations; tests inject fakes. `makeSimulator` defaults to a factory that
 *  builds a real SimulatorDriver bound to the fresh pi + ctx (its live seams wired
 *  from the session ctx + the bench model resolver + the agent-loop runner). */
export interface Phase2Ops {
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  /** Check whether a branch already exists (foreign-branch conflict detection — a
   *  pre-existing branch with this run's name is a stop-and-surface conflict, never
   *  silently reused). Injectable
   * so unit tests avoid real git + can exercise the exists-skip path. */
  branchExists: typeof branchExists;
  commit: typeof commitAll;
  /** Seed a branch's session file by copying its parent's (parallel to forking the git branch). */
  copySeed: (src: string, dest: string) => void;
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
  /** The scenario repo path (holds the branches; tracks ONLY project files — the session transcript lives in `sessionsDir`). */
  readonly repo: string;
  /** The per-branch session-transcript store (sibling of the repo; agent-invisible). Each
   *  attempt's session file is seeded from its arm base's + appended to by the continuation. */
  readonly sessionsDir: string;
  /** Continuation attempts per arm (the bench's N). */
  readonly N: number;
  /** Run/compaction signal (default = a never-aborting signal). */
  readonly signal?: AbortSignal;
  /** The live-progress widget (TUI-only; null/absent → no-op). */
  readonly widget?: WidgetPort | null;
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
function makeContinuationInject(pi: ExtensionAPI): (text: string) => void {
  return makeAntiPeekInject(pi, ANTI_PEEK_PROMPT);
}

/**
 * Register a `session_before_compact` → `session_compact` timing pair on the FRESH pi.
 * Each Phase-2 compaction's wall time is measured as the span between those two events
 * (NOT the coarse turn_end → agent_settled span, which over-counts non-compaction work)
 * + keyed by the persisted CompactionEntry id. Returns the wall-time map + a disposer.
 */
function makeCompactionTimer(pi: ExtensionAPI): { wallMsMap: Map<string, number>; dispose: () => void } {
  const wallMsMap = new Map<string, number>();
  let pendingStart: number | null = null;
  const disposeBefore = subscribeAgentEvent(pi, "session_before_compact", () => {
    pendingStart = Date.now();
  });
  const disposeAfter = subscribeAgentEvent(pi, "session_compact", (data: unknown) => {
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
  return (args: MakeSimulatorArgs): ContinuationDriver =>
    buildSimulatorDriver({
      pi: args.pi,
      ctx: args.ctx,
      task: manifest.description,
      evaluatedModel: config.evaluatedModel,
      targetContext: args.targetContext,
      maxTokens: SIMULATOR_MAX_TOKENS,
      signal: args.signal,
      inject: args.inject,
      onStop: args.onStop,
      ...widgetStageHooks(args.widget),
    });
}

// --- per-attempt drive helpers (throw Phase2StoppedError on failure/hang) ---

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
    copySeed: deps.ops?.copySeed ?? ((src, dest) => copyFileSync(src, dest)),
    awaitSettled: deps.ops?.awaitSettled ?? awaitAgentSettled,
    makeMonitor: deps.ops?.makeMonitor ?? makeContextMonitor,
    captureTrace: deps.ops?.captureTrace ?? captureTrace,
    makeSimulator,
  };
  const signal = deps.signal ?? NEVER_ABORT_CONTROLLER.signal;

  let currentCtx: ExtensionCommandContext = deps.cmdCtx;
  const traces: RunTrace[] = [];
  for (const base of deps.armBases) {
    const armIdx = deps.armBases.indexOf(base) + 1;
    for (let attempt = 1; attempt <= deps.N; attempt++) {
      deps.widget?.setArm(armIdx, deps.armBases.length, base.tool);
      deps.widget?.setDetail(`${attempt}/${deps.N}`);
      // Attempt branch = arm-base branch + the -{attemptN} suffix (single source in branches.ts).
      const attemptBranch = appendAttempt(base.branch, attempt);
      // A pre-existing attempt branch is a CONFLICT (branch names embed the runId; a
      // fresh run never reuses one within an output root — an existing branch means a
      // prior run derived the same id against this shared scenario repo). Stop+surface:
      // silently re-seeding the session + stacking commits on foreign work would
      // corrupt both runs' traces.
      if (ops.branchExists(deps.repo, attemptBranch)) {
        throw new Phase2StoppedError(
          base.arm,
          attempt,
          "branch-conflict",
          `branch ${attemptBranch} already exists — runId collision with a prior run on this scenario repo. ` +
            `Inspect the repo's bench-compact/* branches or point outputDir at the earlier root.`,
        );
      }
      ops.fork(deps.repo, base.branch, attemptBranch);
      ops.checkout(deps.repo, attemptBranch);
      // Seed this attempt's session file from its arm base's (parallel to forking the
      // git branch): the transcript lives in the sessions store (outside the repo), so
      // each attempt gets its OWN file, appended to by the continuation below.
      const sessionPath = branchSessionFile(deps.sessionsDir, attemptBranch);
      ops.copySeed(branchSessionFile(deps.sessionsDir, base.branch), sessionPath);
      if (getRunState() !== null) updateRunState({ currentArm: base.arm, currentAttempt: attempt });

      const wallMsMap = await ops.loadSession(currentCtx, sessionPath, async (sessionCtx) => {
        currentCtx = sessionCtx;
        const pi = getBenchPi();
        // Re-isolate the arm IN-PLACE (same as Phase-1): switchSession resets the active
        // tool set + the prior arm's memory config may still be live, so re-write THIS arm's
        // config + reload + setActiveTools before driving the continuation. Keeps the
        // measurement phase arm-isolated (the control arm stays bare; memory arms keep their recall tools).
        isolateArmOrStop(
          pi,
          base.arm,
          deps.repo,
          { omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens },
          `arm ${base.arm} attempt ${attempt}`,
          (msg) => new Phase2StoppedError(base.arm, attempt, "config-failed", msg),
        );
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
        const { stop, onStop } = makeDriveStop();
        const driver = ops.makeSimulator({
          pi,
          ctx: sessionCtx,
          targetContext,
          inject: injectSeam,
          signal,
          onStop,
          widget: deps.widget,
        });
        let budgetReached = false;
        const monitor: ContextMonitor = ops.makeMonitor(pi, sessionCtx, {
          onApproachingWindow: () => {
            budgetReached = true;
          },
        });
        const compaction = makeCompactionTimer(pi);
        try {
          // Drive until stop/budget: ALWAYS settle after an inject (even the kick-off),
          // so the agent's response to the last inject is awaited before returning.
          // setAgentQuestion/trackContext are deliberately unwired — the context
          // monitor (budgetReached) owns wrap-up pacing. Stops on a simulator stop, the
          // context budget being reached, or an error/hung (thrown by awaitSettle / the
          // cycle's error-stop). Shared loop helper (same as the Phase 0 build drive).
          await driveUntilStop({
            driver,
            stop,
            awaitSettled: () => awaitSettle(ops.awaitSettled, pi, signal, base.arm, attempt),
            shouldBreak: () => stop.stopped || budgetReached,
            makeCycleError: (error) =>
              new Phase2StoppedError(
                base.arm,
                attempt,
                "run-failed",
                `attempt ${attempt} simulator stopped with an error (${error ?? "unknown"})`,
              ),
          });
        } finally {
          monitor.dispose();
          compaction.dispose();
        }
        return compaction.wallMsMap;
      });

      ops.commit(deps.repo, `phase-2: continuation attempt ${attempt} for arm ${base.arm} (${base.tool})`);
      const trace = ops.captureTrace(sessionPath, attemptBranch, wallMsMap);
      traces.push({ ...trace, arm: base.arm, attempt });
      log.info(`phase-2: arm ${base.arm} attempt ${attempt} settled → ${attemptBranch}`);
    }
  }
  return { traces, finalCtx: currentCtx };
}
