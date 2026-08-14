// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// LIVE BuildSeams wiring: turn the injectable `BuildSeams` contract (driveAndCapture
// / trialCompact / author) into real pi operations bound to a command-handler ctx.
// Used by `/bench-compact:prepare-scenario` (build mode) + the `run <idea>` Phase-0
// entry point. Extract mode reuses trialCompact + author (no driveAndCapture).
//
// ctx-threading contract (load-bearing — same as Phase 1/2): every `switchSession`
// invalidates BOTH the command-handler `pi` AND the ctx it's called on, but its
// `createRuntime` RE-ACTIVATES the extension (`activate(freshPi)` re-stashes the
// fresh pi via bench-ctx). So each seam runs its `switchSession` work INSIDE a
// `withSession` callback (the fresh ctx is the arg; the fresh pi is `getBenchPi()`),
// and threads the fresh ctx into a shared `CtxHolder` so the NEXT seam's
// `switchSession` starts from a valid ctx. Mirrors runPhase1/runContinuations.

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { getMemoryProxies, type MemoryProxies } from "../arms/proxies.js";
import { configureArm } from "../arms/switch.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type AuthoringSeams, runAuthoringAgent } from "../manifest/author.js";
import type { ScenarioContext, ScenarioManifest } from "../manifest/schema.js";
import { getBenchPi } from "../orchestrate/bench-ctx.js";
import { runBenchStage } from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { triggerCompact } from "../session/compact.js";
import { AgentSettledAbortedError, awaitAgentSettled } from "../session/done.js";
import { readMessageEndUsage, subscribeAgentEvent } from "../session/events.js";
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
import type { WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL, widgetStageHooks } from "../widget/tracker.js";
import type { BuildSeams } from "./build.js";
import type { TrialCut } from "./trial-compaction.js";

/** A minimal session-header shape (enough to author a build-session file). */
export interface MinimalSessionHeader {
  readonly type: "session";
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
}

/** Read a file's text contents (injectable seam over `readFileSync`). */
export type ReadText = (path: string) => string;

/** The shared mutable ctx holder threaded across seams (each `switchSession`
 *  invalidates the prior ctx; the fresh ctx from `withSession` replaces it here). */
export interface CtxHolder {
  current: ExtensionCommandContext;
}

/** The session-entry type discriminator written into a session JSONL header. */
const SESSION_HEADER_TYPE = "session";
/** Line terminator used when serializing session JSONL entries. */
const JSONL_NEWLINE = "\n";

/** Build a minimal valid session header (the first JSONL line of a session file)
 *  with `cwd` set to the scenario repo (so `switchSession` lands the agent there). */
export function buildSessionHeader(input: { repoPath: string; id: string; timestamp: string }): MinimalSessionHeader {
  return { type: SESSION_HEADER_TYPE, id: input.id, timestamp: input.timestamp, cwd: input.repoPath };
}

/** Serialize a session header as a single JSONL line (with trailing newline). */
export function serializeSessionFile(header: MinimalSessionHeader): string {
  return `${JSON.stringify(header)}${JSONL_NEWLINE}`;
}

/** Read a session JSONL's entries (EXCLUDING the header), mapped to `{id}`.
 *  Blank lines are ignored. Used to return `backupEntries` from `driveAndCapture`. */
export function readBackupEntries(jsonlPath: string, deps: { read: ReadText }): readonly { id: string }[] {
  const text = deps.read(jsonlPath);
  const entries: { id: string }[] = [];
  for (const line of text.split(JSONL_NEWLINE)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = JSON.parse(trimmed) as { type?: string; id?: string };
    if (entry.type === SESSION_HEADER_TYPE) continue;
    if (entry.id === undefined) continue;
    entries.push({ id: entry.id });
  }
  return entries;
}

// --- author seam (26b) -----------------------------------------------------

/** Model-resolution seam (injectable for testing; default = resolveBenchModel). */
export type ResolveModel = (ctx: ExtensionContext, modelSetting: string | null) => Promise<ResolvedBenchModel>;
/** Stage-runner seam (injectable for testing; default = runBenchStage). */
export type RunStage = typeof runBenchStage;
/** Authoring-agent runner seam (injectable for testing; default = runAuthoringAgent). */
export type RunAuthor = typeof runAuthoringAgent;

