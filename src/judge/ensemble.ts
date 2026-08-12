// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Multi-judge ensemble aggregation (design multi-judge reliability). Each
// grading primitive (gradeSlice binary, rankAxis comparative, findFirstCorrectUse
// recall-cost boundary) runs once per configured judge; this module AGGREGATES
// the K results — it does not invoke the judges (the orchestrator kicks off the
// K calls in parallel + passes the promises here). K=1 short-circuits to the
// single result (no aggregation — the single-judge path).

import type { C2Boundary } from "./c2-boundary.js";
import type { Ranking } from "./ranking.js";

/** Majority vote over K boolean grades. K=1 → the value itself; K=3 → ≥2 of 3
 *  (strictly more than half). Ties (even K) cannot occur for K∈{1,3}. */
export function majorityVote(passes: readonly boolean[]): boolean {
  const trues = passes.filter((p) => p).length;
  return trues > passes.length / 2;
}

/** Run K binary judges (already-kicked-off promises) + majority-vote. K=1
 *  short-circuits. Rejects propagate (Promise.all). */
export async function runBinaryEnsemble(grades: readonly Promise<boolean>[]): Promise<boolean> {
  const resolved = await Promise.all(grades);
  return resolved.length === 1 ? (resolved[0] as boolean) : majorityVote(resolved);
}

/**
 * Borda count over K rankings: each arm's score = the SUM of its rank positions
 * across the K rankings (0=best → N-1=worst). Lowest sum = best. Arms absent
 * from a ranking score at the tail (position = armIds.length). Ties broken by
 * first-seen order in `armIds` (stable sort).
 */
export function bordaAggregate(rankings: readonly Ranking[], armIds: readonly string[]): Ranking {
  const tailPos = armIds.length; // unranked arms score at the tail
  const scores = new Map<string, number>();
  for (const arm of armIds) scores.set(arm, 0);
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.order.forEach((arm, pos) => {
      if (scores.has(arm)) {
        scores.set(arm, (scores.get(arm) ?? 0) + pos);
        seen.add(arm);
      }
    });
    // arms in armIds but absent from this ranking → tail position
    for (const arm of armIds) {
      if (!seen.has(arm)) scores.set(arm, (scores.get(arm) ?? 0) + tailPos);
    }
  }
  // stable sort by score (lowest = best); ties keep armIds order (first-seen)
  const order = armIds.slice().sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
  return { order };
}

/** Run K comparative judges + Borda-aggregate. K=1 short-circuits. */
export async function rankEnsemble(rankings: readonly Promise<Ranking>[], armIds: readonly string[]): Promise<Ranking> {
  const resolved = await Promise.all(rankings);
  return resolved.length === 1 ? (resolved[0] as Ranking) : bordaAggregate(resolved, armIds);
}

/**
 * Union K judges' recall-cost boundaries: a fact counts RECOVERED if ANY judge found its
 * first-correct-use (non-null entry id). When a judge recovers a fact others
 * missed, its boundary wins. All-null across judges stays null (notRecovered).
 * Disjoint fact sets across judges are merged (union of factIds).
 *
 * Disagreeing-entry tie-break (R-measurement): when several judges recover the
 * SAME fact at DIFFERENT non-null entries, the LOWEST-NUMBERED recovering judge's
 * entry wins (judges are iterated in judge1..judgeK order; the first
 * non-null boundary for a fact is kept, later non-null ones do NOT overwrite it).
 * judge1 is the primary/highest-trust judge, so its measurement drives the
 * recall-cost token sum deterministically (not judge-order-arbitrary). Pure.
 */
export function unionBoundaries(perJudge: readonly C2Boundary[][]): C2Boundary[] {
  if (perJudge.length === 0) return [];
  if (perJudge.length === 1) return perJudge[0] as C2Boundary[];
  const byFact = new Map<string, C2Boundary>();
  for (const judgeBoundaries of perJudge) {
    for (const b of judgeBoundaries) {
      const existing = byFact.get(b.factId);
      // prefer a recovered (non-null) boundary over a not-recovered (null) one;
      // among recovered boundaries the lowest-numbered judge wins (first set, kept).
      if (existing === undefined || (existing.firstCorrectUseEntryId === null && b.firstCorrectUseEntryId !== null)) {
        byFact.set(b.factId, b);
      }
    }
  }
  return [...byFact.values()];
}

/** Run K recall-cost-boundary judges (already-kicked-off promises, one per
 *  judge) + union them. K=1 short-circuits (no union). Rejects propagate. */
export async function unionC2Boundaries(perJudge: readonly Promise<C2Boundary[]>[]): Promise<C2Boundary[]> {
  const resolved = await Promise.all(perJudge);
  return resolved.length === 1 ? (resolved[0] as C2Boundary[]) : unionBoundaries(resolved);
}
