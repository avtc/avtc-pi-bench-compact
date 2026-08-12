// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Metrics-layer re-read of a scenario repo's session transcript.
//
// The live orchestration path consumes the already-captured RunTrace
// (orchestrate/trace.ts); this module is the re-computation / reporting reader
// that turns the raw `session.jsonl` back into entries + isolated compaction
// entries. It reuses the SINGLE parse path (`readSessionEntries`) so the
// metrics layer never duplicates the parse predicate or header filter.
//
// `sumAssistantOutput` + `phaseOneCompactionIndex` are the shared post-
// compaction primitives for the run-cost and recall-cost metrics: per-entry
// generated tokens live on each assistant message's `usage.output` (user
// messages carry none; tool-result usage is explicitly not part of main context
// accounting), and the post-compaction range is the entries AFTER the first
// (boundary) compaction — the continuation-generated work.

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readSessionEntries } from "../orchestrate/trace.js";
import { messageEndUsage } from "../runtime/streaming-tokens.js";

/** Result of re-reading a repo's transcript: all entries + the compactions isolated. */
export interface TraceRead {
  readonly entries: SessionEntry[];
  readonly compactionEntries: CompactionEntry[];
}

/**
 * Re-read a scenario repo's `session.jsonl` into real session entries + the
 * compaction entries isolated. Thin wrapper over `readSessionEntries` (the
 * shared parse path) — the metrics layer reports off this without re-parsing.
 */
export function readTraceFromRepo(repo: string): TraceRead {
  const entries = readSessionEntries(repo);
  const compactionEntries = entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
  return { entries, compactionEntries };
}

/**
 * Index of the first (boundary) compaction entry in file order — the initial
 * compaction that marks where the continuation run begins. -1 when the branch
 * never compacted (the post-compaction range then falls back to the whole run).
 */
export function phaseOneCompactionIndex(entries: readonly SessionEntry[]): number {
  return entries.findIndex((entry) => entry.type === "compaction");
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
