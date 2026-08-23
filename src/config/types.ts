// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The five compaction/memory arms under test. */
export type ArmId = "A1" | "A2" | "A3" | "A4" | "A5";

/** Canonical arm order. */
export const ARM_IDS: readonly ArmId[] = ["A1", "A2", "A3", "A4", "A5"];

/** Human-readable arm descriptions (used by reports + the status command). */
export const ARM_LABELS: Record<ArmId, string> = {
  A1: "bare-pi",
  A2: "om-default",
  A3: "memkeeper-builder",
  A4: "memkeeper-selector",
  A5: "om-full",
};

/**
 * Maps each arm id to the BenchConfig boolean that enables it. Single source of
 * truth for the arm→setting-key binding (consumed by the schema, the accessor's
 * derived `armsEnabled`, and validation).
 */
export const ARM_ENABLED_KEY: Record<ArmId, keyof BenchConfig> = {
  A1: "armBarePiEnabled",
  A2: "armOmDefaultEnabled",
  A3: "armMemkeeperObservationsRootEnabled",
  A4: "armMemkeeperSelectedRootEnabled",
  A5: "armOmFullEnabled",
};

export type BackupMode = "build" | "extract";

/** Fast-eval mode. `off` = the full design budget (continuations drive to the model's
 *  context window). `probes-only` = skip continuations entirely: after the Phase-1
 *  compaction the agent is asked to pause goal work and answer the manifest's direct
 *  questions; scores probe recall + summary cost + compaction cost; continuation
 *  lanes are n/a. Part of the cfgId fingerprint. */
export type FastEvalMode = "off" | "probes-only";

/** How the post-compaction latent-probe stage authors its question set: off
 *  (planted-fact probes only), per-arm (one authoring run per arm's session
 *  file), or shared (one run over all arms' files — a single set absent from
 *  every summary). */
export type LatentProbesMode = "off" | "per-arm" | "shared";

/** The judge-ensemble fields shared by {@link BenchConfig} (live settings) + the
 *  persisted {@link RunConfig} snapshot (so cfgId + reproducibility cover them).
 *  Extracted to avoid duplicating the 7-field block across the two interfaces. */
export interface JudgeEnsembleConfig {
  judgeModel: string | null;
  judgeThinkingLevel: ThinkingLevel | null;
  /** Multi-judge ensemble size: 1 (single judge, default) or 3 (majority/Borda). */
  judgesNumber: number;
  /** Judge 2 model (used when judgesNumber >= 2). null = background default, then session default. */
  judge2Model: string | null;
  judge2ThinkingLevel: ThinkingLevel | null;
  /** Judge 3 model (used when judgesNumber >= 3). null = background default, then session default. */
  judge3Model: string | null;
  judge3ThinkingLevel: ThinkingLevel | null;
}

/** Project the 7 judge-ensemble fields off a config (single source for RunConfig
 *  mapping + cfgId canonical form). */
export function judgeEnsembleFields(c: JudgeEnsembleConfig): JudgeEnsembleConfig {
  return {
    judgeModel: c.judgeModel,
    judgeThinkingLevel: c.judgeThinkingLevel,
    judgesNumber: c.judgesNumber,
    judge2Model: c.judge2Model,
    judge2ThinkingLevel: c.judge2ThinkingLevel,
    judge3Model: c.judge3Model,
    judge3ThinkingLevel: c.judge3ThinkingLevel,
  };
}

/**
 * The fully-resolved bench configuration. `armsEnabled` is DERIVED from
 * the five per-arm booleans by the accessor (not stored in settings).
 *
 * The bench configures ONLY evaluated + judge `thinkingLevel` + model selection;
 * it does NOT override model sampling params (temperatures) or pi model-level
 * config (contextWindow / keepRecentTokens) — those come from the model config.
 * `null` model = fall through to the session default.
 */
export interface BenchConfig extends JudgeEnsembleConfig {
  // Models tab
  evaluatedModel: string | null;
  evaluatedThinkingLevel: ThinkingLevel;
  // Run tab
  N: number;
  compactionBoundary: number;
  fastEval: FastEvalMode;
  latentProbes: LatentProbesMode;
  /** Per-call output-token caps (judge ensemble / latent authoring). */
  judgeMaxTokens: number | null;
  /** Per-call output-token cap for latent authoring (null = backgroundMaxTokens). */
  latentStageMaxTokens: number | null;
  /** Wall-clock cap per judge LLM call; null = no cap (the "Infinite" preset). */
  judgeTurnTimeoutMs: number | null;
  /** Wall-clock cap for the embedded testSpec shell run. */
  testspecTimeoutMs: number;
  // Background agents tab — per-agent values fall back to the matching background
  // setting (no code-level fallback: the background settings always carry a value).
  /** Shared default for every background agent's model (null = per-agent bases). */
  backgroundModel: string | null;
  /** Shared default thinking level (null = omit the reasoning field). */
  backgroundThinkingLevel: ThinkingLevel | null;
  /** Shared default per-call output-token cap for every background agent. */
  backgroundMaxTokens: number;
  /** Shared default wall-clock cap per background-agent LLM call (ms). */
  backgroundTimeoutMs: number;
  /** Provider-level retry attempts per background-stage LLM call (transient
   *  5xx/429/408/409 — pi's session-owned retries never cover bench stages). */
  stageProviderMaxRetries: number;
  authorModel: string | null;
  authorThinkingLevel: ThinkingLevel | null;
  /** Per-call output-token cap override (null = backgroundMaxTokens). */
  authorMaxTokens: number | null;
  /** Wall-clock cap override per authoring LLM call (null = backgroundTimeoutMs). */
  authorTimeoutMs: number | null;
  probeValidateModel: string | null;
  probeValidateThinkingLevel: ThinkingLevel | null;
  /** Per-call output-token cap override (null = backgroundMaxTokens). */
  probeValidateMaxTokens: number | null;
  /** Wall-clock cap override for the tail-check LLM call (null = backgroundTimeoutMs). */
  probeValidateTimeoutMs: number | null;
  simulatorModel: string | null;
  simulatorThinkingLevel: ThinkingLevel | null;
  /** Per-call output-token cap override (null = backgroundMaxTokens). */
  simulatorMaxTokens: number | null;
  /** Wall-clock cap override per user-simulator LLM call (null = backgroundTimeoutMs). */
  simulatorTurnTimeoutMs: number | null;
  latentModel: string | null;
  latentThinkingLevel: ThinkingLevel | null;
  /** Wall-clock cap override per latent-authoring LLM call (null = backgroundTimeoutMs). */
  latentTimeoutMs: number | null;
  scenario: string | null;
  outputDir: string | null;
  // Arms tab
  armBarePiEnabled: boolean;
  armOmDefaultEnabled: boolean;
  armMemkeeperObservationsRootEnabled: boolean;
  armMemkeeperSelectedRootEnabled: boolean;
  armOmFullEnabled: boolean;
  omFullReflectionThresholdTokens: number;
  /** Derived: enabled arm ids in canonical order. */
  armsEnabled: ArmId[];
}
