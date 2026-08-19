// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { DEFAULTS } from "./schema.js";
import {
  ARM_ENABLED_KEY,
  ARM_IDS,
  type ArmId,
  type BenchConfig,
  type FastEvalMode,
  type LatentProbesMode,
} from "./types.js";

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

function asStringOrNull(raw: Record<string, unknown>, key: string, fallback: string | null): string | null {
  const v = raw[key];
  return typeof v === "string" ? v : v === null ? null : fallback;
}

function asNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" ? v : fallback;
}

/** Number-or-null reader (null survives — the "Infinite" preset stores null). */
function asNumberOrNull(raw: Record<string, unknown>, key: string, fallback: number | null): number | null {
  const v = raw[key];
  if (v === null) return null;
  return typeof v === "number" ? v : fallback;
}

function asBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Narrow a raw value to a ThinkingLevel; fall back if it isn't a known level (the
 *  settings-ui thinking-level type only emits these, but the handle is untyped). */
function asThinkingLevel(raw: Record<string, unknown>, key: string, fallback: ThinkingLevel): ThinkingLevel {
  const v = raw[key];
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : fallback;
}

/** Thinking-level-or-null reader for the background agents (null = "none" — omit reasoning). */
function asThinkingLevelOrNull(
  raw: Record<string, unknown>,
  key: string,
  fallback: ThinkingLevel | null,
): ThinkingLevel | null {
  if (raw[key] === null) return null;
  return asThinkingLevel(raw, key, fallback as ThinkingLevel);
}

function asFastEvalMode(raw: Record<string, unknown>, key: string, fallback: FastEvalMode): FastEvalMode {
  return raw[key] === "probes-only" ? "probes-only" : fallback;
}

function asLatentProbesMode(raw: Record<string, unknown>, key: string, fallback: LatentProbesMode): LatentProbesMode {
  const v = raw[key];
  return v === "off" || v === "per-arm" || v === "shared" ? v : fallback;
}

/** Derive the enabled arm ids in canonical order from the per-arm booleans. */
function deriveArmsEnabled(cfg: BenchConfig): ArmId[] {
  return ARM_IDS.filter((id) => cfg[ARM_ENABLED_KEY[id]] === true);
}

/**
 * Read the live bench config. Reads `handle.getSettings()` each call so a
 * `/reload` or in-panel edit is picked up immediately; falls back to DEFAULTS for
 * any absent/mistyped key. `armsEnabled` is derived here (not stored in settings).
 */
export function getBenchConfig(): BenchConfig {
  const raw: Record<string, unknown> = handle ? handle.getSettings() : {};
  const cfg: BenchConfig = {
    evaluatedModel: asStringOrNull(raw, "evaluatedModel", DEFAULTS.evaluatedModel),
    evaluatedThinkingLevel: asThinkingLevel(raw, "evaluatedThinkingLevel", DEFAULTS.evaluatedThinkingLevel),
    judgeModel: asStringOrNull(raw, "judgeModel", DEFAULTS.judgeModel),
    judgeThinkingLevel: asThinkingLevelOrNull(raw, "judgeThinkingLevel", DEFAULTS.judgeThinkingLevel),
    judgesNumber: asNumber(raw, "judgesNumber", DEFAULTS.judgesNumber),
    judge2Model: asStringOrNull(raw, "judge2Model", DEFAULTS.judge2Model),
    judge2ThinkingLevel: asThinkingLevelOrNull(raw, "judge2ThinkingLevel", DEFAULTS.judge2ThinkingLevel),
    judge3Model: asStringOrNull(raw, "judge3Model", DEFAULTS.judge3Model),
    judge3ThinkingLevel: asThinkingLevelOrNull(raw, "judge3ThinkingLevel", DEFAULTS.judge3ThinkingLevel),
    N: asNumber(raw, "N", DEFAULTS.N),
    compactionBoundary: asNumber(raw, "compactionBoundary", DEFAULTS.compactionBoundary),
    fastEval: asFastEvalMode(raw, "fastEval", DEFAULTS.fastEval),
    latentProbes: asLatentProbesMode(raw, "latentProbes", DEFAULTS.latentProbes),
    judgeMaxTokens: asNumberOrNull(raw, "judgeMaxTokens", DEFAULTS.judgeMaxTokens),
    latentStageMaxTokens: asNumberOrNull(raw, "latentStageMaxTokens", DEFAULTS.latentStageMaxTokens),
    judgeTurnTimeoutMs: asNumberOrNull(raw, "judgeTurnTimeoutMs", DEFAULTS.judgeTurnTimeoutMs),
    testspecTimeoutMs: asNumber(raw, "testspecTimeoutMs", DEFAULTS.testspecTimeoutMs),
    backgroundModel: asStringOrNull(raw, "backgroundModel", DEFAULTS.backgroundModel),
    backgroundThinkingLevel: asThinkingLevelOrNull(raw, "backgroundThinkingLevel", DEFAULTS.backgroundThinkingLevel),
    backgroundMaxTokens: asNumber(raw, "backgroundMaxTokens", DEFAULTS.backgroundMaxTokens),
    backgroundTimeoutMs: asNumber(raw, "backgroundTimeoutMs", DEFAULTS.backgroundTimeoutMs),
    authorModel: asStringOrNull(raw, "authorModel", DEFAULTS.authorModel),
    authorThinkingLevel: asThinkingLevelOrNull(raw, "authorThinkingLevel", DEFAULTS.authorThinkingLevel),
    authorMaxTokens: asNumberOrNull(raw, "authorMaxTokens", DEFAULTS.authorMaxTokens),
    authorTimeoutMs: asNumberOrNull(raw, "authorTimeoutMs", DEFAULTS.authorTimeoutMs),
    tailCheckModel: asStringOrNull(raw, "tailCheckModel", DEFAULTS.tailCheckModel),
    tailCheckThinkingLevel: asThinkingLevelOrNull(raw, "tailCheckThinkingLevel", DEFAULTS.tailCheckThinkingLevel),
    tailCheckMaxTokens: asNumberOrNull(raw, "tailCheckMaxTokens", DEFAULTS.tailCheckMaxTokens),
    tailCheckTimeoutMs: asNumberOrNull(raw, "tailCheckTimeoutMs", DEFAULTS.tailCheckTimeoutMs),
    simulatorModel: asStringOrNull(raw, "simulatorModel", DEFAULTS.simulatorModel),
    simulatorThinkingLevel: asThinkingLevelOrNull(raw, "simulatorThinkingLevel", DEFAULTS.simulatorThinkingLevel),
    simulatorMaxTokens: asNumberOrNull(raw, "simulatorMaxTokens", DEFAULTS.simulatorMaxTokens),
    simulatorTurnTimeoutMs: asNumberOrNull(raw, "simulatorTurnTimeoutMs", DEFAULTS.simulatorTurnTimeoutMs),
    latentModel: asStringOrNull(raw, "latentModel", DEFAULTS.latentModel),
    latentThinkingLevel: asThinkingLevelOrNull(raw, "latentThinkingLevel", DEFAULTS.latentThinkingLevel),
    latentTimeoutMs: asNumberOrNull(raw, "latentTimeoutMs", DEFAULTS.latentTimeoutMs),
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
