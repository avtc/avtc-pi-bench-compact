// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { ArmId } from "../../src/config/types.js";
import type { MetricId } from "../../src/metrics/defs.js";
import { METRIC_DEFS } from "../../src/metrics/defs.js";
import { type RunSelection, renderComparison } from "../../src/report/compare.js";
import type { ArmResultJson, BenchResultJson, MetricJson } from "../../src/report/result-json.js";

interface ArmSpec {
  tool: string;
  metrics: Partial<Record<MetricId, MetricJson>>;
  completed?: number;
  failed?: number;
}

function mkResult(opts: {
  runId: string;
  cfgId: string;
  arms: Partial<Record<ArmId, ArmSpec>>;
  config?: Partial<BenchResultJson["config"]>;
  toolVersions?: BenchResultJson["toolVersions"];
}): BenchResultJson {
  const armsJson: Partial<Record<ArmId, ArmResultJson>> = {};
  for (const [armId, spec] of Object.entries(opts.arms) as [ArmId, ArmSpec | undefined][]) {
    if (spec === undefined) continue;
    armsJson[armId] = {
      tool: spec.tool,
      runsCompleted: spec.completed ?? 10,
      runsFailed: spec.failed ?? 0,
      metrics: spec.metrics,
    };
  }
  return {
    schema: "bench-compact.result-v1",
    runId: opts.runId,
    cfgId: opts.cfgId,
    timestamp: "2026-08-10T14:32:00Z",
    scenario: { id: "tycoon", manifestRef: "/p/m.json" },
    config: {
      evaluatedModel: "eval",
      evaluatedThinkingLevel: "high",
      judgeModel: "judge",
      judgeThinkingLevel: "high",
      judgesNumber: 1,
      judge2Model: null,
      judge2ThinkingLevel: "high",
      judge3Model: null,
      judge3ThinkingLevel: "high",
      N: 10,
      compactionBoundary: 140000,
      armsEnabled: Object.keys(opts.arms) as ArmId[],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",
      fastEval: "off",
      ...opts.config,
    },
    toolVersions: opts.toolVersions ?? {},
    metricDefs: METRIC_DEFS,
    arms: armsJson,
    ranks: { E1: { order: Object.keys(opts.arms) as ArmId[], elo: {} } },
    failures: [],
    artifacts: { scenarioRepo: "/r", branches: ["main"], judgeDir: "/j", config: "/c.json" },
  };
}

