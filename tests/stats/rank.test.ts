// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type ArmRanking, aggregateRanks, rankMatrix } from "../../src/stats/rank.js";

const r = (order: readonly string[]): ArmRanking => ({ order: order as ArmRanking["order"] });

describe("rankMatrix", () => {
  it("averages each arm's position across runs and orders best (lowest avg rank) → worst", () => {
    // Two run-slots; A3 is 1st both times, A1 last both times, A2 middle.
    const rankings: ArmRanking[] = [r(["A3", "A2", "A1"]), r(["A3", "A2", "A1"])];
    const matrix = rankMatrix(rankings, ["A1", "A2", "A3"]);
    expect(matrix.avgRank.A3).toBe(1);
    expect(matrix.avgRank.A2).toBe(2);
    expect(matrix.avgRank.A1).toBe(3);
    expect(matrix.order).toEqual(["A3", "A2", "A1"]);
  });

  it("handles mixed rankings by averaging positions", () => {
    // A3: (1+2)/2=1.5, A2: (2+1)/2=1.5, A1: (3+3)/2=3 → A3/A2 tie at 1.5, A1 last.
    const rankings: ArmRanking[] = [r(["A3", "A2", "A1"]), r(["A2", "A3", "A1"])];
    const matrix = rankMatrix(rankings, ["A1", "A2", "A3"]);
    expect(matrix.avgRank.A1).toBe(3);
    expect(matrix.avgRank.A2).toBe(1.5);
    expect(matrix.avgRank.A3).toBe(1.5);
    // Tie broken deterministically (A2 before A3 by stable id order at equal avg).
    expect(matrix.order).toEqual(["A2", "A3", "A1"]);
  });

  it("returns empty order + no avgRank when there are no rankings", () => {
    const matrix = rankMatrix([], ["A1", "A2"]);
    expect(matrix.order).toEqual([]);
    expect(matrix.avgRank).toEqual({});
  });

  it("treats an arm absent from a ranking as tied-last in that run", () => {
    // A ranking listing only A2,A1 → A3 absent → ranked last (position 3) in that run.
    const matrix = rankMatrix([r(["A2", "A1"])], ["A1", "A2", "A3"]);
    expect(matrix.avgRank.A2).toBe(1);
    expect(matrix.avgRank.A1).toBe(2);
    expect(matrix.avgRank.A3).toBe(3);
  });
});

describe("aggregateRanks", () => {
  it("produces a consistent order + per-arm rank (1=best) + rankCi", () => {
    const rankings: ArmRanking[] = [r(["A3", "A2", "A1"]), r(["A3", "A2", "A1"]), r(["A3", "A2", "A1"])];
    const result = aggregateRanks(rankings, ["A1", "A2", "A3"], null);
    expect(result.order).toEqual(["A3", "A2", "A1"]);
    expect(result.ranks.A3?.rank).toBe(1);
    expect(result.ranks.A2?.rank).toBe(2);
    expect(result.ranks.A1?.rank).toBe(3);
    // CI brackets the average rank.
    const ci = result.ranks.A3?.rankCi;
    expect(ci?.[0]).toBeLessThanOrEqual(ci?.[1] ?? Number.NaN);
  });

  it("computes Elo where the consistently-best arm scores highest", () => {
    const rankings: ArmRanking[] = [r(["A3", "A2", "A1"]), r(["A3", "A2", "A1"])];
    const result = aggregateRanks(rankings, ["A1", "A2", "A3"], null);
    const eloA3 = result.elo.A3;
    const eloA2 = result.elo.A2;
    const eloA1 = result.elo.A1;
    expect(eloA3).toBeDefined();
    expect(eloA2).toBeDefined();
    expect(eloA1).toBeDefined();
    expect(eloA3 ?? 0).toBeGreaterThan(eloA2 ?? 0);
    expect(eloA2 ?? 0).toBeGreaterThan(eloA1 ?? 0);
  });

  it("is deterministic given a seed (rankCi reproducible)", () => {
    const rankings: ArmRanking[] = [r(["A2", "A1"]), r(["A1", "A2"]), r(["A2", "A1"]), r(["A2", "A1"])];
    const a = aggregateRanks(rankings, ["A1", "A2"], { seed: 5, samples: 2000 });
    const b = aggregateRanks(rankings, ["A1", "A2"], { seed: 5, samples: 2000 });
    expect(a).toEqual(b);
  });

  it("rankCi brackets the arm's average rank", () => {
    const rankings: ArmRanking[] = [
      r(["A1", "A2", "A3"]),
      r(["A3", "A1", "A2"]),
      r(["A2", "A3", "A1"]),
      r(["A1", "A3", "A2"]),
    ];
    const result = aggregateRanks(rankings, ["A1", "A2", "A3"], { seed: 9, samples: 3000 });
    for (const arm of ["A1", "A2", "A3"] as const) {
      const rankCi = result.ranks[arm]?.rankCi;
      expect(rankCi?.[0]).toBeLessThanOrEqual(rankCi?.[1] ?? Number.NaN);
    }
  });

  it("a single arm → rank 1, Elo at baseline, point rankCi", () => {
    const result = aggregateRanks([r(["A1"])], ["A1"], null);
    expect(result.order).toEqual(["A1"]);
    expect(result.ranks.A1?.rank).toBe(1);
    expect(result.elo.A1).toBe(1000);
  });

  it("empty rankings → empty order, no ranks, no elo", () => {
    const result = aggregateRanks([], ["A1", "A2"], null);
    expect(result.order).toEqual([]);
    expect(result.ranks).toEqual({});
    expect(result.elo).toEqual({});
  });
});
