// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { renderHeadline } from "../../src/report/markdown.js";
import type { BenchResultJson } from "../../src/report/result-json.js";

/** A synthetic result-JSON: A1 (bare) + A3 (memkeeper). A3 beats A1 on E4/E5
 *  (higher rate → positive Δ) but is WORSE on C1 footprint (higher tokens →
 *  net-negative ⚠, lowerBetter polarity). Exercises ΔvsA1 both signs + a ⚠. */
function syntheticResult(omitA1: boolean | null): BenchResultJson {
  const arms: BenchResultJson["arms"] =
    omitA1 === true
      ? {
          A3: {
            tool: "memkeeper-builder",
            runsCompleted: 9,
            runsFailed: 1,
            metrics: {
              E4: { rate: 0.62, ci: [0.5, 0.74], n: 9 },
              E5: { rate: 0.9, ci: [0.8, 0.96], n: 9 },
              E1: { rank: 1, rankCi: [1, 1] },
              C1: { mean: 12100, ci: [11000, 13000] },
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
        }
      : {
          A1: {
            tool: "bare-pi",
            runsCompleted: 10,
            runsFailed: 0,
            metrics: {
              E4: { rate: 0.1, ci: [0.0, 0.3], n: 10 },
              E5: { rate: 0.3, ci: [0.1, 0.5], n: 10 },
              E1: { rank: 2, rankCi: [2, 2] },
              C1: { mean: 1200, ci: [1100, 1300] },
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
            tool: "memkeeper-builder",
            runsCompleted: 9,
            runsFailed: 1,
            metrics: {
              E4: { rate: 0.62, ci: [0.5, 0.74], n: 9 },
              E5: { rate: 0.9, ci: [0.8, 0.96], n: 9 },
              E1: { rank: 1, rankCi: [1, 1] },
              C1: { mean: 12100, ci: [11000, 13000] },
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
        };
  return {
    schema: "bench-compact.result-v1",
    runId: "2026-08-10T14-32Z",
    cfgId: "cfg-a3f2c1",
    timestamp: "2026-08-10T14:32:00Z",
    scenario: { id: "tycoon", manifestRef: "/p/manifest.json" },
    config: {
      evaluatedModel: "eval-model",
      evaluatedThinkingLevel: "high",
      judgeModel: "judge-model",
      judgeThinkingLevel: "high",
      N: 10,
      compactionBoundary: 140000,
      armsEnabled: omitA1 === true ? ["A3"] : ["A1", "A3"],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",
    },
    toolVersions: { A3: { source: "git", commit: "g4a2f8e", full: "4a2f8e9" } },
    metricDefs: {
      E1: { name: "resume", channel: "comparative", polarity: "rankLowerBetter", desc: "d" },
      E4: { name: "proactive-recall", channel: "binary", polarity: "higherBetter", desc: "d" },
      E5: { name: "recall-accuracy", channel: "binary", polarity: "higherBetter", desc: "d" },
      C1: { name: "footprint", channel: "exact", polarity: "lowerBetter", desc: "d" },
      C4: { name: "compaction-cost", channel: "exact", polarity: "lowerBetter", desc: "d" },
    } as BenchResultJson["metricDefs"],
    arms,
    ranks: { E1: { order: ["A3", "A1"], elo: { A1: 900, A3: 1100 } } },
    failures: [{ arm: "A3", run: 4, phase: "resume", reason: "agent hang", traceBranch: "b", resolved: true }],
    artifacts: { scenarioRepo: "/p/repo", branches: ["main"], judgeDir: "/p/judge", config: "/p/cfg.json" },
  };
}

describe("renderHeadline", () => {
  it("renders the §7.3 header: scenario/runId/cfgId + config + tool versions", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("tycoon");
    expect(md).toContain("2026-08-10T14-32Z");
    expect(md).toContain("cfg-a3f2c1");
    expect(md).toContain("eval-model");
    expect(md).toContain("judge-model");
    expect(md).toContain("N=10");
    expect(md).toContain("g4a2f8e"); // A3 tool version
  });

  it("formats binary rates as % (not proportions)", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("62%"); // A3 E4 rate 0.62
    expect(md).toContain("10%"); // A1 E4 rate 0.10
    expect(md).not.toMatch(/\| 0\.62 /); // not a raw proportion in the table
  });

  it("shows ΔvsA1 polarity-aware: positive for A3 E4 (higher rate better), net-negative ⚠ for C1 (lower better)", () => {
    const md = renderHeadline(syntheticResult(false));
    // E4: A3 62% vs A1 10% → +52 (higherBetter → positive delta). Find a [+...].
    expect(md).toMatch(/\[\+52\]/);
    // C1 footprint: A3 12100 vs A1 1200 → A3 worse (lowerBetter) → negative delta → ⚠
    expect(md).toContain("⚠");
  });

  it("OMITS ΔvsA1 entirely when A1 is absent", () => {
    const md = renderHeadline(syntheticResult(true));
    expect(md).not.toMatch(/\[\+\d+\]/);
    expect(md).not.toContain("⚠");
    expect(md).not.toMatch(/ΔvsA1|vsA1/i);
  });

  it("renders verdicts (one-line per comparative axis from ranks.order)", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toMatch(/E1 resume.*A3.*A1|E1.*resume/);
    expect(md).toContain("A3 > A1"); // order best -> worst
  });

  it("renders the C4 breakdown (in/out/cacheR/cacheW/$/wall/stages per arm)", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("C4 breakdown");
    expect(md).toContain("Observer");
    expect(md).toContain("Builder");
    expect(md).toContain("$0.034"); // A3 dollars
  });

  it("renders reliability (completed/failed per arm) + artifacts", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("Reliability");
    expect(md).toContain("10"); // A1 completed
    expect(md).toContain("Artifacts");
    expect(md).toContain("/p/repo");
  });
});
