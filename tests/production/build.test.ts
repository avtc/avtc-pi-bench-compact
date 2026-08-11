// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { type BuildSeams, buildBackup, SurfaceConditionsError } from "../../src/production/build.js";

/** A manifest with all 4 condition types citing the given entry-ids (all in-span when < e4).
 *  Conditions use search-terms present in every backup entry's content (see writeBackup)
 *  so the cited-content-present check passes. Includes one probe per recallable condition. */
function manifestWith(rfId: string, doId: string, ssId: string, abId: string): ScenarioManifest {
  return {
    id: "t",
    description: "d",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
    recallFacts: [
      { id: "rf1", fact: "decision", accept: ["decision"], entryIds: [rfId], domain: "technical", lanes: [] },
    ],
    doneOps: [{ id: "do1", description: "work", artifact: "work", reworkable: false, entryIds: [doId], lanes: [] }],
    supersessions: [{ id: "ss1", subject: "mind", oldValue: "a", latestValue: "b", entryIds: [ssId], lanes: [] }],
    abstentions: [{ id: "ab1", question: "question", correctRefusal: true, entryIds: [abId], lanes: [] }],
    taskObjective: { description: "b", testSpec: "npm test", lane: "embedded-test" },
    probes: [
      { question: "what decision?", accept: ["decision"], targets: [rfId], lanes: [] },
      { question: "current value?", accept: ["b"], targets: [ssId], lanes: [] },
      { question: "answer?", correctRefusal: true, targets: [abId], lanes: [] },
    ],
  };
}

/** Write a backup JSONL with entries e1..eN; return path + entries.
 *  Each entry's content contains all condition search-terms (decision/work/mind/question/a/b)
 *  so the cited-content-present check passes for any citation. */
function writeBackup(dir: string, n: number): { path: string; entries: { id: string }[] } {
  const path = join(dir, `backup-${n}.jsonl`);
  const entries = [{ id: "s1" }, ...Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}` }))];
  writeFileSync(
    path,
    entries
      .map((e) =>
        JSON.stringify(
          e.id === "s1"
            ? { id: "s1", type: "session", timestamp: "t0", cwd: "/repo" }
            : {
                id: e.id,
                type: "message",
                parentId: null,
                timestamp: "t",
                message: { role: "user", content: "decision work mind question a b" },
              },
        ),
      )
      .join("\n"),
  );
  return { path, entries: entries.slice(1) }; // exclude header from entryOrder
}

describe("buildBackup", () => {
  it("proceeds when all conditions land in-span → returns the authored manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup = writeBackup(dir, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath: backup.path, backupEntries: backup.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" };
        },
        async author() {
          return manifestWith("e1", "e2", "e3", "e3"); // all < e4 → landed
        },
      };
      const result = await buildBackup({
        scenario: "tycoon",
        compactionBoundary: 140000,
        preSliceDir: dir,
        seams,
      });
      expect(result.manifest.recallFacts[0].id).toBe("rf1");
      expect(result.backupPath).toBe(backup.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues on a tail condition, re-drives, and proceeds when it slides in-span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup5 = writeBackup(dir, 5); // recallFact cites e5 (tail) on attempt 0
      const backup6 = writeBackup(dir, 6); // after continue, e5 < e4? no — e4 still cut. Use e6 session.
      let attempt = 0;
      const seams: BuildSeams = {
        async driveAndCapture() {
          return attempt === 0
            ? { backupPath: backup5.path, backupEntries: backup5.entries }
            : { backupPath: backup6.path, backupEntries: backup6.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" };
        },
        async author() {
          // attempt 0: rf cites e5 (tail, >= e4). attempt 1: rf cites e3 (landed).
          return attempt++ === 0 ? manifestWith("e5", "e2", "e3", "e3") : manifestWith("e3", "e2", "e3", "e3");
        },
      };
      const result = await buildBackup({
        scenario: "tycoon",
        compactionBoundary: 140000,
        preSliceDir: dir,
        seams,
      });
      expect(result.manifest.recallFacts[0].entryIds).toEqual(["e3"]); // the landed (2nd-attempt) manifest
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws SurfaceConditionsError when an essential topic never materializes (missing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup = writeBackup(dir, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath: backup.path, backupEntries: backup.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          // recallFacts empty → key-decision (essential) missing → surface (no skip)
          return { ...manifestWith("e1", "e2", "e3", "e3"), recallFacts: [] };
        },
      };
      await expect(
        buildBackup({ scenario: "tycoon", compactionBoundary: 140000, preSliceDir: dir, seams }),
      ).rejects.toBeInstanceOf(SurfaceConditionsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds the continue loop (maxAttempts) + throws if it never converges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup = writeBackup(dir, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath: backup.path, backupEntries: backup.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          return manifestWith("e5", "e2", "e3", "e3"); // always tail → never converges
        },
      };
      await expect(
        buildBackup({
          scenario: "tycoon",
          compactionBoundary: 140000,
          preSliceDir: dir,
          seams,
          maxAttempts: 3,
        }),
      ).rejects.toThrow(/converge|landing/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the final manifest fails structural validation (no probes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup = writeBackup(dir, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath: backup.path, backupEntries: backup.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          // all topics land (proceed) but NO probes → validateManifest fails
          return { ...manifestWith("e1", "e2", "e3", "e3"), probes: [] };
        },
      };
      await expect(
        buildBackup({ scenario: "tycoon", compactionBoundary: 140000, preSliceDir: dir, seams }),
      ).rejects.toThrow(/validation|probe/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-continues when a missing topic's content is detected in the kept tail (findTailContent seam)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-build-"));
    try {
      const backup = writeBackup(dir, 5);
      let attempt = 0;
      let tailCalls = 0;
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath: backup.path, backupEntries: backup.entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          // attempt 0: recallFacts missing (key-decision). attempt 1: all present.
          return attempt++ === 0
            ? { ...manifestWith("e1", "e2", "e3", "e3"), recallFacts: [] }
            : manifestWith("e1", "e2", "e3", "e3");
        },
        async findTailContent() {
          // attempt 0: key-decision content IS in the tail → tail (not missing) → continue.
          // attempt 1: empty (it landed in the span now).
          return ++tailCalls === 1 ? new Set(["key-decision"]) : new Set<string>();
        },
      };
      const result = await buildBackup({
        scenario: "tycoon",
        compactionBoundary: 140000,
        preSliceDir: dir,
        seams,
      });
      expect(result.manifest.recallFacts.length).toBe(1); // proceeded on 2nd attempt
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
