// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  type CompactionEntryLike,
  findFirstKeptEntryId,
  runTrialCompaction,
  type TrialCompactionSeam,
} from "../../src/production/trial-compaction.js";

const canned: CompactionEntryLike = {
  type: "compaction",
  firstKeptEntryId: "e42",
  summary: "the agent built a game loop and chose JSON storage",
};

describe("findFirstKeptEntryId (pure reader)", () => {
  it("extracts the cut point + summary from a CompactionEntry", () => {
    expect(findFirstKeptEntryId(canned)).toEqual({
      firstKeptEntryId: "e42",
      summary: "the agent built a game loop and chose JSON storage",
    });
  });
});

describe("runTrialCompaction", () => {
  it("calls the seam to compact a copy + returns the cut point, summary, and entry", async () => {
    let calledWith: string | null = null;
    const seam: TrialCompactionSeam = {
      async compactCopy(backupPath: string) {
        calledWith = backupPath;
        return canned;
      },
    };
    const result = await runTrialCompaction(seam, "/tmp/backup.jsonl");
    expect(calledWith).toBe("/tmp/backup.jsonl");
    expect(result.firstKeptEntryId).toBe("e42");
    expect(result.summary).toBe("the agent built a game loop and chose JSON storage");
    expect(result.compactionEntry).toBe(canned);
  });

  it("propagates seam failures (a thrown compact surfaces, not swallowed)", async () => {
    const seam: TrialCompactionSeam = {
      async compactCopy() {
        throw new Error("compaction failed");
      },
    };
    await expect(runTrialCompaction(seam, "/tmp/x.jsonl")).rejects.toThrow(/compaction failed/);
  });
});
