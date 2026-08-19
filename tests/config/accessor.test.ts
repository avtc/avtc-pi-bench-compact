// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SettingsHandle } from "avtc-pi-settings-ui";
import { afterEach, describe, expect, it } from "vitest";
import { _setHandleForTest, getBenchConfig } from "../../src/config/accessor.js";
import { DEFAULTS } from "../../src/config/schema.js";

function fakeHandle(raw: Record<string, unknown>): SettingsHandle {
  return { getSettings: () => raw } as unknown as SettingsHandle;
}

describe("getBenchConfig", () => {
  afterEach(() => {
    _setHandleForTest(null);
  });

  it("falls back to defaults for every key when raw is empty", () => {
    _setHandleForTest(fakeHandle({}));
    const cfg = getBenchConfig();
    expect(cfg.N).toBe(DEFAULTS.N);
    expect(cfg.compactionBoundary).toBe(DEFAULTS.compactionBoundary);
    expect(cfg.evaluatedModel).toBeNull();
    expect(cfg.evaluatedThinkingLevel).toBe(DEFAULTS.evaluatedThinkingLevel);
    expect(cfg.judgeModel).toBeNull();
    expect(cfg.judgesNumber).toBe(DEFAULTS.judgesNumber);
    expect(cfg.judge2Model).toBeNull();
    expect(cfg.judge2ThinkingLevel).toBe(DEFAULTS.judge2ThinkingLevel);
    expect(cfg.judge3Model).toBeNull();
    expect(cfg.judge3ThinkingLevel).toBe(DEFAULTS.judge3ThinkingLevel);
    expect(cfg.omFullReflectionThresholdTokens).toBe(DEFAULTS.omFullReflectionThresholdTokens);
    expect(cfg.judgeMaxTokens).toBe(DEFAULTS.judgeMaxTokens);
    expect(cfg.latentStageMaxTokens).toBe(DEFAULTS.latentStageMaxTokens);
    expect(cfg.judgeTurnTimeoutMs).toBe(DEFAULTS.judgeTurnTimeoutMs);
    expect(cfg.testspecTimeoutMs).toBe(DEFAULTS.testspecTimeoutMs);
  });

  it("maps the stage-budget settings (overrides + Infinite→null)", () => {
    _setHandleForTest(
      fakeHandle({
        judgeMaxTokens: 65536,
        latentStageMaxTokens: 131072,
        judgeTurnTimeoutMs: null,
        testspecTimeoutMs: 30000,
      }),
    );
    const cfg = getBenchConfig();
    expect(cfg.judgeMaxTokens).toBe(65536);
    expect(cfg.latentStageMaxTokens).toBe(131072);
    expect(cfg.judgeTurnTimeoutMs).toBeNull();
    expect(cfg.testspecTimeoutMs).toBe(30000);
  });

  it("defaults the background-agent settings (background xhigh/64K/20m, per-agent overrides null)", () => {
    _setHandleForTest(fakeHandle({}));
    const cfg = getBenchConfig();
    expect(cfg.backgroundModel).toBeNull();
    expect(cfg.backgroundThinkingLevel).toBe("xhigh");
    expect(cfg.backgroundMaxTokens).toBe(65536);
    expect(cfg.backgroundTimeoutMs).toBe(1200000);
    for (const key of [
      "authorModel",
      "authorThinkingLevel",
      "authorMaxTokens",
      "authorTimeoutMs",
      "tailCheckModel",
      "tailCheckThinkingLevel",
      "tailCheckMaxTokens",
      "tailCheckTimeoutMs",
      "simulatorModel",
      "simulatorThinkingLevel",
      "simulatorMaxTokens",
      "simulatorTurnTimeoutMs",
      "latentModel",
      "latentThinkingLevel",
      "latentTimeoutMs",
      "latentStageMaxTokens",
    ] as const) {
      expect(cfg[key]).toBeNull();
    }
  });

  it("maps background-agent overrides (models, thinking, per-agent tokens + timeouts)", () => {
    _setHandleForTest(
      fakeHandle({
        backgroundModel: "p/m",
        backgroundThinkingLevel: "low",
        backgroundMaxTokens: 16384,
        backgroundTimeoutMs: 600000,
        authorMaxTokens: 4096,
        authorTimeoutMs: 300000,
        tailCheckMaxTokens: 512,
        tailCheckTimeoutMs: 120000,
        simulatorMaxTokens: 1024,
        simulatorTurnTimeoutMs: 60000,
        latentStageMaxTokens: 65536,
        latentTimeoutMs: 900000,
      }),
    );
    const cfg = getBenchConfig();
    expect(cfg.backgroundModel).toBe("p/m");
    expect(cfg.backgroundThinkingLevel).toBe("low");
    expect(cfg.backgroundMaxTokens).toBe(16384);
    expect(cfg.backgroundTimeoutMs).toBe(600000);
    expect(cfg.authorMaxTokens).toBe(4096);
    expect(cfg.authorTimeoutMs).toBe(300000);
    expect(cfg.tailCheckMaxTokens).toBe(512);
    expect(cfg.tailCheckTimeoutMs).toBe(120000);
    expect(cfg.simulatorMaxTokens).toBe(1024);
    expect(cfg.simulatorTurnTimeoutMs).toBe(60000);
    expect(cfg.latentStageMaxTokens).toBe(65536);
    expect(cfg.latentTimeoutMs).toBe(900000);
  });

  it("maps provided values (numbers, models, booleans, strings)", () => {
    _setHandleForTest(
      fakeHandle({
        N: 3,
        compactionBoundary: 50000,
        evaluatedModel: "zai/glm-4.6",
        evaluatedThinkingLevel: "medium",
        judgeThinkingLevel: "low",
        judgesNumber: 3,
        judge2Model: "zai/glm-4.6",
        judge2ThinkingLevel: "minimal",
        judge3Model: "anthropic/claude",
        judge3ThinkingLevel: "high",
        backupMode: "extract",
        scenario: "my scenario",
        outputDir: "/tmp/out",
        armBarePiEnabled: false,
        omFullReflectionThresholdTokens: 2000,
      }),
    );
    const cfg = getBenchConfig();
    expect(cfg.N).toBe(3);
    expect(cfg.compactionBoundary).toBe(50000);
    expect(cfg.evaluatedModel).toBe("zai/glm-4.6");
    expect(cfg.evaluatedThinkingLevel).toBe("medium");
    expect(cfg.judgeThinkingLevel).toBe("low");
    expect(cfg.judgesNumber).toBe(3);
    expect(cfg.judge2Model).toBe("zai/glm-4.6");
    expect(cfg.judge2ThinkingLevel).toBe("minimal");
    expect(cfg.judge3Model).toBe("anthropic/claude");
    expect(cfg.judge3ThinkingLevel).toBe("high");
    expect("backupMode" in cfg).toBe(false); // removed setting — stale stored key is ignored
    expect(cfg.scenario).toBe("my scenario");
    expect(cfg.outputDir).toBe("/tmp/out");
    expect(cfg.armBarePiEnabled).toBe(false);
    expect(cfg.omFullReflectionThresholdTokens).toBe(2000);
  });

  it("derives armsEnabled from the per-arm booleans in canonical A1..A5 order", () => {
    _setHandleForTest(
      fakeHandle({
        armBarePiEnabled: true,
        armOmDefaultEnabled: false,
        armMemkeeperObservationsRootEnabled: true,
        armMemkeeperSelectedRootEnabled: false,
        armOmFullEnabled: true,
      }),
    );
    expect(getBenchConfig().armsEnabled).toEqual(["A1", "A3", "A5"]);
  });

  it("lists all five arms when all enabled", () => {
    _setHandleForTest(
      fakeHandle({
        armBarePiEnabled: true,
        armOmDefaultEnabled: true,
        armMemkeeperObservationsRootEnabled: true,
        armMemkeeperSelectedRootEnabled: true,
        armOmFullEnabled: true,
      }),
    );
    expect(getBenchConfig().armsEnabled).toEqual(["A1", "A2", "A3", "A4", "A5"]);
  });

  it("lists no arms when all disabled", () => {
    _setHandleForTest(
      fakeHandle({
        armBarePiEnabled: false,
        armOmDefaultEnabled: false,
        armMemkeeperObservationsRootEnabled: false,
        armMemkeeperSelectedRootEnabled: false,
        armOmFullEnabled: false,
      }),
    );
    expect(getBenchConfig().armsEnabled).toEqual([]);
  });

  it("returns all defaults (all arms enabled) when no handle is initialized", () => {
    _setHandleForTest(null);
    const cfg = getBenchConfig();
    expect(cfg.N).toBe(DEFAULTS.N);
    expect(cfg.compactionBoundary).toBe(DEFAULTS.compactionBoundary);
    expect(cfg.evaluatedModel).toBeNull();
    // all five arm defaults are true
    expect(cfg.armsEnabled).toEqual(["A1", "A2", "A3", "A4", "A5"]);
  });

  it("falls back to the default thinking level when the raw value is not a known level", () => {
    _setHandleForTest(fakeHandle({ evaluatedThinkingLevel: "bogus", judgeThinkingLevel: 42 }));
    const cfg = getBenchConfig();
    expect(cfg.evaluatedThinkingLevel).toBe(DEFAULTS.evaluatedThinkingLevel);
    expect(cfg.judgeThinkingLevel).toBe(DEFAULTS.judgeThinkingLevel);
  });
});

describe("fastEval mapping", () => {
  it("defaults to off and accepts probes-only", () => {
    _setHandleForTest(fakeHandle({}));
    expect(getBenchConfig().fastEval).toBe("off");
    _setHandleForTest(fakeHandle({ fastEval: "probes-only" }));
    expect(getBenchConfig().fastEval).toBe("probes-only");
    _setHandleForTest(fakeHandle({ fastEval: "bogus" }));
    expect(getBenchConfig().fastEval).toBe("off"); // unknown values fall back
  });
});
