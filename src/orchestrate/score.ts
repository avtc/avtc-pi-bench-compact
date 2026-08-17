// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The scoring orchestrator: composes the metrics (exact footprint/run-cost/
// compaction-cost, judge-boundaried recall-cost), the judge (single-call slices,
// agentLoop+tools trajectory, trajectory-summary, comparative ranking), the
// multi-judge ensemble layer, and the statistics + reporting layers into ONE
// entry point — `scoreRun` — that turns per-(arm, attempt) captured traces into
// a BenchResultJson + headline markdown.
//
// Metric -> mechanism routing (design metric-mechanism table):
//   exact (no judge):
//     footprint         — computeC1(boundary compaction summary). GUARDED: when a
//                          run has no compaction the run contributes no footprint
//                          sample (the arm's footprint is undefined if every run
//                          lacks one).
//     run-cost          — computeC3(post-compaction assistant output sum).
//     compaction-cost   — computeC4(all compactions, pricing).
//   judge-boundaried exact:
//     recall-cost       — findFirstCorrectUse (K-ensemble union) -> computeC2 per
//                          fact. One C2Result per (attempt, fact); flattened.
//   binary (judge, per-run yes/no -> rate over samples):
//     recall-accuracy / abstention / supersession
//                       — probe-answer slices (axis resolved by axisForProbe);
//                          one boolean per probe, flattened across attempts.
//     proactive-recall  — trajectory (gradeTrajectory). One boolean per attempt.
//     redo-execution    — two-checkpoint slice (short) OR trajectory (long).
//                          Its pass=true means REDO happened (the bad outcome),
//                          so its rate is the redo-rate (lowerBetter) — polarity
//                          metadata handles the rest; no special logic here.
//   comparative (judge ranks the enabled arms per axis per attempt):
//     resume            — buildStartSlice per arm.
//     task-quality      — buildDoneSnapshot per arm.
//     redo-plan / goal  — summarizeTrajectory per arm (needs checkout) -> rankAxis.
//   Cross-cutting: trajectory/summarize/recall-cost stages need the repo checked
//   out to the attempt's branch (one checkout per (arm, attempt), all stages for
//   that run execute on it); comparative ranking is grouped BY ATTEMPT (one
//   ranking per attempt-slot, aggregated across attempts).

import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { ArmId } from "../config/types.js";
import { findFirstCorrectUse } from "../judge/c2-boundary.js";
import { majorityVote, rankEnsemble, runBinaryEnsemble, unionC2Boundaries } from "../judge/ensemble.js";
import { BenchJudgeError } from "../judge/errors.js";
import { axisForProbe } from "../judge/probe-axis.js";
import { type Ranking, rankAxis, type Shuffle } from "../judge/ranking.js";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type CallJudge, gradeSlice } from "../judge/single-call.js";
import {
  buildDoneSnapshot,
  buildProbeAnswerSlice,
  buildStartSlice,
  buildTwoCheckpointSlice,
  DEFAULT_ACTIONS_MAX,
  type SliceOptions,
} from "../judge/slices.js";
import type { JsonToolStageSeams } from "../judge/stage-runner.js";
import { summarizeTrajectory } from "../judge/summarize-trajectory.js";
import { gradeTrajectory, type TrajectoryGrade } from "../judge/trajectory.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { type C2Result, computeC2 } from "../metrics/c2.js";
import type { MetricId } from "../metrics/defs.js";
import { type C4Result, computeC1, computeC3, computeC4 } from "../metrics/exact.js";
import type { Pricing } from "../metrics/pricing.js";
import { postCompactionEntries } from "../metrics/trace-read.js";
import { renderHeadline } from "../report/markdown.js";
import {
  type ResultArtifacts,
  type ResultFailure,
  type ResultScenario,
  serializeResultJson,
} from "../report/result-json.js";
import { type AllArmsGrades, type ArmRunGrades, aggregateArmMetrics } from "../stats/aggregate.js";
import type { BootstrapOptions } from "../stats/bootstrap.js";
import type { ArmRanking } from "../stats/rank.js";
import type { RunConfig } from "../storage/branches.js";
import type { ProbeTrace } from "./probes.js";
import type { TestSpecResult } from "./testspec.js";
import type { RunTrace } from "./trace.js";

