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
type MetricChannel = "exact" | "binary" | "comparative";

/** Polarity: which direction is better (drives the baseline-delta sign + net-negative). */
export type MetricPolarity = "lowerBetter" | "higherBetter" | "rankLowerBetter";

/** The canonical metric identifiers (the keys of METRIC_DEFS). */
export type MetricId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E10" | "C1" | "C2" | "C3" | "C4";

/** The binary-axis metric ids (judge per-run yes/no → rate over N). */
export const BINARY_METRICS: readonly MetricId[] = ["E2", "E4", "E5", "E6", "E8"];
/** The comparative-axis metric ids (judge ranks the enabled arms per axis). */
export const COMPARATIVE_METRICS: readonly MetricId[] = ["E1", "E3", "E7", "E10"];
/** The exact metric ids (no judge; computed off the trace). */
export const EXACT_METRICS: readonly MetricId[] = ["C1", "C2", "C3", "C4"];

/** Static metadata for one metric (name, channel, polarity, human description). */
export interface MetricDef {
  readonly name: string;
  readonly channel: MetricChannel;
  readonly polarity: MetricPolarity;
  readonly desc: string;
}

/**
 * The authoritative metric definitions for ALL channels (binary, comparative,
 * exact) — the single source consumed by the statistics + reporting layers; the
 * result schema embeds a copy so every result is self-describing. Binary axes
 * carry a `lowerBetter`/`higherBetter` polarity (rate direction); comparative
 * axes are `rankLowerBetter` (rank 1 = best); exact axes are all `lowerBetter`
 * (lower cost is better).
 *
 * Footprint tokens are estimated as summary chars divided by the shared
 * chars-per-token constant (noted in the footprint description so cross-arm /
 * cross-run comparisons use one estimate).
 */
export const METRIC_DEFS: Record<MetricId, MetricDef> = {
  E1: {
    name: "resume",
    channel: "comparative",
    polarity: "rankLowerBetter",
    desc: "resumes in-progress task → next planned step",
  },
  E2: {
    name: "redo-exec",
    channel: "binary",
    polarity: "lowerBetter",
    desc: "re-executes completed work (rate)",
  },
  E3: {
    name: "redo-plan",
    channel: "comparative",
    polarity: "rankLowerBetter",
    desc: "re-proposes tried/rejected approaches",
  },
  E4: {
    name: "proactive-recall",
    channel: "binary",
    polarity: "higherBetter",
    desc: "uses a needed fact unprompted (rate)",
  },
  E5: {
    name: "recall-accuracy",
    channel: "binary",
    polarity: "higherBetter",
    desc: "direct-probe answer correct vs accept[] (rate)",
  },
  E6: {
    name: "abstention",
    channel: "binary",
    polarity: "higherBetter",
    desc: "declines vs fabricates; flags stale (rate)",
  },
  E7: {
    name: "task-quality",
    channel: "comparative",
    polarity: "rankLowerBetter",
    desc: "resumed+continued work quality",
  },
  E8: {
    name: "supersession",
    channel: "binary",
    polarity: "higherBetter",
    desc: "uses latestValue, suppresses oldValue (rate)",
  },
  E10: {
    name: "goal",
    channel: "comparative",
    polarity: "rankLowerBetter",
    desc: "stays on scripted goal, no wandering",
  },
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
