// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type PresetElement,
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

/** The "no model set" default (session default) — the single null-model sentinel. */
export const NO_MODEL: string | null = null;

/** Raw default values for every settings key (the accessor maps these to BenchConfig). */
export const DEFAULTS = {
  evaluatedModel: NO_MODEL,
  evaluatedThinkingLevel: "high",
  judgeModel: NO_MODEL,
  judgeThinkingLevel: null as ThinkingLevel | null,
  judgesNumber: 1,
  judge2Model: NO_MODEL,
  judge2ThinkingLevel: null as ThinkingLevel | null,
  judge3Model: NO_MODEL,
  judge3ThinkingLevel: null as ThinkingLevel | null,
  N: 10,
  compactionBoundary: 140000,
  fastEval: "off" as FastEvalMode,
  latentProbes: "per-arm" as LatentProbesMode,
  judgeMaxTokens: null as number | null,
  latentStageMaxTokens: null as number | null,
  judgeTurnTimeoutMs: null as number | null,
  testspecTimeoutMs: 120000,
  backgroundModel: NO_MODEL,
  backgroundThinkingLevel: "xhigh" as ThinkingLevel | null,
  backgroundMaxTokens: 65536,
  backgroundTimeoutMs: 1200000,
  stageProviderMaxRetries: 3,
  authorModel: NO_MODEL,
  authorThinkingLevel: null as ThinkingLevel | null,
  authorMaxTokens: null as number | null,
  authorTimeoutMs: null as number | null,
  probeValidateModel: NO_MODEL,
  probeValidateThinkingLevel: null as ThinkingLevel | null,
  probeValidateMaxTokens: null as number | null,
  probeValidateTimeoutMs: null as number | null,
  simulatorModel: NO_MODEL,
  simulatorThinkingLevel: null as ThinkingLevel | null,
  simulatorMaxTokens: null as number | null,
  simulatorTurnTimeoutMs: null as number | null,
  latentModel: NO_MODEL,
  latentThinkingLevel: null as ThinkingLevel | null,
  latentTimeoutMs: null as number | null,
  scenario: null as string | null,
  outputDir: null as string | null,
  armBarePiEnabled: true,
  armOmDefaultEnabled: true,
  armSessionOwlObservationsRootEnabled: true,
  armSessionOwlSelectedRootEnabled: true,
  armOmFullEnabled: true,
  omFullReflectionThresholdTokens: 4000,
} as const;

const FAST_EVAL_PRESETS: readonly ["off", "probes-only"] = ["off", "probes-only"];
const LATENT_PROBES_PRESETS: readonly ["off", "per-arm", "shared"] = ["off", "per-arm", "shared"];
/** TestSpec shell-timeout presets. */
const TESTSPEC_TIMEOUT_PRESETS: readonly (readonly [string, number])[] = [
  ["30s", 30000],
  ["1m", 60000],
  ["2m", 120000],
  ["5m", 300000],
  ["10m", 600000],
];
/** Thinking-level presets for background agents: "none" (null — omit the reasoning
 *  field entirely, the model default) + the standard ladder (mirrors the type-def's
 *  THINKING_LEVEL_PRESETS; presets override replaces, so the ladder is restated). */
