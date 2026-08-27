// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { renderHeadline } from "../../src/report/markdown.js";
import type { BenchResultJson } from "../../src/report/result-json.js";

/** A synthetic result-JSON: A1 (bare) + A3 (memkeeper). A3 beats A1 on E4/"E5.1"
 * (higher rate → positive Δ) but is WORSE on C1 footprint (higher tokens →
 * net-negative ⚠, lowerBetter polarity). Exercises ΔvsA1 both signs + a ⚠. */
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
              "E5.1": { rate: 0.9, ci: [0.8, 0.96], n: 9 },
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
              "E5.1": { rate: 0.3, ci: [0.1, 0.5], n: 10 },
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
              "E5.1": { rate: 0.9, ci: [0.8, 0.96], n: 9 },
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
      judgesNumber: 1,
      judge2Model: null,
      judge2ThinkingLevel: "high",
      judge3Model: null,
      judge3ThinkingLevel: "high",
      N: 10,
      compactionBoundary: 140000,
      armsEnabled: omitA1 === true ? ["A3"] : ["A1", "A3"],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",      fastEval: "off",      latentProbes: "off",
    },
    toolVersions: { A3: { source: "git", commit: "g4a2f8e", full: "4a2f8e9" } },
    metricDefs: {
      E1: { name: "resume", channel: "comparative", polarity: "rankLowerBetter", desc: "d" },
      E4: { name: "proactive-recall", channel: "binary", polarity: "higherBetter", desc: "d" },
      E6: { name: "abstention", channel: "binary", polarity: "higherBetter", desc: "d" },
      "E5.1": { name: "recall-accuracy", channel: "binary", polarity: "higherBetter", desc: "d" },
      "E5.2": { name: "recall-accuracy", channel: "binary", polarity: "higherBetter", desc: "d" },
      "E5.3": { name: "recall-accuracy", channel: "binary", polarity: "higherBetter", desc: "d" },
      C1: { name: "footprint", channel: "exact", polarity: "lowerBetter", desc: "d" },
      C4: { name: "compaction-cost", channel: "exact", polarity: "lowerBetter", desc: "d" },
    } as BenchResultJson["metricDefs"],
    arms,
    ranks: { E1: { order: ["A3", "A1"], elo: { A1: 900, A3: 1100 } } },
    failures: [{ arm: "A3", run: 4, phase: "resume", reason: "agent hang", traceBranch: "b", resolved: true }],
    artifacts: {
      scenarioRepo: "/p/repo",
      branches: ["main"],
      judgeDir: "/p/judge",
      config: "/p/cfg.json",
      results: "/p/runs/run1/results.json",
    },
  };
}

