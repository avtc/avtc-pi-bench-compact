// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The cross-run comparison report (markdown) from /bench-compact:results with
// multiple run refs. Renders a CONFIG DIFF across the selected runs on top
// (config fields + per-arm tool versions), then a per-arm metric table where
// each selected (runId·arm) is a column and every non-first-run cell carries a
// polarity-aware Δ suffix against its baseline.
//
// Baseline resolution per cell (the first run is the reference run):
//   1. the SAME arm in run0 (Δ run0·arm → run_i·arm — e.g. one tool version vs
//      another); else
//   2. run0's baseline arm when present + this cell's arm differs (CR-5: a prior
//      run's baseline serves as the floor so a dev re-running only the memory
//      arms can reuse it); else
//   3. no baseline → no Δ for that cell.
// The Δ is DERIVED LIVE from the exact values + metricDefs.polarity (not stored),
// reusing stats/delta.ts a1Delta (positive = better than baseline; ⚠ net-negative).

import type { ArmId } from "../config/types.js";
import type { MetricId } from "../metrics/defs.js";
import { a1Delta } from "../stats/delta.js";
import { formatDeltaSuffix, formatMetricValue, polarityArrow, versionTag } from "./format.js";
import type { BenchResultJson, MetricJson } from "./result-json.js";
import { extractJsonScalars } from "./result-json.js";

/** A run reference for comparison: a runId + optional arm subset (all arms if undefined). */
export interface RunSelection {
  readonly runId: string;
  readonly arms?: readonly ArmId[];
}

/** One column in the comparison table: a selected (run, arm) pair. */
interface ComparisonCell {
  readonly runIndex: number;
  readonly runId: string;
  readonly arm: ArmId;
  readonly tool: string;
  readonly scalars: Readonly<Partial<Record<MetricId, number | null>>>;
  readonly metrics: Readonly<Partial<Record<MetricId, MetricJson>>>;
}

/** The canonical metric display order (mirrors the headline report). */
const METRIC_ORDER: readonly MetricId[] = [
  "E2",
  "E4",
  "E5",
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

/** Config fields compared in the diff (in display order). */
const CONFIG_FIELDS: readonly (keyof BenchResultJson["config"])[] = [
  "evaluatedModel",
  "evaluatedThinkingLevel",
  "judgeModel",
  "judgeThinkingLevel",
  "N",
  "compactionBoundary",
  "backupMode",
  "omFullReflectionThresholdTokens",
  "armsEnabled",
];

/** Build the comparison cells from the loaded results + selections (positional). */
function buildCells(results: readonly BenchResultJson[], selections: readonly RunSelection[]): ComparisonCell[] {
  const cells: ComparisonCell[] = [];
  results.forEach((result, runIndex) => {
    const sel = selections[runIndex];
    const armIds = sel?.arms ?? (Object.keys(result.arms) as ArmId[]);
    for (const arm of armIds) {
      const armData = result.arms[arm];
      if (armData === undefined) continue; // selection named an arm absent from this run
      cells.push({
        runIndex,
        runId: result.runId,
        arm,
        tool: armData.tool,
        scalars: extractJsonScalars(armData.metrics),
        metrics: armData.metrics,
      });
    }
  });
  return cells;
}

/** Resolve a cell's baseline (the run0 cell it is compared against), or undefined. */
function resolveBaseline(cell: ComparisonCell, run0Cells: readonly ComparisonCell[]): ComparisonCell | undefined {
  if (cell.runIndex === 0) return undefined; // run0 cells ARE the baseline
  const sameArm = run0Cells.find((c) => c.arm === cell.arm);
  if (sameArm !== undefined) return sameArm; // Δ run0·arm → run_i·arm
  if (cell.arm !== "A1") {
    const baseline = run0Cells.find((c) => c.arm === "A1"); // CR-5: prior baseline as floor
    if (baseline !== undefined) return baseline;
  }
  return undefined;
}

/** Render the config diff across runs (config fields + per-arm tool versions). */
function renderConfigDiff(results: readonly BenchResultJson[]): string[] {
  const lines: string[] = ["## Config diff"];
  const runIds = results.map((r) => r.runId);
  let diffs = 0;
  for (const field of CONFIG_FIELDS) {
    const vals = results.map((r) => r.config[field]);
    const allEqual = vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]));
    if (!allEqual) {
      const rendered = runIds.map((id, i) => `${id}=${JSON.stringify(vals[i])}`).join(" · ");
      lines.push(`- ${field}: ${rendered}`);
      diffs++;
    }
  }
  // Per-arm tool versions (union of arms across runs).
  const allArms = new Set<ArmId>();
  for (const r of results) for (const a of Object.keys(r.toolVersions) as ArmId[]) allArms.add(a);
  for (const arm of allArms) {
    const tags = results.map((r) => versionTag(r.toolVersions[arm]));
    if (!tags.every((t) => t === tags[0])) {
      const rendered = runIds.map((id, i) => `${id}=${tags[i] || "(none)"}`).join(" · ");
      lines.push(`- ${arm} toolVersion: ${rendered}`);
      diffs++;
    }
  }
  if (diffs === 0) lines.push("(all config + tool-version fields match across runs)");
  return lines;
}

/** Render the full cross-run comparison report. Pure. */
export function renderComparison(results: readonly BenchResultJson[], selections: readonly RunSelection[]): string {
  const cells = buildCells(results, selections);
  const lines: string[] = [];
  const run0Cells = cells.filter((c) => c.runIndex === 0);
  const metricDefs = results[0]?.metricDefs ?? ({} as BenchResultJson["metricDefs"]);

  lines.push(`# bench-compact comparison — ${results.map((r) => r.runId).join(" vs ")}`);
  lines.push("");

  // --- Config diff ---
  lines.push(...renderConfigDiff(results));
  lines.push("");

  // --- Per-arm metric table ---
  lines.push(
    "## Metric comparison   (Δ suffix per cell vs its baseline: run0 same-arm (tool-version diff), else run0 baseline arm (CR-5); + = better; net-negative flagged)",
  );
  const header = `| Metric | ${cells.map((c) => `${c.runId}·${c.arm}`).join(" | ")} |`;
  const sep = `|---|${cells.map(() => "---").join("|")}|`;
  lines.push(header);
  lines.push(sep);
  const presentMetrics = METRIC_ORDER.filter((m) => cells.some((c) => c.metrics[m] !== undefined));
  for (const metric of presentMetrics) {
    const def = metricDefs[metric];
    const polarity = def?.polarity ?? "lowerBetter";
    const chan = def?.channel ?? "exact";
    const arrow = polarityArrow(polarity);
    const label = `${metric} ${def?.name ?? ""}${chan === "comparative" ? " (rank)" : arrow ? ` (${arrow})` : ""}`;
    const renderedCells = cells.map((c) => {
      const mv = c.metrics[metric];
      if (mv === undefined) return "—";
      let val = formatMetricValue(mv);
      const baseline = resolveBaseline(c, run0Cells);
      if (baseline !== undefined) {
        const delta = a1Delta(c.scalars, baseline.scalars, metricDefs)[metric];
        if (delta !== undefined && delta !== null) val += formatDeltaSuffix(delta, mv);
      }
      return val;
    });
    lines.push(`| ${label} | ${renderedCells.join(" | ")} |`);
  }
  return lines.join("\n");
}