const BACKGROUND_THINKING_PRESETS: readonly (readonly [string, string | null])[] = [
  ["none", null],
  ["off", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
];
/** Shared background-agent output-token-cap presets (64K = the default), used
 *  identically by every background agent's max-tokens setting. */
const BACKGROUND_MAX_TOKENS_PRESETS: readonly number[] = [16384, 32768, 65536, 131072, 262144];
/** Shared background-agent wall-clock presets (human durations; 20m = the default), used
 *  identically by every background agent's timeout setting. */
const BACKGROUND_TIMEOUT_PRESETS: readonly string[] = ["5m", "10m", "20m", "60m", "120m"];
/** Per-agent max-tokens presets: "default" = inherit the background setting, then the shared picks. */
const AGENT_MAX_TOKENS_PRESETS: readonly PresetElement[] = [["default", null], ...BACKGROUND_MAX_TOKENS_PRESETS];
/** Per-agent timeout presets: "default" = inherit the background setting, then the shared picks. */
const AGENT_TIMEOUT_PRESETS: readonly PresetElement[] = [["default", null], ...BACKGROUND_TIMEOUT_PRESETS];
/** Per-agent thinking presets: "default" (null = inherit the background level), then the
 *  standard ladder starting at "off" (the no-thinking level). FULL PAIRS, not bare
 *  strings: the thinking-level type parse is a closed-enum membership check that the
 *  settings-ui preset normalizer runs against an EMPTY preset ctx — a bare string always
 *  fails it and throws at extension load (pairs pass through un-parsed). */
const AGENT_THINKING_PRESETS: readonly PresetElement[] = [
  ["default", null],
  ["off", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
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
    description: "Model for the LLM judge (scoring). Empty = background default, then the session model.",
    type: "model",
    defaultValue: DEFAULTS.judgeModel,
  }),
  setting("judgeThinkingLevel", {
    label: "Judge thinking level",
    description: "Thinking level for the judge. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judgeThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
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
    description:
      "Second judge model (used when ensemble size >= 2). Empty = background default, then the session default.",
    type: "model",
    defaultValue: DEFAULTS.judge2Model,
  }),
  setting("judge2ThinkingLevel", {
    label: "Judge 2 thinking level",
    description: "Thinking level for judge 2. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judge2ThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
  }),
  setting("judge3Model", {
    label: "Judge 3 model",
    description:
      "Third judge model (used when ensemble size >= 3). Empty = background default, then the session default.",
    type: "model",
    defaultValue: DEFAULTS.judge3Model,
  }),
  setting("judge3ThinkingLevel", {
    label: "Judge 3 thinking level",
    description: "Thinking level for judge 3. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.judge3ThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
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
    description:
      "Per-call output-token cap for every judge call (single-call slices, rankings, trajectory summaries). default = the background max tokens.",
    type: "number",
    defaultValue: DEFAULTS.judgeMaxTokens,
    min: 1,
    presets: AGENT_MAX_TOKENS_PRESETS,
  }),
  setting("latentStageMaxTokens", {
    label: "Latent authoring max output tokens",
    description: "Per-call output-token cap for the latent-probe authoring agent. default = the background max tokens.",
    type: "number",
    defaultValue: DEFAULTS.latentStageMaxTokens,
    min: 1,
    presets: AGENT_MAX_TOKENS_PRESETS,
  }),
  setting("judgeTurnTimeoutMs", {
    label: "Judge turn timeout",
    description: "Wall-clock cap per judge LLM call. default = the background timeout.",
    type: "duration",
    defaultValue: DEFAULTS.judgeTurnTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: AGENT_TIMEOUT_PRESETS,
  }),
  setting("testspecTimeoutMs", {
    label: "TestSpec timeout",
    description: "Wall-clock cap for the embedded testSpec shell run per attempt branch.",
    type: "number",
    defaultValue: DEFAULTS.testspecTimeoutMs,
    presets: TESTSPEC_TIMEOUT_PRESETS,
  }),
  setting("backgroundModel", {
    label: "Background default model",
    description:
      "Model for every background agent (manifest author, probe validator, simulator, latent authoring) unless overridden per agent. Empty = each agent keeps its built-in base (author/probe validator/simulator: the evaluated model; latent authoring: the session default).",
    type: "model",
    defaultValue: DEFAULTS.backgroundModel,
  }),
  setting("backgroundThinkingLevel", {
    label: "Background default thinking level",
    description:
      "Thinking level for every background agent unless overridden per agent. none = omit the reasoning field (the model's default).",
    type: "thinking-level",
    defaultValue: DEFAULTS.backgroundThinkingLevel,
    presets: BACKGROUND_THINKING_PRESETS,
  }),
  setting("backgroundMaxTokens", {
    label: "Background max output tokens",
    description: "Per-call output-token cap for every background agent unless overridden per agent.",
    type: "number",
    defaultValue: DEFAULTS.backgroundMaxTokens,
    min: 1,
    presets: BACKGROUND_MAX_TOKENS_PRESETS,
  }),
  setting("backgroundTimeoutMs", {
    label: "Background timeout",
    description: "Wall-clock cap for every background agent's LLM calls unless overridden per agent.",
    type: "duration",
    defaultValue: DEFAULTS.backgroundTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: BACKGROUND_TIMEOUT_PRESETS,
  }),
  setting("stageProviderMaxRetries", {
    label: "Stage provider retries",
    description:
      "Provider-level retry attempts per background-stage LLM call (judge / manifest author / latent author / user-simulator) on transient 5xx/429/408/409 responses. pi's session-owned retries never apply to bench stages. default = 3.",
    type: "number",
    defaultValue: DEFAULTS.stageProviderMaxRetries,
    min: 0,
    max: 20,
    presets: [0, 3, 5, 10],
  }),
  setting("authorModel", {
    label: "Manifest author model",
    description:
      "Model for the manifest-authoring agent (prepare). Empty = background default, then the evaluated model.",
    type: "model",
    defaultValue: DEFAULTS.authorModel,
  }),
  setting("authorThinkingLevel", {
    label: "Manifest author thinking level",
    description: "Thinking level for the manifest-authoring agent. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.authorThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
  }),
  setting("authorMaxTokens", {
    label: "Manifest author max output tokens",
    description:
      "Per-call output-token cap for the manifest-authoring agent (multi-turn, tool-bearing). default = the background max tokens.",
    type: "number",
    defaultValue: DEFAULTS.authorMaxTokens,
    min: 1,
    presets: AGENT_MAX_TOKENS_PRESETS,
  }),
  setting("authorTimeoutMs", {
    label: "Manifest author timeout",
    description: "Wall-clock cap for the manifest-authoring agent's LLM calls. default = the background timeout.",
    type: "duration",
    defaultValue: DEFAULTS.authorTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: AGENT_TIMEOUT_PRESETS,
  }),
  setting("probeValidateModel", {
    label: "Probe validator model",
    description:
      "Model for the probe validator (validates every authored probe at add time) and the kept-tail content check (prepare). Empty = background default, then the evaluated model.",
    type: "model",
    defaultValue: DEFAULTS.probeValidateModel,
  }),
  setting("probeValidateThinkingLevel", {
    label: "Probe validator thinking level",
    description: "Thinking level for the probe validator. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.probeValidateThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
  }),
  setting("probeValidateMaxTokens", {
    label: "Probe validator max output tokens",
    description: "Per-call output-token cap for the probe validator. default = the background max tokens.",
    type: "number",
    defaultValue: DEFAULTS.probeValidateMaxTokens,
    min: 1,
    presets: AGENT_MAX_TOKENS_PRESETS,
  }),
  setting("probeValidateTimeoutMs", {
    label: "Probe validator timeout",
    description: "Wall-clock cap per probe-validator LLM call. default = the background timeout.",
    type: "duration",
    defaultValue: DEFAULTS.probeValidateTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: AGENT_TIMEOUT_PRESETS,
  }),
  setting("simulatorModel", {
    label: "Simulator model",
    description:
      "Model for the user-simulator (build drive + continuations). Empty = background default, then the evaluated model.",
    type: "model",
    defaultValue: DEFAULTS.simulatorModel,
  }),
  setting("simulatorThinkingLevel", {
    label: "Simulator thinking level",
    description: "Thinking level for the user-simulator. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.simulatorThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
  }),
  setting("simulatorMaxTokens", {
    label: "Simulator max output tokens",
    description: "Per-call output-token cap for the user-simulator's turns. default = the background max tokens.",
    type: "number",
    defaultValue: DEFAULTS.simulatorMaxTokens,
    min: 1,
    presets: AGENT_MAX_TOKENS_PRESETS,
  }),
  setting("simulatorTurnTimeoutMs", {
    label: "Simulator turn timeout",
    description: "Wall-clock cap per user-simulator LLM call. default = the background timeout.",
    type: "duration",
    defaultValue: DEFAULTS.simulatorTurnTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: AGENT_TIMEOUT_PRESETS,
  }),
  setting("latentModel", {
    label: "Latent authoring model",
    description: "Model for the latent-probe authoring agent. Empty = background default, then the session default.",
    type: "model",
    defaultValue: DEFAULTS.latentModel,
  }),
  setting("latentThinkingLevel", {
    label: "Latent authoring thinking level",
    description: "Thinking level for the latent-probe authoring agent. default = the background thinking level.",
    type: "thinking-level",
    defaultValue: DEFAULTS.latentThinkingLevel,
    presets: AGENT_THINKING_PRESETS,
  }),
  setting("latentTimeoutMs", {
    label: "Latent authoring timeout",
    description: "Wall-clock cap for the latent-probe authoring agent's LLM calls. default = the background timeout.",
    type: "duration",
    defaultValue: DEFAULTS.latentTimeoutMs,
    min: 1000,
    max: 7200000,
    presets: AGENT_TIMEOUT_PRESETS,
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
  setting("armSessionOwlObservationsRootEnabled", {
    label: "A3 — session-owl (observations-root)",
    description: "session-owl renderMode=observations-root (Builder's full root view; Selector OFF).",
    type: "boolean",
    defaultValue: DEFAULTS.armSessionOwlObservationsRootEnabled,
  }),
  setting("armSessionOwlSelectedRootEnabled", {
    label: "A4 — session-owl (selected-root)",
    description: "session-owl renderMode=selected-root (Selector-curated active set).",
    type: "boolean",
    defaultValue: DEFAULTS.armSessionOwlSelectedRootEnabled,
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
    label: "General",
    settingIds: [
      "evaluatedModel",
      "evaluatedThinkingLevel",
      "judgesNumber",
      "backgroundModel",
      "backgroundThinkingLevel",
      "backgroundMaxTokens",
      "backgroundTimeoutMs",
      "stageProviderMaxRetries",
    ],
  },
  {
    label: "Run",
    settingIds: ["N", "compactionBoundary", "fastEval", "latentProbes", "testspecTimeoutMs", "scenario", "outputDir"],
  },
  {
    label: "Arms",
    settingIds: [
      "armBarePiEnabled",
      "armOmDefaultEnabled",
      "armSessionOwlObservationsRootEnabled",
      "armSessionOwlSelectedRootEnabled",
      "armOmFullEnabled",
      "omFullReflectionThresholdTokens",
    ],
  },
  {
    label: "Judge",
    settingIds: [
      "judgeModel",
      "judgeThinkingLevel",
      "judge2Model",
      "judge2ThinkingLevel",
      "judge3Model",
      "judge3ThinkingLevel",
      "judgeMaxTokens",
      "judgeTurnTimeoutMs",
    ],
  },
  {
    label: "Author",
    settingIds: ["authorModel", "authorThinkingLevel", "authorMaxTokens", "authorTimeoutMs"],
  },
  {
    label: "Validate",
    settingIds: [
      "probeValidateModel",
      "probeValidateThinkingLevel",
      "probeValidateMaxTokens",
      "probeValidateTimeoutMs",
    ],
  },
  {
    label: "Sim",
    settingIds: ["simulatorModel", "simulatorThinkingLevel", "simulatorMaxTokens", "simulatorTurnTimeoutMs"],
  },
  {
    label: "Latent",
    settingIds: ["latentModel", "latentThinkingLevel", "latentStageMaxTokens", "latentTimeoutMs"],
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
 *  local + deterministic (session-owl's pattern). */
let registerFn: typeof registerSettingsCommand = registerSettingsCommand;

/** Test-only: inject a fake registerSettingsCommand (pass null to restore the real one). */
export function _setRegisterSettingsCommand(fn: typeof registerSettingsCommand | null): void {
  registerFn = fn ?? registerSettingsCommand;
}

/** Register /bench-compact:settings and return the settings handle. */
export function registerBenchSettings(pi: ExtensionAPI): SettingsHandle {
  return registerFn(pi, BENCH_SCHEMA, REGISTRATION_OPTIONS);
}
