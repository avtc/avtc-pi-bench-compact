// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SettingSchema } from "avtc-pi-settings-ui";
import { describe, expect, it } from "vitest";
import { BENCH_SCHEMA, BENCH_SETTINGS_COMMAND } from "../../src/config/schema.js";

function row(id: string): SettingSchema {
  const found = BENCH_SCHEMA.settings.find((s) => s.id === id);
  if (!found) {
    throw new Error(`schema has no setting with id "${id}"`);
  }
  return found;
}

describe("BENCH_SCHEMA", () => {
  it("registers the /bench-compact:settings command name", () => {
    expect(BENCH_SETTINGS_COMMAND).toBe("bench-compact:settings");
  });

  it("has eight tabs (General / Run / Arms / Judge / Author / Tail / Sim / Latent) covering every setting id", () => {
    expect(BENCH_SCHEMA.tabs.map((t) => t.label)).toEqual([
      "General",
      "Run",
      "Arms",
      "Judge",
      "Author",
      "Tail",
      "Sim",
      "Latent",
    ]);
    const tabbed = new Set(BENCH_SCHEMA.tabs.flatMap((t) => t.settingIds));
    for (const s of BENCH_SCHEMA.settings) {
      expect(tabbed.has(s.id)).toBe(true);
    }
  });

  describe("Models tab", () => {
    it("evaluatedModel: model, default null (Default)", () => {
      expect(row("evaluatedModel")).toMatchObject({ type: "model", defaultValue: null });
    });
    it("evaluatedThinkingLevel: thinking-level, default high", () => {
      expect(row("evaluatedThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: "high" });
    });
    it("judgeModel: model, default null", () => {
      expect(row("judgeModel")).toMatchObject({ type: "model", defaultValue: null });
    });
    it("judgeThinkingLevel: thinking-level, default null, agent thinking ladder (default-inherit, no none)", () => {
      expect(row("judgeThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
      expect(row("judgeThinkingLevel").presets).toEqual([
        ["default", null],
        ["off", "off"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
      ]);
    });
    it("judgesNumber: number, default 1", () => {
      expect(row("judgesNumber")).toMatchObject({ type: "number", defaultValue: 1 });
    });
    it("judgesNumber presets are exactly [1, 3]", () => {
      expect(row("judgesNumber").presets).toEqual([1, 3]);
    });
    it("judge2Model: model, default null", () => {
      expect(row("judge2Model")).toMatchObject({ type: "model", defaultValue: null });
    });
    it("judge2ThinkingLevel: thinking-level, default null, agent thinking ladder", () => {
      expect(row("judge2ThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
      expect(row("judge2ThinkingLevel").presets).toBe(row("judgeThinkingLevel").presets);
    });
    it("judge3Model: model, default null", () => {
      expect(row("judge3Model")).toMatchObject({ type: "model", defaultValue: null });
    });
    it("judge3ThinkingLevel: thinking-level, default null, agent thinking ladder", () => {
      expect(row("judge3ThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
      expect(row("judge3ThinkingLevel").presets).toBe(row("judgeThinkingLevel").presets);
    });
  });

  describe("Run tab", () => {
    it("N: number, default 10", () => {
      expect(row("N")).toMatchObject({ type: "number", defaultValue: 10 });
    });
    it("compactionBoundary: number, default 140000", () => {
      expect(row("compactionBoundary")).toMatchObject({ type: "number", defaultValue: 140000 });
    });
    it("latentProbes: string, default per-arm", () => {
      expect(row("latentProbes")).toMatchObject({ type: "string", defaultValue: "per-arm" });
    });
    it("fastEval: string, default off", () => {
      expect(row("fastEval")).toMatchObject({ type: "string", defaultValue: "off" });
    });
    it("fastEval presets are exactly [off, probes-only]", () => {
      expect(row("fastEval").presets).toEqual(["off", "probes-only"]);
    });
    it("judgeMaxTokens: number, default null (background max tokens), shared token ladder", () => {
      expect(row("judgeMaxTokens")).toMatchObject({ type: "number", defaultValue: null, min: 1 });
      expect(row("judgeMaxTokens").presets).toEqual([["default", null], 16384, 32768, 65536, 131072, 262144]);
    });
    it("latentStageMaxTokens: number, default null (background max tokens), shared token ladder", () => {
      expect(row("latentStageMaxTokens")).toMatchObject({ type: "number", defaultValue: null, min: 1 });
      expect(row("latentStageMaxTokens").presets).toEqual([["default", null], 16384, 32768, 65536, 131072, 262144]);
    });
    it("judgeTurnTimeoutMs: duration, default null (background timeout), shared duration ladder", () => {
      expect(row("judgeTurnTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: null,
        min: 1000,
        max: 7200000,
      });
      expect(row("judgeTurnTimeoutMs").presets).toEqual([["default", null], "5m", "10m", "20m", "60m", "120m"]);
    });
    it("testspecTimeoutMs: number, default 120000, labelled presets", () => {
      expect(row("testspecTimeoutMs")).toMatchObject({ type: "number", defaultValue: 120000 });
      expect(row("testspecTimeoutMs").presets).toEqual([
        ["30s", 30000],
        ["1m", 60000],
        ["2m", 120000],
        ["5m", 300000],
        ["10m", 600000],
      ]);
    });
    it("scenario: open string (free-form editor), default null", () => {
      expect(row("scenario")).toMatchObject({ type: "string", defaultValue: null, supportsCustomValues: true });
    });
    it("outputDir: string, default null", () => {
      expect(row("outputDir")).toMatchObject({ type: "string", defaultValue: null });
    });
  });

  describe("Background agents tab", () => {
    it("backgroundModel: model, default null", () => {
      expect(row("backgroundModel")).toMatchObject({ type: "model", defaultValue: null });
    });
    it("backgroundThinkingLevel: thinking-level, default xhigh, presets incl. none(null) + the full ladder", () => {
      expect(row("backgroundThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: "xhigh" });
      expect(row("backgroundThinkingLevel").presets).toEqual([
        ["none", null],
        ["off", "off"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
      ]);
    });
    it("backgroundMaxTokens: number, default 65536, shared token ladder, no null preset (always set)", () => {
      expect(row("backgroundMaxTokens")).toMatchObject({ type: "number", defaultValue: 65536, min: 1 });
      expect(row("backgroundMaxTokens").presets).toEqual([16384, 32768, 65536, 131072, 262144]);
    });
    it("backgroundTimeoutMs: duration, default 1200000 (20m), bounded, shared duration ladder, no null preset (always set)", () => {
      expect(row("backgroundTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: 1200000,
        min: 1000,
        max: 7200000,
      });
      expect(row("backgroundTimeoutMs").presets).toEqual(["5m", "10m", "20m", "60m", "120m"]);
    });
    it("authorModel / authorThinkingLevel: model + thinking-level, default null", () => {
      expect(row("authorModel")).toMatchObject({ type: "model", defaultValue: null });
      expect(row("authorThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
    });
    it("authorMaxTokens: number, default null (background max tokens), shared token ladder", () => {
      expect(row("authorMaxTokens")).toMatchObject({ type: "number", defaultValue: null, min: 1 });
      expect(row("authorMaxTokens").presets).toEqual([["default", null], 16384, 32768, 65536, 131072, 262144]);
    });
    it("authorTimeoutMs: duration, default null (background timeout), bounded, shared duration ladder", () => {
      expect(row("authorTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: null,
        min: 1000,
        max: 7200000,
      });
      expect(row("authorTimeoutMs").presets).toEqual([["default", null], "5m", "10m", "20m", "60m", "120m"]);
    });
    it("tailCheckModel / tailCheckThinkingLevel: model + thinking-level, default null", () => {
      expect(row("tailCheckModel")).toMatchObject({ type: "model", defaultValue: null });
      expect(row("tailCheckThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
    });
    it("tailCheckMaxTokens: number, default null (background max tokens), shared token ladder", () => {
      expect(row("tailCheckMaxTokens")).toMatchObject({ type: "number", defaultValue: null, min: 1 });
      expect(row("tailCheckMaxTokens").presets).toEqual([["default", null], 16384, 32768, 65536, 131072, 262144]);
    });
    it("tailCheckTimeoutMs: duration, default null (background timeout), bounded", () => {
      expect(row("tailCheckTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: null,
        min: 1000,
        max: 7200000,
      });
    });
    it("simulatorModel / simulatorThinkingLevel: model + thinking-level, default null", () => {
      expect(row("simulatorModel")).toMatchObject({ type: "model", defaultValue: null });
      expect(row("simulatorThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
    });
    it("simulatorMaxTokens: number, default null (background max tokens), shared token ladder", () => {
      expect(row("simulatorMaxTokens")).toMatchObject({ type: "number", defaultValue: null, min: 1 });
      expect(row("simulatorMaxTokens").presets).toEqual([["default", null], 16384, 32768, 65536, 131072, 262144]);
    });
    it("simulatorTurnTimeoutMs: duration, default null (background timeout), bounded", () => {
      expect(row("simulatorTurnTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: null,
        min: 1000,
        max: 7200000,
      });
    });
    it("latentModel / latentThinkingLevel: model + thinking-level, default null", () => {
      expect(row("latentModel")).toMatchObject({ type: "model", defaultValue: null });
      expect(row("latentThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: null });
    });
    it("latentTimeoutMs: duration, default null (background timeout), bounded", () => {
      expect(row("latentTimeoutMs")).toMatchObject({
        type: "duration",
        defaultValue: null,
        min: 1000,
        max: 7200000,
      });
    });
    it("every per-agent thinking row (author/tail/sim/latent + judges) shares the agent ladder (default-inherit, no none)", () => {
      const agentThinking = [
        ["default", null],
        ["off", "off"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
      ];
      for (const id of [
        "authorThinkingLevel",
        "tailCheckThinkingLevel",
        "simulatorThinkingLevel",
        "latentThinkingLevel",
        "judgeThinkingLevel",
        "judge2ThinkingLevel",
        "judge3ThinkingLevel",
      ]) {
        expect(row(id).presets, id).toEqual(agentThinking);
      }
    });

    it("every thinking-level preset is a full pair (a bare string throws at extension load)", () => {
      // Regression: the settings-ui preset normalizer parses bare strings with the type's
      // parse against an EMPTY preset ctx. thinking-level's parse is a closed-enum
      // membership check with no identity fallback (unlike the string type), so a bare
      // level string — even a valid one — fails and createSettingsExtension throws at
      // load. Full pairs pass through un-parsed.
      for (const s of BENCH_SCHEMA.settings) {
        if (s.type !== "thinking-level") continue;
        for (const el of (s.presets ?? []) as readonly unknown[]) {
          expect(Array.isArray(el), `${s.id}: preset ${JSON.stringify(el)} must be a [label, value] pair`).toBe(true);
        }
      }
    });
  });

  describe("Arms tab", () => {
    it("armBarePiEnabled: boolean, default true", () => {
      expect(row("armBarePiEnabled")).toMatchObject({ type: "boolean", defaultValue: true });
    });
    it("armOmDefaultEnabled: boolean, default true", () => {
      expect(row("armOmDefaultEnabled")).toMatchObject({ type: "boolean", defaultValue: true });
    });
    it("armMemkeeperObservationsRootEnabled: boolean, default true", () => {
      expect(row("armMemkeeperObservationsRootEnabled")).toMatchObject({ type: "boolean", defaultValue: true });
    });
    it("armMemkeeperSelectedRootEnabled: boolean, default true", () => {
      expect(row("armMemkeeperSelectedRootEnabled")).toMatchObject({ type: "boolean", defaultValue: true });
    });
    it("armOmFullEnabled: boolean, default true", () => {
      expect(row("armOmFullEnabled")).toMatchObject({ type: "boolean", defaultValue: true });
    });
    it("omFullReflectionThresholdTokens: number, default 4000", () => {
      expect(row("omFullReflectionThresholdTokens")).toMatchObject({ type: "number", defaultValue: 4000 });
    });
  });
});