// ---------------------------------------------------------------------------
// Input + dependency contracts
// ---------------------------------------------------------------------------

/** One captured run: the Phase-2 continuation trace + its direct-probe answers
 *  + the repo/branch the trajectory stages inspect. Richer than a bare RunTrace
 *  — the orchestrator needs the arm, the attempt index, the probes, and the
 *  testSpec result (for the task-quality done-snapshot). */
export interface ArmAttemptRun {
  readonly arm: ArmId;
  /** 1-based attempt index (drives the comparative per-attempt grouping). */
  readonly attempt: number;
  /** The Phase-2 continuation trace (post-compaction work). */
  readonly continuation: RunTrace;
  /** The direct-probe answers for this run (matched to manifest.probes by position). */
  readonly probes: readonly ProbeTrace[];
  /** The embedded-test result (for the task-quality done-snapshot); omitted = skipped. */
  readonly testSpecResult?: TestSpecResult;
  /** The scenario repo path (the trajectory stages check this out + inspect it). */
  readonly repo: string;
  /** The attempt branch the continuation lives on. */
  readonly branch: string;
}

/** The full per-run input: every captured (arm, attempt) run across all arms. */
export type ScoreRunInput = readonly ArmAttemptRun[];

/** The run-meta the serializer needs (identity + config + run counts + failures + artifacts). */
export interface ScoreRunMeta {
  readonly runId: string;
  readonly cfgId: string;
  readonly timestamp: string;
  /** The scenario reference (id + manifest path). */
  readonly scenario: ResultScenario;
  /** The full run config (config block + toolVersions are split out by the serializer). */
  readonly runConfig: RunConfig;
  /** Per-arm completed/failed run counts (run tracking, not the aggregate). */
  readonly armRunCounts: Readonly<Partial<Record<ArmId, { completed: number; failed: number }>>>;
  readonly failures: readonly ResultFailure[];
  readonly artifacts: ResultArtifacts;
  /** The bench root (outputDir ?? the pi bench-compact dir). */
  readonly root: string;
}

/** The scoring result: the machine-readable result-JSON + the operator-facing markdown. */
export interface ScoreRunResult {
  readonly resultJson: ReturnType<typeof serializeResultJson>;
  readonly markdown: string;
}

/** Per-run exact metric values: footprint is absent when the run has no compaction. */
export interface RunExactMetrics {
  readonly C1?: number;
  readonly C3: number;
  readonly C4: C4Result;
}

/**
 * Compute one run's exact metrics off its trace: footprint (the boundary compaction
 * summary token-count, GUARDED — undefined when the run never compacted), run-cost
 * (the post-compaction assistant output sum), and compaction-cost (compaction
 * tokens/$/wall summed
 * across every compaction). Pure + deterministic.
 */
export function computeRunExact(trace: RunTrace, pricing: Pricing): RunExactMetrics {
  const boundary: CompactionEntry | undefined = trace.compactions[0]?.entry;
  const C1 = boundary === undefined ? undefined : computeC1(boundary);
  return {
    C1,
    C3: computeC3(trace),
    C4: computeC4(trace, pricing),
  };
}

// The full scoring dependency contract. Composes the narrow routing-deps
// interfaces (recall-cost / probe / trace-binary / comparative); ScoreRunDeps satisfies each
// so scoreRun threads ONE deps object through every routing helper.
export interface ScoreRunDeps {
  readonly manifest: ScenarioManifest;
  /** K judge single-call seams (paired by index with stageSeams; both length K). */
  readonly callJudges: readonly CallJudge[];
  /** K judge stage seams (paired by index with callJudges; both length K). */
  readonly stageSeams: readonly JsonToolStageSeams[];
  /** REQUIRED presentation-order shuffle for rankAxis anonymization (seeded). */
  readonly shuffle: Shuffle<string>;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  /** Malformed-JSON re-prompt budget for the single-call paths (default 2). */
  readonly maxRetries?: number;
  readonly bootstrapOptions: BootstrapOptions | null;
  readonly pricing: Pricing;
  /** Switch the repo working tree to a branch (one worktree; sequenced per run). */
  readonly checkout: (repo: string, branch: string) => void;
  /** fast eval (probes-only): skip the continuation-judged lanes (recall-cost +
   *  trace-binary + comparative) — no continuation transcript exists to judge; those
   *  lanes render n/a. The compaction/summary cost metrics (from the arm-base
   *  compaction) + the probe lanes still grade. */
  readonly probesOnly?: boolean;
  readonly meta: ScoreRunMeta;
}

