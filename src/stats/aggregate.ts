// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Per-arm + cross-arm metric aggregation: routes each metric to its channel
// shape (binary → rate+CI; comparative → rank+CI; exact footprint/run-cost →
// mean+CI; recall-cost → mean-over-recovered + notRecoveredRate; compaction-cost
// → mean-fields + mode-stages + mean phase-2 count). All functions are PURE +
// DETERMINISTIC given a seed.
//
// This is the bridge between the per-run grades (binary yes/no, comparative
// per-run rankings, exact per-run values) and the per-arm aggregates the report
// surfaces. The comparative channel is CROSS-ARM (one ranking folds all enabled
// arms); binary + exact are PER-ARM.

import type { ArmId } from "../config/types.js";
import type { C2Result } from "../metrics/c2.js";
import type { MetricId } from "../metrics/defs.js";
import type { C4Result } from "../metrics/exact.js";
import type { ProbeUsage } from "../orchestrate/probes.js";
import { type BinaryRateResult, type BootstrapOptions, binaryRate, bootstrapCi, type CiResult } from "./bootstrap.js";
import { type ArmRanking, aggregateRanks, type ComparativeAxisResult } from "./rank.js";
import { mean } from "./util.js";

/** Per-run exact values for one arm (footprint/run-cost numbers, recall-cost results, compaction-cost results). */
interface ArmExactValues {
  readonly C1?: readonly number[];
  readonly C2?: readonly C2Result[];
  readonly C3?: readonly number[] | readonly ProbeCostSample[];
  readonly C4?: readonly C4Result[];
}

/** Per-arm per-run grades: binary pass/fail arrays + per-run exact values. */
export interface ArmRunGrades {
  readonly binary?: Readonly<Partial<Record<MetricId, readonly boolean[]>>>;
  readonly exact?: ArmExactValues;
  /** Per-probe binary detail (the report's probe breakdown); one entry per graded
   *  probeId with its per-attempt passes. Aggregated unchanged (raw detail, no CI). */
  readonly probes?: readonly ProbeGrades[];
}

/** One probe's binary grades across attempts (per-probe breakdown detail). */
export interface ProbeGrades {
  readonly probeId: string;
  readonly axis: MetricId;
  readonly question: string;
  readonly passes: readonly boolean[];
  /** Per-attempt probe-answer usage, aligned with `passes` (null when the probe tail
   *  was not a clean append — usage unknowable). */
  readonly usages?: readonly (ProbeUsage | null)[];
}

/** One probes-only run-cost sample (per-run SUMS over that run's probe answers).
 *  Pooling divides total dollars/wall by total answers across runs. */
export interface ProbeCostSample {
  readonly dollars: number;
  readonly wallMs: number;
  readonly answers: number;
}

/** Probes-only run-cost aggregate: mean $ + wall PER probe answer. */
export interface C3CostMetric {
  readonly dollars: number;
  readonly wallMs: number;
  readonly answers: number;
}

/** Sum one numeric field over samples (0 over an empty list). */
function sumField(samples: readonly object[], field: "dollars" | "wallMs" | "answers"): number {
  let sum = 0;
  for (const s of samples) {
    const v = (s as Record<string, unknown>)[field];
    if (typeof v === "number") sum += v;
  }
  return sum;
}

/** Recall-cost aggregate: mean over RECOVERED runs only (+ null when none recovered). */
interface C2Metric {
  readonly mean: number | null;
  readonly ci: readonly [number, number] | null;
  readonly notRecoveredRate: number;
}

/** Compaction-cost aggregate: mean of numeric fields + mode stages + mean phase-2-compaction count. */
interface C4Metric {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly dollars: number;
  readonly wallMs: number;
  readonly stages: readonly string[];
  readonly phase2CompactionCount: number;
}

/** One arm's aggregated metrics across all channels it produced. */
export interface ArmMetrics {
  readonly binary: Readonly<Partial<Record<MetricId, BinaryRateResult>>>;
  readonly exact: {
    readonly C1?: CiResult;
    readonly C2?: C2Metric;
    readonly C3?: CiResult | C3CostMetric;
    readonly C4?: C4Metric;
  };
  /** Per-probe detail passed through from the grades (no aggregation). */
  readonly probes?: readonly ProbeGrades[];
}

/** All run grades the aggregator consumes (per-arm binary/exact + cross-arm comparative). */
export interface AllArmsGrades {
  readonly arms: Readonly<Partial<Record<ArmId, ArmRunGrades>>>;
  readonly comparative?: Readonly<Partial<Record<MetricId, readonly ArmRanking[]>>>;
  /** The enabled arms (defaults to the keys of `arms`); drives comparative ranking. */
  readonly enabledArms?: readonly ArmId[];
}

/** The full aggregate: per-arm metrics + cross-arm comparative axis results. */
export interface AggregateResult {
  readonly arms: Readonly<Partial<Record<ArmId, ArmMetrics>>>;
  readonly comparative: Readonly<Partial<Record<MetricId, ComparativeAxisResult>>>;
}

