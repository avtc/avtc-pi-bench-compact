// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared formatting primitives for the report (headline markdown + cross-run
// comparison). Pure helpers — no I/O, no state. Kept here so the two renderers
// format metric values + polarity-aware deltas identically (single source of
// truth for the operator-facing number formatting).

import type { MetricPolarity } from "../metrics/defs.js";
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
  return String(n);
}

/** Format a signed integer delta ([+52] / [-14]). */
export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
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

/** Format a metric's bare value (no delta): 62% / 1 / $0.03 / 1.2K / n/a. */
export function formatMetricValue(v: MetricJson): string {
  if ("rate" in v) return `${pct(v.rate)} [${pct(v.ci[0])}–${pct(v.ci[1])}]`;
  if ("rank" in v) return String(v.rank);
  if ("dollars" in v) return `$${v.dollars}`;
  if ("notRecoveredRate" in v) return v.mean === null ? "n/a" : count(v.mean);
  return count(v.mean); // exact footprint / run-cost
}

/** Render the polarity-aware delta suffix for a metric cell: " [+52]" / " [-14]⚠" / "".
 *  `delta` is the polarity-NORMALIZED delta (positive = better) from a1Delta.
 *  Binary rate-deltas render as percentage points; comparative/exact as raw ints. */
export function formatDeltaSuffix(delta: number, v: MetricJson): string {
  let deltaStr: string;
  if ("rate" in v)
    deltaStr = `[${signed(Math.round(delta * 100))}]`; // percentage points
  else if ("rank" in v)
    deltaStr = `[${signed(delta)}]`; // rank points
  else deltaStr = `[${signed(Math.round(delta))}]`; // raw count
  const flag = delta < 0 ? "⚠" : ""; // net-negative (worse than baseline)
  return ` ${deltaStr}${flag}`;
}