describe("renderComparison", () => {
  it("renders a config diff across runs (config + toolVersions)", () => {
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1200, ci: [1100, 1300] } } } },
      config: { N: 10, judgeModel: "judge-a" },
      toolVersions: { A3: { source: "git", commit: "g4a2f8e", full: "f" } },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 800, ci: [700, 900] } } } },
      config: { N: 5, judgeModel: "judge-b" },
      toolVersions: { A3: { source: "git", commit: "g9b1c3", full: "f2" } },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A3"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    expect(md).toContain("Config diff");
    expect(md).toContain("N"); // differs 10 -> 5
    expect(md).toContain("judge-a");
    expect(md).toContain("judge-b");
    expect(md).toContain("g4a2f8e"); // toolVersion differs
    expect(md).toContain("g9b1c3");
  });

  it("a judgesNumber-only diff shows in the config diff (not 'all match')", () => {
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1200, ci: [1100, 1300] } } } },
      config: { judgesNumber: 1 },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 800, ci: [700, 900] } } } },
      config: { judgesNumber: 3 },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A3"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    expect(md).toContain("judgesNumber");
    expect(md).not.toContain("all config + tool-version fields match");
  });

  it("renders a per-arm metric table with Δ run1·arm→run2·arm (same-arm, polarity-aware)", () => {
    // C1 footprint lowerBetter: run1=1200, run2=800 → run2 better → positive delta.
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1200, ci: [1100, 1300] } } } },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 800, ci: [700, 900] } } } },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A3"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    expect(md).toContain("run1·A3");
    expect(md).toContain("run2·A3");
    expect(md).toContain("1.2K"); // run1 C1
    expect(md).toContain("800"); // run2 C1 (exact, <1000)
    // Δ: run2 better than run1 → positive (+400), no ⚠
    expect(md).toMatch(/\[\+400\]/);
    expect(md).not.toContain("⚠");
  });

  it("selecting run1:A1 derives run2 A1-less arms' ΔvsA1 (prior A1 as baseline)", () => {
    // E4 proactive-recall higherBetter: run1·A1=0.10, run2·A3=0.60 → +50pp (better, no ⚠).
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A1: { tool: "bare-pi", metrics: { E4: { rate: 0.1, ci: [0, 0.3], n: 10 } } } },
      config: { armsEnabled: ["A1"] },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { E4: { rate: 0.6, ci: [0.5, 0.7], n: 10 } } } },
      config: { armsEnabled: ["A3"] },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A1"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    // run2·A3 gets ΔvsA1 derived from run1·A1: +50pp
    expect(md).toContain("run2·A3");
    expect(md).toMatch(/\[\+50\]/); // (0.60 - 0.10) * 100 = +50pp
    expect(md).not.toContain("⚠"); // better than baseline → no net-negative
  });

  it("flags net-negative when a run2 memory arm is worse than the prior A1 baseline", () => {
    // C1 footprint lowerBetter: run1·A1=500 (bare, tiny native summary), run2·A3=5000 (memory) → A3 worse → negative ⚠.
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A1: { tool: "bare-pi", metrics: { C1: { mean: 500, ci: [400, 600] } } } },
      config: { armsEnabled: ["A1"] },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 5000, ci: [4500, 5500] } } } },
      config: { armsEnabled: ["A3"] },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A1"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    // C1 lowerBetter: run2·A3 (5000) worse than run1·A1 (500) → a1Value-armValue = 500-5000 = -4500 → ⚠
    expect(md).toContain("⚠");
  });

  it("omits Δ for run0 cells (they are the baseline) and when no baseline is available", () => {
    // run2 only (no run1) — single run comparison is degenerate; run0 cells have no Δ.
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1000, ci: [900, 1100] } } } },
    });
    const md = renderComparison([run1], [{ runId: "run1", arms: ["A3"] }]);
    expect(md).toContain("run1·A3");
    expect(md).not.toMatch(/\[\+\d+\]/); // no delta column for the only run
  });

  it("labels each run with its cfgId + tool version (comparison labels)", () => {
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-aaa",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1000, ci: [900, 1100] } } } },
      toolVersions: { A3: { source: "git", commit: "g4a2f8e", full: "f" } },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-bbb",
      arms: { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 800, ci: [700, 900] } } } },
      toolVersions: { A3: { source: "git", commit: "g9b1c3", full: "f2" } },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A3"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    expect(md).toContain("cfg-aaa"); // cfgId present
    expect(md).toContain("cfg-bbb");
    expect(md).toContain("memkeeper-builder@g4a2f8e"); // tool@version in column header
  });

  it("derives the metricDefs from the first result (self-describing)", () => {
    const run1 = mkResult({
      runId: "run1",
      cfgId: "cfg-1",
      arms: { A1: { tool: "bare-pi", metrics: { E4: { rate: 0.1, ci: [0, 0.3], n: 10 } } } },
    });
    const run2 = mkResult({
      runId: "run2",
      cfgId: "cfg-2",
      arms: { A3: { tool: "memkeeper-builder", metrics: { E4: { rate: 0.9, ci: [0.8, 0.96], n: 10 } } } },
    });
    const md = renderComparison(
      [run1, run2],
      [
        { runId: "run1", arms: ["A1"] },
        { runId: "run2", arms: ["A3"] },
      ],
    );
    // metricDefs come from run1 → E4 is higherBetter → run2·A3 0.9 vs A1 0.1 → +80pp (positive = better)
    expect(md).toMatch(/\[\+80\]/);
  });
});

// Ensure the RunSelection type is exported + structurally compatible with RunRef.
void (0 as unknown as RunSelection);