/** Inputs to {@link buildAuthorSeam}. The `ctxGetter` reads the live (fresh) ctx —
 *  after a `switchSession` the command-handler ctx is stale, so the caller threads a
 *  getter returning the holder's current (fresh) ctx for model-registry resolution. */
export interface AuthorSeamDeps {
  readonly ctxGetter: () => ExtensionContext;
  /** The evaluated model (`provider/id`) the authoring agent runs on (null = session default). */
  readonly evaluatedModel: string | null;
  /** Harness-authoritative scenario context (id/description/boundary) merged into the manifest. */
  readonly scenarioCtx: ScenarioContext;
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  readonly rateLimitOptions?: RateLimitOptions | null;
  /** Injectable (default = resolveBenchModel). */
  readonly resolveModel?: ResolveModel;
  /** Injectable (default = runBenchStage). */
  readonly runStage?: RunStage;
  /** Injectable (default = runAuthoringAgent). */
  readonly runAuthor?: RunAuthor;
  /** The live-progress widget (the author seam advances to the 'extract' cell + wires the authoring agent's ctx/tok). */
  readonly widget?: WidgetPort | null;
}

/** Per-call output-token cap for the authoring agent's stage calls. */
const AUTHOR_MAX_TOKENS = 8192;

/** Build the `author` seam: run the manifest-authoring agent on the pre-sliced JSONL.
 *  The authoring tools' cwd is the JSONL's directory (so the file is within tool scope). */
export function buildAuthorSeam(deps: AuthorSeamDeps): BuildSeams["author"] {
  const resolve = deps.resolveModel ?? resolveBenchModel;
  const runStage = deps.runStage ?? runBenchStage;
  const runAuthor = deps.runAuthor ?? runAuthoringAgent;
  return async (preSlicedJsonlPath: string): Promise<ScenarioManifest> => {
    deps.widget?.startPhase("extract", NO_DETAIL);
    const hooks = widgetStageHooks(deps.widget);
    const seams: AuthoringSeams = {
      resolveModel: () => resolve(deps.ctxGetter(), deps.evaluatedModel),
      runStage,
      onEvent: hooks?.onEvent,
      onModelResolved: hooks?.onModelResolved,
    };
    return runAuthor({
      seams,
      cwd: dirname(preSlicedJsonlPath),
      preSlicedJsonlPath,
      scenarioCtx: deps.scenarioCtx,
      signal: deps.signal,
      maxTokens: deps.maxTokens,
      rateLimitOptions: deps.rateLimitOptions,
    });
  };
}

// --- trialCompact seam (26c) -----------------------------------------------

/** The bare-pi arm — used to disable memory hooks for a NATIVE trial compaction
 *  (the trial finds where pi's native cut lands, not a memory arm's cut). */
const TRIAL_ARM: ArmId = "A1";

/** The configureArm operation type (named for type-only import in tests). */
export type ConfigureArmOp = typeof configureArm;
/** The triggerCompact operation type (named for type-only import in tests). */
export type TriggerCompactOp = typeof triggerCompact;

/** Disable the memory arms' hooks (configure the bare-pi arm) so the next compaction
 *  or build drive is NATIVE (no om or memkeeper custom entries). No-op when no memory
 *  proxies are live (the hooks aren't loaded → already native). Shared by the trial
 *  compaction (native cut) + the build drive (raw backup). */
function disableMemoryHooks(
  pi: ExtensionAPI,
  proxies: MemoryProxies | null,
  repoCwd: string,
  threshold: number,
  configure: ConfigureArmOp,
): void {
  if (proxies === null) return;
  configure(pi, proxies.om, proxies.mk, TRIAL_ARM, repoCwd, { omFullReflectionThresholdTokens: threshold });
}

/** Injectable ops for {@link buildTrialCompactSeam} (defaults = real implementations). */
export interface TrialCompactSeamDeps {
  readonly holder: CtxHolder;
  readonly repoCwd: string;
  readonly omFullReflectionThresholdTokens: number;
  /** Where to write the trial copy (must be OUTSIDE the repo — contamination rule). */
  readonly trialCopyPath: string;
  readonly copyFile?: (src: string, dest: string) => void;
  readonly loadSession?: typeof loadSession;
  readonly triggerCompact?: TriggerCompactOp;
  readonly configureArm?: ConfigureArmOp;
  readonly getPi?: () => ExtensionAPI;
  readonly getProxies?: () => MemoryProxies | null;
}

