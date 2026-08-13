// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESULT_SCHEMA,
  serializeResultJson,
} from "../../src/report/result-json.js";
import type { AggregateResult } from "../../src/stats/aggregate.js";
import type { RunConfig, ToolVersion } from "../../src/storage/branches.js";

const gitVer = (hash: string): ToolVersion => ({ source: "git", commit: `g${hash.slice(0, 6)}`, full: hash });
const npmVer = (version: string): ToolVersion => ({ source: "npm", commit: `npm${version}`, full: version });

const runConfig: RunConfig = {
  evaluatedModel: "eval-model",
  evaluatedThinkingLevel: "high",
  judgeModel: "judge-model",
  judgeThinkingLevel: "high",
  judgesNumber: 1,
  judge2Model: null,
  judge2ThinkingLevel: "high",
  judge3Model: null,
  judge3ThinkingLevel: "high",
  N: 10,
  compactionBoundary: 140000,
  armsEnabled: ["A1", "A3"],
  omFullReflectionThresholdTokens: 4000,
  backupMode: "build",
  toolVersions: { A3: gitVer("aabbccdd"), A2: npmVer("0.4.2") },
};

// A synthetic aggregate: A1 (bare) + A3 (memkeeper). Binary E2/E4/E5; comparative
// E1 (A3 beats A1); exact C1/C2/C3/C4. Exercises every channel shape.
const aggregate: AggregateResult = {
  arms: {
    A1: {
      binary: {
        E2: { rate: 0.72, ci: [0.45, 0.92], n: 10 },
        E4: { rate: 0.1, ci: [0.0, 0.3], n: 10 },
        E5: { rate: 0.3, ci: [0.1, 0.5], n: 10 },
      },
      exact: {
        C1: { mean: 1200, ci: [1100, 1300] },
        C2: { mean: null, ci: null, notRecoveredRate: 1.0 },
        C3: { mean: 45000, ci: [40000, 50000] },
        C4: {
          tokensIn: 90000,
          tokensOut: 1500,
          cacheRead: 80000,
          cacheWrite: 0,
          dollars: 0.001,
          wallMs: 2000,
          stages: ["native-summary"],
          phase2CompactionCount: 0,
        },
      },
    },
    A3: {
      binary: {
        E2: { rate: 0.51, ci: [0.4, 0.62], n: 9 },
        E5: { rate: 0.9, ci: [0.8, 0.96], n: 9 },
      },
      exact: {
        C4: {
          tokensIn: 120000,
          tokensOut: 3000,
          cacheRead: 100000,
          cacheWrite: 5000,
          dollars: 0.034,
          wallMs: 41000,
          stages: ["Observer", "Builder"],
          phase2CompactionCount: 1,
        },
      },
    },
  },
  comparative: {
    E1: {
      order: ["A3", "A1"],
      elo: { A1: 900, A3: 1100 },
      ranks: {
        A1: { rank: 2, rankCi: [2, 2] },
        A3: { rank: 1, rankCi: [1, 1] },
      },
    },
  },
};

const baseDeps = {
  runId: "2026-08-10T14-32Z",
  cfgId: "cfg-a3f2c1",
  timestamp: "2026-08-10T14:32:00Z",
  scenario: { id: "tycoon", manifestRef: "/path/manifest.json" },
  runConfig,
  aggregate,
  armRunCounts: {
    A1: { completed: 10, failed: 0 },
    A3: { completed: 9, failed: 1 },
  },
  failures: [
    {
      arm: "A3",
      run: 4,
      phase: "resume",
      reason: "agent hang (idle 2m)",
      traceBranch: "run-.../arm-memkeeper-builder-g4a2f8e-4",
      resolved: true,
    },
  ],
  artifacts: {
    scenarioRepo: "/path/repo",
    branches: ["main", "run-.../arm-bare-pi"],
    judgeDir: "/path/judge",
    config: "~/.pi/bench-compact/configs/cfg-a3f2c1.json",
  },
} as const;

