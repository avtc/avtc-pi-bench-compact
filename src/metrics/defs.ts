// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Metric definitions for the exact (no-judge) cost channel. The exact metrics
// are all "lower is better" (lower cost is better) and are computed
// deterministically off the captured trace. This is the authoritative metadata
// consumed by the statistics + reporting layers; the result schema embeds a
// copy so every result is self-describing.
//
// The footprint metric's description pins the token estimate: the injected
// summary's token count is chars divided by the shared chars-per-token constant
// (the same estimate the live widget + the runtime fallback use), so the
// footprint number is comparable across arms and across runs.

/** The scoring channel a metric flows through. */
export type MetricChannel = "exact" | "binary" | "comparative";

/** Polarity: which direction is better (drives the baseline-delta sign + net-negative). */
export type MetricPolarity = "lowerBetter" | "higherBetter" | "rankLowerBetter";

/** Static metadata for one metric (name, channel, polarity, human description). */
export interface MetricDef {
  readonly name: string;
  readonly channel: MetricChannel;
  readonly polarity: MetricPolarity;
  readonly desc: string;
}

/**
 * The exact-cost metric definitions. Footprint tokens are estimated as summary
 * chars divided by the shared chars-per-token constant (noted in the footprint
 * description so cross-arm/cross-run comparisons use one estimate).
 */
export const METRIC_DEFS: Record<string, MetricDef> = {
  C1: {
    name: "footprint",
    channel: "exact",
    polarity: "lowerBetter",
    desc: "tokens the summary injects (estimated as summary chars divided by the shared chars-per-token constant)",
  },
  C2: {
    name: "recall-cost",
    channel: "exact",
    polarity: "lowerBetter",
    desc: "tokens spent recovering forgotten info (the judge identifies the first-correct-use boundary; the harness sums tokens up to it)",
  },
  C3: {
    name: "run-cost",
    channel: "exact",
    polarity: "lowerBetter",
    desc: "tokens generated from compaction to done (sum of post-compaction assistant output tokens)",
  },
  C4: {
    name: "compaction-cost",
    channel: "exact",
    polarity: "lowerBetter",
    desc: "compaction tokens (in/out/cacheRead/cacheWrite) plus dollars and wall-clock, summed across every compaction",
  },
};