/** Build the `trialCompact` seam: copy the backup → load the copy → disable memory
 *  (configure the bare-pi arm so the hook is a no-op) → compact natively → read the
 *  cut. Memory is disabled only when the memory-extension proxies are live (when they
 *  are absent there are no hooks to disable — the cut is already native). The fresh
 *  ctx from the copy's `withSession` is threaded into `holder.current`. */
export function buildTrialCompactSeam(deps: TrialCompactSeamDeps): BuildSeams["trialCompact"] {
  const copyFile = deps.copyFile ?? copyFileSync;
  const load = deps.loadSession ?? loadSession;
  const trigger = deps.triggerCompact ?? triggerCompact;
  const configure = deps.configureArm ?? configureArm;
  const getPi =
    deps.getPi ??
    (() => {
      throw new Error("trialCompact: no pi getter wired (buildTrialCompactSeam default requires getPi)");
    });
  const getProxies = deps.getProxies ?? (() => null);
  return async (backupPath: string): Promise<TrialCut> => {
    copyFile(backupPath, deps.trialCopyPath);
    const { compactionEntry } = await load(deps.holder.current, deps.trialCopyPath, async (sessionCtx) => {
      deps.holder.current = sessionCtx;
      const pi = getPi();
      // Disable the memory arms' hooks so this compaction is NATIVE (bare-pi cut).
      disableMemoryHooks(pi, getProxies(), deps.repoCwd, deps.omFullReflectionThresholdTokens, configure);
      return trigger(pi, sessionCtx, {});
    });
    return { firstKeptEntryId: compactionEntry.firstKeptEntryId, summary: compactionEntry.summary };
  };
}

// --- driveAndCapture seam (26d) --------------------------------------------

/** The drive loop's driver surface: run a simulator cycle + accept context tracking. */
export interface BuildDriver {
  onAgentSettled(): Promise<void>;
  trackContext(totalTokens: number): void;
}

/** Args the build-simulator factory binds to the FRESH pi + fresh ctx (inside withSession). */
interface MakeBuildSimulatorArgs {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionCommandContext;
  readonly targetContext: number;
  readonly signal: AbortSignal;
  readonly onStop: NonNullable<SimulatorHooks["onStop"]>;
  /** The live-progress widget (the factory wires its onEvent + ctx-window for build ctx/tok). */
  readonly widget?: WidgetPort | null;
}

/** Tokens added to the pacing target per continue attempt (so a tail-condition
 *  re-drive injects more, sliding the native cut forward into the compacted-away span). */
const CONTINUE_STEP_TOKENS = 20000;

/** Injectable ops for {@link buildDriveAndCaptureSeam} (defaults = real implementations). */
export interface DriveAndCaptureSeamDeps {
  readonly holder: CtxHolder;
  readonly repoPath: string;
  /** Stable path for the build session JSONL (persists + grows across continue attempts). */
  readonly buildSessionPath: string;
  readonly compactionBoundary: number;
  readonly scenarioDescription: string;
  readonly evaluatedModel: string | null;
  /** OM-full threshold for disabling memory during the build drive (raw backup). */
  readonly omFullReflectionThresholdTokens: number;
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  /** Tokens added to the pacing target per continue attempt (default {@link CONTINUE_STEP_TOKENS}). */
  readonly continueStep?: number;
  readonly exists?: (path: string) => boolean;
  readonly writeHeader?: (path: string, header: MinimalSessionHeader) => void;
  readonly loadSession?: typeof loadSession;
  readonly awaitSettled?: typeof awaitAgentSettled;
  readonly makeSimulator?: (args: MakeBuildSimulatorArgs) => BuildDriver;
  readonly getPi?: () => ExtensionAPI;
  /** The live-progress widget (advances to the 'build' cell + wires the user-simulator's ctx/tok). */
  readonly widget?: WidgetPort | null;
  readonly getProxies?: () => MemoryProxies | null;
  readonly configureArm?: ConfigureArmOp;
  readonly read?: ReadText;
}

/** Ensure the build-session file exists: write a minimal header (cwd=repo) when absent. */
function ensureBuildSession(
  path: string,
  repoPath: string,
  deps: { exists: (p: string) => boolean; writeHeader: (p: string, h: MinimalSessionHeader) => void },
): void {
  if (deps.exists(path)) return;
  deps.writeHeader(path, buildSessionHeader({ repoPath, id: randomUUID(), timestamp: new Date().toISOString() }));
}