describe("serializeResultJson", () => {
  it("produces a bench-compact.result-v1 with the schema marker + top-level fields", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    expect(json.schema).toBe(RESULT_SCHEMA);
    expect(json.runId).toBe(baseDeps.runId);
    expect(json.cfgId).toBe(baseDeps.cfgId);
    expect(json.timestamp).toBe(baseDeps.timestamp);
    expect(json.scenario).toEqual(baseDeps.scenario);
  });

  it("splits config (no toolVersions) + toolVersions out of runConfig", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    expect(json.config).not.toHaveProperty("toolVersions");
    expect(json.config.evaluatedModel).toBe("eval-model");
    expect(json.config.N).toBe(10);
    expect(json.config.armsEnabled).toEqual(["A1", "A3"]);
    // the judge-ensemble fields persist into the result-JSON config block (R2-1)
    expect(json.config.judgesNumber).toBe(1);
    expect(json.config.judge2Model).toBeNull();
    expect(json.config.judge3Model).toBeNull();
    expect(json.toolVersions.A3).toEqual(gitVer("aabbccdd"));
    expect(json.toolVersions.A1).toBeUndefined(); // bare-pi has no tool version
  });

  it("embeds the self-describing metricDefs for all 13 metrics", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    expect(Object.keys(json.metricDefs).sort()).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
      "E1",
      "E10",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
    ]);
    expect(json.metricDefs.E4).toEqual({
      name: "proactive-recall",
      channel: "binary",
      polarity: "higherBetter",
      desc: expect.any(String),
    });
  });

  it("maps per-arm metrics to the per-channel JSON shapes (binary/comparative/exact/C2/C4)", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    const a1 = json.arms.A1;
    expect(a1?.tool).toBe("bare-pi");
    expect(a1?.runsCompleted).toBe(10);
    expect(a1?.runsFailed).toBe(0);
    // binary
    expect(a1?.metrics.E2).toEqual({ rate: 0.72, ci: [0.45, 0.92], n: 10 });
    // comparative (rank pulled cross-arm -> per-arm)
    expect(a1?.metrics.E1).toEqual({ rank: 2, rankCi: [2, 2] });
    // exact C1/C3
    expect(a1?.metrics.C1).toEqual({ mean: 1200, ci: [1100, 1300] });
    expect(a1?.metrics.C3).toEqual({ mean: 45000, ci: [40000, 50000] });
    // C2 (null mean when all notRecovered)
    expect(a1?.metrics.C2).toEqual({ mean: null, ci: null, notRecoveredRate: 1.0 });
    // C4
    expect(a1?.metrics.C4).toEqual({
      tokensIn: 90000,
      tokensOut: 1500,
      cacheRead: 80000,
      cacheWrite: 0,
      dollars: 0.001,
      wallMs: 2000,
      stages: ["native-summary"],
      phase2CompactionCount: 0,
    });
    // A3 comparative rank (1=best)
    expect(json.arms.A3?.metrics.E1).toEqual({ rank: 1, rankCi: [1, 1] });
  });

  it("stores the comparative ranks block (order + Elo per axis)", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    expect(json.ranks.E1).toEqual({ order: ["A3", "A1"], elo: { A1: 900, A3: 1100 } });
  });

  it("stores EXACT values only — NO a1Delta / netNegative fields anywhere", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toMatch(/a1Delta|netNegative/i);
  });

  it("carries failures + artifacts", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp" });
    expect(json.failures).toHaveLength(1);
    expect(json.failures[0]?.arm).toBe("A3");
    expect(json.artifacts.scenarioRepo).toBe("/path/repo");
    expect(json.artifacts.config).toContain("cfg-a3f2c1");
  });

  it("populates artifacts.results from root + runId (the report reads this, not the config path)", () => {
    const json = serializeResultJson({ ...baseDeps, root: "/tmp/bench-compact" });
    expect(json.artifacts.results).toBe(path.join("/tmp/bench-compact", "runs", baseDeps.runId, "results.json"));
    // the caller-provided artifacts.results (if any) is overwritten by the derived path.
  });
});
