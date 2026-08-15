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
import { log } from "../log.js";
import { type AuthoringSeams, runAuthoringAgent } from "../manifest/author.js";
import type { ScenarioContext, ScenarioManifest } from "../manifest/schema.js";
import { getBenchPi } from "../orchestrate/bench-ctx.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  runBenchStage,
} from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { triggerCompact } from "../session/compact.js";
import {
  AgentSettledAbortedError,
  type AwaitSettledOptions,
  awaitAgentSettled,
  withStallWatch,
} from "../session/done.js";
import { readMessageEndUsage, subscribeAgentEvent } from "../session/events.js";
import { makeAntiPeekInjectFactory } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import {
  buildSimulatorDriver,
  driveUntilStop,
  extractAssistantText,
  makeDriveStop,
  SIMULATOR_MAX_TOKENS,
  type SimulatorHooks,
} from "../simulator/loop.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import type { WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL, widgetStageHooks } from "../widget/tracker.js";
import type { BuildResume, BuildSeams } from "./build.js";
import { parseTailCheckResponse, renderTailText, TAIL_CHECK_SYSTEM_PROMPT } from "./tail-check.js";
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
export function readBackupEntries(
  jsonlPath: string,
  deps: { read: ReadText },
): readonly { id: string; type?: string }[] {
  const text = deps.read(jsonlPath);
  const entries: { id: string; type?: string }[] = [];
  for (const line of text.split(JSONL_NEWLINE)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = JSON.parse(trimmed) as { type?: string; id?: string };
    if (entry.type === SESSION_HEADER_TYPE) continue;
    if (entry.id === undefined) continue;
    entries.push(entry.type === undefined ? { id: entry.id } : { id: entry.id, type: entry.type });
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
    const manifest = await runAuthor({
      seams,
      cwd: dirname(preSlicedJsonlPath),
      preSlicedJsonlPath,
      scenarioCtx: deps.scenarioCtx,
      signal: deps.signal,
      maxTokens: deps.maxTokens,
      rateLimitOptions: deps.rateLimitOptions,
    });
    log.info(
      `prepare: manifest authored — ${manifest.recallFacts.length} recallFacts, ` +
        `${manifest.doneOps.length} doneOps, ${manifest.supersessions.length} supersessions, ` +
        `${manifest.probes.length} probes`,
    );
    return manifest;
  };
}

// --- tail-check seam -------------------------------------------------------

/** Per-call output-token cap for the tail check (the reply is a tiny JSON object). */
const TAIL_CHECK_MAX_TOKENS = 512;
/** Per-turn wall-clock cap for the tail-check stage call. */
const TAIL_CHECK_TIMEOUT_MS = 120_000;
/** Single-turn, no-tool stage (the reply IS the answer). */
const SINGLE_TURN = 1;

/** Inputs to {@link buildTailCheckSeam} (mirrors the author seam's threading). */
export interface TailCheckSeamDeps {
  readonly ctxGetter: () => ExtensionContext;
  /** The evaluated model the check runs on (null = session default). */
  readonly evaluatedModel: string | null;
  readonly signal: AbortSignal;
  /** Injectable (default = resolveBenchModel). */
  readonly resolveModel?: ResolveModel;
  /** Injectable (default = runBenchStage). */
  readonly runStage?: RunStage;
  /** Injectable file reader (default = fs readFileSync utf-8). */
  readonly read?: ReadText;
  /** The live-progress widget (build-phase ctx/tok for the check call). */
  readonly widget?: WidgetPort | null;
}

/** Read the raw backup entries (header skipped) — the tail check needs full message
 *  bodies, not just ids. Pure parse; throws on malformed JSONL lines. */
export function readRawBackupEntries(jsonlPath: string, deps: { read: ReadText }): unknown[] {
  const text = deps.read(jsonlPath);
  const entries: unknown[] = [];
  for (const line of text.split(JSONL_NEWLINE)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = JSON.parse(trimmed) as { type?: string };
    if (entry.type === SESSION_HEADER_TYPE) continue;
    entries.push(entry);
  }
  return entries;
}

/** Slice the KEPT TAIL: entries at/after `firstKeptEntryId` in file order (the same
 *  boundary classifyLanding treats as the tail). Unknown cut id → empty tail (nothing
 *  provably in-tail). */
export function sliceKeptTail(entries: readonly unknown[], firstKeptEntryId: string): readonly unknown[] {
  const cut = entries.findIndex((e) => (e as { id?: string }).id === firstKeptEntryId);
  if (cut === -1) return [];
  return entries.slice(cut);
}

/** Build the `findTailContent` seam: render the kept tail + one single-call kind-level
 *  presence check. Malformed replies are conservative (empty set → surface), model/
 *  transport failures propagate (stop-and-surface). */