/** The default build-simulator factory: a real SimulatorDriver whose live seams are
 *  wired to the fresh session ctx (branch + model resolution) + the bench agent-loop
 *  runner, using the anti-peek-wrapped inject seam. Delegates the driver construction
 *  to the shared {@link buildSimulatorDriver} (same as Phase 2). */
function createDefaultBuildSimulatorFactory(deps: {
  evaluatedModel: string | null;
  scenarioDescription: string;
  maxTokens: number;
  antiPeekPrompt: string;
}): (args: MakeBuildSimulatorArgs) => BuildDriver {
  return (args: MakeBuildSimulatorArgs): BuildDriver =>
    buildSimulatorDriver({
      pi: args.pi,
      ctx: args.ctx,
      task: deps.scenarioDescription,
      evaluatedModel: deps.evaluatedModel,
      targetContext: args.targetContext,
      maxTokens: deps.maxTokens,
      signal: args.signal,
      inject: makeAntiPeekInject(args.pi, deps.antiPeekPrompt),
      onStop: args.onStop,
      ...widgetStageHooks(args.widget),
    });
}

/** Build the `driveAndCapture` seam: ensure the build-session file exists, load it,
 *  drive the user-simulator until the boundary, then capture the session's entries. */
export function buildDriveAndCaptureSeam(deps: DriveAndCaptureSeamDeps): BuildSeams["driveAndCapture"] {
  const exists = deps.exists ?? existsSync;
  const writeHeader = deps.writeHeader ?? ((path, header) => writeFileSync(path, serializeSessionFile(header)));
  const load = deps.loadSession ?? loadSession;
  const awaitSettledFn = deps.awaitSettled ?? awaitAgentSettled;
  const read = deps.read ?? ((path: string) => readFileSync(path, "utf8"));
  const getPi =
    deps.getPi ??
    (() => {
      throw new Error("driveAndCapture: no pi getter wired (buildDriveAndCaptureSeam default requires getPi)");
    });
  const makeSimulator =
    deps.makeSimulator ??
    createDefaultBuildSimulatorFactory({
      evaluatedModel: deps.evaluatedModel,
      scenarioDescription: deps.scenarioDescription,
      maxTokens: deps.maxTokens,
      antiPeekPrompt: ANTI_PEEK_PROMPT,
    });
  const getProxies = deps.getProxies ?? (() => null);
  const configure = deps.configureArm ?? configureArm;
  const continueStep = deps.continueStep ?? CONTINUE_STEP_TOKENS;

  return async (attempt: number) => {
    ensureBuildSession(deps.buildSessionPath, deps.repoPath, { exists, writeHeader });
    const targetContext = deps.compactionBoundary + attempt * continueStep;
    await load(deps.holder.current, deps.buildSessionPath, async (sessionCtx) => {
      deps.holder.current = sessionCtx;
      const pi = getPi();
      deps.widget?.startPhase("build", NO_DETAIL);
      // Disable the memory arms' hooks BEFORE driving so the build session stays raw
      // (no om.*/memkeeper.* entries) — the backup is the pre-compaction input every arm
      // compacts. Done once per load (idempotent); skipped when no memory proxies are live.
      disableMemoryHooks(pi, getProxies(), deps.repoPath, deps.omFullReflectionThresholdTokens, configure);
      const { stop, onStop } = makeDriveStop();
      const driver = makeSimulator({
        pi,
        ctx: sessionCtx,
        targetContext,
        signal: deps.signal,
        onStop,
        widget: deps.widget,
      });
      // Seed the driver with the session's current context (so a continue attempt paces
      // correctly against the already-grown session, not a fresh zero).
      const usage = sessionCtx.getContextUsage();
      if (usage?.tokens !== undefined && usage.tokens !== null) driver.trackContext(usage.tokens);
      const disposeMsgEnd = subscribeAgentEvent(pi, "message_end", (event: unknown) => {
        const parsed = readMessageEndUsage(event as MessageEndEvent);
        if (parsed !== null) driver.trackContext(parsed.totalTokens);
      });
      try {
        // Drive until boundary-stop: ALWAYS settle after an inject (even the kick-off),
        // so the agent's response to the last inject is awaited before capturing. Shared
        // loop helper (same as Phase 2 continuation). An error-stop or settle-failure
        // throws (surfaced by the prepare handler).
        await driveUntilStop({
          driver,
          stop,
          awaitSettled: async () => {
            try {
              await awaitSettledFn(pi, { signal: deps.signal });
            } catch (err) {
              const cause =
                err instanceof AgentSettledAbortedError
                  ? "run signal aborted"
                  : err instanceof Error
                    ? err.message
                    : String(err);
              throw new Error(`build driveAndCapture(attempt ${attempt}) agent did not settle (${cause})`);
            }
          },
          shouldBreak: () => stop.stopped,
          makeCycleError: (error) =>
            new Error(
              `build driveAndCapture(attempt ${attempt}) simulator stopped with an error (${error ?? "unknown"})`,
            ),
        });
      } finally {
        disposeMsgEnd();
      }
    });
    const backupEntries = readBackupEntries(deps.buildSessionPath, { read });
    return { backupPath: deps.buildSessionPath, backupEntries };
  };
}

