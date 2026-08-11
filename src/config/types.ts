// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** The five compaction/memory arms under test (§2). */
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
export const ARM_ENABLED_KEY: Record<ArmId, string> = {
  A1: "armBarePiEnabled",
  A2: "armOmDefaultEnabled",
  A3: "armMemkeeperObservationsRootEnabled",
  A4: "armMemkeeperSelectedRootEnabled",
  A5: "armOmFullEnabled",
};

export type BackupMode = "build" | "extract";

/**
 * The fully-resolved bench configuration (§2.12). `armsEnabled` is DERIVED from
 * the five per-arm booleans by the accessor (not stored in settings).
 *
 * The bench configures ONLY evaluated + judge `thinkingLevel` + model selection;
 * it does NOT override model sampling params (temperatures) or pi model-level
 * config (contextWindow / keepRecentTokens) — those come from the model config
 * (UD30). `null` model = fall through to the session default.
 */
export interface BenchConfig {
  // Models tab
  evaluatedModel: string | null;
  evaluatedThinkingLevel: string;
  judgeModel: string | null;
  judgeThinkingLevel: string;
  // Run tab
  N: number;
  compactionBoundary: number;
  backupMode: BackupMode;
  scenario: string | null;
  outputDir: string | null;
  // Arms tab
  armBarePiEnabled: boolean;
  armOmDefaultEnabled: boolean;
  armMemkeeperObservationsRootEnabled: boolean;
  armMemkeeperSelectedRootEnabled: boolean;
  armOmFullEnabled: boolean;
  omFullReflectionThresholdTokens: number;
  /** Derived: enabled arm ids in canonical order (A1..A5). */
  armsEnabled: ArmId[];
}
