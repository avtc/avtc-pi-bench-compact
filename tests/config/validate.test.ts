// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { ArmId, BenchConfig } from "../../src/config/types.js";
import { validateBenchConfig } from "../../src/config/validate.js";

/** A fully-valid config; each rejection case mutates one field. */
function validConfig(): BenchConfig {
  return {
    evaluatedModel: null,
    evaluatedThinkingLevel: "high",
    judgeModel: null,
    judgeThinkingLevel: "high",
    N: 10,
    compactionBoundary: 140000,
    backupMode: "build",
    scenario: null,
    outputDir: null,
    armBarePiEnabled: true,
    armOmDefaultEnabled: true,
    armMemkeeperObservationsRootEnabled: true,
    armMemkeeperSelectedRootEnabled: true,
    armOmFullEnabled: true,
    omFullReflectionThresholdTokens: 4000,
    armsEnabled: ["A1", "A2", "A3", "A4", "A5"] as ArmId[],
  };
}

describe("validateBenchConfig", () => {
  it("accepts a fully-valid config (null models = Default, not an error)", () => {
    const result = validateBenchConfig(validConfig());
    expect(result).toEqual({ ok: true });
  });

  it("rejects when zero arms are enabled", () => {
    const cfg = validConfig();
    cfg.armBarePiEnabled = false;
    cfg.armOmDefaultEnabled = false;
    cfg.armMemkeeperObservationsRootEnabled = false;
    cfg.armMemkeeperSelectedRootEnabled = false;
    cfg.armOmFullEnabled = false;
    cfg.armsEnabled = [];
    const result = validateBenchConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("arm");
    }
  });

  it("rejects when compactionBoundary < 20000", () => {
    const cfg = validConfig();
    cfg.compactionBoundary = 19999;
    const result = validateBenchConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/boundary|compaction/i);
    }
  });

  it("accepts compactionBoundary exactly at the 20000 floor", () => {
    const cfg = validConfig();
    cfg.compactionBoundary = 20000;
    expect(validateBenchConfig(cfg)).toEqual({ ok: true });
  });

  it("rejects when N < 1", () => {
    const cfg = validConfig();
    cfg.N = 0;
    const result = validateBenchConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/\bN\b|runs/i);
    }
  });

  it("rejects when A5 (om-full) is enabled but omFullReflectionThresholdTokens < 1", () => {
    const cfg = validConfig();
    cfg.armOmFullEnabled = true;
    cfg.armsEnabled = ["A5"];
    cfg.omFullReflectionThresholdTokens = 0;
    const result = validateBenchConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/reflection|threshold|om-?full|A5/i);
    }
  });

  it("does NOT require omFullReflectionThresholdTokens when A5 is disabled", () => {
    const cfg = validConfig();
    cfg.armOmFullEnabled = false;
    cfg.armsEnabled = ["A1"];
    cfg.omFullReflectionThresholdTokens = 0;
    expect(validateBenchConfig(cfg)).toEqual({ ok: true });
  });

  it("rejects when A5 (om-full) is enabled but omFullReflectionThresholdTokens >= OM's default (30000) — would make A5 indistinguishable from A2", () => {
    const cfg = validConfig();
    cfg.armOmFullEnabled = true;
    cfg.armsEnabled = ["A5"];
    cfg.omFullReflectionThresholdTokens = 30000;
    const result = validateBenchConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/30000|indistinguishable|reflection|threshold/i);
    }
  });

  it("accepts A5 at the default 4000 (well below OM's 30000 default)", () => {
    const cfg = validConfig();
    cfg.armOmFullEnabled = true;
    cfg.armsEnabled = ["A5"];
    cfg.omFullReflectionThresholdTokens = 4000;
    expect(validateBenchConfig(cfg)).toEqual({ ok: true });
  });
});