describe("renderHeadline", () => {
  it("probe breakdown: manifest probes union across arms; latent ids render PER ARM (same id names a different question per arm)", () => {
    const base = syntheticResult(false);
    const withProbes: BenchResultJson = {
      ...base,
      arms: {
        ...base.arms,
        A1: {
          ...(base.arms.A1 as NonNullable<BenchResultJson["arms"]["A1"]>),
          probes: [
            { probeId: "1", axis: "E6", question: "shared manifest question", passes: [true, false], usages: [null, null] },
            { probeId: "l1", axis: "E5.2", question: "A1's latent question", passes: [true], usages: [null] },
          ],
        },
        A3: {
          ...(base.arms.A3 as NonNullable<BenchResultJson["arms"]["A3"]>),
          probes: [
            { probeId: "1", axis: "E6", question: "shared manifest question", passes: [true, true], usages: [null, null] },
            { probeId: "l1", axis: "E5.3", question: "A3's DIFFERENT latent question", passes: [false], usages: [null] },
          ],
        },
      },
    };
    const md = renderHeadline(withProbes);
    // one table per probe category (axis), canonical metric order; no Axis column
    expect(md).toContain("## Probe breakdown — E6 abstention");
    expect(md).toContain("## Probe breakdown — E5.2 recall-accuracy (latent, cued)");
    expect(md).toContain("## Probe breakdown — E5.3 recall-accuracy (latent, uncued)");
    // manifest probe: one shared row
    expect(md).toContain("| p1 · shared manifest question | 1/2 | 2/2 |");
    // latent probes: one row PER ARM, labeled with the arm, not unioned
    expect(md).toContain("pl1 (A1) · A1's latent question");
    expect(md).toContain("pl1 (A3) · A3's DIFFERENT latent question");
    expect(md).not.toContain("| pl1 · ");
  });

  it("probe breakdown: per-table rate row aggregates that axis's probes per arm (— when ungraded)", () => {
    const base = syntheticResult(false);
    const withProbes: BenchResultJson = {
      ...base,
      arms: {
        ...base.arms,
        A1: {
          ...(base.arms.A1 as NonNullable<BenchResultJson["arms"]["A1"]>),
          probes: [
            { probeId: "1", axis: "E6", question: "q one", passes: [true, false], usages: [null, null] },
            { probeId: "2", axis: "E6", question: "q two", passes: [true, true], usages: [null, null] },
            { probeId: "l1", axis: "E5.2", question: "latent", passes: [false, false], usages: [null, null] },
          ],
        },
        A3: {
          ...(base.arms.A3 as NonNullable<BenchResultJson["arms"]["A3"]>),
          probes: [
            { probeId: "1", axis: "E6", question: "q one", passes: [true, false], usages: [null, null] },
          ],
        },
      },
    };
    const md = renderHeadline(withProbes);
    // E6 table: A1 3/4 = 75%, A3 1/2 = 50%
    expect(md).toContain("| **rate** | 75% | 50% |");
    // E5.2 table: A1 0/2 = 0%, A3 ungraded → —
    expect(md).toContain("| **rate** | 0% | — |");
    // E5.3 has no rows at all → no table for it
    expect(md).not.toContain("## Probe breakdown — E5.3");
  });

  it("renders the header: scenario/runId/cfgId + config + tool versions", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("tycoon");
    expect(md).toContain("2026-08-10T14-32Z");
    expect(md).toContain("cfg-a3f2c1");
    expect(md).toContain("eval-model");
    expect(md).toContain("judge-model");
    expect(md).toContain("N=10");
    expect(md).toContain("g4a2f8e"); // A3 tool version
    expect(md).not.toContain("K="); // K=1 (single judge) omits the ensemble suffix
  });

  it("renders the Memkeeper arm-params line (variable shape keys only; omitted without memkeeper arms)", () => {
    const base = syntheticResult(false);
    const withMk = renderHeadline({
      ...base,
      config: {
        ...base.config,
        memkeeperArms: {
          A3: {
            enabled: true,
            renderMode: "observations-root",
            rootViewTargetNodes: 160,
            rootViewStrategy: "task",
            ignoreConflicts: true,
          },
          A4: { enabled: true, renderMode: "selected-root", ignoreConflicts: true },
        },
      },
    });
    expect(withMk).toContain(
      "Memkeeper: A3 render=observations-root rootTarget=160 rootStrategy=task; A4 render=selected-root",
    );
    // absent memkeeperArms (older snapshots) → no line at all
    expect(renderHeadline(base)).not.toContain("Memkeeper:");
  });

  it("surfaces the multi-judge ensemble in the config line when judgesNumber > 1", () => {
    const base = syntheticResult(false);
    const md = renderHeadline({
      ...base,
      config: { ...base.config, judgesNumber: 3, judge2Model: "judge2-model", judge3Model: "judge3-model" },
    });
    expect(md).toContain("K=3");
    expect(md).toContain("judge2-model");
    expect(md).toContain("judge3-model");
  });

  it("formats binary rates as % (not proportions)", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("62%"); // A3 E4 rate 0.62
    expect(md).toContain("10%"); // A1 E4 rate 0.10
    expect(md).not.toMatch(/\| 0\.62 /); // not a raw proportion in the table
  });

  it("shows ΔvsA1 raw: +52pp for A3 E4 (higher rate better), +10.9K⚠ for C1 (bigger footprint, worse)", () => {
    const md = renderHeadline(syntheticResult(false));
    // E4: A3 62% vs A1 10% → +52 (higherBetter → positive delta). Find a [+...].
    expect(md).toMatch(/\[\+52\]/);
    // C1 footprint: A3 12100 vs A1 1200 → A3 worse (lowerBetter) → negative delta → ⚠
    expect(md).toContain("⚠");
  });

  it("OMITS ΔvsA1 entirely when A1 is absent", () => {
    const md = renderHeadline(syntheticResult(true));
    expect(md).not.toMatch(/\[\+\d+\]/);
    expect(md).not.toMatch(/]⚠/);
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

  it("renders dollars to 3 decimals in BOTH the results-table C4 cell + the C4 breakdown (parity)", () => {
    // A raw-decimal dollar (0.034567) must round to $0.035 in BOTH sites — not raw in one.
    // Reconstruct immutably (metrics is readonly) overriding A3's C4 dollars.
    const base = syntheticResult(false);
    const a3 = base.arms.A3;
    const a3Metrics = a3?.metrics;
    const c4 = a3Metrics?.C4;
    const c4Override = c4 !== undefined && "dollars" in c4 ? ({ ...c4, dollars: 0.034567 } as typeof c4) : c4;
    const result: BenchResultJson = {
      ...base,
      arms: { ...base.arms, A3: a3 !== undefined ? { ...a3, metrics: { ...a3Metrics, C4: c4Override } } : a3 },
    };
    const md = renderHeadline(result);
    expect(md).toContain("$0.035/41s"); // results-table C4 row ($/wall)
    expect(md).toContain("| $0.035 |"); // C4 breakdown table $ column
    expect(md).not.toContain("$0.034567"); // no raw decimals anywhere
  });

  it("renders reliability (completed/failed per arm) + stop-and-surface failure notes", () => {
    const md = renderHeadline(syntheticResult(false));
    expect(md).toContain("Reliability");
    expect(md).toContain("10"); // A1 completed
    expect(md).toContain("Artifacts");
    expect(md).toContain("/p/repo");
    // The A3 failure note (arm + run + phase + reason + branch + resolved state — transparency).
    expect(md).toContain("agent hang");
    expect(md).toContain("run 4");
    expect(md).toContain("resume");
    expect(md).toContain("resolved");
    // The result-JSON artifact path is the serializer-populated `results` field (not the config fallback).
    expect(md).toContain("/p/runs/run1/results.json");
  });
});

