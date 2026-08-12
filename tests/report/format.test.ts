// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  count,
  formatDeltaSuffix,
  formatMetricValue,
  pct,
  polarityArrow,
  signed,
  versionTag,
} from "../../src/report/format.js";

describe("format primitives", () => {
  it("pct: rate ∈[0,1] → percentage (rounds, no decimals)", () => {
    expect(pct(0.624)).toBe("62%");
    expect(pct(0.1)).toBe("10%");
    expect(pct(0)).toBe("0%");
  });

  it("count: K/M suffix above 999; raw below", () => {
    expect(count(999)).toBe("999");
    expect(count(1200)).toBe("1.2K");
    expect(count(12_100)).toBe("12.1K");
    expect(count(2_400_000)).toBe("2.4M");
    expect(count(-1500)).toBe("-1.5K");
  });

  it("signed: [+N] / [-N]", () => {
    expect(signed(52)).toBe("+52");
    expect(signed(-14)).toBe("-14");
    expect(signed(0)).toBe("+0");
  });

  it("polarityArrow: ↑ higher / ↓ lower / empty rank", () => {
    expect(polarityArrow("higherBetter")).toBe("↑");
    expect(polarityArrow("lowerBetter")).toBe("↓");
    expect(polarityArrow("rankLowerBetter")).toBe("");
  });

  it("versionTag: git commit / npm version / empty", () => {
    expect(versionTag({ source: "git", commit: "g4a2f8e", full: "f" })).toBe("g4a2f8e");
    expect(versionTag({ source: "npm", commit: "0.4.2", full: "0.4.2" })).toBe("0.4.2");
    expect(versionTag(undefined)).toBe("");
  });
});

describe("formatMetricValue", () => {
  it("binary → rate% [ci-lo–ci-hi]", () => {
    expect(formatMetricValue({ rate: 0.62, ci: [0.5, 0.74], n: 9 })).toBe("62% [50%–74%]");
  });
  it("comparative → rank", () => {
    expect(formatMetricValue({ rank: 1, rankCi: [1, 1] })).toBe("1");
  });
  it("exact → K-suffixed mean", () => {
    expect(formatMetricValue({ mean: 12_100, ci: [11_000, 13_000] })).toBe("12.1K");
  });
  it("compaction-cost → $dollars/wall", () => {
    expect(
      formatMetricValue({
        tokensIn: 1,
        tokensOut: 1,
        cacheRead: 1,
        cacheWrite: 1,
        dollars: 0.034,
        wallMs: 41000,
        stages: ["s"],
        phase2CompactionCount: 0,
      }),
    ).toBe("$0.034/41s");
  });
  it("recall-cost → mean or n/a when all notRecovered", () => {
    expect(formatMetricValue({ mean: 500, ci: [400, 600], notRecoveredRate: 0 })).toBe("500");
    expect(formatMetricValue({ mean: null, ci: [0, 0], notRecoveredRate: 1 })).toBe("n/a");
  });
});

describe("formatDeltaSuffix", () => {
  it("binary delta → percentage points", () => {
    const s = formatDeltaSuffix(0.52, { rate: 0.62, ci: [0.5, 0.74], n: 9 });
    expect(s).toBe(" [+52]");
  });
  it("comparative delta → raw rank points", () => {
    const s = formatDeltaSuffix(1, { rank: 1, rankCi: [1, 1] });
    expect(s).toBe(" [+1]");
  });
  it("exact token delta → K-suffixed count (negative → ⚠)", () => {
    const s = formatDeltaSuffix(-7200, { mean: 8400, ci: [8000, 9000] });
    expect(s).toBe(" [-7.2K]⚠");
  });
  it("exact token delta → raw count when < 1000 (positive → no ⚠)", () => {
    const s = formatDeltaSuffix(400, { mean: 800, ci: [700, 900] });
    expect(s).toBe(" [+400]");
  });
  it("C4 cost delta → dollar-cents (negative → ⚠)", () => {
    const s = formatDeltaSuffix(-0.033, {
      tokensIn: 1,
      tokensOut: 1,
      cacheRead: 1,
      cacheWrite: 1,
      dollars: 0.034,
      wallMs: 41000,
      stages: ["s"],
      phase2CompactionCount: 0,
    });
    expect(s).toBe(" [-$0.033]⚠");
  });
  it("C4 cost delta → positive dollar-cents (no ⚠)", () => {
    const s = formatDeltaSuffix(0.011, {
      tokensIn: 1,
      tokensOut: 1,
      cacheRead: 1,
      cacheWrite: 1,
      dollars: 0.012,
      wallMs: 18000,
      stages: ["s"],
      phase2CompactionCount: 0,
    });
    expect(s).toBe(" [+$0.011]");
  });
});
