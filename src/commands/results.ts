// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:results <runId>[:arms] [<runId2>[:arms2] …]` command.
// Parses the run refs (commands/parse.ts), loads each run's result-JSON, and
// dispatches: a SINGLE run → the headline report; MULTIPLE runs → the cross-run
// comparison (with the CR-5 prior-baseline path). An optional `:arms` suffix
// filters a single run's report to the selected arms (deselecting the baseline
// arm → its delta omitted, per CR-5). The orchestrator is PURE + injectable
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
import type { ArmResultJson, BenchResultJson, RankAxisJson } from "../report/result-json.js";
import { runDir } from "../storage/paths.js";
import { parseResultsArgs } from "./parse.js";

/** Injectable result-JSON loader (one run's result, by runId). */
export interface ResultsSeams {
  /** Load a run's result-JSON by runId; return undefined if not found / unreadable. */
  loadResultJson(runId: string): BenchResultJson | undefined;
}

/** The orchestrator outcome: the rendered report (success) OR an error message. */
export interface ResultsOutcome {
  readonly report: string | undefined;
  readonly error: string | undefined;
}

/**
 * Pure orchestrator: parse args → load result-JSONs → dispatch render. Single
 * run → headline report (honoring an `:arms` subset by filtering arms); multiple
 * runs → cross-run comparison. Returns the report or an error message.
 */
export function runResultsCommand(args: string, seams: ResultsSeams): ResultsOutcome {
  const parsed = parseResultsArgs(args);
  if (parsed.error !== undefined) return { report: undefined, error: parsed.error };
  const refs = parsed.runs;
  if (refs.length === 0) return { report: undefined, error: "results requires at least one runId" };

  // Load every referenced run's result-JSON (fail fast on the first missing one).
  const loaded: BenchResultJson[] = [];
  for (const ref of refs) {
    const result = seams.loadResultJson(ref.runId);
    if (result === undefined) {
      return {
        report: undefined,
        error: `run results not found for "${ref.runId}" (expected results.json under ~/.pi/bench-compact/runs/${ref.runId}/)`,
      };
    }
    loaded.push(result);
  }

  if (loaded.length === 1) {
    const report = renderHeadline(filterResultArms(loaded[0], refs[0].arms));
    return { report, error: undefined };
  }
  const report = renderComparison(
    loaded,
    refs.map((r) => ({ runId: r.runId, arms: r.arms })),
  );
  return { report, error: undefined };
}

/**
 * Filter a single run's result-JSON to an arm subset (undefined = all). Filters
 * `arms` + `ranks.order` so the headline report shows only the selected arms;
 * deselecting the baseline arm makes its delta absent (CR-5 — the report derives
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
    description: "Render the headline report for <runId>[:arms] (compare multiple).",
    handler: async (args, ctx) => {
      const root = resolveBenchRoot();
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
      // Write the rendered report next to the (first) run's results.json + notify the path.
      const parsed = parseResultsArgs(args);
      const firstRunId = parsed.runs[0]?.runId ?? "unknown";
      const dir = runDir(root, firstRunId);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "report.md");
      writeFileSync(file, `${outcome.report}\n`, "utf8");
      ctx.ui.notify(`report written: ${file}`, "info");
    },
  });
}

/** Resolve the bench root (outputDir ?? ~/.pi/bench-compact/) from the bench config. */
function resolveBenchRoot(): string {
  // The bench root defaults to ~/.pi/bench-compact/ unless outputDir is set in config.
  const outputDir = getBenchConfig().outputDir;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return outputDir ?? path.join(home, ".pi", "bench-compact");
}
