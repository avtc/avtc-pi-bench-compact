// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Result of reading the native compaction cut point off a trial CompactionEntry.
// `buildTrialCompactSeam` (src/production/live-seams.ts) runs the live compaction on a
// COPY of the backup (bare-pi-style, no memory extension) + reads the new CompactionEntry's
// `firstKeptEntryId` + `summary` directly into this shape.

/** Result of reading the cut point from a trial CompactionEntry. */
export interface TrialCut {
  readonly firstKeptEntryId: string;
  readonly summary: string;
}