export function buildTailCheckSeam(deps: TailCheckSeamDeps): NonNullable<BuildSeams["findTailContent"]> {
  const resolve = deps.resolveModel ?? resolveBenchModel;
  const runStage = deps.runStage ?? runBenchStage;
  const hooks = widgetStageHooks(deps.widget);
  return async (backupPath: string, firstKeptEntryId: string): Promise<ReadonlySet<string>> => {
    const raw = readRawBackupEntries(backupPath, { read: deps.read ?? ((p) => readFileSync(p, "utf-8")) });
    const tailText = renderTailText(sliceKeptTail(raw, firstKeptEntryId));
    const resolved = await resolve(deps.ctxGetter(), deps.evaluatedModel);
    if (!resolved.ok) throw new Error(`tail check model not available: ${resolved.error}`);
    hooks?.onModelResolved(resolved.model);
    const result = await runStage({
      systemPrompt: TAIL_CHECK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: tailText, timestamp: Date.now() }],
      tools: [],
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal: deps.signal,
      reasoning: NO_REASONING,
      maxTurns: SINGLE_TURN,
      maxTokens: TAIL_CHECK_MAX_TOKENS,
      timeoutMs: TAIL_CHECK_TIMEOUT_MS,
      onEvent: hooks?.onEvent ?? NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: NO_LOOP_OVERRIDE,
    });
    return parseTailCheckResponse(extractAssistantText(result.messages));
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
    log.info(
      `prepare: trial compaction cut at ${compactionEntry.firstKeptEntryId}` +
        (compactionEntry.tokensBefore !== undefined ? ` (${compactionEntry.tokensBefore} tokens before)` : ""),
    );
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
  /** Plant-resume: the drive's first-cycle harness instruction override. */
  readonly firstInstruction?: string;
  /** The live-progress widget (the factory wires its onEvent + ctx-window for build ctx/tok). */
  readonly widget?: WidgetPort | null;
}

/** Tokens added to the pacing target per continue attempt (so a tail-condition
 *  re-drive injects more, sliding the native cut forward into the compacted-away span). */
const CONTINUE_STEP_TOKENS = 20000;
/** Settle-wait budget before the drive declares a stall (stop-and-surface). */
const STALL_TIMEOUT_MS = 60 * 60 * 1000;

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
  /** Plant-and-continue recovery: when the drive runs THIS attempt, the simulator's
   *  first cycle gets the plant instruction (steering the missing topics in). */
  readonly plant?: { readonly attempt: number; readonly instruction: string };
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
  // ONE anti-peek flag for the whole build session (created once per factory, which
  // lives for the seam): the build session is never compacted, so the preamble from
  // the first inject stays in the agent's context across continue attempts — arming
  // a fresh injector per attempt would duplicate the preamble in the transcript.
  // Each attempt still binds its own fresh pi (a new injector per load, shared flag).
  const injector = makeAntiPeekInjectFactory(deps.antiPeekPrompt);
  return (args: MakeBuildSimulatorArgs): BuildDriver =>
    buildSimulatorDriver({
      pi: args.pi,
      ctx: args.ctx,
      task: deps.scenarioDescription,
      evaluatedModel: deps.evaluatedModel,
      targetContext: args.targetContext,
      maxTokens: deps.maxTokens,
      signal: args.signal,
      inject: injector(args.pi),
      onStop: args.onStop,
      firstInstruction: args.firstInstruction,
      ...widgetStageHooks(args.widget),
    });
}

/** Build the `driveAndCapture` seam: ensure the build-session file exists, load it,
 *  drive the user-simulator until the boundary, then capture the session's entries. */
/** Mirror of pi's default compaction reserve: pi auto-compacts when
 *  `contextTokens > contextWindow − reserveTokens` (settings-manager default 16384).
 *  The build drive MUST stop below that line or pi's NATIVE auto-compaction fires
 *  mid-drive, which voids the backup's pre-compaction guarantee (fatal for the scenario). */
const AUTO_COMPACT_RESERVE_TOKENS = 16384;
/** Headroom under the auto-compaction line for one marathon tool-looping turn: the
 *  mid-turn tripwire checks per assistant message, but a single long turn can add
 *  tens of thousands of tokens between checks (observed: +76K in one 28-minute turn). */
const TURN_HEADROOM_TOKENS = 30000;

/** Error thrown when pi's native auto-compaction fires during the build drive (or is
 *  found in the captured backup): the build session then contains a compaction, so
 *  it is unusable as the pre-compaction input every arm forks + compacts. */
class BuildAutoCompactedError extends Error {
  constructor(attempt: number) {
    super(
      `native auto-compaction fired during the build drive (attempt ${attempt}) — the build session is no longer pre-compaction and cannot back a scenario. ` +
        "Lower the compactionBoundary setting (or reduce the work-order size) and re-prepare with --force",
    );
    this.name = "BuildAutoCompactedError";
  }
}

