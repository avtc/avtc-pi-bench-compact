// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared formatting primitives for the report (headline markdown + cross-run
// comparison). Pure helpers — no I/O, no state. Kept here so the two renderers
// format metric values + polarity-aware deltas identically (single source of
// truth for the operator-facing number formatting).

import type { MetricId, MetricPolarity } from "../metrics/defs.js";
import { isNetNegative } from "../stats/delta.js";
import type { MetricJson } from "./result-json.js";

/** Format a rate ∈[0,1] as a percentage with no decimals (62%). */
export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Format a large count with a K/M suffix (1200 -> 1.2K, 2_400_000 -> 2.4M). */
export function count(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n)); // means are fractional — render whole units
}

/** Format a signed integer delta ([+52] / [-14]). */
export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Sign-prefixed count (K/M-suffixed): +400 / -7.2K / +0. For exact token deltas. */
export function signedCount(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "+";
  return `${sign}${count(Math.abs(n))}`;
}

/** Sign-prefixed dollar delta (3 decimals): +$0.011 / -$0.033 / +$0.000. For compaction-cost deltas. */
export function signedDollars(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "+";
  return `${sign}${dollars(Math.abs(n))}`;
}

/** Bare dollar value (3 decimals): $0.034 / $0.035. Shared by the results-table cell
 *  + the compaction-cost breakdown so both render dollars identically. */
export function dollars(n: number): string {
  return `$${n.toFixed(3)}`;
}

/** The polarity arrow for a metric label (↓ lower-better, ↑ higher-better). */
export function polarityArrow(polarity: MetricPolarity): string {
  if (polarity === "higherBetter") return "↑";
  if (polarity === "lowerBetter") return "↓";
  return ""; // rankLowerBetter — label says "(rank)"
}

/** The short tool-version tag (git commit prefix or npm version), "" if absent. */
export function versionTag(v: { source: string; commit: string; full?: string } | undefined): string {
  if (v === undefined) return "";
  return v.commit;
}

/** The canonical metric display order (binary, comparative, then exact). Shared by
 *  the headline + comparison so both render metrics in the same order. */
export const METRIC_ORDER: readonly MetricId[] = [
  "E2",
  "E4",
  "E5.1",
  "E5.2",
  "E5.3",
  "E6",
  "E8",
  "E1",
  "E3",
  "E7",
  "E10",
  "C1",
  "C3",
  "C2",
  "C4",
];

/** Format a metric's bare value (no delta): 62% / 1 / $0.03/41s / 1.2K / n/a. */
export function formatMetricValue(v: MetricJson): string {
  if ("rate" in v) return `${pct(v.rate)} [${pct(v.ci[0])}–${pct(v.ci[1])}]`;
  if ("rank" in v) return String(v.rank);
  if ("dollars" in v) return `${dollars(v.dollars)}/${Math.round(v.wallMs / 1000)}s`; // $/wall (compaction-cost row, 3-decimal $)
  if ("notRecoveredRate" in v) return v.mean === null ? "n/a" : count(v.mean);
  return count(v.mean); // exact footprint / run-cost
}

/** Render the raw delta suffix for a metric cell: " [+52]" / " [-7.2K]" / " [-2.6K]⚠" /
 *  "". The bracket is the RAW difference (this arm − baseline) in the metric's
 *  natural unit; `delta` is the polarity-NORMALIZED delta (positive = better) from
 *  a1Delta — ⚠ flags net-negative (worse), and ↓ metrics flip its sign for display
 *  (smaller footprint → negative bracket). Binary rate-deltas render as percentage
 *  points; comparative as rank points; exact token deltas as K/M-suffixed counts;
 *  compaction-cost as cents. */
export function formatDeltaSuffix(delta: number, v: MetricJson): string {
  let deltaStr: string;
  if ("rate" in v)
    deltaStr = `[${signed(Math.round(delta * 100))}]`; // percentage points (↑: raw = normalized)
  else if ("rank" in v)
    deltaStr = `[${signed(-delta)}]`; // rank points (↓: raw = arm − baseline)
  else if ("dollars" in v)
    deltaStr = `[${signedDollars(-delta)}]`; // compaction-cost (↓: raw dollars)
  else deltaStr = `[${signedCount(-delta)}]`; // footprint/run-cost tokens (↓: raw = arm − baseline)
  const flag = isNetNegative(delta) ? "⚠" : ""; // net-negative (worse than baseline)
  return ` ${deltaStr}${flag}`;
}
