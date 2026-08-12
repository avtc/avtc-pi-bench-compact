// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { mean } from "../../src/stats/util.js";

describe("mean", () => {
  it("computes the arithmetic mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
  it("returns NaN for an empty input", () => {
    expect(Number.isNaN(mean([]))).toBe(true);
  });
  it("returns the value for a single-element input", () => {
    expect(mean([42])).toBe(42);
  });
});
