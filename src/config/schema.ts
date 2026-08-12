// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type RegisterSettingsOptions,
  registerSettingsCommand,
  type SettingSchema,
  type SettingsHandle,
  type SettingsSchema,
  type SettingsTabSchema,
  settingsFilePaths,
} from "avtc-pi-settings-ui";
import type { BackupMode } from "./types.js";

/** The /bench-compact:settings command name. */
export const BENCH_SETTINGS_COMMAND = "bench-compact:settings";

// ---------------------------------------------------------------------------
// DEFAULTS — the canonical defaults. Single source of truth: every schema row's
// `defaultValue` reads FROM this object so the two can never drift.
// ---------------------------------------------------------------------------

const NO_MODEL: string | null = null;

/** Raw default values for every settings key (the accessor maps these to BenchConfig). */
export const DEFAULTS = {
  evaluatedModel: NO_MODEL,
  evaluatedThinkingLevel: "high",
  judgeModel: NO_MODEL,
  judgeThinkingLevel: "high",
  judgesNumber: 1,
  judge2Model: NO_MODEL,
  judge2ThinkingLevel: "high",
  judge3Model: NO_MODEL,
  judge3ThinkingLevel: "high",
  N: 10,
  compactionBoundary: 140000,
  backupMode: "build" as BackupMode,
  scenario: null as string | null,
  outputDir: null as string | null,
  armBarePiEnabled: true,
  armOmDefaultEnabled: true,
  armMemkeeperObservationsRootEnabled: true,
  armMemkeeperSelectedRootEnabled: true,
  armOmFullEnabled: true,
  omFullReflectionThresholdTokens: 4000,
} as const;

const BACKUP_MODE_PRESETS: readonly ["build", "extract"] = ["build", "extract"];

/** Helper: build a SettingSchema from an id + the non-id fields. */
function setting(id: string, over: Omit<SettingSchema, "id">): SettingSchema {
  return { id, ...over };
}

// ---------------------------------------------------------------------------
// SETTINGS — the schema rows across three tabs (Models / Run / Arms).
// ---------------------------------------------------------------------------

const SETTINGS: readonly SettingSchema[] = [
  // --- Models tab ---
  setting("evaluatedModel", {
    label: "Evaluated agent model",
    description: "The model for the agent under test (the subject). Empty = use the current session model.",
    type: "model",
    defaultValue: DEFAULTS.evaluatedModel,
  }),
  setting("evaluatedThinkingLevel", {
    label: "Evaluated thinking level",
    description:
      "Thinking level for the evaluated agent. The bench pins this (UD30); it does NOT override temperatures or other sampling params.",
    type: "thinking-level",
    defaultValue: DEFAULTS.evaluatedThinkingLevel,
  }),
  setting("judgeModel", {
    label: "Judge model",
    description: "Model for the LLM judge (scoring). Empty = use the current session model.",
    type: "model",
    defaultValue: DEFAULTS.judgeModel,
  }),
  setting("judgeThinkingLevel", {
    label: "Judge thinking level",
    description: "Thinking level for the judge.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judgeThinkingLevel,
  }),
  setting("judgesNumber", {
    label: "Multi-judge ensemble size",
    description:
      "Number of independent judges per grading call. 1 = single judge (cheap dev default); 3 = majority/Borda aggregation (robust final runs).",
    type: "number",
    defaultValue: DEFAULTS.judgesNumber,
    min: 1,
    max: 3,
    presets: [1, 3],
  }),
  setting("judge2Model", {
    label: "Judge 2 model",
    description: "Second judge model (used when ensemble size >= 2). Empty = session default.",
    type: "model",
    defaultValue: DEFAULTS.judge2Model,
  }),
  setting("judge2ThinkingLevel", {
    label: "Judge 2 thinking level",
    description: "Thinking level for judge 2.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judge2ThinkingLevel,
  }),
  setting("judge3Model", {
    label: "Judge 3 model",
    description: "Third judge model (used when ensemble size >= 3). Empty = session default.",
    type: "model",
    defaultValue: DEFAULTS.judge3Model,
  }),
  setting("judge3ThinkingLevel", {
    label: "Judge 3 thinking level",
    description: "Thinking level for judge 3.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judge3ThinkingLevel,
  }),
  // --- Run tab ---
  setting("N", {
    label: "N (continuation runs per arm)",
    description:
      "How many post-compaction continuation runs to sample per arm. Higher = tighter confidence intervals, higher cost.",
    type: "number",
    defaultValue: DEFAULTS.N,
  }),
  setting("compactionBoundary", {
    label: "Compaction boundary (tokens)",
    description:
      "The harness fires the Phase-1 compaction when context reaches this many tokens. The bench's own knob — it does NOT override the model's contextWindow.",
    type: "number",
    defaultValue: DEFAULTS.compactionBoundary,
  }),
  setting("backupMode", {
    label: "Backup mode",
    description:
      "build = the user-simulator builds the pre-compaction backup; extract = slice a real (never-compacted) session.",
    type: "string",
    defaultValue: DEFAULTS.backupMode,
    presets: BACKUP_MODE_PRESETS,
  }),
  setting("scenario", {
    label: "Scenario folder",
    description:
      "Path/id of a prepared scenario folder to run by default. null = the folder must be passed to /bench-compact:run-scenario.",
    type: "string",
    defaultValue: DEFAULTS.scenario,
  }),
  setting("outputDir", {
    label: "Output directory",
    description: "Where run artifacts (manifest, results, judge outputs) are stored. Empty = ~/.pi/bench-compact/.",
    type: "string",
    defaultValue: DEFAULTS.outputDir,
  }),
  // --- Arms tab ---
  setting("armBarePiEnabled", {
    label: "A1 — bare-pi (baseline)",
    description: "Native pi compaction (LLM summary). The attribution floor for ΔvsA1.",
    type: "boolean",
    defaultValue: DEFAULTS.armBarePiEnabled,
  }),
  setting("armOmDefaultEnabled", {
    label: "A2 — observational-memory (default)",
    description:
      "OM with default reflectionThresholdTokens (no override). Requires the forked OM (passive catch-up fix).",
    type: "boolean",
    defaultValue: DEFAULTS.armOmDefaultEnabled,
  }),
  setting("armMemkeeperObservationsRootEnabled", {
    label: "A3 — memkeeper (observations-root)",
    description: "memkeeper renderMode=observations-root (Builder's full root view; Selector OFF).",
    type: "boolean",
    defaultValue: DEFAULTS.armMemkeeperObservationsRootEnabled,
  }),
  setting("armMemkeeperSelectedRootEnabled", {
    label: "A4 — memkeeper (selected-root)",
    description: "memkeeper renderMode=selected-root (Selector-curated active set).",
    type: "boolean",
    defaultValue: DEFAULTS.armMemkeeperSelectedRootEnabled,
  }),
  setting("armOmFullEnabled", {
    label: "A5 — observational-memory (full)",
    description:
      "OM with reflectionThresholdTokens overridden low so reflector/pruner always run. Requires the forked OM.",
    type: "boolean",
    defaultValue: DEFAULTS.armOmFullEnabled,
  }),
  setting("omFullReflectionThresholdTokens", {
    label: "A5 reflection threshold tokens",
    description:
      "reflectionThresholdTokens override for A5 (forces reflector/pruner to run). Only consulted when A5 is enabled.",
    type: "number",
    defaultValue: DEFAULTS.omFullReflectionThresholdTokens,
  }),
];

