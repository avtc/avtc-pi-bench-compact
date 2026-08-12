// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Exact (no-judge) cost metrics computed off the captured run trace.
//
// - computeC1: tokens the boundary compaction's summary injects (chars of the
//   summary divided by the shared chars-per-token estimate — the same estimate
//   the live widget + runtime fallback use, so the footprint is comparable
//   across arms + runs).
// - computeC3: tokens the agent GENERATED from compaction to done — the sum of
//   post-compaction assistant-message output tokens (per-entry generated tokens
//   live on each assistant message's usage.output).
// - computeC4: compaction tokens (in/out/cacheRead/cacheWrite) + dollars +
//   wall-clock summed across every compaction (see below).
//
// The post-compaction range is the entries STRICTLY AFTER the first (boundary)
// compaction in file order — the continuation-generated work. The boundary
// compaction's firstKeptEntryId points at a pre-compaction kept entry, so it is
// not the start of the generated-work range; summing from it would wrongly
// include pre-compaction output in the run cost.

import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { RunTrace } from "../orchestrate/trace.js";
import { estimateContentTokens } from "../runtime/streaming-tokens.js";
import { costDollars, type Pricing, type TokenCounts, usageTokens } from "./pricing.js";
import { phaseOneCompactionIndex, sumAssistantOutput } from "./trace-read.js";

/** The stage name for a native pi compaction (no per-stage details). */
const NATIVE_SUMMARY_STAGE = "native-summary";

/** One stage of an at-compaction arm's per-stage breakdown (name only for now). */
export interface StageUsage {
  readonly name: string;
}

/** Aggregated cost of the continuation compactions (a run may compact again). */
export interface Phase2CompactionCost {
  readonly count: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly dollars: number;
  readonly wallMs: number;
}

/** The full compaction-cost result (tokens + dollars + wall-clock + stages). */
export interface C4Result {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly dollars: number;
  readonly wallMs: number;
  readonly stages: StageUsage[];
  readonly phase2Compactions: Phase2CompactionCost;
}

/** A per-stage entry as emitted in CompactionEntry.details.compactionStages. */
type StageDetail = string | { readonly stage?: string; readonly name?: string; readonly stageName?: string };

/** Extract the stage name from one per-stage detail (defensive over its shape). */
function stageNameOf(detail: StageDetail): string {
  if (typeof detail === "string") return detail;
  return detail.stage ?? detail.name ?? detail.stageName ?? NATIVE_SUMMARY_STAGE;
}

/**
 * Read the boundary compaction's per-stage breakdown. At-compaction arms emit
 * `details.compactionStages` (a per-stage list); the native arm's pi compaction
 * has no such field (its details is { readFiles, modifiedFiles }), so it defaults
 * to a single native-summary stage.
 */
function readStages(details: unknown): StageUsage[] {
  if (details !== null && typeof details === "object") {
    const stages = (details as { compactionStages?: unknown }).compactionStages;
    if (Array.isArray(stages) && stages.length > 0) {
      return stages.map((stage) => ({ name: stageNameOf(stage as StageDetail) }));
    }
  }
  return [{ name: NATIVE_SUMMARY_STAGE }];
}

/** Sum a list of compactions' token quadruples (each usage field guarded to 0). */
function sumCompactionTokens(compactions: ReadonlyArray<{ readonly entry: CompactionEntry }>): TokenCounts {
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const captured of compactions) {
    const tokens = usageTokens(captured.entry.usage);
    tokensIn += tokens.tokensIn;
    tokensOut += tokens.tokensOut;
    cacheRead += tokens.cacheRead;
    cacheWrite += tokens.cacheWrite;
  }
  return { tokensIn, tokensOut, cacheRead, cacheWrite };
}

/** Sum the bench-captured wall-clock across a list of compactions. */
function sumWallMs(compactions: ReadonlyArray<{ readonly wallMs: number }>): number {
  let wallMs = 0;
  for (const captured of compactions) {
    wallMs += captured.wallMs;
  }
  return wallMs;
}

/**
 * Tokens the boundary compaction's summary injects — the summary's chars
 * divided by the shared chars-per-token estimate (ceiling). Pure + deterministic
 * over the summary string.
 */
export function computeC1(compactionEntry: CompactionEntry): number {
  return estimateContentTokens(compactionEntry.summary);
}

/**
 * Tokens generated from compaction to done — the sum of assistant-message
 * output tokens for entries after the boundary compaction. When the branch has
 * no compaction, the whole run's assistant output is summed (lenient fallback).
 */
export function computeC3(trace: RunTrace): number {
  const start = phaseOneCompactionIndex(trace.entries) + 1;
  return sumAssistantOutput(trace.entries.slice(start));
}

/** Zeroed continuation-compaction aggregate (when the run never re-compacted). */
const EMPTY_PHASE2: Phase2CompactionCost = {
  count: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  dollars: 0,
  wallMs: 0,
};

/**
 * Compaction cost summed across EVERY compaction in the trace: the token
 * quadruple (in/out/cacheRead/cacheWrite, each guarded to 0) summed over all
 * compactions' usage, priced into dollars, plus the bench-captured wall-clock
 * summed over all compactions. `stages` is the boundary (first) compaction's
 * per-stage breakdown (native-summary when absent); `phase2Compactions`
 * aggregates any continuation compactions separately. Pure + deterministic.
 */
export function computeC4(trace: RunTrace, pricing: Pricing): C4Result {
  const all = trace.compactions;
  const total = sumCompactionTokens(all);
  const phase2List = all.slice(1);
  const phase2Tokens = sumCompactionTokens(phase2List);
  const boundary = all[0];
  const stages = boundary === undefined ? [{ name: NATIVE_SUMMARY_STAGE }] : readStages(boundary.entry.details);
  const phase2Compactions: Phase2CompactionCost =
    phase2List.length === 0
      ? EMPTY_PHASE2
      : {
          count: phase2List.length,
          tokensIn: phase2Tokens.tokensIn,
          tokensOut: phase2Tokens.tokensOut,
          cacheRead: phase2Tokens.cacheRead,
          cacheWrite: phase2Tokens.cacheWrite,
          dollars: costDollars(phase2Tokens, pricing),
          wallMs: sumWallMs(phase2List),
        };

  return {
    tokensIn: total.tokensIn,
    tokensOut: total.tokensOut,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    dollars: costDollars(total, pricing),
    wallMs: sumWallMs(all),
    stages,
    phase2Compactions,
  };
}