describe("C3 rows (probes-only per-answer compound + live totals)", () => {
  const probesOnlyResult = (): BenchResultJson => {
    const base = syntheticResult(false);
    const usage = (d: number, w: number) => ({ tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, dollars: d, wallMs: w });
    return {
      ...base,
      metricDefs: {
        ...base.metricDefs,
        C3: { name: "run-cost", channel: "exact", polarity: "lowerBetter", desc: "d" },
      },
      arms: {
        A1: {
          tool: "bare-pi",
          runsCompleted: 0,
          runsFailed: 0,
          metrics: { C3: { dollars: 0.004, wallMs: 14000, answers: 2 } },
          probes: [{ probeId: "1", axis: "E6", question: "q", passes: [true], usages: [usage(0.02, 30000)] }],
        },
        A3: {
          tool: "memkeeper-builder",
          runsCompleted: 0,
          runsFailed: 0,
          metrics: { C3: { dollars: 0.007, wallMs: 16000, answers: 2 } },
          probes: [{ probeId: "1", axis: "E6", question: "q", passes: [true], usages: [usage(0.05, 90000)] }],
        },
      },
    };
  };

  it("renders the per-answer row (renamed) + the live-totals row beneath it", () => {
    const md = renderHeadline(probesOnlyResult());
    expect(md).toContain("| C3 run-cost/answer (↓) | $0.004/14s | $0.007/16s ");
    expect(md).toContain("| C3 run-cost total (↓) | $0.020/30s | $0.050/90s |");
    // the plain full-run label is gone in probes-only mode
    expect(md).not.toContain("| C3 run-cost (↓) |");
  });

  it("an arm with NO probe usages renders — in the totals row", () => {
    const base = probesOnlyResult();
    const result: BenchResultJson = {
      ...base,
      arms: {
        ...base.arms,
        A3: {
          ...(base.arms.A3 as NonNullable<BenchResultJson["arms"]["A3"]>),
          probes: [{ probeId: "1", axis: "E6", question: "q", passes: [true], usages: [null] }],
        },
      },
    };
    const md = renderHeadline(result);
    expect(md).toContain("| C3 run-cost total (↓) | $0.020/30s | — |");
  });

  it("a full-run scalar C3 keeps the single unrenamed row (no totals row)", () => {
    const base = syntheticResult(false);
    const result: BenchResultJson = {
      ...base,
      metricDefs: { ...base.metricDefs, C3: { name: "run-cost", channel: "exact", polarity: "lowerBetter", desc: "d" } },
      arms: {
        A1: {
          ...(base.arms.A1 as NonNullable<BenchResultJson["arms"]["A1"]>),
          metrics: { ...base.arms.A1?.metrics, C3: { mean: 4200, ci: [4000, 4400] } },
        },
      },
    };
    const md = renderHeadline(result);
    expect(md).toContain("| C3 run-cost (↓) |");
    expect(md).not.toContain("C3 run-cost/answer");
    expect(md).not.toContain("C3 run-cost total");
  });
});