/** Per-arm mutable accumulators built up as runs are scored. */
interface ArmAccumulators {
  readonly binary: Partial<Record<MetricId, boolean[]>>;
  readonly C1: number[];
  readonly C2: C2Result[];
  readonly C3: number[];
  readonly C4: C4Result[];
}

/** A new per-arm accumulator. */
function newAccumulator(): ArmAccumulators {
  return { binary: {}, C1: [], C2: [], C3: [], C4: [] };
}

/** Get (creating if absent) one axis's boolean-sample array on an accumulator. */
function binaryArray(acc: ArmAccumulators, axis: MetricId): boolean[] {
  let arr = acc.binary[axis];
  if (arr === undefined) {
    arr = [];
    acc.binary[axis] = arr;
  }
  return arr;
}

/**
 * Score every captured run into a BenchResultJson + headline markdown. Routes each
 * metric to its mechanism (exact / judge-boundaried exact / binary / comparative),
 * assembles the per-arm grades + cross-arm comparative rankings, aggregates them
 * (bootstrap CIs + rank matrix + Elo), serializes the result-JSON, and renders the
 * headline report. Pure aside from the judge + checkout seams.
 *
 * Sequencing: per (arm, attempt) run the exact metrics, the recall-cost boundary,
 * the probe binary grades, + the trace binary grades (one checkout per run for the
 * trajectory stages); then the comparative axes (resume/task-quality pure slices +
 * redo-plan/goal per-judge summaries with a checkout per arm). The checkout seam is
 * called in a deterministic order so a single-worktree scenario repo stays
 * consistent (one worktree — branches are checked out sequentially, never concurrently).
 */
export async function scoreRun(input: ScoreRunInput, deps: ScoreRunDeps): Promise<ScoreRunResult> {
  const accumulators = new Map<ArmId, ArmAccumulators>();
  const accOf = (arm: ArmId): ArmAccumulators => {
    let acc = accumulators.get(arm);
    if (acc === undefined) {
      acc = newAccumulator();
      accumulators.set(arm, acc);
    }
    return acc;
  };

  // --- per-run routing: exact + recall-cost + probe-binary + trace-binary ---
  for (const run of input) {
    const acc = accOf(run.arm);
    const exact = computeRunExact(run.continuation, deps.pricing);
    if (exact.C1 !== undefined) acc.C1.push(exact.C1);
    acc.C3.push(exact.C3);
    acc.C4.push(exact.C4);

    if (deps.probesOnly !== true) {
      for (const c2 of await gradeC2ForRun(run, deps)) acc.C2.push(c2);
    }

    for (const { axis, pass } of await gradeProbeAxesForRun(run, deps)) {
      binaryArray(acc, axis).push(pass);
    }

    if (deps.probesOnly !== true) {
      for (const [axis, pass] of Object.entries(await gradeTraceBinaryForRun(run, deps)) as [MetricId, boolean][]) {
        binaryArray(acc, axis).push(pass);
      }
    }
  }

  // --- comparative routing: resume/task-quality slices + redo-plan/goal summaries ---
  const comparative = deps.probesOnly === true ? {} : await gradeComparativeRouting(input, deps);

  // --- assemble AllArmsGrades ---
  const arms: Partial<Record<ArmId, ArmRunGrades>> = {};
  for (const [arm, acc] of accumulators) {
    const exactValues: {
      C1?: readonly number[];
      C2?: readonly C2Result[];
      C3?: readonly number[];
      C4?: readonly C4Result[];
    } = {};
    if (acc.C1.length > 0) exactValues.C1 = acc.C1;
    if (acc.C2.length > 0) exactValues.C2 = acc.C2;
    if (acc.C3.length > 0) exactValues.C3 = acc.C3;
    if (acc.C4.length > 0) exactValues.C4 = acc.C4;
    arms[arm] = { binary: acc.binary, exact: exactValues };
  }
  const grades: AllArmsGrades = { arms, comparative, enabledArms: uniqueArmIds(input) };

  // --- aggregate + serialize + render ---
  const aggregate = aggregateArmMetrics(grades, deps.bootstrapOptions);
  const resultJson = serializeResultJson({
    runId: deps.meta.runId,
    cfgId: deps.meta.cfgId,
    timestamp: deps.meta.timestamp,
    scenario: deps.meta.scenario,
    runConfig: deps.meta.runConfig,
    aggregate,
    armRunCounts: deps.meta.armRunCounts,
    failures: deps.meta.failures,
    artifacts: deps.meta.artifacts,
    root: deps.meta.root,
  });
  return { resultJson, markdown: renderHeadline(resultJson) };
}