const TABS: readonly SettingsTabSchema[] = [
  {
    label: "Models",
    settingIds: [
      "evaluatedModel",
      "evaluatedThinkingLevel",
      "judgeModel",
      "judgeThinkingLevel",
      "judgesNumber",
      "judge2Model",
      "judge2ThinkingLevel",
      "judge3Model",
      "judge3ThinkingLevel",
    ],
  },
  {
    label: "Run",
    settingIds: ["N", "compactionBoundary", "backupMode", "scenario", "outputDir"],
  },
  {
    label: "Arms",
    settingIds: [
      "armBarePiEnabled",
      "armOmDefaultEnabled",
      "armMemkeeperObservationsRootEnabled",
      "armMemkeeperSelectedRootEnabled",
      "armOmFullEnabled",
      "omFullReflectionThresholdTokens",
    ],
  },
];

const { globalPath, projectPath } = settingsFilePaths("avtc-pi-bench-compact");

/** The full settings-ui schema for /bench-compact:settings. */
export const BENCH_SCHEMA: SettingsSchema = {
  settings: [...SETTINGS],
  tabs: [...TABS],
  globalPath,
  projectPath,
};

// ---------------------------------------------------------------------------
// Registration — registers the /bench-compact:settings command + modal.
// ---------------------------------------------------------------------------

const REGISTRATION_OPTIONS: RegisterSettingsOptions = {
  commandName: BENCH_SETTINGS_COMMAND,
  title: "Bench-Compact Settings",
  titleRight: "avtc-pi-bench-compact",
  storageLevels: ["session", "project", "global"],
  envVar: "PI_SETTINGS_BENCH_COMPACT",
};

/** Indirection over registerSettingsCommand so tests can inject a fake WITHOUT
 *  vi.mock(avtc-pi-settings-ui) — the library loads the REAL settings stack + modal
 *  at import time, which a minimal fake `pi` cannot satisfy. The seam keeps the fake
 *  local + deterministic (memkeeper's pattern). */
let registerFn: typeof registerSettingsCommand = registerSettingsCommand;

/** Test-only: inject a fake registerSettingsCommand (pass null to restore the real one). */
export function _setRegisterSettingsCommand(fn: typeof registerSettingsCommand | null): void {
  registerFn = fn ?? registerSettingsCommand;
}

/** Register /bench-compact:settings and return the settings handle. */
export function registerBenchSettings(pi: ExtensionAPI): SettingsHandle {
  return registerFn(pi, BENCH_SCHEMA, REGISTRATION_OPTIONS);
}
