// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type ResultsSeams, runResultsCommand } from "../../src/commands/results.js";
import type { ArmId } from "../../src/config/types.js";
import { METRIC_DEFS } from "../../src/metrics/defs.js";
import type { ArmResultJson, BenchResultJson, MetricJson } from "../../src/report/result-json.js";

/** A minimal result-JSON with one arm (configurable) for dispatch testing. */
function mkResult(
  runId: string,
  arms: Partial<Record<ArmId, { tool: string; metrics?: Partial<Record<string, MetricJson>> }>>,
): BenchResultJson {
  const armsJson: Partial<Record<ArmId, ArmResultJson>> = {};
  for (const [arm, spec] of Object.entries(arms) as [
    ArmId,
    { tool: string; metrics?: Partial<Record<string, MetricJson>> } | undefined,
  ][]) {
    if (spec === undefined) continue;
    armsJson[arm] = { tool: spec.tool, runsCompleted: 10, runsFailed: 0, metrics: spec.metrics ?? {} };
  }
  return {
    schema: "bench-compact.result-v1",
    runId,
    cfgId: `cfg-${runId}`,
    timestamp: "t",
    scenario: { id: "tycoon", manifestRef: "/m.json" },
    config: {
      evaluatedModel: "eval",
      evaluatedThinkingLevel: "high",
      judgeModel: "judge",
      judgeThinkingLevel: "high",
      N: 10,
      compactionBoundary: 140000,
      armsEnabled: Object.keys(arms) as ArmId[],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",
    },
    toolVersions: {},
    metricDefs: METRIC_DEFS,
    arms: armsJson,
    ranks: {},
    failures: [],
    artifacts: { scenarioRepo: "/r", branches: ["main"], judgeDir: "/j", config: "/c.json" },
  };
}

const seams = (results: Record<string, BenchResultJson>): ResultsSeams => ({
  loadResultJson: (runId) => results[runId],
});

describe("runResultsCommand", () => {
  it("single run → renders the headline report", () => {
    const outcome = runResultsCommand(
      "run1",
      seams({
        run1: mkResult("run1", { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1000, ci: [900, 1100] } } } }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toBeDefined();
    expect(outcome.report).toContain("bench-compact — tycoon · run run1"); // headline header
  });

  it("multiple runs → renders the cross-run comparison", () => {
    const outcome = runResultsCommand(
      "run1 run2",
      seams({
        run1: mkResult("run1", { A3: { tool: "memkeeper-builder" } }),
        run2: mkResult("run2", { A3: { tool: "memkeeper-builder" } }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toContain("comparison");
    expect(outcome.report).toContain("run1·A3");
    expect(outcome.report).toContain("run2·A3");
  });

  it("arm-subset on a single run filters the report to the selected arms (A1 deselected → no ΔvsA1)", () => {
    const outcome = runResultsCommand(
      "run1:A3",
      seams({
        run1: mkResult("run1", {
          A1: { tool: "bare-pi", metrics: { C1: { mean: 500, ci: [400, 600] } } },
          A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1200, ci: [1100, 1300] } } },
        }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toContain("A3"); // A3 present
    expect(outcome.report).not.toContain("bare-pi"); // A1 deselected → its tool name absent
    expect(outcome.report).not.toMatch(/\[\+\d+\]/); // no delta values (no baseline to delta against)
  });

  it("surfaces an error when a referenced run's result-JSON is missing", () => {
    const outcome = runResultsCommand("run1 run2", seams({ run1: mkResult("run1", { A3: { tool: "mk" } }) }));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/run2/); // names the missing run
  });

  it("surfaces a parse error (empty args)", () => {
    const outcome = runResultsCommand("", seams({}));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/runId/);
  });

  it("surfaces a parse error (trailing comma in :arms)", () => {
    const outcome = runResultsCommand("run1:A3,", seams({}));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/trailing comma/);
  });
});
