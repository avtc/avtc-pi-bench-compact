// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:results <runId>[:arms] [<runId2>[:arms2] …]` command.
// Parses the run refs (commands/parse.ts), loads each run's result-JSON, and
// dispatches: a SINGLE run → the headline report; MULTIPLE runs → the cross-run
// comparison (with the prior-baseline path). An optional `:arms` suffix
// filters a single run's report to the selected arms (deselecting the baseline
// arm → its delta omitted). The orchestrator is PURE + injectable
// (loadResultJson seam); the command registration wires the real file-reading
// loader + writes the rendered report under the run dir, then notifies the path.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import type { ArmId } from "../config/types.js";
import type { MetricId } from "../metrics/defs.js";
import { renderComparison } from "../report/compare.js";
import { renderHeadline } from "../report/markdown.js";
import { mergeResultJsons } from "../report/merge.js";
import type { ArmResultJson, BenchResultJson, RankAxisJson } from "../report/result-json.js";
import { benchRoot, runDir } from "../storage/paths.js";
import { parseResultsArgs } from "./parse.js";

/** Injectable result-JSON loader (one run's result, by runId). */
export interface ResultsSeams {
  /** Load a run's result-JSON by runId; return undefined if not found / unreadable. */
  loadResultJson(runId: string): BenchResultJson | undefined;
}

/** The orchestrator outcome: the rendered report (success) OR an error message.
 *  `runIds` is always populated from parsing (even on load error) so the handler
 *  need not re-parse to locate the first run's dir. */
export interface ResultsOutcome {
  readonly report: string | undefined;
  readonly error: string | undefined;
  readonly runIds: readonly string[];
  /** Which file this rendering belongs in — the canonical run report is only ever
   * a full single-run rendering; subset + comparison renderings get their own
   * siblings so re-rendering never clobbers the frozen artifact. */
  readonly reportFile: "report.md" | "report-arms.md" | "report-compare.md" | "report-merged.md";
}

/**
 * Pure orchestrator: parse args → load result-JSONs → dispatch render. Single
 * run → headline report (honoring an `:arms` subset by filtering arms); multiple
 * runs → cross-run comparison. Returns the report or an error message.
 */
export function runResultsCommand(args: string, seams: ResultsSeams): ResultsOutcome {
  const parsed = parseResultsArgs(args);
  if (parsed.error !== undefined)
    return { report: undefined, error: parsed.error, runIds: [], reportFile: "report.md" };
  const refs = parsed.runs;
  if (refs.length === 0)
    return {
      report: undefined,
      error: "results requires at least one runId",
      runIds: [],
      reportFile: "report.md",
    };
  const runIds = refs.map((r) => r.runId);

  // Load every referenced run's result-JSON (fail fast on the first missing one).
  const loaded: BenchResultJson[] = [];
  for (const ref of refs) {
    const result = seams.loadResultJson(ref.runId);
    if (result === undefined) {
      return {
        report: undefined,
        error: `run results not found for "${ref.runId}" (expected results.json under runs/${ref.runId}/)`,
        runIds,
        reportFile: "report.md",
      };
    }
    loaded.push(result);
  }

  if (loaded.length === 1) {
    const subset = refs[0].arms !== undefined;
    const report = renderHeadline(filterResultArms(loaded[0], refs[0].arms));
    return { report, error: undefined, runIds, reportFile: subset ? "report-arms.md" : "report.md" };
  }
  // --merge: combine the runs' arm subsets into ONE full headline report (the
  // scoped re-run workflow: baseline arms from an earlier run + re-compact arms
  // from a fresh scoped run). Falls back to the per-metric comparison without it.
  if (parsed.merge) {
    const merged = mergeResultJsons(
      loaded.map((result, i) => ({ runId: runIds[i] ?? "", result, arms: refs[i]?.arms })),
    );
    if (!merged.ok) {
      return { report: undefined, error: merged.error, runIds, reportFile: "report.md" };
    }
    return { report: renderHeadline(merged.merged), error: undefined, runIds, reportFile: "report-merged.md" };
  }
  const report = renderComparison(
    loaded,
    refs.map((r) => ({ runId: r.runId, arms: r.arms })),
  );
  return { report, error: undefined, runIds, reportFile: "report-compare.md" };
}

/**
 * Filter a single run's result-JSON to an arm subset (undefined = all). Filters
 * `arms` + `ranks.order` so the headline report shows only the selected arms;
 * deselecting the baseline arm makes its delta absent (the report derives
 * it from presence).
 */
function filterResultArms(result: BenchResultJson, arms: readonly ArmId[] | undefined): BenchResultJson {
  if (arms === undefined) return result; // no subset = all arms
  const keep = new Set<ArmId>(arms);
  const filteredArms: Partial<Record<ArmId, ArmResultJson>> = {};
  for (const [arm, data] of Object.entries(result.arms) as [ArmId, ArmResultJson | undefined][]) {
    if (data !== undefined && keep.has(arm)) filteredArms[arm] = data;
  }
  const filteredRanks: Partial<Record<MetricId, RankAxisJson>> = {};
  for (const [axis, rank] of Object.entries(result.ranks) as [MetricId, RankAxisJson | undefined][]) {
    if (rank === undefined) continue;
    filteredRanks[axis] = { order: rank.order.filter((a) => keep.has(a)), elo: rank.elo };
  }
  return { ...result, arms: filteredArms, ranks: filteredRanks };
}

/** Register the `/bench-compact:results` command with the real file-reading loader. */
export function registerResultsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("bench-compact:results", {
    description:
      "Render the headline report for <runId>[:arms] (compare multiple runs; --merge combines runs' arm subsets into one full report).",
    handler: async (args, ctx) => {
      const root = benchRoot(getBenchConfig().outputDir);
      const seams: ResultsSeams = {
        loadResultJson: (runId) => {
          const file = path.join(runDir(root, runId), "results.json");
          try {
            return JSON.parse(readFileSync(file, "utf8")) as BenchResultJson;
          } catch {
            return undefined;
          }
        },
      };
      const outcome = runResultsCommand(args, seams);
      if (outcome.error !== undefined) {
        ctx.ui.notify(outcome.error, "warning");
        return;
      }
      // Write the rendering next to the (first) run's results.json + notify the
      // path. A FULL single-run rendering regenerates the canonical report.md;
      // subset + comparison renderings go to their own siblings — the run's frozen
      // canonical report is never clobbered by a filtered or derived variant.
      const firstRunId = outcome.runIds[0] ?? "unknown";
      const dir = runDir(root, firstRunId);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, outcome.reportFile);
      writeFileSync(file, `${outcome.report}\n`, "utf8");
      ctx.ui.notify(`report written: ${file}`, "info");
    },
  });
}