export function buildDriveAndCaptureSeam(deps: DriveAndCaptureSeamDeps): BuildSeams["driveAndCapture"] {
  const exists = deps.exists ?? existsSync;
  const writeHeader = deps.writeHeader ?? ((path, header) => writeFileSync(path, serializeSessionFile(header)));
  const load = deps.loadSession ?? loadSession;
  const awaitSettledRaw = deps.awaitSettled ?? awaitAgentSettled;
  // Stall watchdog: a wedged LLM request (or a hung turn) must surface, not block
  // the drive forever. Generous budget — marathon tool-looping turns run 45+ min.
  const awaitSettledFn = (pi: ExtensionAPI, options: AwaitSettledOptions | null): Promise<void> =>
    withStallWatch((opts) => awaitSettledRaw(pi, opts), STALL_TIMEOUT_MS, "build drive")(options);
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
    const formulaTarget = deps.compactionBoundary + attempt * continueStep;
    let autoCompacted = false;
    await load(deps.holder.current, deps.buildSessionPath, async (sessionCtx) => {
      deps.holder.current = sessionCtx;
      const pi = getPi();
      deps.widget?.startPhase("build", NO_DETAIL);
      // Disable the memory arms' hooks BEFORE driving so the build session stays raw
      // (no om.*/memkeeper.* entries) — the backup is the pre-compaction input every arm
      // compacts. Done once per load (idempotent); skipped when no memory proxies are live.
      disableMemoryHooks(pi, getProxies(), deps.repoPath, deps.omFullReflectionThresholdTokens, configure);
      const { stop, onStop } = makeDriveStop();
      // Read the session's current context BEFORE constructing the driver: a resumed
      // (plant) or continued session may have OVERSHOT its formula target by more
      // than one continue-step (a large last turn grows >20K past it), which would
      // pace-stop before the plant/continue instruction is ever consulted. Pace
      // against actual usage — the target always leaves one continue-step of headroom.
      const usage = sessionCtx.getContextUsage();
      const seededTokens = usage?.tokens;
      let targetContext =
        seededTokens === undefined || seededTokens === null
          ? formulaTarget
          : Math.max(formulaTarget, seededTokens + continueStep);
      // Clamp the target BELOW pi's native auto-compaction line (window − reserve −
      // marathon-turn headroom): crossing that line mid-drive makes pi auto-compact the
      // build session itself — the backup must stay never-compacted.
      const contextWindow = usage?.contextWindow;
      if (contextWindow !== undefined && contextWindow > 0) {
        const ceiling = contextWindow - AUTO_COMPACT_RESERVE_TOKENS - TURN_HEADROOM_TOKENS;
        if (targetContext > ceiling) {
          log.warn(
            `prepare: attempt ${attempt} target ~${Math.round(targetContext / 1000)}k clamped to ~${Math.round(ceiling / 1000)}k — stays under the native auto-compaction line`,
          );
          targetContext = ceiling;
        }
      }
      log.info(
        `prepare: attempt ${attempt} build drive — target ~${Math.round(targetContext / 1000)}k tokens` +
          (seededTokens !== undefined && seededTokens !== null
            ? ` (session already at ~${Math.round(seededTokens / 1000)}k)`
            : ""),
      );
      // Mid-turn tripwire state: pacing normally fires at agent-settle, but a single
      // marathon tool-looping turn can blow PAST the target (and into pi's native
      // auto-compaction) with no settle in between — observed as one 28-minute turn
      // growing +76K tokens. The message_end tracker below aborts the in-flight turn
      // the moment tracked context crosses the target.
      let boundaryAbortInitiated = false;
      const driver = makeSimulator({
        pi,
        ctx: sessionCtx,
        targetContext,
        signal: deps.signal,
        onStop,
        firstInstruction:
          deps.plant !== undefined && deps.plant.attempt === attempt ? deps.plant.instruction : undefined,
        widget: deps.widget,
      });
      // Seed the driver with the session's current context (so a continue attempt paces
      // correctly against the already-grown session, not a fresh zero).
      if (seededTokens !== undefined && seededTokens !== null) driver.trackContext(seededTokens);
      const disposeMsgEnd = subscribeAgentEvent(pi, "message_end", (event: unknown) => {
        const parsed = readMessageEndUsage(event as MessageEndEvent);
        if (parsed === null) return;
        driver.trackContext(parsed.totalTokens);
        // Mid-turn boundary tripwire: abort the in-flight turn as soon as the tracked
        // context crosses the target (a marathon turn must not run on into pi's native
        // auto-compaction territory). The abort ends the turn; agent_settled still fires;
        // the drive loop then sees stop.stopped and breaks cleanly.
        if (!stop.stopped && !boundaryAbortInitiated && parsed.totalTokens >= targetContext) {
          boundaryAbortInitiated = true;
          log.info(
            `prepare: attempt ${attempt} crossed the target mid-turn (~${Math.round(parsed.totalTokens / 1000)}k) — aborting the in-flight turn`,
          );
          onStop({ contextTokens: parsed.totalTokens, reason: "boundary" });
          try {
            sessionCtx.abort();
          } catch (err) {
            log.warn(`prepare: mid-turn boundary abort failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }
      });
      // Native auto-compaction tripwire: ANY session_compact during the drive (memory
      // hooks are disabled, so nothing legitimate compacts) means pi auto-compacted the
      // build session — the backup is invalid. Detect immediately, stop, and surface.
      const disposeCompact = subscribeAgentEvent(pi, "session_compact", (event: unknown) => {
        const abortedFlag = (event as { aborted?: boolean } | null)?.aborted === true;
        if (!abortedFlag) {
          autoCompacted = true;
          log.error(`native auto-compaction fired during the build drive (attempt ${attempt})`);
          onStop({ contextTokens: 0, reason: "error", error: "native auto-compaction" });
          try {
            sessionCtx.abort();
          } catch {
            // best effort — the post-capture guard below still catches it
          }
        }
      });
      try {
        // Drive until boundary-stop: ALWAYS settle after an inject (even the kick-off),
        // so the agent's response to the last inject is awaited before capturing. Shared
        // loop helper (same as Phase 2 continuation). An error-stop or settle-failure
        // throws (surfaced by the prepare handler).
        try {
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
        } catch (err) {
          // The auto-compaction tripwire aborts via an error-stop — surface the
          // DISTINCT cause (the backup is invalid), not the generic cycle error.
          if (autoCompacted) throw new BuildAutoCompactedError(attempt);
          throw err;
        }
      } finally {
        disposeMsgEnd();
        disposeCompact();
      }
    });
    const backupEntries = readBackupEntries(deps.buildSessionPath, { read });
    if (autoCompacted || backupEntries.some((e) => e.type === "compaction")) {
      // Defense in depth: the live tripwire should have caught it, but the captured
      // entries are the ground truth — any compaction entry means the backup is unusable.
      throw new BuildAutoCompactedError(attempt);
    }
    log.info(`prepare: attempt ${attempt} drive captured ${backupEntries.length} entries`);
    return { backupPath: deps.buildSessionPath, backupEntries };
  };
}

// --- assembly (26e) --------------------------------------------------------
/** Filename for the trial-compaction copy (under preSliceDir, OUTSIDE the repo). */
const TRIAL_COPY_NAME = "trial-copy.jsonl";
/** Filename for the stable build session (under preSliceDir, OUTSIDE the repo). */
/** The stable build-session file name (persists + grows across attempts + prepares). */
export const BUILD_SESSION_NAME = "build.jsonl";

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
  /** Plant-and-continue recovery (`--plant`): the failed prepare's attempt + the plant
   *  steering instruction. Drives the build loop from that attempt with the plant
   *  instruction as the resumed drive's first harness instruction. */
  readonly resume?: BuildResume;
  readonly signal: AbortSignal;
}

/** Assemble the three live `BuildSeams` bound to a shared `CtxHolder` + the fresh-pi /
 *  memory-proxy getters. Each seam threads the fresh ctx into the holder so the next
 *  seam's `switchSession` starts from a valid ctx (every switchSession invalidates the
 *  prior ctx). Extract mode reuses only `trialCompact` + `author` (driveAndCapture unused). */
export function buildLiveSeams(args: BuildLiveSeamsArgs): LiveSeamsBundle {
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
    plant:
      args.resume?.plantInstruction !== undefined
        ? { attempt: args.resume.attempt, instruction: args.resume.plantInstruction }
        : undefined,
  });
  const findTailContent = buildTailCheckSeam({
    ctxGetter: () => holder.current,
    evaluatedModel: args.config.evaluatedModel,
    signal: args.signal,
    widget: args.widget,
  });
  return { driveAndCapture, trialCompact, author, findTailContent, holder };
}

/** {@link buildLiveSeams}'s output: the four seams + the shared ctx holder (whose
 *  `.current` is the FINAL fresh ctx after the seams ran — thread it to whatever
 *  drives sessions next; the original command ctx is stale by then). */
export interface LiveSeamsBundle {
  readonly driveAndCapture: BuildSeams["driveAndCapture"];
  readonly trialCompact: BuildSeams["trialCompact"];
  readonly author: BuildSeams["author"];
  readonly findTailContent: BuildSeams["findTailContent"];
  /** The shared ctx holder — `.current` ends at the last switchSession's fresh ctx. */
  readonly holder: CtxHolder;
}
