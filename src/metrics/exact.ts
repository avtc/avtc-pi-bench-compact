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
/** The stage name for a present-but-nameless per-stage detail (distinct from native). */
const UNNAMED_STAGE = "unnamed-stage";

/** One Phase-2 (continuation) compaction's cost — lossless per-compaction (Task 19
 * aggregates). `[]` when the run never re-compacted. */
export interface Phase2CompactionEntry {
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
  readonly stages: string[];
  readonly phase2Compactions: Phase2CompactionEntry[];
}

/** A per-stage entry as emitted in CompactionEntry.details.compactionStages. */
type StageDetail = string | { readonly stage?: string; readonly name?: string; readonly stageName?: string };

/** Extract the stage name from one per-stage detail (defensive over its shape).
 * A present-but-nameless stage object → "unnamed-stage" (NOT native-summary, to avoid
 * conflating a malformed non-native stage with the native arm). */
function stageNameOf(detail: StageDetail): string {
  if (typeof detail === "string") return detail;
  return detail.stage ?? detail.name ?? detail.stageName ?? UNNAMED_STAGE;
}

/**
 * Read the boundary compaction's per-stage breakdown (a list of stage names).
 * At-compaction arms emit `details.compactionStages` (a per-stage list); the native
 * arm's pi compaction has no such field (its details is { readFiles, modifiedFiles }),
 * so it defaults to a single native-summary stage.
 */
function readStages(details: unknown): string[] {
  if (details !== null && typeof details === "object") {
    const stages = (details as { compactionStages?: unknown }).compactionStages;
    if (Array.isArray(stages) && stages.length > 0) {
      return stages.map((stage) => stageNameOf(stage as StageDetail));
    }
  }
  return [NATIVE_SUMMARY_STAGE];
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

/** Zeroed continuation-compaction list (when the run never re-compacted). */
const NO_PHASE2: readonly Phase2CompactionEntry[] = Object.freeze([]);

/** One continuation compaction's per-compaction cost (tokens + dollars + bench wallMs). */
function phase2Entry(
  captured: { readonly entry: CompactionEntry; readonly wallMs: number },
  pricing: Pricing,
): Phase2CompactionEntry {
  const tokens = usageTokens(captured.entry.usage);
  return {
    tokensIn: tokens.tokensIn,
    tokensOut: tokens.tokensOut,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    dollars: costDollars(tokens, pricing),
    wallMs: captured.wallMs,
  };
}

/**
 * Compaction cost summed across EVERY compaction in the trace: the token
 * quadruple (in/out/cacheRead/cacheWrite, each guarded to 0) summed over all
 * compactions' usage, priced into dollars, plus the bench-captured wall-clock
 * summed over all compactions. `stages` is the boundary (first) compaction's
 * per-stage names (native-summary when absent); `phase2Compactions` is the
 * lossless per-compaction list of any continuation compactions ([] when none).
 * Pure + deterministic.
 */
export function computeC4(trace: RunTrace, pricing: Pricing): C4Result {
  const all = trace.compactions;
  const total = sumCompactionTokens(all);
  const phase2List = all.slice(1);
  const boundary = all[0];
  const stages = boundary === undefined ? [NATIVE_SUMMARY_STAGE] : readStages(boundary.entry.details);
  const phase2Compactions: Phase2CompactionEntry[] =
    phase2List.length === 0 ? [...NO_PHASE2] : phase2List.map((captured) => phase2Entry(captured, pricing));

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
