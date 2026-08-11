// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pre-slice the compacted-away span (all entries before `firstKeptEntryId`) into a
// standalone JSONL for the manifest-authoring agent (§4.18 pre-sliced input). This
// STRUCTURALLY guarantees every entry-id the author cites is in-span, so validation
// (Task 9) only needs the cited-content-present check — no boundary logic in the
// authoring prompt.
//
// The session header (type:"session") is excluded — the slice is a span of
// conversation entries, not a loadable session. Shared by build.ts (first pass) +
// the condition-landing re-slice loop.

import { readFileSync, writeFileSync } from "node:fs";

/** A minimal session-entry shape (enough to read id + type per JSONL line). */
interface EntryLike {
  readonly type: string;
  readonly id: string;
}

/** Result of {@link preSlice}. */
export interface PreSliceResult {
  /** The standalone JSONL containing the compacted-away span. */
  readonly jsonlPath: string;
  /** entry-ids in the span (the validation context's `preSlicedEntryIds`). */
  readonly entryIds: readonly string[];
  /** entry-id → its raw JSON line (for the cited-content-present substring check in
   *  validateManifest — the raw line contains the entry's content text). */
  readonly entryTextById: ReadonlyMap<string, string>;
}

/**
 * Slice all entries before `firstKeptEntryId` (exclusive) into `outputPath`.
 *
 * @param backupPath  the captured pre-compaction session JSONL (un-compacted).
 * @param firstKeptEntryId  the cut point (CompactionEntry.firstKeptEntryId) — the
 *   first entry KEPT; everything before it is compacted-away.
 * @param outputPath  where to write the standalone span JSONL.
 * @throws when `firstKeptEntryId` is not present in the backup.
 */
export function preSlice(backupPath: string, firstKeptEntryId: string, outputPath: string): PreSliceResult {
  const lines = readFileSync(backupPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const cutIndex = lines.findIndex((line) => {
    const entry = JSON.parse(line) as EntryLike;
    return entry.id === firstKeptEntryId;
  });
  if (cutIndex === -1) {
    throw new Error(`firstKeptEntryId "${firstKeptEntryId}" not found in backup ${backupPath}`);
  }

  // Everything strictly before the cut is the compacted-away span; the header
  // (type:"session") is naturally excluded since it precedes the first real entry,
  // but defend against a header sitting among sliced entries too.
  const spanLines = lines.slice(0, cutIndex).filter((line) => {
    const entry = JSON.parse(line) as EntryLike;
    return entry.type !== "session";
  });
  const entryIds = spanLines.map((line) => (JSON.parse(line) as EntryLike).id);
  const entryTextById = new Map<string, string>();
  for (const line of spanLines) {
    const entry = JSON.parse(line) as EntryLike;
    entryTextById.set(entry.id, line);
  }

  writeFileSync(outputPath, spanLines.join("\n"));
  return { jsonlPath: outputPath, entryIds, entryTextById };
}
