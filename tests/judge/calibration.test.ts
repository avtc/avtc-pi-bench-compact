// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  BINARY_GATE,
  type BinaryCalibrationSample,
  type CalibrationSample,
  type ComparativeCalibrationSample,
  RANK_GATE,
  type RankSlices,
  runCalibrationGate,
} from "../../src/judge/calibration.js";
import type { CallJudge } from "../../src/judge/single-call.js";

function binarySample(id: string, goldPass: boolean): BinaryCalibrationSample {
  return { kind: "binary", id, axis: "E5", slice: `slice-${id}`, goldPass };
}

function compSample(id: string, armSlices: Record<string, string>, goldOrder: string[]): ComparativeCalibrationSample {
  return { kind: "comparative", id, axis: "E1", armSlices, goldOrder };
}

/** Sort arm keys alphabetically (deterministic fake judge order). */
const sortedKeys = (armSlices: Readonly<Record<string, string>>): string[] => Object.keys(armSlices).sort();

/** Fake RankSlices that returns the alphabetical order (treated as the judge's ranking). */
const rankAlphabetical: RankSlices = async (_axis, armSlices) => sortedKeys(armSlices);

/** Fake RankSlices that swaps the top two alphabetical arms (off-by-one, within ±1). */
const rankSwapTop: RankSlices = async (_axis, armSlices) => {
  const k = sortedKeys(armSlices);
  if (k.length >= 2) {
    [k[0], k[1]] = [k[1], k[0]];
  }
  return k;
};

/** Fake RankSlices that reverses the alphabetical order (worst divergence). */
const rankReversed: RankSlices = async (_axis, armSlices) => sortedKeys(armSlices).reverse();

describe("runCalibrationGate (binary)", () => {
  it("passes when the judge agrees on all binary samples (≥85% gate)", async () => {
    const samples: CalibrationSample[] = [
      binarySample("b1", true),
      binarySample("b2", false),
      binarySample("b3", true),
    ];
    // Judge agrees with gold exactly: derive pass from the slice's id → gold.
    const callJudge: CallJudge = async (_sys, slice) => {
      const id = slice.replace("slice-", "");
      const gold = samples.find((s) => s.id === id) as BinaryCalibrationSample;
      return JSON.stringify({ pass: gold.goldPass, evidence: "" });
    };
    const result = await runCalibrationGate({ callJudge, rankSlices: rankAlphabetical, samples });
    expect(result.binaryAgreement).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("fails binary when agreement drops below the 85% gate", async () => {
    const samples: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => binarySample(`b${i}`, i % 2 === 0));
    // Judge disagrees on the first 3 (returns opposite of gold) → 70% < 85%.
    const callJudge: CallJudge = async (_sys, slice) => {
      const id = slice.replace("slice-", "");
      const idx = Number(id.slice(1));
      const gold = samples.find((s) => s.id === id) as BinaryCalibrationSample;
      const disagree = idx < 3;
      return JSON.stringify({ pass: disagree ? !gold.goldPass : gold.goldPass, evidence: "" });
    };
    const result = await runCalibrationGate({ callJudge, rankSlices: rankAlphabetical, samples });
    expect(result.binaryAgreement).toBe(0.7);
    expect(result.pass).toBe(false);
  });
});

describe("runCalibrationGate (comparative)", () => {
  it("passes when the judge ranks within ±1 on ≥80% of slots", async () => {
    // Gold is alphabetical [A,B,C]; judge (swapTop) returns [B,A,C] — every arm within ±1.
    const samples: CalibrationSample[] = [
      compSample("c1", { A: "s-a", B: "s-b", C: "s-c" }, ["A", "B", "C"]),
      compSample("c2", { A: "s-a", B: "s-b" }, ["A", "B"]),
    ];
    const callJudge: CallJudge = async () => JSON.stringify({ pass: true, evidence: "" });
    const result = await runCalibrationGate({ callJudge, rankSlices: rankSwapTop, samples });
    expect(result.rankAccuracy).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("fails comparative when any slot's ranking diverges by more than ±1 on an arm", async () => {
    // Gold [A,B,C,D]; judge (reversed) returns [D,C,B,A]: A 0->3 (off 3) -> slot fails.
    const samples: CalibrationSample[] = [compSample("c1", { A: "a", B: "b", C: "c", D: "d" }, ["A", "B", "C", "D"])];
    const callJudge: CallJudge = async () => JSON.stringify({ pass: true, evidence: "" });
    const result = await runCalibrationGate({ callJudge, rankSlices: rankReversed, samples });
    expect(result.rankAccuracy).toBeLessThan(RANK_GATE);
    expect(result.pass).toBe(false);
  });

  it("fails comparative when the judge returns an EMPTY order on a non-empty slot (never pass an uncalibrated judge)", async () => {
    // Regression: a broken RankSlices returning [] must NOT report perfect accuracy.
    const emptyRank: RankSlices = async () => [];
    const samples: CalibrationSample[] = [compSample("c1", { A: "a", B: "b" }, ["A", "B"])];
    const callJudge: CallJudge = async () => JSON.stringify({ pass: true, evidence: "" });
    const result = await runCalibrationGate({ callJudge, rankSlices: emptyRank, samples });
    expect(result.rankAccuracy).toBe(0);
    expect(result.pass).toBe(false);
  });

  it("a slot with one arm within ±1 + one off still fails the slot (strict all-within per slot)", async () => {
    // Gold [A,B,C]; judge returns [C,B,A] — B ok (pos 1), A off (0->2), C off (2->0) -> slot fails.
    const offRank: RankSlices = async (_axis, armSlices) => sortedKeys(armSlices).reverse();
    const samples: CalibrationSample[] = [
      compSample("c1", { A: "a", B: "b", C: "c" }, ["A", "B", "C"]),
      compSample("c2", { A: "a", B: "b", C: "c" }, ["A", "B", "C"]),
    ];
    const callJudge: CallJudge = async () => JSON.stringify({ pass: true, evidence: "" });
    const result = await runCalibrationGate({ callJudge, rankSlices: offRank, samples });
    expect(result.rankAccuracy).toBe(0);
    expect(result.pass).toBe(false);
  });
});

describe("runCalibrationGate (edges)", () => {
  it("empty binary + comparative sets do not block (gates trivially satisfied)", async () => {
    const callJudge: CallJudge = async () => JSON.stringify({ pass: true, evidence: "" });
    const result = await runCalibrationGate({ callJudge, rankSlices: rankAlphabetical, samples: [] });
    expect(result.binaryCount).toBe(0);
    expect(result.comparativeCount).toBe(0);
    expect(result.pass).toBe(true);
  });

  it("records per-sample failures (ids that disagreed) for operator inspection", async () => {
    const samples: CalibrationSample[] = [
      binarySample("agree1", true),
      binarySample("disagree1", true),
      binarySample("disagree2", true),
    ];
    const callJudge: CallJudge = async (_sys, slice) => {
      const disagree = slice.includes("disagree");
      return JSON.stringify({ pass: !disagree, evidence: "" });
    };
    const result = await runCalibrationGate({ callJudge, rankSlices: rankAlphabetical, samples });
    expect(result.failures).toContain("disagree1");
    expect(result.failures).toContain("disagree2");
    expect(result.failures).not.toContain("agree1");
  });
});

describe("calibration gates are the §5.11 thresholds", () => {
  it("BINARY_GATE is 0.85 (≥85% binary agreement)", () => {
    expect(BINARY_GATE).toBe(0.85);
  });
  it("RANK_GATE is 0.80 (±1 rank on ≥80% of slots)", () => {
    expect(RANK_GATE).toBe(0.8);
  });
});
