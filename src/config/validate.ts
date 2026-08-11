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
