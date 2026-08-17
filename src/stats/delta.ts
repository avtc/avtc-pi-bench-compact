// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Baseline-delta derivation. The report surfaces a per-metric ΔvsBaseline that
// is POLARITY-AWARE: positive = the arm is BETTER than the baseline on that
// metric, negative = worse (net-negative). Deltas are CONDITIONAL on the baseline
// arm being present: if it is disabled (or didn't produce a metric, or the arm's
// value is null/NaN), the delta is null — the report then omits the delta /
// net-negative for that metric (conditional attribution). All functions PURE.
//
// The comparable SCALAR per metric: binary → rate; exact footprint/run-cost → mean;
// recall-cost → mean
// (null when all runs notRecovered); compaction-cost → dollars (the headline cost);
// comparative → rank (1=best). Polarity maps the raw difference to the
// "better-than-baseline" sign.

import type { ArmId } from "../config/types.js";
import type { MetricId, MetricPolarity } from "../metrics/defs.js";
import type { AggregateResult, ArmMetrics } from "./aggregate.js";

/** Per-metric -delta (positive = better than; null when not computable). */
export type PerMetricDelta = Readonly<Partial<Record<MetricId, number | null>>>;

/** Extract the comparable scalar for every metric an arm produced. */
export function extractArmScalars(
  armId: ArmId,
  armMetrics: ArmMetrics,
  comparative: AggregateResult["comparative"],
): Partial<Record<MetricId, number | null>> {
  const scalars: Partial<Record<MetricId, number | null>> = {};
  for (const [metricId, m] of Object.entries(armMetrics.binary) as [MetricId, { rate: number }][]) {
    scalars[metricId] = m.rate;
  }
  if (armMetrics.exact.C1 !== undefined) scalars.C1 = armMetrics.exact.C1.mean;
  if (armMetrics.exact.C3 !== undefined)
    scalars.C3 = "mean" in armMetrics.exact.C3 ? armMetrics.exact.C3.mean : armMetrics.exact.C3.dollars;
  if (armMetrics.exact.C2 !== undefined) scalars.C2 = armMetrics.exact.C2.mean;
  if (armMetrics.exact.C4 !== undefined) scalars.C4 = armMetrics.exact.C4.dollars;
  for (const [metricId, axis] of Object.entries(comparative) as [
    MetricId,
    AggregateResult["comparative"][MetricId],
  ][]) {
    if (axis === undefined) continue;
    const rank = axis.ranks[armId]?.rank;
    if (rank !== undefined) scalars[metricId] = rank;
  }
  return scalars;
}

/** Polarity-aware difference (positive = `armValue` better than `a1Value`). */
function polarityAwareDelta(
  armValue: number | null,
  a1Value: number | null,
  polarity: MetricPolarity | undefined,
): number | null {
  if (armValue === null || a1Value === null) return null;
  if (typeof armValue !== "number" || typeof a1Value !== "number") return null;
  if (Number.isNaN(armValue) || Number.isNaN(a1Value)) return null;
  if (polarity === undefined) return null;
  switch (polarity) {
    case "higherBetter":
      return armValue - a1Value;
    case "lowerBetter":
      return a1Value - armValue;
    case "rankLowerBetter":
      return a1Value - armValue;
    default:
      return null;
  }
}

/**
 * Per-metric -delta (polarity-aware; + = better than). Iterates the union of
 * the arm's + 's metric ids; each delta is null when either side is absent/null
 * /NaN (so disabling yields all-null deltas — conditional attribution). Pure.
 */
export function a1Delta(
  armScalars: Readonly<Partial<Record<MetricId, number | null>>>,
  a1Scalars: Readonly<Partial<Record<MetricId, number | null>>>,
  metricDefs: Readonly<Record<MetricId, { polarity: MetricPolarity }>>,
): PerMetricDelta {
  const delta: Partial<Record<MetricId, number | null>> = {};
  const ids = new Set<MetricId>([
    ...(Object.keys(armScalars) as MetricId[]),
    ...(Object.keys(a1Scalars) as MetricId[]),
  ]);
  for (const metricId of ids) {
    const armValue = armScalars[metricId] ?? null;
    const a1Value = a1Scalars[metricId] ?? null;
    delta[metricId] = polarityAwareDelta(armValue, a1Value, metricDefs[metricId]?.polarity);
  }
  return delta;
}

/** Net-negative = the delta is a real negative number (arm worse than). */
export function isNetNegative(delta: number | null): boolean {
  return delta !== null && delta < 0;
}
