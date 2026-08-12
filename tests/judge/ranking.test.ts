// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type RankAxisOptions, rankAxis } from "../../src/judge/ranking.js";
import type { CallJudge } from "../../src/judge/single-call.js";

/** Deterministic label assignment for assertions: armIds sorted -> A, B, C... */
const identityShuffle = <T>(xs: readonly T[]): T[] => [...xs];

describe("rankAxis (combined)", () => {
  it("parses the judge's {order} + maps anonymized labels back to arm ids", async () => {
    // armSlices in sorted-id order: arm1->A, arm2->B, arm3->C. Judge ranks B > A > C.
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["B", "A", "C"] });
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "slice-1", arm2: "slice-2", arm3: "slice-3" },
      options: { shuffle: identityShuffle },
    });
    expect(ranking.order).toEqual(["arm2", "arm1", "arm3"]);
  });

  it("uses the axis rubric in the system prompt", async () => {
    const seen: string[] = [];
    const callJudge: CallJudge = async (sys) => {
      seen.push(sys);
      return JSON.stringify({ order: ["A", "B"] });
    };
    await rankAxis({
      callJudge,
      axis: "E1",
      armSlices: { arm1: "s1", arm2: "s2" },
      options: { shuffle: identityShuffle },
    });
    expect(seen[0]).toContain("resume"); // E1 rubric content
  });

  it("re-prompts on malformed JSON, then succeeds (<= maxRetries)", async () => {
    const responses = ["not json", JSON.stringify({ order: ["A", "B"] })];
    let i = 0;
    const callJudge: CallJudge = async () => responses[i++] ?? "";
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2" },
      options: { shuffle: identityShuffle, maxRetries: 2 },
    });
    expect(ranking.order).toEqual(["arm1", "arm2"]);
  });

  it("throws after maxRetries malformed responses (STOP+surface)", async () => {
    const callJudge: CallJudge = async () => "garbage";
    await expect(
      rankAxis({
        callJudge,
        axis: "E7",
        armSlices: { arm1: "s1", arm2: "s2" },
        options: { shuffle: identityShuffle, maxRetries: 1 },
      }),
    ).rejects.toThrow(/malformed|not valid json/i);
  });

  it("requires every ranked label to be a known arm (rejects invented labels)", async () => {
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A", "Z"] }); // Z unknown
    await expect(
      rankAxis({
        callJudge,
        axis: "E7",
        armSlices: { arm1: "s1", arm2: "s2" },
        options: { shuffle: identityShuffle },
      }),
    ).rejects.toThrow(/unknown.*label|invented/i);
  });
});

describe("rankAxis (pairwise)", () => {
  it("aggregates C(N,2) pairwise wins into a full order", async () => {
    // 3 arms -> 3 pairs. Make arm2 beat everyone; arm1 beat arm3; so order arm2 > arm1 > arm3.
    const armLabel: Record<string, string> = { arm1: "A", arm2: "B", arm3: "C" };
    const beats: Record<string, string> = { "A-B": "B", "A-C": "A", "B-C": "B" }; // pair-key sorted -> winner label
    const callJudge: CallJudge = async (_sys, user) => {
      // The user content presents two labels; parse them out to find the pair.
      const labels = ["A", "B", "C"].filter((l) => user.includes(`Arm ${l}`));
      labels.sort();
      const winner = beats[labels.join("-")] ?? labels[0];
      return JSON.stringify({ better: winner });
    };
    void armLabel;
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2", arm3: "s3" },
      options: { strategy: "pairwise", shuffle: identityShuffle },
    });
    expect(ranking.order).toEqual(["arm2", "arm1", "arm3"]); // B(2 wins) > A(1) > C(0)
  });

  it("breaks win-count ties deterministically by arm id", async () => {
    // 2 arms, judge always picks A (arm1) -> arm1 has 1 win, arm2 has 0.
    const callJudge: CallJudge = async () => JSON.stringify({ better: "A" });
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2" },
      options: { strategy: "pairwise", shuffle: identityShuffle },
    });
    expect(ranking.order).toEqual(["arm1", "arm2"]);
  });
});

describe("rankAxis (auto strategy)", () => {
  it("uses combined when the combined slice fits the budget", async () => {
    let calls = 0;
    const callJudge: CallJudge = async () => {
      calls += 1;
      return JSON.stringify({ order: ["A", "B"] });
    };
    await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "small", arm2: "small" },
      options: { strategy: "auto", maxCombinedChars: 100000, shuffle: identityShuffle },
    });
    expect(calls).toBe(1); // one combined call
  });

  it("falls back to pairwise when the combined slice exceeds the budget", async () => {
    let calls = 0;
    const callJudge: CallJudge = async () => {
      calls += 1;
      return JSON.stringify({ better: "A" }); // pairwise shape (2 arms -> 1 pair -> 1 call)
    };
    await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "x".repeat(100), arm2: "y".repeat(100) },
      options: { strategy: "auto", maxCombinedChars: 50, shuffle: identityShuffle },
    });
    expect(calls).toBe(1); // 1 pair for 2 arms -> 1 call (pairwise), not a combined call
  });
});

describe("rankAxis (edges)", () => {
  it("a single arm is ranked trivially (no judge call needed)", async () => {
    const callJudge: CallJudge = async () => {
      throw new Error("should not be called for a single arm");
    };
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "solo" },
      options: { shuffle: identityShuffle } as RankAxisOptions,
    });
    expect(ranking.order).toEqual(["arm1"]);
  });
});
