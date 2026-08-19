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
import type { FastEvalMode, LatentProbesMode } from "./types.js";

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
  fastEval: "off" as FastEvalMode,
  latentProbes: "per-arm" as LatentProbesMode,
  judgeMaxTokens: 32768,
  latentStageMaxTokens: 32768,
  judgeTurnTimeoutMs: 300000 as number | null,
  testspecTimeoutMs: 120000,
  scenario: null as string | null,
  outputDir: null as string | null,
  armBarePiEnabled: true,
  armOmDefaultEnabled: true,
  armMemkeeperObservationsRootEnabled: true,
  armMemkeeperSelectedRootEnabled: true,
  armOmFullEnabled: true,
  omFullReflectionThresholdTokens: 4000,
} as const;

const FAST_EVAL_PRESETS: readonly ["off", "probes-only"] = ["off", "probes-only"];
const LATENT_PROBES_PRESETS: readonly ["off", "per-arm", "shared"] = ["off", "per-arm", "shared"];
/** Output-token budget presets (memkeeper's MAX_TOKENS_PRESETS — same ladder everywhere). */
const MAX_TOKENS_PRESETS: readonly number[] = [16384, 32768, 65536, 131072, 262144];
/** Judge turn-timeout presets (memkeeper's LLM-call ladder + "5m" so the default is selectable). */
const JUDGE_TURN_TIMEOUT_PRESETS: readonly (readonly [string, number | null])[] = [
  ["5m", 300000],
  ["10m", 600000],
  ["20m", 1200000],
  ["30m", 1800000],
  ["Infinite", null],
];
/** TestSpec shell-timeout presets. */
const TESTSPEC_TIMEOUT_PRESETS: readonly (readonly [string, number])[] = [
  ["30s", 30000],
  ["1m", 60000],
  ["2m", 120000],
  ["5m", 300000],
  ["10m", 600000],
];

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
    description: "Thinking level for the evaluated agent.",
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
  setting("fastEval", {
    label: "Fast eval",
    description:
      "off = full budget (continuations drive to the model's context window). probes-only = skip continuations: after the Phase-1 compaction the agent is asked to pause goal work and answer the manifest's direct questions; scores probe recall, summary cost (C1/C2), and compaction cost (C4); continuation lanes are n/a.",
    type: "string",
    defaultValue: DEFAULTS.fastEval,
    presets: FAST_EVAL_PRESETS,
  }),
  setting("latentProbes", {
    label: "Latent probes",
    description:
      "off = current behavior (planted-fact probes only). per-arm = after compaction, a second authoring agent reads each arm's session file and writes that arm's probes for knowledge lost from its summary + tail (one authoring run per arm). shared = one authoring run over all arms' files producing a single question set absent from every summary.",
    type: "string",
    defaultValue: DEFAULTS.latentProbes,
    presets: LATENT_PROBES_PRESETS,
  }),
  setting("judgeMaxTokens", {
    label: "Judge max output tokens",
    description: "Per-call output-token cap for every judge call (single-call slices, rankings, trajectory summaries).",
    type: "number",
    defaultValue: DEFAULTS.judgeMaxTokens,
    presets: MAX_TOKENS_PRESETS,
  }),
  setting("latentStageMaxTokens", {
    label: "Latent authoring max output tokens",
    description: "Per-call output-token cap for the latent-probe authoring agent.",
    type: "number",
    defaultValue: DEFAULTS.latentStageMaxTokens,
    presets: MAX_TOKENS_PRESETS,
  }),
  setting("judgeTurnTimeoutMs", {
    label: "Judge turn timeout",
    description: "Wall-clock cap per judge LLM call. Infinite = no cap.",
    type: "number",
    defaultValue: DEFAULTS.judgeTurnTimeoutMs,
    presets: JUDGE_TURN_TIMEOUT_PRESETS,
  }),
  setting("testspecTimeoutMs", {
    label: "TestSpec timeout",
    description: "Wall-clock cap for the embedded testSpec shell run per attempt branch.",
    type: "number",
    defaultValue: DEFAULTS.testspecTimeoutMs,
    presets: TESTSPEC_TIMEOUT_PRESETS,
  }),
  setting("scenario", {
    label: "Scenario folder",
    description:
      "Path/id of a prepared scenario folder to run by default. null = the folder must be passed to /bench-compact:run-scenario.",
    type: "string",
    supportsCustomValues: true, // free-form path — opens the text editor directly (no preset list)
    defaultValue: DEFAULTS.scenario,
  }),
  setting("outputDir", {
    label: "Output directory",
    description: "Where run artifacts (manifest, results, judge outputs) are stored. Empty = ~/.pi/bench-compact/.",
    type: "string",
    supportsCustomValues: true, // free-form path — opens the text editor directly (no preset list)
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
    settingIds: [
      "N",
      "compactionBoundary",
      "fastEval",
      "latentProbes",
      "judgeMaxTokens",
      "latentStageMaxTokens",
      "judgeTurnTimeoutMs",
      "testspecTimeoutMs",
      "scenario",
      "outputDir",
    ],
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
