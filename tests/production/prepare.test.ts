// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { BuildSeams } from "../../src/production/build.js";
import { prepareScenario } from "../../src/production/prepare.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const scenarioCtx = {
  id: "t",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
};

/** Every backup entry's content contains all condition search-terms so the cited-content-present
 *  check passes. Terms: decision / work / mind / question / a / b. */
const ENTRY_CONTENT = "decision work mind question a b";

/** A valid manifest (all 4 conditions + 3 probes) citing the given entry-ids. */
function cannedManifest(rfId: string, doId: string, ssId: string, abId: string): ScenarioManifest {
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

/** Write a session JSONL (header + entries e1..eN, each with ENTRY_CONTENT). */
function writeSession(path: string, cwd: string, n: number): void {
  const lines = [
    JSON.stringify({ type: "session", id: "s1", timestamp: "t0", cwd }),
    ...Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        type: "message",
        id: `e${i + 1}`,
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: ENTRY_CONTENT },
      }),
    ),
  ];
  writeFileSync(path, lines.join("\n"));
}

function setup(): { root: string; repo: string; manifestPath: string; preSliceDir: string } {
  const root = mkdtempSync(join(tmpdir(), "bench-prepare-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const preSliceDir = join(root, "sliced");
  mkdirSync(preSliceDir, { recursive: true });
  return { root, repo, manifestPath, preSliceDir };
}

describe("prepareScenario — build mode", () => {
  it("drives build → freeze: main holds session.jsonl + files, manifest outside repo", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      const backupPath = join(root, "built.jsonl");
      writeSession(backupPath, repo, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          const entries = Array.from({ length: 5 }, (_, i) => ({ id: `e${i + 1}` }));
          return { backupPath, backupEntries: entries };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" }; // e1,e2,e3 in-span
        },
        async author() {
          return cannedManifest("e1", "e2", "e3", "e3"); // all in-span → landed
        },
      };
      const result = await prepareScenario({
        scenario: "tycoon",
        compactionBoundary: 140000,
        repoPath: repo,
        manifestPath,
        preSliceDir,
        scenarioCtx,
        seams,
      });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).toContain("session.jsonl");
      expect(files).not.toContain("manifest.json");
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).recallFacts[0].id).toBe("rf1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — extract mode", () => {
  it("extracts + copies codebase → trial → author → validate → freeze", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      const codebase = join(root, "codebase");
      mkdirSync(codebase, { recursive: true });
      writeFileSync(join(codebase, "main.ts"), "export const x = 1;");
      const sessionPath = join(root, "real.jsonl");
      writeSession(sessionPath, codebase, 5); // header cwd = codebase (coherent)
      const extractOutput = join(root, "cleaned.jsonl");
      let copied = false;
      const seams: BuildSeams = {
        async driveAndCapture() {
          throw new Error("driveAndCapture should not be called in extract mode");
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" };
        },
        async author() {
          return cannedManifest("e1", "e2", "e3", "e3");
        },
      };
      const result = await prepareScenario({
        fromSessionPath: sessionPath,
        extractOutputPath: extractOutput,
        extractCwd: codebase,
        compactionBoundary: 140000,
        repoPath: repo,
        manifestPath,
        preSliceDir,
        scenarioCtx,
        seams,
        copyProjectFiles: (src, dest) => {
          copied = true;
          expect(src).toBe(codebase);
          expect(dest).toBe(repo);
          writeFileSync(join(dest, "main.ts"), "export const x = 1;"); // simulate copy
        },
      });
      expect(copied).toBe(true); // codebase copied into repo
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).toContain("session.jsonl");
      expect(files).toContain("main.ts"); // project file committed (V2/R1-2 fix)
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).id).toBe("t");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — contamination guards (R1-3)", () => {
  it("rejects preSliceDir inside the repo (agent could peek at the sliced ground truth)", async () => {
    const { root, repo, manifestPath } = setup();
    try {
      const preSliceInsideRepo = join(repo, "sliced"); // INSIDE repo — contamination
      await expect(
        prepareScenario({
          scenario: "tycoon",
          compactionBoundary: 140000,
          repoPath: repo,
          manifestPath,
          preSliceDir: preSliceInsideRepo,
          scenarioCtx,
          seams: {} as BuildSeams,
        }),
      ).rejects.toThrow(/contamination|inside/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects extractOutputPath inside the repo", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      const extractInsideRepo = join(repo, "cleaned.jsonl"); // INSIDE repo
      await expect(
        prepareScenario({
          fromSessionPath: join(root, "real.jsonl"),
          extractOutputPath: extractInsideRepo,
          extractCwd: root,
          compactionBoundary: 140000,
          repoPath: repo,
          manifestPath,
          preSliceDir,
          scenarioCtx,
          seams: {} as BuildSeams,
        }),
      ).rejects.toThrow(/contamination|inside/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
