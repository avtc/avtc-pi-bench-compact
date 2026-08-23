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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearArmConfig, readMemkeeperGlobalSettings } from "../arms/config.js";
import { ARM_DEFS } from "../arms/definitions.js";
import { DEFAULT_VERSION_RESOLVER, type VersionResolver } from "../arms/version.js";
import { type JudgeAgentSpec, resolveBackgroundAgents } from "../config/background-agents.js";
import { type ArmId, type BenchConfig, judgeEnsembleFields } from "../config/types.js";
import { BenchJudgeError, type JudgeErrorCategory } from "../judge/errors.js";
import { buildJudgeEnsemble, defaultJudgeTransport } from "../judge/seams.js";
import { seededShuffle } from "../judge/shuffle.js";
import { openVerdictJournal, scoringFingerprint } from "../judge/verdict-journal.js";
import { log } from "../log.js";
import type { LatentProbe } from "../manifest/latent.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import type { Pricing } from "../metrics/pricing.js";
import { DEFAULT_MODELS_PATH, readPricing } from "../metrics/pricing.js";
import { runBenchStage } from "../runtime/agent-loop.js";
import { resolveBenchModel } from "../runtime/model.js";
import {
  DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS,
  NO_STAGE_RETRY_POLICY,
  setStageRetryPolicy,
} from "../runtime/stage-retry.js";
import { pinsFromSettings } from "../session/fork.js";
import { buildCfgId } from "../storage/branches.js";
import { writeRunConfig } from "../storage/configs.js";
import {
  assertNotInRepo,
  benchRoot,
  branchSessionFile,
  configPath,
  runDir,
  scenarioManifest,
} from "../storage/paths.js";
import { type Phase1Walls, readPhase1Walls, writePhase1Walls } from "../storage/phase1-walls.js";
import { checkout } from "../storage/repo.js";
import { parseResumeRunId, type ResumeTarget } from "../storage/resume.js";
import { getActiveWidget, setActiveWidget, type WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL, scoreJudgeHooks, widgetStageHooks } from "../widget/tracker.js";
import { buildProbeGroundTruthMap, groundTruthDigest } from "./ground-truth.js";
import {
  activeLatentForArm,
  LatentStageStoppedError,
  latentDetailFromCounts,
  latentProbesDigest,
  purgeLatentProbeArtifacts,
  runLatentStage,
} from "./latent-stage.js";
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
import {
  type ArmAttemptRun,
  E2_LONG_RUN_THRESHOLD_ENTRIES,
  type ScoreRunDeps,
  type ScoreRunInput,
  type ScoreRunMeta,
  scoreRun,
} from "./score.js";
import type { TestSpecOps, TestSpecResult, TestSpecStopReason } from "./testspec.js";
import { runTestSpec, TestSpecFaultError } from "./testspec.js";
import { captureTrace, type RunTrace, readSessionEntries } from "./trace.js";

/** A run-scoped abort controller (owned by startRun; threaded into Phase 2/probes/
 *  score). Phase 1 (compaction) has NO signal seam yet — `ctx.compact()` takes none —
 *  so Phase 1 is not abortable. `/bench-compact:abort` fires this controller via the
 *  run-state abort holder; the phases that consume the signal stop via their existing
 *  stop-and-surface path. */
type RunSignal = AbortSignal;

