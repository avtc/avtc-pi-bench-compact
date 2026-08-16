// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Focused acceptance checks for the bench's done-conditions. Where the smoke test
// proves the FULL pipeline holds together (shape + integration), these checks pin
// the QUALITY invariants the headline promises: cost metrics are EXACT + DETERMINISTIC
// (re-derived from the same trace every time), statistics carry SANE confidence
// intervals, A1 attribution + net-negative detection work, the run-config id is
// REPRODUCIBLE + SENSITIVE, and the bench's mechanism primitives (the compaction
// trigger + the anti-peek inject) actually fire. Each check targets one invariant so
// a regression points straight at the broken promise.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryProxies } from "../../src/arms/proxies.js";
import { clearMemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";
import type { ArmId } from "../../src/config/types.js";
import { METRIC_DEFS, type MetricDef, type MetricId } from "../../src/metrics/defs.js";
import { clearBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";
import { type Phase1Deps, type Phase1Ops, runPhase1 } from "../../src/orchestrate/phase1.js";
import { startRun } from "../../src/orchestrate/run.js";
import { clearRunState } from "../../src/orchestrate/run-state.js";
import type { BenchResultJson } from "../../src/report/result-json.js";
import { a1Delta, isNetNegative } from "../../src/stats/delta.js";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { buildCfgId, type RunConfig } from "../../src/storage/branches.js";
import { makeSmokeDeps } from "./helpers.js";

/** Read + parse a run's results.json into the typed result-v1 shape. */
function readResultJson(resultsPath: string): BenchResultJson {
  return JSON.parse(readFileSync(resultsPath, "utf8")) as BenchResultJson;
}

/** Drive the 2-arm smoke pipeline once and return its done-result (caller owns cleanup). */
async function drivePipeline(root: string): Promise<{ resultsPath: string; reportPath: string }> {
  const result = await startRun(makeSmokeDeps(root, ["A1", "A3"]));
  expect(result.kind).toBe("done");
  if (result.kind !== "done") throw new Error("pipeline did not complete");
  return { resultsPath: result.resultsPath, reportPath: result.reportPath };
}

afterEach(() => {
  clearRunState();
  clearBenchPi();
  clearMemoryProxies();
});

// ---------------------------------------------------------------------------
// cost metrics are EXACT + DETERMINISTIC — re-running the same trace yields the
// identical footprint / run-cost / compaction-cost every time (no judge in the loop).
// ---------------------------------------------------------------------------
describe("acceptance — cost metrics are exact + deterministic", () => {
  let rootA: string;
  let rootB: string;
  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), "bench-accept-cost-a-"));
    rootB = mkdtempSync(join(tmpdir(), "bench-accept-cost-b-"));
  });
  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it("produces identical C1/C3/C4 for A1 + A3 across two runs of the same trace", async () => {
    const runA = await drivePipeline(rootA);
    const runB = await drivePipeline(rootB);
    const jsonA = readResultJson(runA.resultsPath);
    const jsonB = readResultJson(runB.resultsPath);

    for (const arm of ["A1", "A3"] as const) {
      const metricsA = jsonA.arms[arm]?.metrics;
      const metricsB = jsonB.arms[arm]?.metrics;
      expect(metricsA).toBeDefined();
      expect(metricsB).toBeDefined();
      // exact metrics are byte-identical across runs (same trace → same derived cost)
      expect(metricsA?.C1).toEqual(metricsB?.C1);
      expect(metricsA?.C3).toEqual(metricsB?.C3);
      expect(metricsA?.C4).toEqual(metricsB?.C4);
    }
  });
});