// --- recall-cost routing (judge-boundaried exact) -------------------------

/** The narrow deps the recall-cost routing needs (the full ScoreRunDeps satisfies this). */
export interface C2RoutingDeps {
  readonly manifest: ScenarioManifest;
  /** K judge stage seams (one per configured judge) — findFirstCorrectUse runs once each. */
  readonly stageSeams: readonly JsonToolStageSeams[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  /** Switch the repo to the run's branch before the stage inspects the working tree. */
  readonly checkout: (repo: string, branch: string) => void;
}

/**
 * Grade one run's recall-cost: check the repo out to the run's branch, kick off
 * K findFirstCorrectUse calls (one per judge), union the boundaries (a fact counts
 * recovered if ANY judge found its first-correct-use; lowest-numbered recovering
 * judge's entry wins on disagreement), then computeC2 per fact off the run trace.
 * Returns one C2Result per recallFact (one per planted fact). No judge call + []
 * when the manifest has no recallFacts. The caller flattens these across attempts.
 */
export async function gradeC2ForRun(run: ArmAttemptRun, deps: C2RoutingDeps): Promise<C2Result[]> {
  if (deps.manifest.recallFacts.length === 0) return [];
  deps.checkout(run.repo, run.branch);
  const judgePromises = deps.stageSeams.map((seams) =>
    findFirstCorrectUse({
      seams,
      cwd: run.repo,
      tracePath: run.continuation.tracePath,
      manifest: deps.manifest,
      maxTokens: deps.maxTokens,
      signal: deps.signal,
      rateLimitOptions: deps.rateLimitOptions,
    }),
  );
  const boundaries = await unionC2Boundaries(judgePromises);
  return boundaries.map((boundary) => computeC2(run.continuation, boundary.firstCorrectUseEntryId));
}

// --- Binary routing (probe recall/abstention/supersession + trace proactive/redo) --

/** A run with more than this many post-compaction entries is "long": redo-execution is
 *  graded via the trajectory (the two-checkpoint slice truncates to a bounded
 *  action list + could miss a redo buried deep in a long continuation). Tunable. */
export const E2_LONG_RUN_THRESHOLD_ENTRIES = 40;

/** Extract one axis's pass from a judge's trajectory grades (STOP+surface if missing). */
function trajectoryGradeForAxis(grades: readonly TrajectoryGrade[], axis: MetricId): boolean {
  const grade = grades.find((g) => g.axis === axis);
  if (grade === undefined) {
    throw new BenchJudgeError(
      "incomplete-output",
      `trajectory grades missing axis ${axis} the judge was asked to grade — STOP+surface`,
    );
  }
  return grade.pass;
}

/** The narrow deps the probe binary routing needs (the full ScoreRunDeps satisfies this). */
export interface ProbeRoutingDeps {
  readonly manifest: ScenarioManifest;
  /** K judge single-call seams (one per configured judge). */
  readonly callJudges: readonly CallJudge[];
  /** Malformed-JSON re-prompt budget for gradeSlice (default 2). */
  readonly maxRetries?: number;
}

/**
 * Grade one run's probe axes (recall-accuracy / abstention / supersession):
 * for each probe, resolve its axis via axisForProbe, build the probe-answer slice,
 * kick off K gradeSlice calls (one per judge) + majority-vote. Returns one
 * {axis, pass} per GRADED probe (malformed-axis + out-of-range probeIds skipped).
 * The caller flattens these per-axis across (attempt x probe). No checkout needed
 * (probe-answer slices are pure over the captured ProbeTrace).
 */
export async function gradeProbeAxesForRun(
  run: ArmAttemptRun,
  deps: ProbeRoutingDeps,
): Promise<ReadonlyArray<{ readonly axis: MetricId; readonly pass: boolean }>> {
  const out: Array<{ readonly axis: MetricId; readonly pass: boolean }> = [];
  const supersessionEntryIds = new Set(deps.manifest.supersessions.flatMap((s) => s.entryIds));
  for (const probeTrace of run.probes) {
    const idx = Number(probeTrace.probeId) - 1;
    const probe = deps.manifest.probes[idx];
    if (probe === undefined) continue; // probeId out of range
    const axis = axisForProbe(probe, deps.manifest);
    if (axis === null) continue; // malformed probe (no axis)
    const slice = buildProbeAnswerSlice(
      { probe, answerText: probeTrace.answer, supersessionEntryIds },
      DEFAULT_SLICE_OPTIONS,
    );
    const judgePromises = deps.callJudges.map(async (callJudge) => {
      const grade = await gradeSlice({ axis, slice, callJudge, maxRetries: deps.maxRetries });
      return grade.pass;
    });
    out.push({ axis, pass: await runBinaryEnsemble(judgePromises) });
  }
  return out;
}

/** The narrow deps the trace binary routing needs (the full ScoreRunDeps satisfies this). */
export interface TraceBinaryRoutingDeps {
  readonly manifest: ScenarioManifest;
  readonly callJudges: readonly CallJudge[];
  readonly stageSeams: readonly JsonToolStageSeams[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  readonly maxRetries?: number;
  /** Switch the repo to the run's branch before the trajectory inspects the working tree. */
  readonly checkout: (repo: string, branch: string) => void;
}

/**
 * Grade one run's trace binary axes: proactive-recall (always trajectory) +
 * redo-execution (two-checkpoint slice when the run is SHORT, trajectory when
 * LONG). Checks the repo out once, then grades. When redo is long, redo +
 * proactive-recall are combined into ONE gradeTrajectory call
 * (both axes inspected in one pass); when short, proactive-recall is trajectory +
 * redo-execution is a single-call slice. Its pass=true means REDO happened (the
 * bad outcome), so its
 * rate is the redo-rate — polarity metadata (lowerBetter) handles the rest.
 * Per-axis K-judge aggregation via majority vote. Pure aside from the seams.
 */
export async function gradeTraceBinaryForRun(
  run: ArmAttemptRun,
  deps: TraceBinaryRoutingDeps,
): Promise<Partial<Record<MetricId, boolean>>> {
  deps.checkout(run.repo, run.branch);
  const postEntries = postCompactionEntries(run.continuation.entries);
  const e2Long = postEntries.length > E2_LONG_RUN_THRESHOLD_ENTRIES;
  const trajectoryAxes: MetricId[] = e2Long ? ["E2", "E4"] : ["E4"];
  const trajResults = await Promise.all(
    deps.stageSeams.map((seams) =>
      gradeTrajectory({
        seams,
        cwd: run.repo,
        tracePath: run.continuation.tracePath,
        axes: trajectoryAxes,
        manifest: deps.manifest,
        maxTokens: deps.maxTokens,
        signal: deps.signal,
        rateLimitOptions: deps.rateLimitOptions,
      }),
    ),
  );
  const out: Partial<Record<MetricId, boolean>> = {};
  for (const axis of trajectoryAxes) {
    out[axis] = majorityVote(trajResults.map((grades) => trajectoryGradeForAxis(grades, axis)));
  }
  if (!e2Long) {
    const slice = buildTwoCheckpointSlice(
      { doneOps: deps.manifest.doneOps, runActions: postEntries },
      DEFAULT_SLICE_OPTIONS,
    );
    const e2Promises = deps.callJudges.map(async (callJudge) => {
      const grade = await gradeSlice({ axis: "E2", slice, callJudge, maxRetries: deps.maxRetries });
      return grade.pass;
    });
    out.E2 = await runBinaryEnsemble(e2Promises);
  }
  return out;
}

// --- Comparative routing (resume/task-quality slices + redo-plan/goal summaries) --

/** The tail of post-compaction entries the done-snapshot renders (the final actions,
 *  sized to the slice render cap so the cap is a no-op — single source: slices.ts). */
const DONE_FINAL_ACTIONS = DEFAULT_ACTIONS_MAX;
/** Slice-builder options sentinel: no per-call override (use each builder's defaults). */
const DEFAULT_SLICE_OPTIONS: SliceOptions | null = null;

/** The narrow deps the comparative routing needs (the full ScoreRunDeps satisfies this). */
export interface ComparativeRoutingDeps {
  readonly manifest: ScenarioManifest;
  /** K judge single-call seams (paired by index with stageSeams; both length K). */
  readonly callJudges: readonly CallJudge[];
  /** K judge stage seams (paired by index with callJudges; both length K). */
  readonly stageSeams: readonly JsonToolStageSeams[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  /** REQUIRED presentation-order shuffle for rankAxis anonymization (seeded). */
  readonly shuffle: Shuffle<string>;
  readonly maxRetries?: number;
  /** Switch the repo to an arm's branch before each summarize stage inspects it. */
  readonly checkout: (repo: string, branch: string) => void;
}

/** The distinct arm ids present in the input, in canonical order (bare-pi, om-default, memkeeper-builder, memkeeper-selector, om-full). */
function uniqueArmIds(input: ScoreRunInput): ArmId[] {
  return [...new Set(input.map((run) => run.arm))].sort();
}

/** Group runs by attempt: one group per attempt-slot, each group a list of [arm, run]. */
function groupByAttempt(input: ScoreRunInput): ReadonlyArray<ReadonlyArray<readonly [ArmId, ArmAttemptRun]>> {
  const byAttempt = new Map<number, Array<readonly [ArmId, ArmAttemptRun]>>();
  for (const run of input) {
    const list = byAttempt.get(run.attempt) ?? [];
    list.push([run.arm, run] as const);
    byAttempt.set(run.attempt, list);
  }
  return [...byAttempt.entries()].sort(([a], [b]) => a - b).map(([, list]) => list);
}

/** Build one arm's per-axis slice for a slice-based comparative axis (resume start / task-quality done). Pure. */
function buildComparativeSlice(axis: "E1" | "E7", run: ArmAttemptRun, manifest: ScenarioManifest): string {
  if (axis === "E1") return buildStartSlice(run.continuation, manifest, DEFAULT_SLICE_OPTIONS);
  const testSpecResult: TestSpecResult = run.testSpecResult ?? { kind: "skipped" };
  const finalEntries = postCompactionEntries(run.continuation.entries).slice(-DONE_FINAL_ACTIONS);
  return buildDoneSnapshot(
    { branch: run.branch, taskObjective: manifest.taskObjective, testSpecResult, finalEntries },
    DEFAULT_SLICE_OPTIONS,
  );
}

/** Rank a slice-based axis per attempt: build each arm's pure slice, kick K rankAxis
 *  calls (one per judge), Borda-aggregate. No checkout (slices are pure). */
async function rankSliceAxisPerAttempt(
  axis: "E1" | "E7",
  byAttempt: ReturnType<typeof groupByAttempt>,
  deps: ComparativeRoutingDeps,
  enabledArms: readonly ArmId[],
): Promise<ArmRanking[]> {
  const rankings: ArmRanking[] = [];
  for (const armRuns of byAttempt) {
    const armSlices: Record<string, string> = {};
    for (const [arm, run] of armRuns) armSlices[arm] = buildComparativeSlice(axis, run, deps.manifest);
    const judgePromises = deps.callJudges.map((callJudge) =>
      rankAxis({ callJudge, axis, armSlices, shuffle: deps.shuffle, options: { maxRetries: deps.maxRetries } }),
    );
    rankings.push(toArmRanking(await rankEnsemble(judgePromises, enabledArms)));
  }
  return rankings;
}

/** Grade the slice-based comparative axes (resume / task-quality), grouped by
 *  attempt. The slices are pure over the captured RunTrace — NO checkout needed. */
export async function gradeSliceComparative(
  input: ScoreRunInput,
  deps: ComparativeRoutingDeps,
): Promise<Partial<Record<MetricId, readonly ArmRanking[]>>> {
  const enabledArms = uniqueArmIds(input);
  const byAttempt = groupByAttempt(input);
  return {
    E1: await rankSliceAxisPerAttempt("E1", byAttempt, deps, enabledArms),
    E7: await rankSliceAxisPerAttempt("E7", byAttempt, deps, enabledArms),
  };
}

/** Rank a summary-based axis per attempt. ONE checkout per arm; while that arm's
 *  branch is checked out, ALL K judges summarize it in parallel (safe — they read
 *  the same read-only working tree; the terminal write_summary captures into each
 *  judge's own stage, not the repo). Then each judge ranks using its OWN summaries
 *  (no checkout — pure strings) + Borda-aggregate the K rankings. The one-checkout-
 *  per-arm ordering avoids concurrent-checkout races on the shared single-worktree
 *  repo (the prior per-judge-parallel fan-out corrupted summaries when K > 1). */
async function rankSummaryAxisPerAttempt(
  axis: "E3" | "E10",
  byAttempt: ReturnType<typeof groupByAttempt>,
  deps: ComparativeRoutingDeps,
  enabledArms: readonly ArmId[],
): Promise<ArmRanking[]> {
  const rankings: ArmRanking[] = [];
  for (const armRuns of byAttempt) {
    // Phase 1: build per-judge per-arm summaries. ONE checkout per arm; all K
    // judges summarize that arm in parallel on the same checked-out tree.
    const summariesByJudge = new Map<number, Record<string, string>>();
    deps.callJudges.forEach((_, judgeIndex) => {
      summariesByJudge.set(judgeIndex, {});
    });
    for (const [arm, run] of armRuns) {
      deps.checkout(run.repo, run.branch);
      const judgeSummaries = await Promise.all(
        deps.stageSeams.map((seams) =>
          summarizeTrajectory({
            seams,
            cwd: run.repo,
            tracePath: run.continuation.tracePath,
            axis,
            manifest: deps.manifest,
            maxTokens: deps.maxTokens,
            signal: deps.signal,
            rateLimitOptions: deps.rateLimitOptions,
          }),
        ),
      );
      judgeSummaries.forEach((summary, judgeIndex) => {
        const judgeSlices = summariesByJudge.get(judgeIndex);
        if (judgeSlices !== undefined) judgeSlices[arm] = summary;
      });
    }
    // Phase 2: each judge ranks using its OWN summaries (no checkout — pure strings).
    const judgeRankings = deps.callJudges.map((callJudge, judgeIndex) =>
      rankAxis({
        callJudge,
        axis,
        armSlices: summariesByJudge.get(judgeIndex) ?? {},
        shuffle: deps.shuffle,
        options: { maxRetries: deps.maxRetries },
      }),
    );
    rankings.push(toArmRanking(await rankEnsemble(judgeRankings, enabledArms)));
  }
  return rankings;
}

/** Grade the summary-based comparative axes (redo-plan / goal), grouped by
 *  attempt. Each judge checks the repo out to every arm's branch + builds its own
 *  trajectory summary, then ranks; Borda-aggregates the K rankings. */
export async function gradeSummaryComparative(
  input: ScoreRunInput,
  deps: ComparativeRoutingDeps,
): Promise<Partial<Record<MetricId, readonly ArmRanking[]>>> {
  const enabledArms = uniqueArmIds(input);
  const byAttempt = groupByAttempt(input);
  return {
    E3: await rankSummaryAxisPerAttempt("E3", byAttempt, deps, enabledArms),
    E10: await rankSummaryAxisPerAttempt("E10", byAttempt, deps, enabledArms),
  };
}

/** Cast a judge Ranking's string order to the ArmId-keyed ArmRanking (the slices are
 *  keyed by ArmId, so the order elements ARE ArmIds — safe structural widening). */
function toArmRanking(ranking: Ranking): ArmRanking {
  return { order: ranking.order as readonly ArmId[] };
}

/**
 * Grade ALL comparative axes (resume/task-quality slice-based + redo-plan/goal
 * summary-based), grouped BY
 * ATTEMPT (one ranking per attempt-slot; the aggregator folds the per-attempt
 * rankings into the cross-arm rank matrix + Elo). resume/task-quality need NO
 * checkout (slices are pure over the captured RunTrace); redo-plan/goal check the
 * repo out to each arm's
 * branch so each judge can build its own trajectory summary. Returns the per-axis
 * per-attempt rankings (AllArmsGrades.comparative shape). Pure aside from the seams.
 */
async function gradeComparativeRouting(
  input: ScoreRunInput,
  deps: ComparativeRoutingDeps,
): Promise<Partial<Record<MetricId, readonly ArmRanking[]>>> {
  const [slice, summary] = await Promise.all([
    gradeSliceComparative(input, deps),
    gradeSummaryComparative(input, deps),
  ]);
  return { ...slice, ...summary };
}
