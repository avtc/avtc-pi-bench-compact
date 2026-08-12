// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { binaryRate, bootstrapCi } from "../../src/stats/bootstrap.js";

describe("bootstrapCi", () => {
  it("returns NaN mean + NaN CI for an empty input", () => {
    const result = bootstrapCi([], null);
    expect(Number.isNaN(result.mean)).toBe(true);
    expect(Number.isNaN(result.ci[0])).toBe(true);
    expect(Number.isNaN(result.ci[1])).toBe(true);
  });

  it("produces a point CI equal to the value when all values are identical", () => {
    const result = bootstrapCi([42, 42, 42, 42], null);
    expect(result.mean).toBe(42);
    expect(result.ci[0]).toBe(42);
    expect(result.ci[1]).toBe(42);
  });

  it("reports mean=0 + [0,0] CI for an all-zero input", () => {
    const result = bootstrapCi([0, 0, 0], null);
    expect(result.mean).toBe(0);
    expect(result.ci[0]).toBe(0);
    expect(result.ci[1]).toBe(0);
  });

  it("computes a mean that falls within its own CI", () => {
    const result = bootstrapCi([10, 20, 30, 40, 50, 60, 70, 80], { samples: 2000, seed: 7 });
    expect(result.mean).toBeGreaterThanOrEqual(result.ci[0]);
    expect(result.mean).toBeLessThanOrEqual(result.ci[1]);
  });

  it("is deterministic — the same values + seed yield the identical CI", () => {
    const values = [12, 48, 7, 33, 91, 5, 60, 22, 18, 77];
    const a = bootstrapCi(values, { samples: 2000, seed: 42 });
    const b = bootstrapCi(values, { samples: 2000, seed: 42 });
    expect(a).toEqual(b);
  });

  it("a different seed can yield a different CI (the seed drives the resampling)", () => {
    const values = [12, 48, 7, 33, 91, 5, 60, 22, 18, 77];
    const a = bootstrapCi(values, { samples: 2000, seed: 1 });
    const b = bootstrapCi(values, { samples: 2000, seed: 999 });
    // mean is seed-independent (it's the plain sample mean); CI bounds can differ.
    expect(a.mean).toBe(b.mean);
    // Not a hard guarantee for every pair, but these two seeds differ here.
    expect(a.ci).not.toEqual(b.ci);
  });

  it("uses the documented defaults when options is null (seed=1, samples=10000, 95% CI)", () => {
    // Smoke: runs with defaults without error + stays deterministic.
    const a = bootstrapCi([1, 2, 3, 4, 5], null);
    const b = bootstrapCi([1, 2, 3, 4, 5], null);
    expect(a).toEqual(b);
    expect(a.mean).toBe(3);
  });
});

describe("binaryRate", () => {
  it("rate = fraction of passes; n = count", () => {
    const result = binaryRate([true, false, true, true, false], null);
    expect(result.rate).toBeCloseTo(0.6, 10);
    expect(result.n).toBe(5);
  });

  it("rate ∈ [0,1] and CI brackets the rate", () => {
    const result = binaryRate([true, false, true, false, true, true, false, true, true, false], {
      samples: 2000,
      seed: 3,
    });
    expect(result.rate).toBeGreaterThanOrEqual(0);
    expect(result.rate).toBeLessThanOrEqual(1);
    expect(result.rate).toBeGreaterThanOrEqual(result.ci[0]);
    expect(result.rate).toBeLessThanOrEqual(result.ci[1]);
  });

  it("all-true → rate 1 + CI [1,1]", () => {
    const result = binaryRate([true, true, true], null);
    expect(result.rate).toBe(1);
    expect(result.ci[0]).toBe(1);
    expect(result.ci[1]).toBe(1);
  });

  it("all-false → rate 0 + CI [0,0]", () => {
    const result = binaryRate([false, false, false, false], null);
    expect(result.rate).toBe(0);
    expect(result.ci[0]).toBe(0);
    expect(result.ci[1]).toBe(0);
  });

  it("empty → rate NaN, n 0", () => {
    const result = binaryRate([], null);
    expect(Number.isNaN(result.rate)).toBe(true);
    expect(result.n).toBe(0);
  });

  it("is deterministic given a seed", () => {
    const passes = [true, false, true, true, false, true, false, true];
    const a = binaryRate(passes, { samples: 2000, seed: 11 });
    const b = binaryRate(passes, { samples: 2000, seed: 11 });
    expect(a).toEqual(b);
  });
});