/** The mode of an array of string-arrays (most common, ties → first-seen). [] if empty. */
function modeStages(perRun: readonly (readonly string[])[]): readonly string[] {
  if (perRun.length === 0) return [];
  const counts = new Map<string, { count: number; first: readonly string[] }>();
  for (const stages of perRun) {
    const key = JSON.stringify(stages);
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, { count: 1, first: stages });
    } else {
      existing.count += 1;
    }
  }
  let best = { count: 0, first: [] as readonly string[] };
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  return best.first;
}

/** Recall-cost aggregate: mean over recovered runs + not-recovered rate. */
function aggregateC2(results: readonly C2Result[], options: BootstrapOptions | null): C2Metric | undefined {
  if (results.length === 0) return undefined;
  const recovered = results.filter((r) => !r.notRecovered);
  const notRecoveredCount = results.length - recovered.length;
  const notRecoveredRate = notRecoveredCount / results.length;
  if (recovered.length === 0) {
    return { mean: null, ci: null, notRecoveredRate };
  }
  const { ci } = bootstrapCi(
    recovered.map((r) => r.tokens),
    options,
  );
  return { mean: mean(recovered.map((r) => r.tokens)), ci, notRecoveredRate };
}

/** Aggregate per-run results: mean of numeric fields + mode stages + mean phase-2 count. */
function aggregateC4(results: readonly C4Result[], options: BootstrapOptions | null): C4Metric | undefined {
  void options;
  if (results.length === 0) return undefined;
  const fieldMean = (select: (c: C4Result) => number): number => mean(results.map(select));
  return {
    tokensIn: fieldMean((c) => c.tokensIn),
    tokensOut: fieldMean((c) => c.tokensOut),
    cacheRead: fieldMean((c) => c.cacheRead),
    cacheWrite: fieldMean((c) => c.cacheWrite),
    dollars: fieldMean((c) => c.dollars),
    wallMs: fieldMean((c) => c.wallMs),
    stages: modeStages(results.map((c) => c.stages)),
    phase2CompactionCount: mean(results.map((c) => c.phase2Compactions.length)),
  };
}

/**
 * Aggregate ALL channels from the per-run grades into per-arm metrics + cross-arm
 * comparative results. Routes each metric to its channel shape: binary →
 * `binaryRate`; comparative → `aggregateRanks` (over `enabledArms`, default the
 * arms present); exact footprint/run-cost → `bootstrapCi` mean+CI; recall-cost → mean-over-recovered +
 * notRecoveredRate; compaction-cost → mean-fields + mode-stages + mean phase-2 count.
 * Deterministic given the seed. Pure.
 */
export function aggregateArmMetrics(grades: AllArmsGrades, options: BootstrapOptions | null): AggregateResult {
  const arms = {} as Partial<Record<ArmId, ArmMetrics>>;
  for (const [armId, armGrades] of Object.entries(grades.arms) as [ArmId, ArmRunGrades][]) {
    const binary: Partial<Record<MetricId, BinaryRateResult>> = {};
    if (armGrades.binary !== undefined) {
      for (const [metricId, passes] of Object.entries(armGrades.binary) as [MetricId, readonly boolean[]][]) {
        binary[metricId] = binaryRate(passes, options);
      }
    }
    // Build the exact map mutably (its fields are readonly on the public type).
    const exact: { C1?: CiResult; C2?: C2Metric; C3?: CiResult | C3CostMetric; C4?: C4Metric } = {};
    const ex = armGrades.exact;
    if (ex?.C1 !== undefined && ex.C1.length > 0) exact.C1 = bootstrapCi(ex.C1, options);
    if (ex?.C3 !== undefined && ex.C3.length > 0) {
      exact.C3 =
        typeof ex.C3[0] === "object"
          ? {
              // pooled per-answer means: total $/wall over total answers across runs
              dollars:
                sumField(ex.C3 as readonly ProbeCostSample[], "dollars") /
                sumField(ex.C3 as readonly ProbeCostSample[], "answers"),
              wallMs:
                sumField(ex.C3 as readonly ProbeCostSample[], "wallMs") /
                sumField(ex.C3 as readonly ProbeCostSample[], "answers"),
              answers: sumField(ex.C3 as readonly ProbeCostSample[], "answers"),
            }
          : bootstrapCi(ex.C3 as readonly number[], options);
    }
    if (ex?.C2 !== undefined) {
      const c2 = aggregateC2(ex.C2, options);
      if (c2 !== undefined) exact.C2 = c2;
    }
    if (ex?.C4 !== undefined) {
      const c4 = aggregateC4(ex.C4, options);
      if (c4 !== undefined) exact.C4 = c4;
    }
    arms[armId] = armGrades.probes === undefined ? { binary, exact } : { binary, exact, probes: armGrades.probes };
  }

  const comparative: Partial<Record<MetricId, ComparativeAxisResult>> = {};
  if (grades.comparative !== undefined) {
    const enabled = grades.enabledArms ?? (Object.keys(grades.arms) as ArmId[]);
    for (const [metricId, rankings] of Object.entries(grades.comparative) as [MetricId, readonly ArmRanking[]][]) {
      comparative[metricId] = aggregateRanks(rankings, enabled, options);
    }
  }

  return { arms, comparative };
}
