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

  it("has three tabs (Models / Run / Arms) covering every setting id", () => {
    expect(BENCH_SCHEMA.tabs.map((t) => t.label)).toEqual(["Models", "Run", "Arms"]);
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
    it("judgeThinkingLevel: thinking-level, default high", () => {
      expect(row("judgeThinkingLevel")).toMatchObject({ type: "thinking-level", defaultValue: "high" });
    });
  });

  describe("Run tab", () => {
    it("N: number, default 10", () => {
      expect(row("N")).toMatchObject({ type: "number", defaultValue: 10 });
    });
    it("compactionBoundary: number, default 140000", () => {
      expect(row("compactionBoundary")).toMatchObject({ type: "number", defaultValue: 140000 });
    });
    it("backupMode: string, default build", () => {
      expect(row("backupMode")).toMatchObject({ type: "string", defaultValue: "build" });
    });
    it("backupMode presets are exactly [build, extract]", () => {
      expect(row("backupMode").presets).toEqual(["build", "extract"]);
    });
    it("scenario: string, default null", () => {
      expect(row("scenario")).toMatchObject({ type: "string", defaultValue: null });
    });
    it("outputDir: string, default null", () => {
      expect(row("outputDir")).toMatchObject({ type: "string", defaultValue: null });
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
