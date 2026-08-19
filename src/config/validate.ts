// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { BenchConfig } from "./types.js";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Floor on the Phase-1 compaction trigger (tokens). Below this the pre-compaction
 *  span is too small to plant meaningful ground-truth conditions. */
const MIN_COMPACTION_BOUNDARY = 20000;

/** OM's default `reflectionThresholdTokens` (30000). The OM-full arm exists to FORCE the
 *  reflector/pruner to run MORE than the OM-default arm — so its override must be strictly
 *  below this. A value >= this silently makes the OM-full arm behave like the OM-default arm, invalidating the
 *  arm differentiation with no error. */
const OM_DEFAULT_REFLECTION_THRESHOLD_TOKENS = 30000;

/** Valid multi-judge ensemble sizes (1 = single judge; 3 = majority/Borda). */
const VALID_JUDGES_NUMBER = new Set([1, 3]);

/**
 * Validate a resolved bench config. Models may be null (= fall through to
 * the session default — NOT an error). Rejects:
 *  - zero arms enabled (the bare-pi arm is the attribution floor; >=1 arm must run),
 *  - compactionBoundary below the floor,
 *  - N < 1 (no continuation runs),
 *  - the OM-full arm enabled with a nonsensical reflectionThresholdTokens: too low (<1)
 *    OR >= OM's default (would make the OM-full arm indistinguishable from the OM-default arm).
 */
export function validateBenchConfig(cfg: BenchConfig): ValidationResult {
  if (cfg.armsEnabled.length === 0) {
    return { ok: false, reason: "At least one arm must be enabled (A1 is the attribution floor)." };
  }
  if (cfg.compactionBoundary < MIN_COMPACTION_BOUNDARY) {
    return {
      ok: false,
      reason: `compactionBoundary must be >= ${MIN_COMPACTION_BOUNDARY} tokens (got ${cfg.compactionBoundary}).`,
    };
  }
  if (cfg.N < 1) {
    return { ok: false, reason: `N (continuation runs per arm) must be >= 1 (got ${cfg.N}).` };
  }
  if (!VALID_JUDGES_NUMBER.has(cfg.judgesNumber)) {
    return {
      ok: false,
      reason: `judgesNumber must be 1 or 3 (got ${cfg.judgesNumber}) — only single-judge (1) or the 3-judge ensemble (3) are supported.`,
    };
  }
  if (
    (cfg.judgeMaxTokens !== null && cfg.judgeMaxTokens < 1) ||
    (cfg.latentStageMaxTokens !== null && cfg.latentStageMaxTokens < 1) ||
    cfg.testspecTimeoutMs < 1000
  ) {
    return {
      ok: false,
      reason:
        `stage budgets must be positive or unset (judgeMaxTokens ${cfg.judgeMaxTokens}, latentStageMaxTokens ${cfg.latentStageMaxTokens}) ` +
        `and testspecTimeoutMs >= 1000 (got ${cfg.testspecTimeoutMs}).`,
    };
  }
  if (cfg.judgeTurnTimeoutMs !== null && cfg.judgeTurnTimeoutMs < 1000) {
    return {
      ok: false,
      reason: `judgeTurnTimeoutMs must be >= 1000 or unset (got ${cfg.judgeTurnTimeoutMs}).`,
    };
  }
  // The shared background defaults are the last fallback for every background agent —
  // always positive (the settings cannot store null for them).
  if (cfg.backgroundMaxTokens < 1 || cfg.backgroundTimeoutMs < 1000) {
    return {
      ok: false,
      reason: `background defaults must be positive (backgroundMaxTokens ${cfg.backgroundMaxTokens}, backgroundTimeoutMs ${cfg.backgroundTimeoutMs}).`,
    };
  }
  // Per-agent overrides, when set, must be positive too.
  const overrideMaxTokens = [
    cfg.authorMaxTokens,
    cfg.tailCheckMaxTokens,
    cfg.simulatorMaxTokens,
    cfg.latentStageMaxTokens,
  ];
  const overrideTimeouts = [
    cfg.authorTimeoutMs,
    cfg.tailCheckTimeoutMs,
    cfg.simulatorTurnTimeoutMs,
    cfg.latentTimeoutMs,
  ];
  if (overrideMaxTokens.some((v) => v !== null && v < 1) || overrideTimeouts.some((v) => v !== null && v < 1000)) {
    return {
      ok: false,
      reason: "per-agent background overrides must be positive when set (maxTokens >= 1, timeoutMs >= 1000).",
    };
  }
  if (cfg.armOmFullEnabled) {
    if (cfg.omFullReflectionThresholdTokens < 1) {
      return {
        ok: false,
        reason: `omFullReflectionThresholdTokens must be >= 1 when A5 (om-full) is enabled (got ${cfg.omFullReflectionThresholdTokens}).`,
      };
    }
    if (cfg.omFullReflectionThresholdTokens >= OM_DEFAULT_REFLECTION_THRESHOLD_TOKENS) {
      return {
        ok: false,
        reason: `omFullReflectionThresholdTokens must be < OM's default ${OM_DEFAULT_REFLECTION_THRESHOLD_TOKENS} when A5 is enabled — otherwise A5 is indistinguishable from A2 (got ${cfg.omFullReflectionThresholdTokens}).`,
      };
    }
    if (cfg.omFullReflectionThresholdTokens >= cfg.compactionBoundary) {
      return {
        ok: false,
        reason: `omFullReflectionThresholdTokens must be < compactionBoundary (${cfg.compactionBoundary}) when A5 is enabled — the observation pool at Phase-1 compaction is bounded by the compacted span, so a threshold at/above the boundary is never reached and A5 is indistinguishable from A2 (got ${cfg.omFullReflectionThresholdTokens}).`,
      };
    }
  }
  return { ok: true };
}
