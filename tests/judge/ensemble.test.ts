// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { C2Boundary } from "../../src/judge/c2-boundary.js";
import {
  bordaAggregate,
  majorityVote,
  rankEnsemble,
  runBinaryEnsemble,
  unionC2Boundaries,
} from "../../src/judge/ensemble.js";
import type { Ranking } from "../../src/judge/ranking.js";

const ranking = (order: readonly string[]): Ranking => ({ order });
const c2b = (factId: string, entryId: string | null, evidence: string): C2Boundary => ({
  factId,
  firstCorrectUseEntryId: entryId,
  evidence,
});

describe("majorityVote", () => {
  it("K=1 returns the single value", () => {
    expect(majorityVote([true])).toBe(true);
    expect(majorityVote([false])).toBe(false);
  });
  it("K=3 returns the majority (>=2)", () => {
    expect(majorityVote([true, true, false])).toBe(true);
    expect(majorityVote([true, false, false])).toBe(false);
    expect(majorityVote([false, false, false])).toBe(false);
    expect(majorityVote([true, true, true])).toBe(true);
  });
});

describe("runBinaryEnsemble", () => {
  it("K=1 short-circuits to the single grade", async () => {
    await expect(runBinaryEnsemble([Promise.resolve(true)])).resolves.toBe(true);
    await expect(runBinaryEnsemble([Promise.resolve(false)])).resolves.toBe(false);
  });
  it("K=3 majority-votes the resolved grades", async () => {
    await expect(
      runBinaryEnsemble([Promise.resolve(true), Promise.resolve(false), Promise.resolve(true)]),
    ).resolves.toBe(true);
  });
  it("awaits all judges in parallel (rejects propagate)", async () => {
    await expect(
      runBinaryEnsemble([Promise.resolve(true), Promise.reject(new Error("boom")), Promise.resolve(false)]),
    ).rejects.toThrow("boom");
  });
});

describe("bordaAggregate", () => {
  it("sums rank positions across rankings; lowest sum = best", () => {
    // judge1: A>B>C ; judge2: A>B>C → A=0, B=2, C=4 → A,B,C
    const r = bordaAggregate([ranking(["A", "B", "C"]), ranking(["A", "B", "C"])], ["A", "B", "C"]);
    expect(r.order).toEqual(["A", "B", "C"]);
  });
  it("resolves disagreement by summed position", () => {
    // judge1: A>B>C (A=0,B=1,C=2); judge2: B>A>C (A=1,B=0,C=2) → A=1,B=1,C=4 → tie A/B then C
    // tie broken by ... (stable sort keeps first-seen among tied). A before B (first seen).
    const r = bordaAggregate([ranking(["A", "B", "C"]), ranking(["B", "A", "C"])], ["A", "B", "C"]);
    expect(r.order).toEqual(["A", "B", "C"]); // A,B tie at 1; A first-seen
  });
  it("arm absent from a ranking is scored at the tail (position = armCount)", () => {
    // judge ranks only A (B,C unranked → tail positions). armIds defines the universe.
    const r = bordaAggregate([ranking(["A"])], ["A", "B", "C"]);
    expect(r.order[0]).toBe("A"); // A best
    expect(new Set(r.order)).toEqual(new Set(["A", "B", "C"]));
  });
});

describe("rankEnsemble", () => {
  it("K=1 short-circuits to the single ranking", async () => {
    await expect(rankEnsemble([Promise.resolve(ranking(["A", "B"]))], ["A", "B"])).resolves.toEqual({
      order: ["A", "B"],
    });
  });
  it("K=3 Borda-aggregates", async () => {
    const r = await rankEnsemble(
      [
        Promise.resolve(ranking(["A", "B", "C"])),
        Promise.resolve(ranking(["A", "B", "C"])),
        Promise.resolve(ranking(["A", "B", "C"])),
      ],
      ["A", "B", "C"],
    );
    expect(r.order).toEqual(["A", "B", "C"]);
  });
});

describe("unionC2Boundaries", () => {
  it("K=1 returns the single judge's boundaries unchanged", () => {
    const single = [c2b("f1", "e5", "e"), c2b("f2", null, "e")];
    expect(unionC2Boundaries([single])).toEqual(single);
  });
  it("a fact counts recovered if ANY judge found its first-correct-use", () => {
    const j1 = [c2b("f1", null, "e")]; // judge1: not recovered
    const j2 = [c2b("f1", "e9", "e")]; // judge2: recovered at e9
    const out = unionC2Boundaries([j1, j2]);
    expect(out).toHaveLength(1);
    expect(out[0]?.firstCorrectUseEntryId).toBe("e9"); // recovered (judge2's boundary wins)
  });
  it("all-null across judges stays null (notRecovered)", () => {
    const out = unionC2Boundaries([[c2b("f1", null, "e")], [c2b("f1", null, "e")]]);
    expect(out[0]?.firstCorrectUseEntryId).toBeNull();
  });
  it("merges disjoint fact sets across judges", () => {
    const out = unionC2Boundaries([[c2b("f1", "e1", "e")], [c2b("f2", "e2", "e")]]);
    expect(out.map((b) => b.factId).sort()).toEqual(["f1", "f2"]);
  });
  it("empty input → []", () => {
    expect(unionC2Boundaries([])).toEqual([]);
  });
});
