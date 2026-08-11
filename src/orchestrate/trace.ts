// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Trace capture — read a continuation attempt's `session.jsonl` into a structured
// trace (the run's entries + every compaction with its bench-measured wall time).
// The trace is the ground truth consumed by Phase-3 scoring: the `CompactionEntry`s
// (summary + firstKeptEntryId + usage) record what the agent saw + the compaction
// cost, and the entries after record behavior.
//
// `wallMs` is bench-timed (the JSONL has no duration field): the orchestration
// measures each Phase-2 compaction's wall time via the `session_before_compact` →
// `session_compact` event pair (keyed by the compaction entry id) and passes the
// map in here. A compaction with no bench-captured wall time pairs with 0 (the map
// may not cover a pre-existing/native compaction).
//
// Pure file read: reads the scenario repo's working-tree `session.jsonl` (which the
// orchestration has checked out to `branch` + committed). `branch` is metadata
// (which attempt this trace belongs to) — the READ is the working-tree file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompactionEntry, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** The scenario repo's session transcript filename (tracked per branch). */
const SESSION_FILE = "session.jsonl";

/** One Phase-2 compaction: the persisted entry + its bench-measured wall time. */
export interface CapturedCompaction {
  /** The persisted CompactionEntry (summary, firstKeptEntryId, tokensBefore, usage). */
  readonly entry: CompactionEntry;
  /** Wall-clock ms of the before-compact → after-compact event pair (0 if uncaptured). */
  readonly wallMs: number;
}

/** A continuation attempt's structured trace — Phase-3 scoring's ground truth. */
export interface RunTrace {
  /** The arm this trace belongs to (set by the orchestration; absent on a raw capture). */
  readonly arm?: string;
  /** The 1-based attempt index (set by the orchestration; absent on a raw capture). */
  readonly attempt?: number;
  /** The branch this trace was captured from. */
  readonly branch: string;
  /** Every SessionEntry in the branch's transcript (messages + custom + compactions), file order. */
  readonly entries: readonly SessionEntry[];
  /** Every CompactionEntry in the transcript, each paired with its bench wall time. */
  readonly compactions: readonly CapturedCompaction[];
  /** Absolute path to the read session.jsonl. */
  readonly tracePath: string;
}

/** The fallback wall time when the bench captured none for a compaction. */
const UNCAPTURED_WALL_MS = 0;

/** True for a parsed file entry that is a real session entry (not the file header). */
function isSessionEntry(entry: { type: string }): entry is SessionEntry {
  return entry.type !== "session";
}

/**
 * Read `branch`'s `session.jsonl` from the scenario repo working tree + return the
 * structured trace: all entries + every compaction paired with its bench-measured
 * `wallMs` (keyed by compaction entry id in `perCompactionWallMs`; 0 when absent).
 *
 * @param repo — the scenario repo working dir (checked out to `branch`).
 * @param branch — the branch this trace belongs to (metadata only).
 * @param perCompactionWallMs — bench-captured wall time per compaction entry id.
 */
export function captureTrace(repo: string, branch: string, perCompactionWallMs: Map<string, number>): RunTrace {
  const tracePath = join(repo, SESSION_FILE);
  const content = readFileSync(tracePath, "utf8");
  const parsed = parseSessionEntries(content);
  const entries = parsed.filter(isSessionEntry);
  const compactions: CapturedCompaction[] = [];
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;
    const compaction = entry as CompactionEntry;
    compactions.push({
      entry: compaction,
      wallMs: perCompactionWallMs.get(compaction.id) ?? UNCAPTURED_WALL_MS,
    });
  }
  return { branch, entries, compactions, tracePath };
}
