// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run driver: owns run identity (date/id/cfgId), sets the run-state
// eagerly (so the live-progress widget can show it), persists the run-config
// snapshot, then drives the full pipeline:
//   Phase 1  — compact each arm's frozen backup once → arm base (inline).
//   Phase 2a — fork each base into N continuation attempts (runContinuations).
//   Phase 2b — run the manifest's direct probes per arm (runProbes, from the arm
//              base) + the embedded testSpec per committed attempt branch.
//   Phase 3  — score every captured (arm, attempt) run (scoreRun) → results.json
//              + report.md under the run dir.
// The fresh command ctx threads across phases (each switchSession invalidates the
// prior ctx; the final ctx of one phase seeds the next). Stop-and-surface on any
// phase halt — never auto-retry.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearArmConfig } from "../arms/config.js";
import { DEFAULT_VERSION_RESOLVER, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { BenchJudgeError, type JudgeErrorCategory } from "../judge/errors.js";
import { buildJudgeEnsemble, defaultJudgeTransport } from "../judge/seams.js";
import { seededShuffle } from "../judge/shuffle.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import type { Pricing } from "../metrics/pricing.js";
import { DEFAULT_MODELS_PATH, readPricing } from "../metrics/pricing.js";
import { buildCfgId } from "../storage/branches.js";
import { writeRunConfig } from "../storage/configs.js";
import { assertNotInRepo, benchRoot, configPath, runDir, scenarioManifest } from "../storage/paths.js";
import { checkout } from "../storage/repo.js";
import { parseResumeRunId, type ResumeTarget } from "../storage/resume.js";
import { setActiveWidget, type WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL } from "../widget/tracker.js";
import {
  type ArmBase,
  buildRunConfig,
  type Phase1Ops,
  Phase1StoppedError,
  type Phase1StopReason,
  runPhase1,
} from "./phase1.js";
import { type Phase2Result, Phase2StoppedError, type Phase2StopReason, runContinuations } from "./phase2.js";
import { type ProbeOps, ProbeStoppedError, type ProbeStopReason, runProbes } from "./probes.js";
import {
  clearRunState,
  getRunState,
  NO_RUN_ABORT,
  setActiveRunAbort,
  setRunState,
  updateRunState,
} from "./run-state.js";
import { type ArmAttemptRun, type ScoreRunDeps, type ScoreRunInput, type ScoreRunMeta, scoreRun } from "./score.js";
import type { TestSpecOps, TestSpecResult, TestSpecStopReason } from "./testspec.js";
import { runTestSpec, TestSpecFaultError } from "./testspec.js";
import type { RunTrace } from "./trace.js";

/** A run-scoped abort controller (owned by startRun; threaded into Phase 2/probes/
 *  score). Phase 1 (compaction) has NO signal seam yet — `ctx.compact()` takes none —
 *  so Phase 1 is not abortable. `/bench-compact:abort` fires this controller via the
 *  run-state abort holder; the phases that consume the signal stop via their existing
 *  stop-and-surface path. */
type RunSignal = AbortSignal;

/** Why a run halted (stop-and-surface), across phases. */
type RunStopReason = Phase1StopReason | Phase2StopReason | ProbeStopReason | TestSpecStopReason | JudgeErrorCategory;

/** Discriminated result of a run. The done branch is Phase-3 (results written);
 *  the stopped branch carries the phase + the arm/attempt (null for a score stop). */
export type RunResult =
  | { kind: "done"; runId: string; cfgId: string; resultsPath: string; reportPath: string }
  | {
      kind: "stopped";
      /** The arm the stop occurred on (null for a Phase-3 score stop). */
      arm: ArmId | null;
      /** The Phase-2 attempt index, or null (Phase-1/probe/score stops carry none). */
      attempt: number | null;
      /** The phase that halted: phase-1 / phase-2 / probe / score. */
      phase: "phase-1" | "phase-2" | "probe" | "score";
      reason: RunStopReason;
      message: string;
      runId: string;
    };

/** Inputs to {@link startRun}. `phase1`/`continuations`/`probes`/`testSpec`/`score`/
 *  `buildScoreDeps` are injectable seams for testing (defaults = real impls). */
export interface StartRunDeps {
  /** The run command's context (the first arm's `switchSession`). */
  cmdCtx: ExtensionCommandContext;
  config: BenchConfig;
  /** The prepared scenario repo path (Phase-0 frozen backup + project files on `main`). */
  scenarioRepo: string;
  /** The scenario manifest (seeds the simulator + the probes + the scoring axes). */
  manifest: ScenarioManifest;
  /** Bench root override (default = `benchRoot(config.outputDir)`). */
  root?: string;
  /** Clock seam (default real). The run's calendar date is derived from this. */
  now?: () => Date;
  /** Operator-attention channel (e.g. `ctx.ui.notify`). Invoked on stop-and-surface. */
  notify?: (message: string) => void;
  /** The live-progress widget (TUI-only). Null in non-TUI/batch → no-op. */
  widget?: WidgetPort | null;
  /** Injectable Phase-1 (default = real {@link runPhase1}). */
  phase1?: typeof runPhase1;
  /** Injectable Phase-2 continuations (default = real {@link runContinuations}). */
  continuations?: typeof runContinuations;
  /** Injectable Phase-2b probes (default = real {@link runProbes}). */
  probes?: typeof runProbes;
  /** Injectable Phase-2b testSpec (default = real {@link runTestSpec}). */
  testSpec?: typeof runTestSpec;
  /** Injectable Phase-3 scoring (default = real {@link scoreRun}). */
  score?: typeof scoreRun;
  /** Injectable Phase-3 ScoreRunDeps builder (default = production wiring). Tests
   *  inject a minimal factory so the heavy judge/pricing deps are bypassed. */
  buildScoreDeps?: (args: BuildScoreDepsArgs) => ScoreRunDeps;
  /** Phase-1 ops seams (passed through to the real `runPhase1`). */
  ops?: Partial<Phase1Ops>;
  /** Phase-2b probe ops seams (passed through to the real `runProbes`). */
  probeOps?: Partial<ProbeOps>;
  /** Phase-2b testSpec ops seams (passed through to the real `runTestSpec`). */
  testSpecOps?: Partial<TestSpecOps>;
  /** Tool-version resolver (default = real filesystem resolution). Tests inject a fake. */
  versionResolver?: VersionResolver;
  /** models.json path for {@link readPricing} (default = `~/.pi/agent/models.json`). */
  modelsPath?: string;
  /** Crash resume: continue the named run instead of starting a fresh identity. The
   *  runId's date+id are REUSED (no nextRunId); the cfgId must equal the resumed run's
   *  namespace cfg (a config change since the crash refuses the resume). Committed
   *  phase artifacts (arm bases, attempts, probes) are skipped by the phases. */
  resume?: ResumeTarget;
}

/** The production ScoreRunDeps builder's inputs. */
export interface BuildScoreDepsArgs {
  /** The scoring-session context (the threaded final ctx — model registry for judge resolution). */
  ctx: ExtensionContext;
  /** The full run config (its judge fields build the ensemble; evaluatedModel resolves pricing). */
  runConfig: ReturnType<typeof buildRunConfig>;
  /** The manifest (scoring axes + rubric context). */
  manifest: ScenarioManifest;
  /** The run-meta the serializer needs. */
  meta: ScoreRunMeta;
  /** The run signal (threaded to the judge stages). */
  signal: RunSignal;
  /** models.json path for {@link readPricing} (default = `~/.pi/agent/models.json`). */
  modelsPath: string;
}

/** Per-run output-token cap for the judge stages (single-call slices + agentLoop summaries). */
const JUDGE_MAX_TOKENS = 8192;
/** The JSON indent written to results.json. */
const JSON_INDENT = 2;

/**
 * Start a bench run. Resolves the run identity, persists the run-config snapshot,
 * sets the run-state to `phase-1`, then drives Phase 1 → 2a → 2b → 3. On any phase
 * stop, records the reason, notifies the operator, and returns `{ kind: "stopped" }`
 * — never auto-retries. On a clean Phase-3, writes results.json + report.md under
 * the run dir and returns `{ kind: "done" }`.
 */
export async function startRun(deps: StartRunDeps): Promise<RunResult> {
  const root = deps.root ?? benchRoot(deps.config.outputDir);
  const now = deps.now ?? (() => new Date());
  // Crash resume REUSES the crashed run's identity (date+id parsed from its runId —
  // nextRunId is skipped so the resumed run lands back in its own run dir); a fresh
  // start derives the identity from the clock as before.
  const identity =
    deps.resume !== undefined
      ? parseResumeRunId(deps.resume.runId)
      : { date: utcDate(now()), id: nextRunId(root, utcDate(now())) };
  const date = identity.date;
  const id = identity.id;
  const runId = `${date}-${id}`;
  const runPath = runDir(root, runId);
  const runAbort = new AbortController();
  const signal: RunSignal = runAbort.signal;
  setActiveRunAbort(runAbort);

  mkdirSync(runPath, { recursive: true });

  const runConfig = buildRunConfig(deps.config, deps.versionResolver ?? DEFAULT_VERSION_RESOLVER);
  const cfgId = buildCfgId(runConfig);
  // Hard cfg guard: the resumed namespace's cfg segment IS the crashed run's run
  // conditions; a mismatch means the config (model / N / arm tool versions / …)
  // changed since the crash — resuming would mix run conditions across arms.
  // Refuse unless the operator explicitly overrode (--allow-config-change).
  const configChanged = deps.resume !== undefined && cfgId !== deps.resume.cfgId;
  const resume = deps.resume;
  if (configChanged && resume !== undefined && resume.allowConfigChange !== true) {
    throw new Error(
      `cannot resume run ${runId}: config changed since the crash ` +
        `(run cfg ${resume.cfgId}, current cfg ${cfgId}) — restore the config or start a fresh run`,
    );
  }
  // On an overridden config change the run KEEPS its original namespace (one cfg
  // dir per runId — branch detection + attempt derivation stay sound); the CURRENT
  // config snapshot is still written under its own id, so both configurations are
  // on disk. Arms whose tool version changed find no base branch (branch names
  // embed the version) and re-compact under the new version.
  const nsCfgId = deps.resume?.cfgId ?? cfgId;
  // Contamination guard: the run config is a bench artifact — it must never land
  // inside the agent-visible scenario repo. Defense-in-depth (the default layout is safe).
  assertNotInRepo(configPath(root, cfgId), deps.scenarioRepo);
  writeRunConfig(cfgId, runConfig, root);

  setRunState({
    runId,
    date,
    id,
    cfgId: nsCfgId,
    scenarioRepo: deps.scenarioRepo,
    phase: "phase-1",
    currentArm: null,
    currentAttempt: null,
    lastStopReason: null,
  });
  const resuming = deps.resume !== undefined;
  if (resuming && configChanged && resume !== undefined) {
    deps.notify?.(
      `config changed since the crash (run cfg ${resume.cfgId}, current cfg ${cfgId}) — ` +
        "continuing under the override; arms whose tool version changed re-compact under the new version",
    );
  }
  log.info(
    resuming
      ? `run ${runId} resumed: cfg ${nsCfgId}${configChanged ? " (config-change override: current cfg " + cfgId + ")" : ""}, arms [${deps.config.armsEnabled.join(", ")}]`
      : `run ${runId} started: cfg ${nsCfgId}, arms [${deps.config.armsEnabled.join(", ")}]`,
  );

  const widget = deps.widget ?? null;
  setActiveWidget(widget);
  widget?.show();
  widget?.startPhase("compact", NO_DETAIL);

  const phase1 = deps.phase1 ?? runPhase1;
  const continuations = deps.continuations ?? runContinuations;
  const probes = deps.probes ?? runProbes;
  const testSpec = deps.testSpec ?? runTestSpec;
  const score = deps.score ?? scoreRun;
  const buildScoreDeps = deps.buildScoreDeps ?? buildProductionScoreDeps;

  try {
    // --- Phase 1: compact each arm once → arm bases ---
    const sessionsDir = join(dirname(deps.scenarioRepo), "sessions");
    const { bases, finalCtx: ctxAfterPhase1 } = await phase1({
      cmdCtx: deps.cmdCtx,
      scenarioRepo: deps.scenarioRepo,
      sessionsDir,
      date,
      id,
      cfgId: nsCfgId,
      toolVersions: runConfig.toolVersions,
      omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
      armsEnabled: deps.config.armsEnabled,
      resume: resuming,
      reuseBases: deps.resume?.reuseBases === true,
      widget,
      ops: deps.ops,
    });

    // --- Phase 2a: fork each base into N continuation attempts ---
    updateRunState({ phase: "phase-2", currentArm: null, currentAttempt: null });
    widget?.startPhase("eval", NO_DETAIL);
    const contResult: Phase2Result = await continuations({
      cmdCtx: ctxAfterPhase1,
      armBases: bases,
      config: deps.config,
      manifest: deps.manifest,
      repo: deps.scenarioRepo,
      sessionsDir,
      N: deps.config.N,
      resume: resuming,
      widget,
      signal,
    });

    // --- Phase 2b: direct probes per arm (from the base) + embedded testSpec per attempt ---
    widget?.startPhase("probe", NO_DETAIL);
    updateRunState({ phase: "probe", currentArm: null, currentAttempt: null });
    let probeCtx = contResult.finalCtx;
    const probeTraces = [];
    for (const base of bases) {
      widget?.setArm(bases.indexOf(base) + 1, bases.length, base.tool);
      updateRunState({ currentArm: base.arm });
      const probeResult = await probes({
        cmdCtx: probeCtx,
        armBase: base,
        N: deps.config.N,
        manifest: deps.manifest,
        repo: deps.scenarioRepo,
        sessionsDir,
        omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
        resume: resuming,
        widget,
        signal,
        ops: deps.probeOps,
      });
      probeTraces.push(...probeResult.traces);
      probeCtx = probeResult.finalCtx;
    }
    // The embedded testSpec runs on each committed attempt branch's project files.
    const testSpecByBranch = new Map<string, TestSpecResult>();
    for (const trace of contResult.traces) {
      const specResult = testSpec({
        repo: deps.scenarioRepo,
        branch: trace.branch,
        manifest: deps.manifest,
        ops: deps.testSpecOps,
      });
      // A harness fault (runError: spawn error / timeout / checkout fault) is NOT a
      // subject failure to score — it is a fault the operator must inspect (the
      // testspec contract promises stop-and-surface; do NOT silently degrade the
      // task-quality signal).
      if (specResult.kind === "ran" && specResult.runError) {
        throw new TestSpecFaultError(trace.branch, specResult.output);
      }
      testSpecByBranch.set(trace.branch, specResult);
    }

    // --- Phase 3: score every captured run → results.json + report.md ---
    widget?.startPhase("score", NO_DETAIL);
    updateRunState({ phase: "score", currentArm: null, currentAttempt: null });
    const input = buildScoreRunInput(bases, contResult.traces, probeTraces, testSpecByBranch, deps.scenarioRepo);
    const meta = buildScoreMeta(deps, runConfig, bases, contResult.traces, runId, nsCfgId, root, runPath, now);
    const scoreDeps = buildScoreDeps({
      ctx: probeCtx,
      runConfig,
      manifest: deps.manifest,
      meta,
      signal,
      modelsPath: deps.modelsPath ?? DEFAULT_MODELS_PATH,
    });
    const { resultJson, markdown } = await score(input, scoreDeps);

    const resultsPath = join(runPath, "results.json");
    const reportPath = join(runPath, "report.md");
    // Contamination guard: results + report are bench artifacts — never inside the repo.
    assertNotInRepo(resultsPath, deps.scenarioRepo);
    assertNotInRepo(reportPath, deps.scenarioRepo);
    writeFileSync(resultsPath, JSON.stringify(resultJson, null, JSON_INDENT));
    writeFileSync(reportPath, markdown);

    widget?.setStatus("done", "/bench-compact:results");
    // A cleanly-finished run clears the state singleton — `/bench-compact:status` goes
    // back to "not started" (stop-and-surface states persist so the stop stays queryable).
    clearRunState();
    log.info(`run ${runId} done: ${resultsPath}`);
    return { kind: "done", runId, cfgId: nsCfgId, resultsPath, reportPath };
  } catch (err) {
    return handleRunStop(err, deps, widget, runId);
  } finally {
    // Tear down the per-arm memory config (env + .pi/settings.json) once the WHOLE run is
    // done (Phase-1 through Phase-3) — it persists across phases so Phase-2/probes keep each
    // arm's isolation, + is cleared here so it never leaks into the post-bench session / next run.
    clearArmConfig(deps.scenarioRepo);
    // Clear the active abort controller so a stale controller never lingers past the run
    // (also covers the abort-fired case — the controller was already fired + cleared by
    // abortActiveRun, this is a defensive no-op then).
    setActiveRunAbort(NO_RUN_ABORT);
  }
}

/** Map a thrown phase-stop error to a stopped RunResult (records reason, notifies,
 *  widget→stopped). Re-throws unexpected (non-stop) errors. */
function handleRunStop(err: unknown, deps: StartRunDeps, widget: WidgetPort | null, runId: string): RunResult {
  if (err instanceof Phase1StoppedError) {
    const { arm, reason, message } = err;
    updateRunState({ lastStopReason: message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    deps.notify?.(`bench-compact stopped (arm ${arm}): ${message}`);
    log.warn(`run ${runId} stopped: arm ${arm} ${reason} — ${message}`);
    return { kind: "stopped", arm, attempt: null, phase: "phase-1", reason, message, runId };
  }
  if (err instanceof Phase2StoppedError) {
    const { arm, attempt, reason, message } = err;
    updateRunState({ lastStopReason: message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    deps.notify?.(`bench-compact stopped (arm ${arm} attempt ${attempt}): ${message}`);
    log.warn(`run ${runId} stopped: arm ${arm} attempt ${attempt} ${reason} — ${message}`);
    return { kind: "stopped", arm, attempt, phase: "phase-2", reason, message, runId };
  }
  if (err instanceof ProbeStoppedError) {
    const { arm, probeId, reason, message } = err;
    updateRunState({ lastStopReason: message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    deps.notify?.(`bench-compact stopped (arm ${arm} probe ${probeId}): ${message}`);
    log.warn(`run ${runId} stopped: arm ${arm} probe ${probeId} ${reason} — ${message}`);
    return { kind: "stopped", arm, attempt: null, phase: "probe", reason, message, runId };
  }
  if (err instanceof TestSpecFaultError) {
    const { branch, reason, message } = err;
    updateRunState({ lastStopReason: message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    deps.notify?.(`bench-compact stopped (testSpec on ${branch}): ${message}`);
    log.warn(`run ${runId} stopped: testSpec on ${branch} ${reason} — ${message}`);
    return { kind: "stopped", arm: null, attempt: null, phase: "probe", reason, message, runId };
  }
  if (err instanceof BenchJudgeError) {
    const { category, message } = err;
    updateRunState({ lastStopReason: message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    deps.notify?.(`bench-compact stopped (scoring): ${message}`);
    log.warn(`run ${runId} stopped: scoring ${category} — ${message}`);
    return { kind: "stopped", arm: null, attempt: null, phase: "score", reason: category, message, runId };
  }
  // Unexpected error (fs fault, git fault, bug): re-throw for the command layer's
  // catch — but FIRST record the stop so the run-state doesn't keep looking live
  // (a live-looking state would block the concurrent-run guard + mislead
  // /bench-compact:status + leave the widget without its stopped status).
  const unexpectedMsg = err instanceof Error ? err.message : String(err);
  if (getRunState() !== null) updateRunState({ lastStopReason: `unexpected error: ${unexpectedMsg}` });
  widget?.setStatus("stopped", "/bench-compact:resume");
  throw err;
}

/**
 * Build the Phase-3 {@link ScoreRunInput}: one {@link ArmAttemptRun} per (arm,
 * attempt) continuation, with that attempt's direct-probe answers attached (probes fork
 * N× per arm — one probe-set per attempt 1..N — so each attempt's probes attach to it
 * and the recall-accuracy/abstention/supersession probe axes rate over N), and the embedded-testSpec result on each attempt's branch.
 * Pure (no I/O).
 */
function buildScoreRunInput(
  bases: readonly ArmBase[],
  continuationTraces: readonly RunTrace[],
  probeTraces: readonly import("./probes.js").ProbeTrace[],
  testSpecByBranch: ReadonlyMap<string, TestSpecResult>,
  repo: string,
): ScoreRunInput {
  const input: ArmAttemptRun[] = [];
  for (const base of bases) {
    const armContTraces = continuationTraces.filter(
      (t): t is RunTrace & { arm: ArmId; attempt: number } => t.arm === base.arm && t.attempt !== undefined,
    );
    armContTraces.forEach((trace) => {
      // Probes fork N× per arm (one set per attempt) → each attempt's probes attach to
      // that attempt, so gradeProbeAxesForRun grades one sample per (attempt × probe).
      const attemptProbes = probeTraces.filter((p) => p.arm === base.arm && p.attempt === trace.attempt);
      input.push({
        arm: trace.arm,
        attempt: trace.attempt,
        continuation: trace,
        probes: attemptProbes,
        testSpecResult: testSpecByBranch.get(trace.branch),
        repo,
        branch: trace.branch,
      });
    });
  }
  return input;
}

/** Build the run-meta the serializer needs (identity + config + counts + artifacts). */
function buildScoreMeta(
  deps: StartRunDeps,
  runConfig: ReturnType<typeof buildRunConfig>,
  bases: readonly ArmBase[],
  continuationTraces: readonly RunTrace[],
  runId: string,
  cfgId: string,
  root: string,
  runPath: string,
  now: () => Date,
): ScoreRunMeta {
  const armRunCounts: Partial<Record<ArmId, { completed: number; failed: number }>> = {};
  for (const base of bases) {
    const completed = continuationTraces.filter((t) => t.arm === base.arm).length;
    armRunCounts[base.arm] = { completed, failed: 0 };
  }
  return {
    runId,
    cfgId,
    timestamp: now().toISOString(),
    scenario: { id: deps.manifest.id, manifestRef: scenarioManifest(root, deps.manifest.id) },
    runConfig,
    armRunCounts,
    failures: [],
    artifacts: {
      scenarioRepo: deps.scenarioRepo,
      branches: bases.map((b) => b.branch),
      judgeDir: join(runPath, "judge"),
      config: join(root, "configs", `${cfgId}.json`),
      results: join(runPath, "results.json"),
    },
    root,
  };
}

/** The production ScoreRunDeps: builds the K-judge ensemble (callJudges + stageSeams
 *  from the run config's judge fields), the evaluated-model pricing, a seeded rank
 *  shuffle, + the repo checkout seam. Pure aside from the readPricing file read.
 *
 *  No live-progress widget forwarding: the score phase is inherently concurrent —
 *  gradeComparativeRouting runs slice (resume/task-quality) + summary (redo-plan/goal)
 *  axes in parallel (plus per-arm trace-binary), so concurrent judge calls would
 *  interleave into the widget's shared two-tier token accumulator (meaningless
 *  tok/ctx). The score phase cell (advanced via startPhase("score") in startRun)
 *  still signals progress; the judge's per-call tokens are not surfaced. Metrics are
 *  read from the trace. */
export function buildProductionScoreDeps(args: BuildScoreDepsArgs): ScoreRunDeps {
  const transport = defaultJudgeTransport(args.ctx, {
    maxTokens: JUDGE_MAX_TOKENS,
    signal: args.signal,
    rateLimitOptions: null,
  });
  const ensemble = buildJudgeEnsemble(args.runConfig, transport);
  const pricing = resolvePricing(args.runConfig, args.ctx, args.modelsPath);
  return {
    manifest: args.manifest,
    callJudges: ensemble.callJudges,
    stageSeams: ensemble.stageSeams,
    // Per-run seed (hashed from runId): within-run reproducibility (same run = same
    // anonymization order) + cross-run position-bias mitigation (different runs vary).
    shuffle: seededShuffle(hashSeed(args.meta.runId)),
    maxTokens: JUDGE_MAX_TOKENS,
    signal: args.signal,
    rateLimitOptions: null,
    bootstrapOptions: null,
    pricing,
    checkout,
    meta: args.meta,
  };
}

/** Resolve the evaluated model's pricing. A non-null `evaluatedModel` ("provider/id")
 *  → readPricing on the id; null → the session model's id (`ctx.model`). Throws a
 *  BenchJudgeError (model-unavailable) on failure so the run STOP-and-surfaces
 *  (a missing price is a scoring-config error, not a crash — the compaction-cost
 *  metric is meaningless without it). */
function resolvePricing(
  runConfig: ReturnType<typeof buildRunConfig>,
  ctx: ExtensionContext,
  modelsPath: string,
): Pricing {
  const modelId = runConfig.evaluatedModel !== null ? modelIdOf(runConfig.evaluatedModel) : (ctx.model?.id ?? null);
  if (modelId === null) {
    throw new BenchJudgeError(
      "model-unavailable",
      "cannot resolve the evaluated model id for pricing (set evaluatedModel)",
    );
  }
  try {
    return readPricing(modelId, { modelsPath });
  } catch (err) {
    throw new BenchJudgeError(
      "model-unavailable",
      `pricing for evaluated model "${modelId}" not found in ${modelsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Extract the model id (the part after `provider/`) from a `provider/id` reference. */
function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/** Hash a run id string to a 32-bit seed (FNV-1a — deterministic, cheap, good spread). */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** UTC calendar date as `YYYY-MM-DD` (fixed across all arms/attempts of a run). */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Next 1-based run id for `date`: counts existing run dirs under `<root>/runs/`
 * whose name starts with `${date}-`. The bench is TUI-primary (one run at a time).
 */
function nextRunId(root: string, date: string): number {
  const runsDir = join(root, "runs");
  if (!existsSync(runsDir)) return 1;
  const prefix = `${date}-`;
  let count = 0;
  for (const entry of readdirSync(runsDir)) {
    if (entry.startsWith(prefix)) count++;
  }
  return count + 1;
}
