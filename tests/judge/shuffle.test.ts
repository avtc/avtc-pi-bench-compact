import { describe, expect, it } from "vitest";
import { seededShuffle } from "../../src/judge/shuffle.js";

describe("seededShuffle", () => {
  it("is a permutation of the input (same multiset)", () => {
    const shuf = seededShuffle(42);
    const out = shuf(["a", "b", "c", "d", "e"]);
    expect(out.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is deterministic for the same seed", () => {
    const a = seededShuffle(7)(["a", "b", "c", "d", "e"]);
    const b = seededShuffle(7)(["a", "b", "c", "d", "e"]);
    expect(a).toEqual(b);
  });

  it("a different seed usually yields a different permutation", () => {
    const a = seededShuffle(1)(["a", "b", "c", "d", "e"]);
    const b = seededShuffle(999)(["a", "b", "c", "d", "e"]);
    expect(a).not.toEqual(b);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    const original = input.slice();
    seededShuffle(1)(input);
    expect(input).toEqual(original);
  });

  it("empty + single-element arrays are no-ops", () => {
    expect(seededShuffle(1)([])).toEqual([]);
    expect(seededShuffle(1)(["x"])).toEqual(["x"]);
  });
});
