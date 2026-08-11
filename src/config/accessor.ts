// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SettingsHandle } from "avtc-pi-settings-ui";
import { DEFAULTS } from "./schema.js";
import { ARM_ENABLED_KEY, ARM_IDS, type ArmId, type BackupMode, type BenchConfig } from "./types.js";

let handle: SettingsHandle | undefined;

/** Store the settings handle (called from activate after registerSettingsCommand). */
export function initBenchConfig(h: SettingsHandle): void {
  handle = h;
}

/** Test-only: inject a fake handle (pass null to clear). */
export function _setHandleForTest(h: SettingsHandle | null): void {
  handle = h ?? undefined;
}

// --- raw-value coercions (the handle's getSettings is untyped; fall back to DEFAULTS) ---

function asString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : fallback;
}

function asStringOrNull(raw: Record<string, unknown>, key: string, fallback: string | null): string | null {
  const v = raw[key];
  return typeof v === "string" ? v : v === null ? null : fallback;
}

function asNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" ? v : fallback;
}

function asBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function asBackupMode(raw: Record<string, unknown>, key: string): BackupMode {
  return raw[key] === "extract" ? "extract" : "build";
}

/** Derive the enabled arm ids in canonical A1..A5 order from the per-arm booleans. */
function deriveArmsEnabled(cfg: BenchConfig): ArmId[] {
  return ARM_IDS.filter((id) => cfg[ARM_ENABLED_KEY[id] as keyof BenchConfig] === true);
}

/**
 * Read the live bench config (§2.12). Reads `handle.getSettings()` each call so a
 * `/reload` or in-panel edit is picked up immediately; falls back to DEFAULTS for
 * any absent/mistyped key. `armsEnabled` is derived here (not stored in settings).
 */
export function getBenchConfig(): BenchConfig {
  const raw: Record<string, unknown> = handle ? handle.getSettings() : {};
  const cfg: BenchConfig = {
    evaluatedModel: asStringOrNull(raw, "evaluatedModel", DEFAULTS.evaluatedModel),
    evaluatedThinkingLevel: asString(raw, "evaluatedThinkingLevel", DEFAULTS.evaluatedThinkingLevel),
    judgeModel: asStringOrNull(raw, "judgeModel", DEFAULTS.judgeModel),
    judgeThinkingLevel: asString(raw, "judgeThinkingLevel", DEFAULTS.judgeThinkingLevel),
    N: asNumber(raw, "N", DEFAULTS.N),
    compactionBoundary: asNumber(raw, "compactionBoundary", DEFAULTS.compactionBoundary),
    backupMode: asBackupMode(raw, "backupMode"),
    scenario: asStringOrNull(raw, "scenario", DEFAULTS.scenario),
    outputDir: asStringOrNull(raw, "outputDir", DEFAULTS.outputDir),
    armBarePiEnabled: asBoolean(raw, "armBarePiEnabled", DEFAULTS.armBarePiEnabled),
    armOmDefaultEnabled: asBoolean(raw, "armOmDefaultEnabled", DEFAULTS.armOmDefaultEnabled),
    armMemkeeperObservationsRootEnabled: asBoolean(
      raw,
      "armMemkeeperObservationsRootEnabled",
      DEFAULTS.armMemkeeperObservationsRootEnabled,
    ),
    armMemkeeperSelectedRootEnabled: asBoolean(
      raw,
      "armMemkeeperSelectedRootEnabled",
      DEFAULTS.armMemkeeperSelectedRootEnabled,
    ),
    armOmFullEnabled: asBoolean(raw, "armOmFullEnabled", DEFAULTS.armOmFullEnabled),
    omFullReflectionThresholdTokens: asNumber(
      raw,
      "omFullReflectionThresholdTokens",
      DEFAULTS.omFullReflectionThresholdTokens,
    ),
    armsEnabled: [],
  };
  cfg.armsEnabled = deriveArmsEnabled(cfg);
  return cfg;
}
