// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Recall-cost metric: the tokens the agent spent recovering forgotten info,
// bounded by the judge-identified first-correct-use entry. The judge (a separate
// producer) identifies the first post-compaction entry where the agent correctly
// uses a planted recall fact; this sums the generated output tokens from the
// post-compaction boundary up to and including that entry. When the agent never
// recovers (no boundary), the whole post-compaction output is summed and the
// not-recovered flag is set (the statistics layer rolls these into a
// not-recovered rate across runs).
//
// Per-entry generated tokens live on each assistant message's usage.output (the
// same source the run-cost metric uses). The post-compaction range is the
// entries after the first (boundary) compaction.

import type { RunTrace } from "../orchestrate/trace.js";
import { phaseOneCompactionIndex, sumAssistantOutput } from "./trace-read.js";

/** One run's recall-cost: the token sum + whether recovery ever happened. */
export interface C2Result {
  readonly tokens: number;
  readonly notRecovered: boolean;
}

/**
 * Sum the generated output tokens from the post-compaction boundary up to the
 * judge-identified first-correct-use entry (inclusive — the agent had to
 * generate through that turn to demonstrate correct use). When
 * `firstCorrectUseEntryId` is null the agent never recovered: `notRecovered` is
 * set and the full post-compaction output is summed. A provided-but-unknown
 * boundary id falls back to the full post-compaction sum (lenient — recovery
 * happened, the exact entry just could not be located). Pure + deterministic.
 */
export function computeC2(trace: RunTrace, firstCorrectUseEntryId: string | null): C2Result {
  const start = phaseOneCompactionIndex(trace.entries) + 1;
  const postCompaction = trace.entries.slice(start);
  const fullSum = () => sumAssistantOutput(postCompaction);

  if (firstCorrectUseEntryId === null) {
    return { tokens: fullSum(), notRecovered: true };
  }

  const boundaryIndex = postCompaction.findIndex((entry) => entry.id === firstCorrectUseEntryId);
  if (boundaryIndex === -1) {
    return { tokens: fullSum(), notRecovered: false };
  }
  return { tokens: sumAssistantOutput(postCompaction.slice(0, boundaryIndex + 1)), notRecovered: false };
}
