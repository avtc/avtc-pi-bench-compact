// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The machine-readable bench result (`bench-compact.result-v1`), written to
// `<root>/runs/<runId>/results.json`. Stores EXACT per-arm results only — no
// stored deltas or net-negative flags; the headline report + cross-run
// comparison DERIVE those from the exact values + `metricDefs.polarity`
// (so a result stays correct when the baseline arm is toggled or compared
// cross-run). Self-describing: the `metricDefs` block names every metric.
//
// `rate` is stored as [0,1]; the report formats it as a percentage.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArmId } from "../config/types.js";
import { ARM_LABELS } from "../config/types.js";
import type { MetricDef, MetricId } from "../metrics/defs.js";
import { METRIC_DEFS } from "../metrics/defs.js";
import type { AggregateResult, ArmMetrics } from "../stats/aggregate.js";
import type { ComparativeAxisResult } from "../stats/rank.js";
import type { RunConfig, ToolVersion } from "../storage/branches.js";
import { runDir } from "../storage/paths.js";

/** The schema marker embedded in every result-JSON. */
export const RESULT_SCHEMA = "bench-compact.result-v1";

/** A binary-rate metric shape: { rate∈[0,1], ci:[lo,hi], n }. */
export interface BinaryMetricJson {
  readonly rate: number;
  readonly ci: readonly [number, number];
  readonly n: number;
}
/** A comparative metric shape: { rank (1=best), rankCi:[lo,hi] }. */
export interface ComparativeMetricJson {
  readonly rank: number;
  readonly rankCi: readonly [number, number];
}
/** An exact mean+CI shape (footprint, run-cost). */
export interface ExactMetricJson {
  readonly mean: number;
  readonly ci: readonly [number, number];
}
/** The recall-cost shape: mean over recovered (null when none recovered). */
export interface C2MetricJson {
  readonly mean: number | null;
  readonly ci: readonly [number, number] | null;
  readonly notRecoveredRate: number;
}
/** The compaction-cost shape: mean token fields + $ + wall + mode stages + mean phase-2 count. */
export interface C4MetricJson {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly dollars: number;
  readonly wallMs: number;
  readonly stages: readonly string[];
  readonly phase2CompactionCount: number;
}
/** Union of per-metric JSON shapes (discriminated by the metric's channel in metricDefs). */
export type MetricJson = BinaryMetricJson | ComparativeMetricJson | ExactMetricJson | C2MetricJson | C4MetricJson;

/** One arm's entry in the result-JSON. */
export interface ArmResultJson {
  readonly tool: string;
  readonly runsCompleted: number;
  readonly runsFailed: number;
  readonly metrics: Readonly<Partial<Record<MetricId, MetricJson>>>;
  /** Per-probe binary breakdown (passes per attempt) — present when probes were graded. */
  readonly probes?: readonly ProbeBreakdownJson[];
}

/** One probe's per-attempt binary grades (the report's probe breakdown). */
export interface ProbeBreakdownJson {
  readonly probeId: string;
  readonly axis: MetricId;
  readonly question: string;
  readonly passes: readonly boolean[];
}

/** A comparative axis's order + Elo (the `ranks` block; full cross-arm detail). */
export interface RankAxisJson {
  readonly order: readonly ArmId[];
  readonly elo: Readonly<Partial<Record<ArmId, number>>>;
}

/** A recorded failure (one run of one arm that STOP-and-surfaced). */
export interface ResultFailure {
  readonly arm: ArmId;
  readonly run: number;
  readonly phase: string;
  readonly reason: string;
  readonly traceBranch: string;
  readonly resolved: boolean;
}

/** Reproducibility artifact paths (all agent-hidden under <root>). */
export interface ResultArtifacts {
  readonly scenarioRepo: string;
  readonly branches: readonly string[];
  readonly judgeDir: string;
  readonly config: string;
  /** The written result-JSON path (set by the serializer from root+runId; read by the report). */
  readonly results?: string;
}

/** The scenario reference (id + manifest path). */
export interface ResultScenario {
  readonly id: string;
  readonly manifestRef: string;
}

/** The complete bench-compact.result-v1 object. */
export interface BenchResultJson {
  readonly schema: typeof RESULT_SCHEMA;
  readonly runId: string;
  readonly cfgId: string;
  readonly timestamp: string;
  readonly scenario: ResultScenario;
  readonly config: Omit<RunConfig, "toolVersions">;
  readonly toolVersions: Partial<Record<ArmId, ToolVersion>>;
  readonly metricDefs: Readonly<Record<MetricId, MetricDef>>;
  readonly arms: Readonly<Partial<Record<ArmId, ArmResultJson>>>;
  readonly ranks: Readonly<Partial<Record<MetricId, RankAxisJson>>>;
  readonly failures: readonly ResultFailure[];
  readonly artifacts: ResultArtifacts;
}

/** Inputs to {@link serializeResultJson}. */
export interface WriteResultJsonDeps {
  readonly runId: string;
  readonly cfgId: string;
  readonly timestamp: string;
  readonly scenario: ResultScenario;
  /** The full run config (config block + toolVersions are split out of it). */
  readonly runConfig: RunConfig;
  /** The aggregated per-arm + cross-arm metrics. */
  readonly aggregate: AggregateResult;
  /** Per-arm completed/failed run counts (run tracking, not the aggregate). */
  readonly armRunCounts: Readonly<Partial<Record<ArmId, { completed: number; failed: number }>>>;
  readonly failures: readonly ResultFailure[];
  readonly artifacts: ResultArtifacts;
  /** The bench root (outputDir ?? ~/.pi/bench-compact). */
  readonly root: string;
}