// ---------------------------------------------------------------------------
// statistics carry SANE confidence intervals — a binary rate always sits inside
// its reported interval, and comparative arms carry a rank.
// ---------------------------------------------------------------------------
describe("acceptance — statistics carry sane confidence intervals", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-accept-stats-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("every binary rate lies within its CI bounds; every comparative arm carries a rank", async () => {
    const run = await drivePipeline(root);
    const json = readResultJson(run.resultsPath);

    for (const arm of Object.values(json.arms)) {
      for (const [id, metric] of Object.entries(arm.metrics)) {
        const def = METRIC_DEFS[id as MetricId] as MetricDef | undefined;
        if (def === undefined) continue;
        if (def.channel === "binary") {
          const m = metric as { rate: number; ci: readonly [number, number] };
          expect(m.rate).toBeGreaterThanOrEqual(0);
          expect(m.rate).toBeLessThanOrEqual(1);
          expect(m.ci[0]).toBeLessThanOrEqual(m.rate);
          expect(m.rate).toBeLessThanOrEqual(m.ci[1]);
          expect(m.ci).toHaveLength(2);
        } else if (def.channel === "comparative") {
          const m = metric as { rank: number };
          const armCount = Object.keys(json.arms).length;
          expect(m.rank).toBeGreaterThanOrEqual(1);
          expect(m.rank).toBeLessThanOrEqual(armCount);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A1 attribution + net-negative detection — the polarity-aware delta derives the
// right sign, and a memory arm WORSE than the bare-pi baseline on a cost axis is
// flagged net-negative.
// ---------------------------------------------------------------------------
describe("acceptance — A1 attribution + net-negative detection", () => {
  const POLARITIES = Object.fromEntries(
    (Object.entries(METRIC_DEFS) as readonly [MetricId, MetricDef][]).map(([id, def]) => [
      id,
      { polarity: def.polarity },
    ]),
  ) as Readonly<Record<MetricId, { polarity: MetricDef["polarity"] }>>;

  it("flags a memory arm with higher run-cost than A1 as net-negative (lowerBetter)", () => {
    // C3 is lowerBetter: A1 = 50, A3 = 80 → A3 spent MORE → worse → net-negative.
    const deltas = a1Delta({ C3: 80 }, { C3: 50 }, POLARITIES);
    expect(deltas.C3).toBe(-30); // a1Value - armValue = 50 - 80
    expect(isNetNegative(deltas.C3 ?? null)).toBe(true);
  });

  it("does NOT flag a memory arm with lower cost than A1 (the win case)", () => {
    const deltas = a1Delta({ C3: 30 }, { C3: 50 }, POLARITIES);
    expect(deltas.C3).toBe(20); // 50 - 30
    expect(isNetNegative(deltas.C3 ?? null)).toBe(false);
  });

  it("treats a higher binary-recall rate as better (higherBetter)", () => {
    // E5 is higherBetter: A1 = 0.5, A3 = 0.9 → A3 better → positive delta.
    const deltas = a1Delta({ E5: 0.9 }, { E5: 0.5 }, POLARITIES);
    expect(deltas.E5).toBeCloseTo(0.4, 5); // armValue - a1Value
    expect(isNetNegative(deltas.E5 ?? null)).toBe(false);
  });

  it("treats a lower comparative rank as better (rankLowerBetter)", () => {
    // E1 is rankLowerBetter: A1 rank = 1, A3 rank = 2 → A3 worse → net-negative.
    const deltas = a1Delta({ E1: 2 }, { E1: 1 }, POLARITIES);
    expect(deltas.E1).toBe(-1); // a1Value - armValue = 1 - 2
    expect(isNetNegative(deltas.E1 ?? null)).toBe(true);
  });

  it("returns null delta when either arm is absent (disabling yields all-null attribution)", () => {
    const deltas = a1Delta({ C3: 80 }, {}, POLARITIES);
    expect(deltas.C3).toBeNull();
    expect(isNetNegative(deltas.C3 ?? null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run-config id is REPRODUCIBLE + SENSITIVE — same config always hashes to the same
// id; differing in model, N, OR any arm's tool version produces a different id.
// ---------------------------------------------------------------------------
describe("acceptance — run-config id is reproducible + sensitive", () => {
  /** A baseline run config (all fields populated so every dimension contributes). */
  function baselineConfig(): RunConfig {
    return {
      evaluatedModel: "model/x",
      evaluatedThinkingLevel: "high",
      judgeModel: "model/j",
      judgeThinkingLevel: "high",
      judgesNumber: 1,
      judge2Model: null,
      judge2ThinkingLevel: "high",
      judge3Model: null,
      judge3ThinkingLevel: "high",
      N: 1,
      compactionBoundary: 140000,
      armsEnabled: ["A1", "A3"],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",
      fastEval: "off",
      toolVersions: { A3: { source: "git", commit: "gabcdef", full: "abcdef1234567890" } },
    };
  }

  it("same config ⇒ same id (reproducible)", () => {
    expect(buildCfgId(baselineConfig())).toBe(buildCfgId(baselineConfig()));
  });

  it("armsEnabled order is normalized (a set)", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, armsEnabled: ["A3", "A1"] };
    expect(buildCfgId(a)).toBe(buildCfgId(b));
  });

  it("differing arms set (a different enabled arm) ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, armsEnabled: ["A1", "A2"] };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing evaluated model ⇒ different id", () => {
    const a = baselineConfig();
    const b = { ...a, evaluatedModel: "model/y" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing N ⇒ different id", () => {
    const a = baselineConfig();
    const b = { ...a, N: 3 };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing arm tool version ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = {
      ...a,
      toolVersions: { A3: { source: "git", commit: "g999999", full: "999999abcdef" } },
    };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing judgesNumber alone ⇒ different id (judge2/3 stay null)", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, judgesNumber: 3 };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing compactionBoundary ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, compactionBoundary: 100000 };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing backupMode ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, backupMode: "extract" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing evaluatedThinkingLevel ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, evaluatedThinkingLevel: "medium" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing judgeModel ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, judgeModel: "model/j2" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing omFullReflectionThresholdTokens ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, omFullReflectionThresholdTokens: 8000 };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing judgeThinkingLevel ⇒ different id", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, judgeThinkingLevel: "medium" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing judge2ThinkingLevel alone ⇒ different id (judge2 model stays null)", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, judge2ThinkingLevel: "medium" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });

  it("differing judge3ThinkingLevel alone ⇒ different id (judge3 model stays null)", () => {
    const a = baselineConfig();
    const b: RunConfig = { ...a, judge3ThinkingLevel: "medium" };
    expect(buildCfgId(a)).not.toBe(buildCfgId(b));
  });
});

// ---------------------------------------------------------------------------
// bench MECHANISM primitives fire — the compaction trigger (ctx.compact) + the
// anti-peek inject (sendUserMessage) are actually invoked by the Phase-1 driver.
// A focused recording Ops proves the bench drives the real pi primitives, not a
// silent no-op. (The continuation/probe primitives — switchSession + agent_settled —
// are exercised by the phase-2/probe unit tests.)
// ---------------------------------------------------------------------------
describe("acceptance — bench mechanism primitives fire (compaction trigger + inject)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-accept-mech-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** A minimal recording Ops: records the fresh pi each trigger + appended anti-peek texts. */
  function recordingOps(): {
    ops: Phase1Ops;
    triggeredPis: ExtensionAPI[];
    injectedTexts: string[];
  } {
    const triggeredPis: ExtensionAPI[] = [];
    const injectedTexts: string[] = [];
    const ops: Phase1Ops = {
      trigger: async (pi) => {
        triggeredPis.push(pi);
        return { compactionEntry: makeBoundaryCompaction(), wallMs: 4200 };
      },
      loadSession: async (_ctx, _path, cb) => {
        // Re-activation: activate(freshPi) stashes the fresh pi + proxies BEFORE withSession runs.
        const pi = {
          sendUserMessage: (text: string) => {
            injectedTexts.push(text);
          },
          setActiveTools: () => {},
        } as unknown as ExtensionAPI;
        setBenchPi(pi);
        setMemoryProxies(makeEnabledProxies());
        return cb({} as unknown as ExtensionCommandContext);
      },
      fork: async () => {},
      checkout: async () => {},
      commit: async () => {},
      branchExists: () => false,
      commitCountAhead: () => 0,
      deleteBranch: () => {},
      exists: () => false,
      newestBranches: () => [],
      copySeed: () => {},
      appendAntiPeek: (_p, text) => {
        injectedTexts.push(text);
      },
    };
    return { ops, triggeredPis, injectedTexts };
  }

  it("fires the compaction trigger once per arm + appends the anti-peek entry per arm file", async () => {
    const arms: readonly ArmId[] = ["A1", "A3"];
    const { ops, triggeredPis, injectedTexts } = recordingOps();
    const deps: Phase1Deps = {
      cmdCtx: {} as unknown as ExtensionCommandContext,
      scenarioRepo: repo,
      sessionsDir: join(repo, "sessions"),
      date: "2026-08-11",
      id: 1,
      cfgId: "cfg-test1",
      toolVersions: {},
      omFullReflectionThresholdTokens: 4000,
      armsEnabled: [...arms],
      ops,
    };

    const { bases } = await runPhase1(deps);

    expect(bases).toHaveLength(2);
    // the compaction primitive fired exactly once per arm
    expect(triggeredPis).toHaveLength(2);
    // the anti-peek inject primitive fired once per arm with the canonical prompt
    expect(injectedTexts.filter((t) => t === ANTI_PEEK_PROMPT)).toHaveLength(2);
  });
});

/** A minimal boundary CompactionEntry with usage (the exact metrics read usage off it). */
function makeBoundaryCompaction(): CompactionEntry {
  return {
    type: "compaction",
    id: "c1",
    parentId: "u0",
    timestamp: "2026-08-11T00:00:00.000Z",
    summary: "boundary summary",
    firstKeptEntryId: "kept-1",
    tokensBefore: 140000,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 },
    },
    fromHook: false,
  } as CompactionEntry;
}

/** Memory proxies whose getConfig reports both arms enabled (so configureArm proceeds). */
function makeEnabledProxies(): MemoryProxies {
  return {
    om: { reloadConfig: () => {}, getConfig: () => ({ enabled: true }) },
    mk: { reloadConfig: () => {}, getConfig: () => ({ enabled: true }) },
  } as unknown as MemoryProxies;
}
