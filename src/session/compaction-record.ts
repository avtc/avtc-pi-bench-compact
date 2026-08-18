// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Read an arm session file's compaction record — the latent stage's inputs (the
// summary to check absence against + the tail anchor). The LAST compaction entry
// in the file is the effective one (a re-compacted arm appends a new record).

import { readFileSync } from "node:fs";

export interface ArmCompaction {
  readonly summary: string;
  readonly firstKeptEntryId: string;
}

/** The last `compaction` entry of a session file, or null (never compacted). */
export function readArmCompaction(sessionPath: string): ArmCompaction | null {
  let last: ArmCompaction | null = null;
  for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: { type?: string; summary?: string; firstKeptEntryId?: string };
    try {
      entry = JSON.parse(line) as { type?: string; summary?: string; firstKeptEntryId?: string };
    } catch {
      continue; // tolerate a torn trailing line
    }
    if (
      entry.type === "compaction" &&
      typeof entry.summary === "string" &&
      typeof entry.firstKeptEntryId === "string"
    ) {
      last = { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId };
    }
  }
  return last;
}