/** Map one arm's aggregated metrics to its result-JSON metric shapes. Pure. */
function mapArmMetrics(arm: ArmMetrics): Partial<Record<MetricId, MetricJson>> {
  const metrics: Partial<Record<MetricId, MetricJson>> = {};
  for (const [metricId, m] of Object.entries(arm.binary) as [
    MetricId,
    { rate: number; ci: readonly [number, number]; n: number },
  ][]) {
    if (m === undefined) continue;
    metrics[metricId] = { rate: m.rate, ci: m.ci, n: m.n };
  }
  if (arm.exact.C1 !== undefined) metrics.C1 = { mean: arm.exact.C1.mean, ci: arm.exact.C1.ci };
  if (arm.exact.C3 !== undefined) metrics.C3 = { mean: arm.exact.C3.mean, ci: arm.exact.C3.ci };
  if (arm.exact.C2 !== undefined) {
    const c2 = arm.exact.C2;
    metrics.C2 = { mean: c2.mean, ci: c2.ci, notRecoveredRate: c2.notRecoveredRate };
  }
  if (arm.exact.C4 !== undefined) {
    const c4 = arm.exact.C4;
    metrics.C4 = {
      tokensIn: c4.tokensIn,
      tokensOut: c4.tokensOut,
      cacheRead: c4.cacheRead,
      cacheWrite: c4.cacheWrite,
      dollars: c4.dollars,
      wallMs: c4.wallMs,
      stages: c4.stages,
      phase2CompactionCount: c4.phase2CompactionCount,
    };
  }
  return metrics;
}

/**
 * Serialize the bench result to the `bench-compact.result-v1` object. PURE — maps
 * the aggregated metrics to the per-arm metric shapes (binary/comparative/exact/
 * recall-cost/compaction-cost), embeds `metricDefs` + `ranks` (comparative order+Elo), and stores EXACT
 * values only (no deltas/net-negative — derived by the report).
 */
export function serializeResultJson(deps: WriteResultJsonDeps): BenchResultJson {
  const { toolVersions, ...configRest } = deps.runConfig;
  void toolVersions;
  const arms: Partial<Record<ArmId, ArmResultJson>> = {};
  for (const [armId, armMetrics] of Object.entries(deps.aggregate.arms) as [ArmId, ArmMetrics | undefined][]) {
    if (armMetrics === undefined) continue;
    const metrics = mapArmMetrics(armMetrics);
    // Pull this arm's comparative ranks (cross-arm → per-arm rank/rankCi).
    for (const [metricId, axis] of Object.entries(deps.aggregate.comparative) as [
      MetricId,
      ComparativeAxisResult | undefined,
    ][]) {
      if (axis === undefined) continue;
      const r = axis.ranks[armId];
      if (r !== undefined) metrics[metricId] = { rank: r.rank, rankCi: r.rankCi };
    }
    const counts = deps.armRunCounts[armId] ?? { completed: 0, failed: 0 };
    const probes =
      armMetrics.probes === undefined || armMetrics.probes.length === 0
        ? undefined
        : armMetrics.probes;
    arms[armId] =
      probes === undefined
        ? {
            tool: armToolName(armId),
            runsCompleted: counts.completed,
            runsFailed: counts.failed,
            metrics,
          }
        : {
            tool: armToolName(armId),
            runsCompleted: counts.completed,
            runsFailed: counts.failed,
            metrics,
            probes,
          };
  }
  const ranks: Partial<Record<MetricId, RankAxisJson>> = {};
  for (const [metricId, axis] of Object.entries(deps.aggregate.comparative) as [
    MetricId,
    ComparativeAxisResult | undefined,
  ][]) {
    if (axis === undefined) continue;
    ranks[metricId] = { order: axis.order, elo: axis.elo };
  }
  return {
    schema: RESULT_SCHEMA,
    runId: deps.runId,
    cfgId: deps.cfgId,
    timestamp: deps.timestamp,
    scenario: deps.scenario,
    config: configRest,
    toolVersions: deps.runConfig.toolVersions,
    metricDefs: METRIC_DEFS,
    arms,
    ranks,
    failures: deps.failures,
    artifacts: { ...deps.artifacts, results: path.join(runDir(deps.root, deps.runId), "results.json") },
  };
}

/** The arm's tool name (bare-pi / om-default / memkeeper-builder / memkeeper-selector / om-full). */
function armToolName(armId: ArmId): string {
  return ARM_LABELS[armId];
}

/**
 * Extract the comparable SCALAR per metric from a result-JSON arm's metrics (the
 * inverse of serialization): binary -> rate, comparative -> rank, exact footprint/
 * run-cost -> mean, recall-cost -> mean (null when all notRecovered), compaction-
 * cost -> dollars. Consumed by the report + comparison to derive ΔvsA1 live
 * (via stats/delta.ts a1Delta) without stored deltas. Pure.
 */
export function extractJsonScalars(
  metrics: Readonly<Partial<Record<MetricId, MetricJson>>>,
): Partial<Record<MetricId, number | null>> {
  const scalars: Partial<Record<MetricId, number | null>> = {};
  for (const [metricId, m] of Object.entries(metrics) as [MetricId, MetricJson | undefined][]) {
    if (m === undefined) continue;
    if ("rate" in m) scalars[metricId] = m.rate;
    else if ("rank" in m) scalars[metricId] = m.rank;
    else if ("dollars" in m) scalars[metricId] = m.dollars;
    else if ("notRecoveredRate" in m)
      scalars[metricId] = m.mean; // recall-cost: null when none recovered
    else if ("mean" in m) scalars[metricId] = m.mean; // footprint / run-cost
  }
  return scalars;
}
