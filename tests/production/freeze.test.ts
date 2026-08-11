// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { freezeScenario } from "../../src/production/freeze.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function backupWith(dir: string, cwd: string, sessionId: string): string {
  const path = join(dir, "backup.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", id: sessionId, timestamp: "t0", cwd }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n"),
  );
  return path;
}

const manifest = (): ScenarioManifest => ({
  id: "t-1",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "build", testSpec: "npm test", lane: "embedded-test" },
  probes: [],
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bench-freeze-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "game.ts"), "export const x = 1;"); // project file pre-placed (simulator output)
  const manifestPath = join(root, "manifest.json"); // OUTSIDE repo
  return { root, repo, manifestPath };
}

describe("freezeScenario", () => {
  it("commits session.jsonl + project files to main + writes manifest outside the repo", () => {
    const { root, repo, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({ repoPath: repo, backupPath: backup, manifest: manifest(), manifestPath });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).toContain("session.jsonl");
      expect(files).toContain("game.ts");
      expect(files).not.toContain("manifest.json"); // contamination rule
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).id).toBe("t-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites the frozen backup header cwd to the repo path (CR-3, both modes)", () => {
    const { root, repo, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({ repoPath: repo, backupPath: backup, manifest: manifest(), manifestPath });
      const frozen = readFileSync(join(repo, "session.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; cwd?: string });
      expect(frozen[0].type).toBe("session");
      expect(frozen[0].cwd).toBe(repo); // rewritten to repo path → arms load into repo cwd
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses re-freeze without --force (main immutable)", () => {
    const { root, repo, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({ repoPath: repo, backupPath: backup, manifest: manifest(), manifestPath });
      expect(() => freezeScenario({ repoPath: repo, backupPath: backup, manifest: manifest(), manifestPath })).toThrow(
        /force/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-freezes with --force (overwrites main with the new backup)", () => {
    const { root, repo, manifestPath } = setup();
    try {
      const backup1 = backupWith(root, "/original-cwd", "s1");
      freezeScenario({ repoPath: repo, backupPath: backup1, manifest: manifest(), manifestPath });
      // second freeze with a different backup + --force
      const backup2 = backupWith(root, "/original-cwd", "s2");
      freezeScenario({ repoPath: repo, backupPath: backup2, manifest: manifest(), manifestPath, force: true });
      const frozen = JSON.parse(readFileSync(join(repo, "session.jsonl"), "utf8").trim().split("\n")[0]);
      expect(frozen.id).toBe("s2"); // overwritten with backup2
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a manifestPath inside the repo (contamination guard)", () => {
    const { root, repo } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      const badManifest = join(repo, "manifest.json"); // INSIDE repo — forbidden
      expect(() =>
        freezeScenario({ repoPath: repo, backupPath: backup, manifest: manifest(), manifestPath: badManifest }),
      ).toThrow(/manifest|repo|contamination/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a backupPath inside the repo (R2-1: the backup is full ground truth — git add -A would commit it)", () => {
    const { root, repo } = setup();
    try {
      const badBackup = join(repo, "leaked-backup.jsonl"); // INSIDE repo — peekable via git show
      writeFileSync(badBackup, JSON.stringify({ type: "session", id: "s1", cwd: repo }));
      const manifestPath = join(root, "manifest.json");
      expect(() =>
        freezeScenario({ repoPath: repo, backupPath: badBackup, manifest: manifest(), manifestPath }),
      ).toThrow(/contamination|inside|backup/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