// --- assembly (26e) --------------------------------------------------------
/** Filename for the trial-compaction copy (under preSliceDir, OUTSIDE the repo). */
const TRIAL_COPY_NAME = "trial-copy.jsonl";
/** Filename for the stable build session (under preSliceDir, OUTSIDE the repo). */
const BUILD_SESSION_NAME = "build.jsonl";

/** Inputs to {@link buildLiveSeams}. The caller computes paths + the scenario identity;
 *  this assembles the three seams bound to a shared `CtxHolder` (threaded across seams). */
export interface BuildLiveSeamsArgs {
  /** The command-handler ctx that starts the loop (the first `switchSession`). */
  readonly cmdCtx: ExtensionCommandContext;
  readonly config: BenchConfig;
  readonly repoPath: string;
  /** Directory for the build session + trial copy (MUST be outside the repo). */
  readonly preSliceDir: string;
  readonly scenarioId: string;
  /** The scenario brief (build-mode idea, or a label for extract). Seeds the simulator + manifest. */
  readonly scenarioDescription: string;
  /** The manifest's compaction-boundary plan tag ("build" | "extract"). */
  readonly compactionPlan: string;
  /** The live-progress widget (build/extract ctx/tok + phase cells). Null/absent → no widget. */
  readonly widget?: WidgetPort | null;
  readonly signal: AbortSignal;
}

/** Assemble the three live `BuildSeams` bound to a shared `CtxHolder` + the fresh-pi /
 *  memory-proxy getters. Each seam threads the fresh ctx into the holder so the next
 *  seam's `switchSession` starts from a valid ctx (every switchSession invalidates the
 *  prior ctx). Extract mode reuses only `trialCompact` + `author` (driveAndCapture unused). */
export function buildLiveSeams(args: BuildLiveSeamsArgs): BuildSeams {
  const holder: CtxHolder = { current: args.cmdCtx };
  const scenarioCtx: ScenarioContext = {
    id: args.scenarioId,
    description: args.scenarioDescription,
    compactionBoundary: { phaseATokenBudget: args.config.compactionBoundary, plan: args.compactionPlan },
  };
  const author = buildAuthorSeam({
    ctxGetter: () => holder.current,
    evaluatedModel: args.config.evaluatedModel,
    scenarioCtx,
    widget: args.widget,
    signal: args.signal,
    maxTokens: AUTHOR_MAX_TOKENS,
  });
  const trialCompact = buildTrialCompactSeam({
    holder,
    repoCwd: args.repoPath,
    omFullReflectionThresholdTokens: args.config.omFullReflectionThresholdTokens,
    trialCopyPath: join(args.preSliceDir, TRIAL_COPY_NAME),
    getPi: getBenchPi,
    getProxies: getMemoryProxies,
  });
  const driveAndCapture = buildDriveAndCaptureSeam({
    holder,
    repoPath: args.repoPath,
    buildSessionPath: join(args.preSliceDir, BUILD_SESSION_NAME),
    compactionBoundary: args.config.compactionBoundary,
    scenarioDescription: args.scenarioDescription,
    evaluatedModel: args.config.evaluatedModel,
    omFullReflectionThresholdTokens: args.config.omFullReflectionThresholdTokens,
    signal: args.signal,
    maxTokens: SIMULATOR_MAX_TOKENS,
    getPi: getBenchPi,
    getProxies: getMemoryProxies,
    widget: args.widget,
  });
  return { driveAndCapture, trialCompact, author };
}
