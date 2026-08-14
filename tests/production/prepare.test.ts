// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { BuildSeams } from "../../src/production/build.js";
import { type LandingState, readLandingState } from "../../src/production/landing-state.js";
import { prepareScenario } from "../../src/production/prepare.js";
import { branchSessionFile } from "../../src/storage/paths.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

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

function setup(): { root: string; repo: string; sessionsDir: string; manifestPath: string; preSliceDir: string } {
  const root = mkdtempSync(join(tmpdir(), "bench-prepare-"));
  const repo = join(root, "repo");
  const sessionsDir = join(root, "sessions");
  mkdirSync(repo, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const preSliceDir = join(root, "sliced");
  mkdirSync(preSliceDir, { recursive: true });
  return { root, repo, sessionsDir, manifestPath, preSliceDir };
}

describe("prepareScenario — build mode", () => {
  it("drives build → freeze: main holds ONLY project files, session in sessions store, manifest outside repo", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
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
        sessionsDir,
        manifestPath,
        preSliceDir,
        seams,
      });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).not.toContain("session.jsonl"); // session lives OUTSIDE the repo
      expect(files).not.toContain("manifest.json");
      // the frozen session is at main's session file in the sessions store
      expect(JSON.parse(readFileSync(branchSessionFile(sessionsDir, "main"), "utf8").trim().split("\n")[0]).type).toBe(
        "session",
      );
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).recallFacts[0].id).toBe("rf1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — extract mode", () => {
  it("extracts + copies codebase → trial → author → validate → freeze", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
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
        sessionsDir,
        manifestPath,
        preSliceDir,
        seams,
        copyProjectFiles: (src, dest): string[] => {
          copied = true;
          expect(src).toBe(codebase);
          expect(dest).toBe(repo);
          writeFileSync(join(dest, "main.ts"), "export const x = 1;"); // simulate copy
          return [];
        },
      });
      expect(copied).toBe(true); // codebase copied into repo
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).not.toContain("session.jsonl"); // session lives OUTSIDE the repo
      expect(files).toContain("main.ts"); // project file committed (V2/R1-2 fix)
      expect(JSON.parse(readFileSync(branchSessionFile(sessionsDir, "main"), "utf8").trim().split("\n")[0]).cwd).toBe(
        repo,
      );
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).id).toBe("t");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the extract-authored manifest fails validation (no probes)", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      const codebase = join(root, "codebase");
      mkdirSync(codebase, { recursive: true });
      const sessionPath = join(root, "real.jsonl");
      writeSession(sessionPath, codebase, 5);
      const seams: BuildSeams = {
        async driveAndCapture() {
          throw new Error("no drive in extract");
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          return { ...cannedManifest("e1", "e2", "e3", "e3"), probes: [] }; // invalid — no probes
        },
      };
      await expect(
        prepareScenario({
          fromSessionPath: sessionPath,
          extractOutputPath: join(root, "cleaned.jsonl"),
          extractCwd: codebase,
          compactionBoundary: 140000,
          repoPath: repo,
          sessionsDir: join(root, "sessions"),
          manifestPath,
          preSliceDir,
          seams,
          copyProjectFiles: (): string[] => [],
        }),
      ).rejects.toThrow(/validation|probe/i);
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
          sessionsDir: join(root, "sessions"),
          manifestPath,
          preSliceDir: preSliceInsideRepo,
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
          sessionsDir: join(root, "sessions"),
          manifestPath,
          preSliceDir,
          seams: {} as BuildSeams,
        }),
      ).rejects.toThrow(/contamination|inside/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — build-mode surface persistence (landing.json)", () => {
  it("on SurfaceConditionsError: writes the recovery state next to the manifest, then re-throws", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
    try {
      const backupPath = join(root, "built.jsonl");
      writeSession(backupPath, repo, 5);
      // Author leaves supersessions+abstentions EMPTY (both safeToSkip → skipOffered).
      const partial = cannedManifest("e1", "e2", "e3", "e3");
      const manifest = { ...partial, supersessions: [], abstentions: [], probes: partial.probes.slice(0, 1) };
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath, backupEntries: Array.from({ length: 5 }, (_, i) => ({ id: `e${i + 1}` })) };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          return manifest;
        },
      };
      await expect(
        prepareScenario({
          scenario: "build a tycoon game",
          compactionBoundary: 140000,
          repoPath: repo,
          sessionsDir,
          manifestPath,
          preSliceDir,
          seams,
        }),
      ).rejects.toThrow(/surfacing required/);
      const state = readLandingState(join(root, "landing.json"));
      expect(state.missingTopics.map((t) => t.id).sort()).toEqual(["change-mind", "open-question"]);
      expect(state.skipOffered).toBe(true);
      expect(state.buildSessionPath).toBe(join(preSliceDir, "build.jsonl"));
      expect(state.firstKeptEntryId).toBe("e4");
      expect(state.attempt).toBe(0);
      expect(state.scenario).toBe("build a tycoon game");
      expect(state.manifest.supersessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — plant resume (buildBackup resume threading)", () => {
  it("passes resume into buildBackup (attempt + plant instruction)", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
    try {
      const backupPath = join(root, "built.jsonl");
      writeSession(backupPath, repo, 5);
      const attempts: number[] = [];
      const seams: BuildSeams = {
        async driveAndCapture(attempt) {
          attempts.push(attempt);
          return { backupPath, backupEntries: Array.from({ length: 5 }, (_, i) => ({ id: `e${i + 1}` })) };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut" };
        },
        async author() {
          return cannedManifest("e1", "e2", "e3", "e3");
        },
      };
      const result = await prepareScenario({
        scenario: "build a tycoon game",
        resume: { attempt: 2, plantInstruction: "Bring up the changed-mind topic now." },
        compactionBoundary: 140000,
        repoPath: repo,
        sessionsDir,
        manifestPath,
        preSliceDir,
        seams,
      });
      expect(attempts).toEqual([2]);
      expect(result.manifestPath).toBe(manifestPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — skip recovery (--skip-topics --from)", () => {
  const makeState = (buildSessionPath: string): LandingState => ({
    missingTopics: [
      { id: "change-mind", label: "Changed mind", tag: "safeToSkip" },
      { id: "open-question", label: "Open question", tag: "safeToSkip" },
    ],
    skipOffered: true,
    buildSessionPath,
    firstKeptEntryId: "e4",
    attempt: 1,
    scenario: "build a tycoon game",
    // supersessions + abstentions empty (that's why they are missing); recallFacts+doneOps authored in-span.
    manifest: (() => {
      const m = cannedManifest("e1", "e2", "e3", "e3");
      return { ...m, supersessions: [], abstentions: [], probes: m.probes.slice(0, 1) };
    })(),
  });

  it("drops the requested safeToSkip topics → re-validates → freezes (no re-build)", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
    try {
      const buildSession = join(preSliceDir, "build.jsonl");
      writeSession(buildSession, repo, 5); // build session with entries e1..e5
      const drive = vi.fn();
      const result = await prepareScenario({
        skipRecovery: { topics: ["change-mind", "open-question"], state: makeState(buildSession) },
        compactionBoundary: 140000,
        repoPath: repo,
        sessionsDir,
        manifestPath,
        preSliceDir,
        seams: {
          async driveAndCapture() {
            drive();
            throw new Error("skip recovery must not re-drive the build");
          },
          async trialCompact() {
            throw new Error("skip recovery must not re-compact");
          },
          async author() {
            throw new Error("skip recovery must not re-author");
          },
        },
      });
      expect(drive).not.toHaveBeenCalled();
      expect(result.manifestPath).toBe(manifestPath);
      // frozen main branch exists + manifest written
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      expect(existsSync(manifestPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a topic that was NOT missing for this prepare", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
    try {
      const buildSession = join(preSliceDir, "build.jsonl");
      writeSession(buildSession, repo, 5);
      await expect(
        prepareScenario({
          skipRecovery: { topics: ["key-decision"], state: makeState(buildSession) },
          compactionBoundary: 140000,
          repoPath: repo,
          sessionsDir,
          manifestPath,
          preSliceDir,
          seams: minimalSeams(),
        }),
      ).rejects.toThrow(/not among this prepare's missing topics/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an essential topic even if listed missing (defense-in-depth)", async () => {
    const { root, repo, sessionsDir, manifestPath, preSliceDir } = setup();
    try {
      const buildSession = join(preSliceDir, "build.jsonl");
      writeSession(buildSession, repo, 5);
      const state = {
        ...makeState(buildSession),
        missingTopics: [
          { id: "change-mind", label: "Changed mind", tag: "safeToSkip" },
          { id: "key-decision", label: "Key decision", tag: "essential" },
        ],
      };
      await expect(
        prepareScenario({
          skipRecovery: { topics: ["key-decision"], state },
          compactionBoundary: 140000,
          repoPath: repo,
          sessionsDir,
          manifestPath,
          preSliceDir,
          seams: minimalSeams(),
        }),
      ).rejects.toThrow(/essential/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function minimalSeams(): BuildSeams {
  return {
    async driveAndCapture() {
      throw new Error("unused");
    },
    async trialCompact() {
      throw new Error("unused");
    },
    async author() {
      throw new Error("unused");
    },
  };
}
