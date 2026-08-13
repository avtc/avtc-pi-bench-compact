// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared post-compaction primitives for the run-cost + recall-cost metrics. The live
// orchestration path consumes the already-captured RunTrace (orchestrate/trace.ts);
// the helpers here operate on its entry list: per-entry generated tokens live on each
// assistant message's `usage.output` (user messages carry none; tool-result usage is
// explicitly not part of main context accounting), and the post-compaction range is
// the entries AFTER the first (boundary) compaction — the continuation-generated work.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageEndUsage } from "../runtime/streaming-tokens.js";

/**
 * Index of the first (boundary) compaction entry in file order — the initial
 * compaction that marks where the continuation run begins. -1 when the branch
 * never compacted (the post-compaction range then falls back to the whole run).
 */
export function phaseOneCompactionIndex(entries: readonly SessionEntry[]): number {
  return entries.findIndex((entry) => entry.type === "compaction");
}

/**
 * The entries strictly after the first (boundary) compaction — the continuation's
 * own generated work (NOT from `firstKeptEntryId`, which points at a pre-compaction kept
 * entry). Single source of truth for the post-compaction range used by the run-cost,
 * recall-cost, and trajectory metrics. Falls back to the whole run when there is no compaction.
 */
export function postCompactionEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.slice(phaseOneCompactionIndex(entries) + 1);
}

/** Read `usage.output` off a message entry's assistant message, or 0 otherwise. */
function assistantOutput(entry: SessionEntry): number {
  if (entry.type !== "message") return 0;
  const message = entry.message;
  if (!("role" in message) || message.role !== "assistant") return 0;
  return messageEndUsage(message)?.output ?? 0;
}

/**
 * Sum the generated output tokens across a slice of session entries — only
 * assistant messages contribute (their `usage.output` is the tokens the agent
 * generated for that turn). User messages, compactions, and tool results are
 * skipped; tool-result usage is intentionally excluded (not main-context cost).
 */
export function sumAssistantOutput(entries: readonly SessionEntry[]): number {
  let sum = 0;
  for (const entry of entries) {
    sum += assistantOutput(entry);
  }
  return sum;
}
