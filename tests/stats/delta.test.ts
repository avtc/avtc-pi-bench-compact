// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { METRIC_DEFS, type MetricId } from "../../src/metrics/defs.js";
import type { AggregateResult, ArmMetrics } from "../../src/stats/aggregate.js";
import { a1Delta, extractArmScalars, isNetNegative } from "../../src/stats/delta.js";

const armMetrics = (over: Partial<ArmMetrics> | null): ArmMetrics => ({
  binary: {},
  exact: {},
  ...(over ?? {}),
});

const ci: readonly [number, number] = [0, 1];

describe("extractArmScalars", () => {
  it("extracts rate (binary), mean (C1/C3), dollars (C4), rank (comparative)", () => {
    const metrics = armMetrics({
      binary: { E5: { rate: 0.8, ci, n: 10 } },
      exact: {
        C1: { mean: 1000, ci },
        C3: { mean: 40000, ci },
        C2: { mean: 150, ci, notRecoveredRate: 0.2 },
        C4: {
          tokensIn: 1000,
          tokensOut: 100,
          cacheRead: 500,
          cacheWrite: 50,
          dollars: 0.03,
          wallMs: 40000,
          stages: ["Observer"],
          phase2CompactionCount: 1,
        },
      },
    });
    const comparative: AggregateResult["comparative"] = {
      E1: { order: ["A3"], elo: { A3: 1000 }, ranks: { A3: { rank: 2, rankCi: ci } } },
    };
    const scalars = extractArmScalars("A3", metrics, comparative);
    expect(scalars.E5).toBe(0.8);
    expect(scalars.C1).toBe(1000);
    expect(scalars.C3).toBe(40000);
    expect(scalars.C2).toBe(150);
    expect(scalars.C4).toBe(0.03);
    expect(scalars.E1).toBe(2);
  });

  it("C2 with null mean (all notRecovered) → C2 scalar null", () => {
    const metrics = armMetrics({ exact: { C2: { mean: null, ci: null, notRecoveredRate: 1.0 } } });
    expect(extractArmScalars("A1", metrics, {}).C2).toBeNull();
  });
});

describe("a1Delta — polarity-aware (+ = better than A1)", () => {
  it("higherBetter (E5 rate): arm higher than A1 → positive delta", () => {
    const delta = a1Delta({ E5: 0.8 }, { E5: 0.5 }, METRIC_DEFS);
    expect(delta.E5).toBeCloseTo(0.3, 10);
    expect(isNetNegative(delta.E5 ?? null)).toBe(false);
  });

  it("higherBetter (E5 rate): arm lower than A1 → negative (net-negative)", () => {
    const delta = a1Delta({ E5: 0.2 }, { E5: 0.6 }, METRIC_DEFS);
    expect(delta.E5).toBeCloseTo(-0.4, 10);
    expect(isNetNegative(delta.E5 ?? null)).toBe(true);
  });

  it("lowerBetter (C1 mean): arm LOWER cost than A1 → positive delta", () => {
    const delta = a1Delta({ C1: 1000 }, { C1: 1200 }, METRIC_DEFS);
    expect(delta.C1).toBe(200); // a1 - arm = 1200 - 1000
    expect(isNetNegative(delta.C1 ?? null)).toBe(false);
  });

  it("lowerBetter (C1 mean): arm HIGHER cost than A1 → negative (net-negative)", () => {
    const delta = a1Delta({ C1: 1500 }, { C1: 1200 }, METRIC_DEFS);
    expect(delta.C1).toBe(-300);
    expect(isNetNegative(delta.C1 ?? null)).toBe(true);
  });

  it("rankLowerBetter (E1 rank): arm ranked better (lower number) than A1 → positive", () => {
    const delta = a1Delta({ E1: 2 }, { E1: 4 }, METRIC_DEFS);
    expect(delta.E1).toBe(2); // a1Rank - armRank = 4 - 2
    expect(isNetNegative(delta.E1 ?? null)).toBe(false);
  });

  it("rankLowerBetter (E1 rank): arm ranked worse (higher number) than A1 → negative", () => {
    const delta = a1Delta({ E1: 5 }, { E1: 2 }, METRIC_DEFS);
    expect(delta.E1).toBe(-3);
    expect(isNetNegative(delta.E1 ?? null)).toBe(true);
  });

  it("C4 (dollars, lowerBetter): arm cheaper than A1 → positive", () => {
    const delta = a1Delta({ C4: 0.03 }, { C4: 0.1 }, METRIC_DEFS);
    expect(delta.C4).toBeCloseTo(0.07, 10);
  });

  it("C2 null scalar (all notRecovered) → delta null", () => {
    const delta = a1Delta({ C2: null }, { C2: 150 }, METRIC_DEFS);
    expect(delta.C2).toBeNull();
  });

  it("A1 scalar absent → delta null (metric A1 didn't produce)", () => {
    const delta = a1Delta({ E5: 0.8 }, {}, METRIC_DEFS);
    expect(delta.E5).toBeNull();
  });

  it("A1 entirely absent (disabled) → every delta null (conditional attribution)", () => {
    const armScalars: Partial<Record<MetricId, number | null>> = { E5: 0.8, C1: 1000, C4: 0.03 };
    const delta = a1Delta(armScalars, {}, METRIC_DEFS);
    for (const v of Object.values(delta)) expect(v).toBeNull();
  });

  it("equal arm + A1 → delta 0 (not net-negative)", () => {
    const delta = a1Delta({ E5: 0.5 }, { E5: 0.5 }, METRIC_DEFS);
    expect(delta.E5).toBe(0);
    expect(isNetNegative(delta.E5 ?? null)).toBe(false);
  });

  it("NaN scalar → delta null", () => {
    const delta = a1Delta({ C1: Number.NaN }, { C1: 1000 }, METRIC_DEFS);
    expect(delta.C1).toBeNull();
  });
});

describe("isNetNegative", () => {
  it("null delta → false", () => {
    expect(isNetNegative(null)).toBe(false);
  });
  it("zero → false", () => {
    expect(isNetNegative(0)).toBe(false);
  });
  it("positive → false", () => {
    expect(isNetNegative(0.3)).toBe(false);
  });
  it("negative → true", () => {
    expect(isNetNegative(-0.1)).toBe(true);
  });
});
