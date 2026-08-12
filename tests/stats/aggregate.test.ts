// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { C2Result } from "../../src/metrics/c2.js";
import type { C4Result } from "../../src/metrics/exact.js";
import { type AllArmsGrades, aggregateArmMetrics } from "../../src/stats/aggregate.js";

const c2 = (tokens: number, notRecovered: boolean): C2Result => ({ tokens, notRecovered });
const c4 = (dollars: number, wallMs: number, stages: string[], phase2: number): C4Result => ({
  tokensIn: 1000,
  tokensOut: 100,
  cacheRead: 500,
  cacheWrite: 50,
  dollars,
  wallMs,
  stages,
  phase2Compactions: Array.from({ length: phase2 }, () => ({
    tokensIn: 10,
    tokensOut: 1,
    cacheRead: 5,
    cacheWrite: 1,
    dollars: 0.01,
    wallMs: 100,
  })),
});

const OPTS = { samples: 500, seed: 1 };

describe("aggregateArmMetrics — binary channel", () => {
  it("routes a binary metric to {rate, ci, n}", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { binary: { E5: [true, false, true, true, false] } } },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    const e5 = result.arms.A1?.binary.E5;
    expect(e5).toBeDefined();
    expect(e5?.rate).toBeCloseTo(0.6, 10);
    expect(e5?.n).toBe(5);
    expect(e5?.ci[0]).toBeLessThanOrEqual(e5?.ci[1] ?? NaN);
  });
});

describe("aggregateArmMetrics — comparative channel", () => {
  it("routes a comparative metric to cross-arm {order, elo, ranks}", () => {
    const grades: AllArmsGrades = {
      arms: { A1: {}, A3: {} },
      comparative: { E1: [{ order: ["A3", "A1"] }, { order: ["A3", "A1"] }] },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    const e1 = result.comparative.E1;
    expect(e1).toBeDefined();
    expect(e1?.order).toEqual(["A3", "A1"]);
    expect(e1?.ranks.A3?.rank).toBe(1);
    expect(e1?.ranks.A1?.rank).toBe(2);
  });
});

describe("aggregateArmMetrics — exact C1/C3 channel", () => {
  it("routes C1/C3 to {mean, ci}", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { exact: { C1: [1200, 1300, 1100], C3: [40000, 50000, 45000] } } },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    expect(result.arms.A1?.exact.C1?.mean).toBe(1200);
    expect(result.arms.A1?.exact.C3?.mean).toBeCloseTo(45000, 5);
  });
});

describe("aggregateArmMetrics — exact C2 channel", () => {
  it("mean is over RECOVERED runs only; notRecoveredRate = fraction never recovered", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { exact: { C2: [c2(100, false), c2(200, false), c2(0, true)] } } },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    const c2m = result.arms.A1?.exact.C2;
    expect(c2m?.mean).toBe(150); // (100+200)/2 — recovered only
    expect(c2m?.notRecoveredRate).toBeCloseTo(1 / 3, 10);
    expect(c2m?.ci).not.toBeNull();
  });

  it("when ALL runs notRecovered → mean null, ci null, notRecoveredRate 1.0", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { exact: { C2: [c2(999, true), c2(888, true)] } } },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    expect(result.arms.A1?.exact.C2).toEqual({ mean: null, ci: null, notRecoveredRate: 1.0 });
  });
});

describe("aggregateArmMetrics — exact C4 channel", () => {
  it("aggregates C4 to mean of numeric fields + mode stages + mean phase-2 count", () => {
    const grades: AllArmsGrades = {
      arms: {
        A3: {
          exact: {
            C4: [c4(0.03, 40000, ["Observer", "Builder"], 1), c4(0.05, 42000, ["Observer", "Builder"], 3)],
          },
        },
      },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    const c4m = result.arms.A3?.exact.C4;
    expect(c4m?.dollars).toBeCloseTo(0.04, 10); // mean
    expect(c4m?.wallMs).toBe(41000); // mean
    expect(c4m?.tokensIn).toBe(1000); // mean (same both)
    expect(c4m?.stages).toEqual(["Observer", "Builder"]); // mode (constant here)
    expect(c4m?.phase2CompactionCount).toBe(2); // mean of [1,3]
  });

  it("C4 stages falls back to the first run's stages when no mode (no agreement)", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { exact: { C4: [c4(0.01, 2000, ["native-summary"], 0), c4(0.02, 3000, ["solo"], 0)] } } },
    };
    const result = aggregateArmMetrics(grades, OPTS);
    // Two different stage lists → first run's stages win (deterministic fallback).
    expect(result.arms.A1?.exact.C4?.stages).toEqual(["native-summary"]);
  });
});

describe("aggregateArmMetrics — routing completeness", () => {
  it("routes every channel in one call + handles multiple arms", () => {
    const grades: AllArmsGrades = {
      arms: {
        A1: {
          binary: { E5: [true, true] },
          exact: { C1: [1000], C3: [40000], C4: [c4(0.001, 2000, ["native-summary"], 0)] },
        },
        A3: {
          binary: { E5: [true, false] },
          exact: { C1: [1100], C3: [41000], C4: [c4(0.03, 40000, ["Observer", "Builder"], 0)] },
        },
      },
      comparative: { E1: [{ order: ["A3", "A1"] }] },
      enabledArms: ["A1", "A3"],
    };
    const result = aggregateArmMetrics(grades, OPTS);
    expect(Object.keys(result.arms).sort()).toEqual(["A1", "A3"]);
    expect(result.arms.A1?.binary.E5?.rate).toBe(1);
    expect(result.arms.A3?.binary.E5?.rate).toBe(0.5);
    expect(result.arms.A1?.exact.C1?.mean).toBe(1000);
    expect(result.arms.A3?.exact.C4?.stages).toEqual(["Observer", "Builder"]);
    expect(result.comparative.E1?.order).toEqual(["A3", "A1"]);
  });

  it("is deterministic given a seed", () => {
    const grades: AllArmsGrades = {
      arms: { A1: { binary: { E5: [true, false, true] }, exact: { C1: [100, 200, 300] } } },
    };
    const a = aggregateArmMetrics(grades, OPTS);
    const b = aggregateArmMetrics(grades, OPTS);
    expect(a).toEqual(b);
  });
});