/** Why a run halted (stop-and-surface), across phases. */
type RunStopReason =
  | Phase1StopReason
  | Phase2StopReason
  | ProbeStopReason
  | TestSpecStopReason
  | JudgeErrorCategory
  | { message: string };

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
      /** The phase that halted: phase-1 / latent / phase-2 / probe / score. */
      phase: "phase-1" | "latent" | "phase-2" | "probe" | "score";
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
  /** Injectable latent stage (default = real {@link runLatentStage} on the session
   *  default model; tests inject a fake). Runs only when latentProbes is enabled. */
  latentStage?: typeof runLatentStage;
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
  /** Trace capture seam for the fast-eval (probes-only) synthesized score rows
   *  (default = real `captureTrace` re-reading the arm-base transcript). */
  traceCapture?: typeof captureTrace;
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
  /** Digest of the run's active latent probes (null when none) — feeds the verdict-journal
   *  fingerprint so a pool change restarts the journal (stale verdicts never replay). */
  latentDigest: string | null;
  /** Digest of the ground-truth excerpt map rendered into probe slices (null when
   *  none) — same verdict-journal fingerprint role as latentDigest. */
  groundTruthDigest: string | null;
  /** Resolved per-judge members (model/thinking fallbacks already applied). */
  judgeMembers: readonly [JudgeAgentSpec, JudgeAgentSpec, JudgeAgentSpec];
  /** Per-call output-token cap for every judge call (resolved — judge setting or background). */
  judgeMaxTokens: number;
  /** Per-turn wall-clock cap for judge LLM calls (resolved — judge setting or background). */
  judgeTurnTimeoutMs: number;
}

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

  const runConfig = buildRunConfig(deps.config, deps.versionResolver ?? DEFAULT_VERSION_RESOLVER, deps.manifest);
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
        "continuing under the override; " +
        (resume.reuseBases === true
          ? "arms whose tool version changed reuse their committed base when one exists (--reuse-bases), else re-compact"
          : "arms whose tool version changed re-compact under the new version"),
    );
  }
  log.info(
    resuming
      ? `run ${runId} resumed: cfg ${nsCfgId}${configChanged ? ` (config-change override: current cfg ${cfgId})` : ""}, arms [${deps.config.armsEnabled.join(", ")}]`
      : `run ${runId} started: cfg ${nsCfgId}, arms [${deps.config.armsEnabled.join(", ")}]`,
  );

  const widget = deps.widget ?? null;
  setActiveWidget(widget);
  widget?.show();
  widget?.startPhase("compact", NO_DETAIL);

  // The run's durable Phase-1 walls: read up front (resume reconstruction recovers
  // each arm's compaction wall), rewritten after the phase with every arm THIS
  // process compacted (merge — a resume re-compacting a subset updates just those).
  const wallsPath = join(runPath, "phase1-walls.json");
  const priorWalls = readPhase1Walls(wallsPath);

  const phase1 = deps.phase1 ?? runPhase1;
  const continuations = deps.continuations ?? runContinuations;
  const probes = deps.probes ?? runProbes;
  const testSpec = deps.testSpec ?? runTestSpec;
  const score = deps.score ?? scoreRun;
  const buildScoreDeps = deps.buildScoreDeps ?? buildProductionScoreDeps;
  // Provider-request retries for every background-stage LLM call. The run config
  // owns the policy so all stages of this run — including resumed ones — retry
  // transient 5xx/429 identically.
  setStageRetryPolicy({
    maxRetries: deps.config.stageProviderMaxRetries,
    maxRetryDelayMs: DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS,
  });

  try {
    // --- Phase 1: compact each arm once → arm bases ---
    const sessionsDir = join(dirname(deps.scenarioRepo), "sessions");
    // The operator's global memkeeper settings, read ONCE and merged under the arm
    // pins at every configureArm (Phase 1 + Phase 2) — global panel tuning (models,
    // timeouts, thinking levels, max tokens) reaches the bench arms.
    const memkeeperGlobalSettings = readMemkeeperGlobalSettings(join(homedir(), ".pi"));
    const { bases, finalCtx: ctxAfterPhase1 } = await phase1({
      cmdCtx: deps.cmdCtx,
      scenarioRepo: deps.scenarioRepo,
      sessionsDir,
      date,
      id,
      cfgId: nsCfgId,
      toolVersions: runConfig.toolVersions,
      omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
      memkeeperGlobalSettings,
      priorWalls,
      wallsPath,
      armsEnabled: deps.config.armsEnabled,
      runtimePins: pinsFromSettings(deps.config.evaluatedModel, deps.config.evaluatedThinkingLevel),
      resume: resuming,
      reuseBases: deps.resume?.reuseBases === true,
      widget,
      ops: deps.ops,
    });

    // Persist every arm THIS process compacted (merge — keeps prior entries for arms
    // that skipped via resume/reuse, whose walls are only in the file).
    const freshWalls: Phase1Walls = {};
    for (const base of bases) {
      if (base.wallMs > 0) freshWalls[base.arm] = base.wallMs;
    }
    if (Object.keys(freshWalls).length > 0) writePhase1Walls(wallsPath, freshWalls);

    // --- Latent stage: author the per-run latent-probe pools (post-compaction).
    // The pools persist under runs/<runId>/ (latent-pool[-<arm>].json) — later
    // phases read them from disk, like the phase-1 walls + verdict journal. ---
    if (deps.config.latentProbes !== "off") {
      updateRunState({ phase: "latent", currentArm: null, currentAttempt: null });
      widget?.startPhase("latent", NO_DETAIL);
      const latentMode = deps.config.latentProbes === "per-arm" ? "per-arm" : "shared";
      const stage = deps.latentStage ?? runLatentStage;
      const latentAgents = resolveBackgroundAgents(deps.config);
      const latentAgent = latentAgents.latent;
      const probeValidateAgent = latentAgents.probeValidate;
      // The latent authoring is a BACKGROUND agent — wire the widget hooks like the
      // extract/author phase: onEvent streams ctx/tok, onModelResolved sets the ctx
      // window, onAdd renders the live per-class probe counts, onArm advances the
      // arm counter (per-arm mode).
      const latentHooks = widgetStageHooks(widget);
      const latentResult = await stage(
        {
          arms: bases.map((b) => ({ arm: b.arm, sessionPath: branchSessionFile(sessionsDir, b.branch) })),
          runPath,
          cwd: deps.scenarioRepo,
          // The phase-1 arm compactions switchSession'd — the original command ctx is
          // STALE by now. Use the threaded fresh ctx (the last arm's withSession ctx),
          // exactly like the continuation + probe phases do.
          ui: ctxAfterPhase1.ui,
          seams: {
            resolveModel: () => resolveBenchModel(ctxAfterPhase1, latentAgent.model),
            runStage: runBenchStage,
            onEvent: latentHooks?.onEvent,
            onModelResolved: latentHooks?.onModelResolved,
            onDone: latentHooks?.onDone,
          },
          signal,
          thinking: latentAgent.thinking,
          maxTokens: latentAgent.maxTokens,
          timeoutMs: latentAgent.timeoutMs,
          rateLimitOptions: null,
          probeValidate: {
            budget: {
              thinking: probeValidateAgent.thinking,
              maxTokens: probeValidateAgent.maxTokens,
              timeoutMs: probeValidateAgent.timeoutMs,
            },
            resolveModel: () => resolveBenchModel(ctxAfterPhase1, probeValidateAgent.model),
          },
          widget,
          onArm: (arm, index, total): void => {
            widget?.setArm(index, total, ARM_DEFS[arm].tool);
            widget?.setDetail(NO_DETAIL);
          },
          onAdd: (counts): void => {
            widget?.setDetail(latentDetailFromCounts(counts));
          },
        },
        latentMode,
      );
      if (latentResult.kind === "stopped") {
        throw new LatentStageStoppedError(latentResult.arm, { message: latentResult.message });
      }
      // A re-authored pool restarts ids at l1 — purge the OLD latent probe branches +
      // session files so a resume cannot replay dead answers for the new questions.
      if (latentResult.reAuthored.length > 0) {
        purgeLatentProbeArtifacts(
          deps.scenarioRepo,
          sessionsDir,
          bases
            .filter((b) => latentResult.kind === "done" && latentResult.reAuthored.includes(b.arm))
            .map((b) => ({ arm: b.arm, branch: b.branch })),
        );
      }
    } else {
      log.info("latent: off — skipped");
    }

    // --- Phase 2a: fork each base into N continuation attempts ---
    updateRunState({ phase: "phase-2", currentArm: null, currentAttempt: null });
    const probesOnly = deps.config.fastEval === "probes-only";
    let contResult: Phase2Result;
    if (probesOnly) {
      // fast eval: no continuations — the direct probes ARE the eval (the agent is
      // asked to PAUSE goal work and answer). Scoring synthesizes one row per arm
      // from the arm-base transcript (the exact cost metrics stay exact; the
      // continuation lanes render n/a).
      log.info("phase-2: skipped (fast eval: probes-only)");
      contResult = { traces: [], finalCtx: ctxAfterPhase1 };
    } else {
      widget?.startPhase("eval", NO_DETAIL);
      contResult = await continuations({
        cmdCtx: ctxAfterPhase1,
        armBases: bases,
        config: deps.config,
        memkeeperGlobalSettings,
        manifest: deps.manifest,
        repo: deps.scenarioRepo,
        sessionsDir,
        N: deps.config.N,
        resume: resuming,
        widget,
        signal,
      });
    }

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
        probesOnly,
        manifest: deps.manifest,
        latentProbes: activeLatentForArm(runPath, deps.config.latentProbes, base.arm),
        repo: deps.scenarioRepo,
        runtimePins: pinsFromSettings(deps.config.evaluatedModel, deps.config.evaluatedThinkingLevel),
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
        timeoutMs: deps.config.testspecTimeoutMs,
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
    const input = buildScoreRunInput(bases, contResult.traces, probeTraces, testSpecByBranch, deps.scenarioRepo, {
      probesOnly,
      sessionsDir,
      captureTrace: deps.traceCapture ?? captureTrace,
    });
    const meta = buildScoreMeta(deps, runConfig, bases, contResult.traces, runId, nsCfgId, root, runPath, now);
    const latentMap = new Map<string, LatentProbe>();
    if (deps.config.latentProbes !== "off") {
      for (const base of bases) {
        for (const probe of activeLatentForArm(runPath, deps.config.latentProbes, base.arm)) {
          latentMap.set(`${base.arm}:${probe.id}`, probe);
        }
      }
    }
    const latentDigest = latentProbesDigest(latentMap);
    // Ground-truth excerpts for the probe judge slices: read each arm's compacted-base
    // session once + resolve the cited entries (latent entryIds / manifest targets).
    // An unreadable session only drops that arm's blocks — never stops the run.
    const groundTruthMap = buildProbeGroundTruthMap({
      bases,
      sessionsDir,
      manifest: deps.manifest,
      latent: latentMap,
      readEntries: readSessionEntries,
    });
    const judgeAgents = resolveBackgroundAgents(deps.config).judge;
    const scoreDeps = {
      ...buildScoreDeps({
        ctx: probeCtx,
        runConfig,
        manifest: deps.manifest,
        meta,
        signal,
        modelsPath: deps.modelsPath ?? DEFAULT_MODELS_PATH,
        latentDigest,
        groundTruthDigest: groundTruthDigest(groundTruthMap),
        judgeMembers: judgeAgents.members,
        judgeMaxTokens: judgeAgents.maxTokens,
        judgeTurnTimeoutMs: judgeAgents.timeoutMs,
      }),
      latent: latentMap,
      groundTruth: groundTruthMap,
    };
    const { resultJson, markdown } = await score(input, scoreDeps);

    const resultsPath = join(runPath, "results.json");
    const reportPath = join(runPath, "report.md");
    // Contamination guard: results + report are bench artifacts — never inside the repo.
    assertNotInRepo(resultsPath, deps.scenarioRepo);
    assertNotInRepo(reportPath, deps.scenarioRepo);
    writeFileSync(resultsPath, JSON.stringify(resultJson, null, JSON_INDENT));
    writeFileSync(reportPath, markdown);

    widget?.setStatus("done", `/bench-compact:results ${runId}`);
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
    // Restore the built-in stage retry policy — the run-config policy must not
    // leak into the next run (or the test suite) once this run ends.
    setStageRetryPolicy(NO_STAGE_RETRY_POLICY);
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
  if (err instanceof LatentStageStoppedError) {
    const { arm, reason } = err;
    updateRunState({ lastStopReason: reason.message });
    widget?.setStatus("stopped", "/bench-compact:resume");
    log.warn(`run ${runId} stopped: latent stage ${arm ?? "shared"} — ${reason.message}`);
    deps.notify?.(reason.message);
    return {
      kind: "stopped",
      arm,
      attempt: null,
      phase: "latent",
      reason,
      message: reason.message,
      runId,
    };
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
    // The judge machinery is shared by the latent-authoring stage — report the
    // CURRENT phase ("latent" there) instead of hardcoding "score".
    const phase = getRunState()?.phase === "latent" ? "latent" : "score";
    const phaseLabel = phase === "latent" ? "latent" : "scoring";
    deps.notify?.(`bench-compact stopped (${phaseLabel}): ${message}`);
    log.warn(`run ${runId} stopped: ${phaseLabel} ${category} — ${message}`);
    return { kind: "stopped", arm: null, attempt: null, phase, reason: category, message, runId };
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
 * Pure aside from the fast-eval synthesis (which re-reads the arm-base transcript —
 * the seeded source of every attempt trace anyway).
 */
function buildScoreRunInput(
  bases: readonly ArmBase[],
  continuationTraces: readonly RunTrace[],
  probeTraces: readonly import("./probes.js").ProbeTrace[],
  testSpecByBranch: ReadonlyMap<string, TestSpecResult>,
  repo: string,
  opts: {
    readonly probesOnly?: boolean;
    readonly sessionsDir?: string;
    readonly captureTrace?: typeof captureTrace;
  },
): ScoreRunInput {
  const input: ArmAttemptRun[] = [];
  // fast eval (probes-only): no continuation attempts exist — synthesize ONE row per
  // arm from the ARM BASE transcript (it carries the Phase-1 boundary compaction, so
  // the compaction + summary cost metrics stay exact) with the single probe attempt
  // attached. The score deps flag skips the continuation-judged lanes (they render n/a).
  if (opts?.probesOnly === true && continuationTraces.length === 0) {
    const capture = opts.captureTrace ?? captureTrace;
    for (const base of bases) {
      const trace = capture(branchSessionFile(opts.sessionsDir ?? "", base.branch), base.branch, new Map());
      // Phase-1 timed the base's boundary compaction (bases carry wallMs) — attach
      // it to the synthesized trace's boundary record; without this the
      // compaction-cost metric renders 0s in probes-only runs.
      const boundary = trace.compactions[0];
      const compactions =
        boundary === undefined || base.wallMs <= 0
          ? trace.compactions
          : [{ ...boundary, wallMs: base.wallMs }, ...trace.compactions.slice(1)];
      input.push({
        arm: base.arm,
        attempt: 1,
        continuation: { ...trace, compactions, arm: base.arm, attempt: 1 },
        // ALL probe attempts attach to the synthesized row — each attempt is an
        // independent probe-recall sample of the same post-compaction memory (rate over N).
        probes: probeTraces.filter((p) => p.arm === base.arm),
        testSpecResult: undefined,
        repo,
        branch: base.branch,
      });
    }
    return input;
  }
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
 *  Live per-judge usage: the judge events are tagged with the ensemble index and
 *  land in per-slot accumulators (scoreJudgeHooks), so the widget shows one ctx/tok
 *  pair per parallel judge — concurrent streams never interleave. Coarse TEXTUAL
 *  progress is forwarded alongside (onScoreProgress → the detail line; one line per
 *  run + per graded probe slice) and the arm counter tracks the scored arm
 *  (onScoreArmFocus → setArm/clearArm). Metrics are read from the trace. */
export function buildProductionScoreDeps(args: BuildScoreDepsArgs): ScoreRunDeps {
  const judgeHooks = scoreJudgeHooks(() => getActiveWidget());
  const transport = defaultJudgeTransport(args.ctx, {
    maxTokens: args.judgeMaxTokens,
    timeoutMs: args.judgeTurnTimeoutMs,
    signal: args.signal,
    rateLimitOptions: null,
    onEvent: judgeHooks.onEvent,
    onModelResolved: judgeHooks.onModelResolved,
  });
  const ensemble = buildJudgeEnsemble(args.runConfig.judgesNumber, args.judgeMembers, transport);
  const pricing = resolvePricing(args.runConfig, args.ctx, args.modelsPath);
  // Incremental score-phase checkpoint: every completed judge unit lands in
  // runs/<runId>/judge/verdicts.jsonl; a resumed/ re-run score replays settled
  // verdicts instead of re-judging them (a crash mid-scoring costs only the
  // in-flight unit). Bound to the scoring fingerprint — a re-authored manifest or a
  // changed judge ensemble invalidates the file wholesale.
  mkdirSync(args.meta.artifacts.judgeDir, { recursive: true });
  const verdicts = openVerdictJournal({
    path: join(args.meta.artifacts.judgeDir, "verdicts.jsonl"),
    fingerprint: scoringFingerprint({
      manifestJson: JSON.stringify(args.manifest),
      judgeEnsembleFields: judgeEnsembleFields(args.runConfig),
      maxTokens: args.judgeMaxTokens,
      probesOnly: args.runConfig.fastEval === "probes-only",
      e2LongThreshold: E2_LONG_RUN_THRESHOLD_ENTRIES,
      latent: args.latentDigest,
      groundTruth: args.groundTruthDigest,
    }),
    fs: { existsSync, readFileSync: (p) => readFileSync(p, "utf8"), appendFileSync, writeFileSync },
    onRestart: (path) => log.info(`score: verdict journal restarted (scoring conditions changed) — ${path}`),
  });
  return {
    manifest: args.manifest,
    callJudges: ensemble.callJudges,
    stageSeams: ensemble.stageSeams,
    // Per-run seed (hashed from runId): within-run reproducibility (same run = same
    // anonymization order) + cross-run position-bias mitigation (different runs vary).
    shuffle: seededShuffle(hashSeed(args.meta.runId)),
    maxTokens: args.judgeMaxTokens,
    signal: args.signal,
    rateLimitOptions: null,
    bootstrapOptions: null,
    pricing,
    checkout,
    // fast eval: skip the continuation-judged lanes (no continuation transcript exists).
    probesOnly: args.runConfig.fastEval === "probes-only",
    meta: args.meta,
    onScoreProgress: (line) => {
      getActiveWidget()?.setDetail(line);
    },
    onScoreArmFocus: (arm, index, total) => {
      const widget = getActiveWidget();
      if (widget === null) return;
      if (arm === null || index === null || total === null) {
        widget.clearArm();
        return;
      }
      widget.setArm(index, total, ARM_DEFS[arm].tool);
    },
    verdicts,
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
