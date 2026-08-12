// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Comparative-ranking aggregation. The judge produces a per-run-slot ranking of
// the enabled arms for each comparative axis; this layer folds
// those N run-slot rankings into a single cross-arm ordering + a per-arm rank
// (1=best) with a bootstrap CI + an Elo score. All functions are PURE and
// DETERMINISTIC given a seed.
//
// Aggregation method: each arm's AVERAGE RANK POSITION across runs (1=best in
// each run; an arm absent from a run's ranking is tied-last in that run). The
// cross-arm order sorts arms by average rank ascending (ties broken by arm id,
// stable). Elo is computed pairwise across runs (a win for every "ranked above"
// pair, K-factor 32, baseline 1000) as a secondary signal. The rank-CI bootstraps
// the average rank (the same procedure the binary/exact CIs use).

import type { ArmId } from "../config/types.js";
import { type BootstrapOptions, bootstrapCi } from "./bootstrap.js";
import { mean } from "./util.js";

/** One run-slot's ranking: arms ordered best → worst (1st = best). */
export interface ArmRanking {
  readonly order: readonly ArmId[];
}

/** The deterministic core: each arm's average rank position + the cross-arm order. */
export interface RankMatrix {
  readonly avgRank: Readonly<Partial<Record<ArmId, number>>>;
  readonly order: readonly ArmId[];
}

/** One arm's comparative aggregate: rank (1=best) + its bootstrap CI. */
export interface ComparativeMetric {
  readonly rank: number;
  readonly rankCi: readonly [number, number];
}

/** A comparative axis's full aggregate: cross-arm order + Elo + per-arm rank/CI. */
export interface ComparativeAxisResult {
  readonly order: readonly ArmId[];
  readonly elo: Readonly<Partial<Record<ArmId, number>>>;
  readonly ranks: Readonly<Partial<Record<ArmId, ComparativeMetric>>>;
}

/** Elo baseline + K-factor for the pairwise update. */
const ELO_BASELINE = 1000;
const ELO_K_FACTOR = 32;
/** The Elo expected-score divisor's exponent base + divisor. */
const ELO_EXP_BASE = 10;
const ELO_EXP_DIVISOR = 400;

/** The per-run position (1-indexed) of each arm across all run-slot rankings.
 *  An arm absent from a ranking is tied-last in that run (position = listed + 1). */
function computePositions(perRunRankings: readonly ArmRanking[], arms: readonly ArmId[]): Record<ArmId, number[]> {
  const positions: Record<ArmId, number[]> = {} as Record<ArmId, number[]>;
  for (const arm of arms) positions[arm] = [];
  for (const ranking of perRunRankings) {
    const listed = ranking.order.length;
    const tiedLastPosition = listed + 1;
    for (const arm of arms) {
      const idx = ranking.order.indexOf(arm);
      positions[arm].push(idx >= 0 ? idx + 1 : tiedLastPosition);
    }
  }
  return positions;
}

/**
 * The deterministic rank matrix: each arm's average rank position across the
 * run-slot rankings + the cross-arm order (best/lowest-average first; ties broken
 * by arm id, stable). Empty rankings → empty avgRank + empty order. Pure.
 */
export function rankMatrix(perRunRankings: readonly ArmRanking[], arms: readonly ArmId[]): RankMatrix {
  if (perRunRankings.length === 0 || arms.length === 0) {
    return { avgRank: {}, order: [] };
  }
  const positions = computePositions(perRunRankings, arms);
  const avgRank = {} as Record<ArmId, number>;
  for (const arm of arms) avgRank[arm] = mean(positions[arm]);
  // Sort by average rank ascending; ties broken by arm id (stable, <<…).
  const order = [...arms].sort((a, b) => {
    const diff = avgRank[a] - avgRank[b];
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { avgRank, order };
}

/** Elo across all run-slot rankings via pairwise "ranked above = win" updates. */
function computeElo(perRunRankings: readonly ArmRanking[], arms: readonly ArmId[]): Record<ArmId, number> {
  const elo = {} as Record<ArmId, number>;
  for (const arm of arms) elo[arm] = ELO_BASELINE;
  for (const ranking of perRunRankings) {
    const order = ranking.order;
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      if (!(a in elo)) continue;
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (!(b in elo)) continue;
        const expectedA = 1 / (1 + ELO_EXP_BASE ** ((elo[b] - elo[a]) / ELO_EXP_DIVISOR));
        elo[a] += ELO_K_FACTOR * (1 - expectedA);
        elo[b] += ELO_K_FACTOR * (expectedA - 1);
      }
    }
  }
  return elo;
}

/**
 * Aggregate per-run rankings into a cross-arm order + Elo + per-arm rank (1=best)
 * with a bootstrap rank-CI. `rank` is the arm's 1-indexed position in the
 * aggregated order; `rankCi` bootstraps the average rank. Empty input → empty
 * order/ranks/elo. Deterministic given `seed`. Pure.
 */
export function aggregateRanks(
  perRunRankings: readonly ArmRanking[],
  arms: readonly ArmId[],
  options: BootstrapOptions | null,
): ComparativeAxisResult {
  if (perRunRankings.length === 0 || arms.length === 0) {
    return { order: [], elo: {}, ranks: {} };
  }
  const matrix = rankMatrix(perRunRankings, arms);
  const positions = computePositions(perRunRankings, arms);
  const ranks = {} as Record<ArmId, ComparativeMetric>;
  matrix.order.forEach((arm, idx) => {
    const rank = idx + 1;
    const { ci } = bootstrapCi(positions[arm], options);
    ranks[arm] = { rank, rankCi: ci };
  });
  const elo = computeElo(perRunRankings, arms);
  return { order: matrix.order, elo, ranks };
}
