// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { rankAxis } from "../../src/judge/ranking.js";
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
      shuffle: identityShuffle,
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
      shuffle: identityShuffle,
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
      shuffle: identityShuffle,
      options: { maxRetries: 2 },
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
        shuffle: identityShuffle,
        options: { maxRetries: 1 },
      }),
    ).rejects.toThrow(/malformed|not valid json/i);
  });

  // R5: an invented label is tool-misuse (§5.12.5) -> re-prompt (not immediate surface)
  it("re-prompts on an invented label, then succeeds when the judge self-corrects (R5)", async () => {
    const responses = [JSON.stringify({ order: ["A", "Z"] }), JSON.stringify({ order: ["A", "B"] })];
    let i = 0;
    const callJudge: CallJudge = async () => responses[i++] ?? "";
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2" },
      shuffle: identityShuffle,
      options: { maxRetries: 2 },
    });
    expect(ranking.order).toEqual(["arm1", "arm2"]);
  });

  it("surfaces (STOP+surface) when the invented label persists past maxRetries (R5)", async () => {
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A", "Z"] }); // always invented
    await expect(
      rankAxis({
        callJudge,
        axis: "E7",
        armSlices: { arm1: "s1", arm2: "s2" },
        shuffle: identityShuffle,
        options: { maxRetries: 1 },
      }),
    ).rejects.toThrow(/unknown.*label|invented/i);
  });

  // R2-1: the combined order must be a PERMUTATION of the known labels (right
  // count, no dups, none omitted) — same completeness class as c2/trajectory.
  it("re-prompts when the order has a duplicate label, then succeeds (R2-1)", async () => {
    const responses = [JSON.stringify({ order: ["A", "A"] }), JSON.stringify({ order: ["A", "B"] })];
    let i = 0;
    const callJudge: CallJudge = async () => responses[i++] ?? "";
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2" },
      shuffle: identityShuffle,
      options: { maxRetries: 2 },
    });
    expect(ranking.order).toEqual(["arm1", "arm2"]);
  });

  it("surfaces when the order omits a label past maxRetries (R2-1)", async () => {
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A"] }); // B omitted
    await expect(
      rankAxis({
        callJudge,
        axis: "E7",
        armSlices: { arm1: "s1", arm2: "s2" },
        shuffle: identityShuffle,
        options: { maxRetries: 1 },
      }),
    ).rejects.toThrow(/permutation|omit|duplicate|incomplete/i);
  });
});

describe("rankAxis (pairwise)", () => {
  it("aggregates C(N,2) pairwise wins into a full order", async () => {
    // 3 arms -> 3 pairs. Make arm2 beat everyone; arm1 beat arm3; so order arm2 > arm1 > arm3.
    const beats: Record<string, string> = { "A-B": "B", "A-C": "A", "B-C": "B" };
    const callJudge: CallJudge = async (_sys, user) => {
      const labels = ["A", "B", "C"].filter((l) => user.includes(`Arm ${l}`));
      labels.sort();
      const winner = beats[labels.join("-")] ?? labels[0];
      return JSON.stringify({ better: winner });
    };
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2", arm3: "s3" },
      shuffle: identityShuffle,
      options: { strategy: "pairwise" },
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
      shuffle: identityShuffle,
      options: { strategy: "pairwise" },
    });
    expect(ranking.order).toEqual(["arm1", "arm2"]);
  });

  // R5: a missing/unknown {better} is tool-misuse -> re-prompt (not immediate surface)
  it("re-prompts on an unknown {better} label, then succeeds (R5)", async () => {
    const responses = [JSON.stringify({ better: "Q" }), JSON.stringify({ better: "A" })];
    let i = 0;
    const callJudge: CallJudge = async () => responses[i++] ?? "";
    const ranking = await rankAxis({
      callJudge,
      axis: "E7",
      armSlices: { arm1: "s1", arm2: "s2" },
      shuffle: identityShuffle,
      options: { strategy: "pairwise", maxRetries: 2 },
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
      shuffle: identityShuffle,
      options: { strategy: "auto", maxCombinedChars: 100000 },
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
      shuffle: identityShuffle,
      options: { strategy: "auto", maxCombinedChars: 50 },
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
      shuffle: identityShuffle,
    });
    expect(ranking.order).toEqual(["arm1"]);
  });

  // R10: only A..Z available (26 labels); >26 arms cannot be anonymized -> STOP+surface
  it("throws when there are more than 26 arms (label alphabet exhausted, R10)", async () => {
    const callJudge: CallJudge = async () => JSON.stringify({ order: [] });
    const armSlices: Record<string, string> = {};
    for (let i = 0; i < 27; i += 1) armSlices[`arm${i}`] = "s";
    await expect(rankAxis({ callJudge, axis: "E7", armSlices, shuffle: identityShuffle })).rejects.toThrow(
      /too many arms|26|alphabet/i,
    );
  });
});
