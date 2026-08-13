// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Trial compaction: find where the native cut lands on a COPY of the backup (no
// memory extension — bare-pi-style), so the manifest-authoring agent gets the exact
// compacted-away span it will be tested on. The copy is NOT the real backup — the
// real backup stays un-compacted (the bench performs the first compaction per arm).
//
// The live compaction (switchSession-load the copy → ctx.compact() → read the
// CompactionEntry) is an injectable seam; the real wiring is `buildTrialCompactSeam`
// (src/production/live-seams.ts). The pure reader is unit-tested here.

/** Minimal CompactionEntry shape (what trial compaction reads). */
export interface CompactionEntryLike {
  readonly type: "compaction";
  readonly firstKeptEntryId: string;
  readonly summary: string;
}

/** Result of reading the cut point from a trial CompactionEntry. */
export interface TrialCut {
  readonly firstKeptEntryId: string;
  readonly summary: string;
}

/** Injectable seam: compact a COPY of `backupPath` (native, no memory ext) + return
 *  the resulting CompactionEntry. The real impl (`buildTrialCompactSeam` in
 *  src/production/live-seams.ts) loads the copy via `switchSession`, calls
 *  `ctx.compact()`, reads the new CompactionEntry. */
export interface TrialCompactionSeam {
  compactCopy(backupPath: string): Promise<CompactionEntryLike>;
}

/** Pure reader: extract the cut point + summary from a CompactionEntry. */
export function findFirstKeptEntryId(entry: CompactionEntryLike): TrialCut {
  return { firstKeptEntryId: entry.firstKeptEntryId, summary: entry.summary };
}

/** Run a trial compaction on a copy of the backup via `seam`, returning the cut
 *  point + summary + the full entry. Seam failures propagate (caller stop-and-surfaces). */
export async function runTrialCompaction(
  seam: TrialCompactionSeam,
  backupPath: string,
): Promise<TrialCut & { compactionEntry: CompactionEntryLike }> {
  const compactionEntry = await seam.compactCopy(backupPath);
  return { ...findFirstKeptEntryId(compactionEntry), compactionEntry };
}
