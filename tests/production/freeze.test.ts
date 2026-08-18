// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { freezeScenario } from "../../src/production/freeze.js";
import { branchSessionFile } from "../../src/storage/paths.js";

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
  const sessionsDir = join(root, "sessions");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "game.ts"), "export const x = 1;"); // project file pre-placed (simulator output)
  const manifestPath = join(root, "manifest.json"); // OUTSIDE repo
  return { root, repo, sessionsDir, manifestPath };
}

describe("freezeScenario", () => {
  it("writes the session to the sessions store (NOT the repo) + commits ONLY project files to main", () => {
    const { root, repo, sessionsDir, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({
        repoPath: repo,
        sessionsDir,
        backupPath: backup,
        manifest: manifest(),
        manifestPath,
        backupMode: "build",
      });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).not.toContain("session.jsonl"); // session lives OUTSIDE the repo now
      expect(files).toContain("game.ts"); // project files still committed
      expect(files).not.toContain("manifest.json"); // contamination rule
      // the rewritten session is at the main branch's session file in the sessions store
      const mainSession = branchSessionFile(sessionsDir, "main");
      expect(JSON.parse(readFileSync(mainSession, "utf8").trim().split("\n")[0]).type).toBe("session");
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).id).toBe("t-1");
      // provenance is stamped into the frozen manifest (mechanically, from the command form)
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).backupMode).toBe("build");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites the frozen backup header cwd to the repo path (, both modes)", () => {
    const { root, repo, sessionsDir, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({
        repoPath: repo,
        sessionsDir,
        backupPath: backup,
        manifest: manifest(),
        manifestPath,
        backupMode: "build",
      });
      const frozen = readFileSync(branchSessionFile(sessionsDir, "main"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; cwd?: string });
      expect(frozen[0]?.type).toBe("session");
      expect(frozen[0]?.cwd).toBe(repo); // rewritten to repo path → arms load into repo cwd
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses re-freeze without --force (main immutable)", () => {
    const { root, repo, sessionsDir, manifestPath } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      freezeScenario({
        repoPath: repo,
        sessionsDir,
        backupPath: backup,
        manifest: manifest(),
        manifestPath,
        backupMode: "build",
      });
      expect(() =>
        freezeScenario({
          repoPath: repo,
          sessionsDir,
          backupPath: backup,
          manifest: manifest(),
          manifestPath,
          backupMode: "build",
        }),
      ).toThrow(/force/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-freezes with --force (overwrites main's session file with the new backup)", () => {
    const { root, repo, sessionsDir, manifestPath } = setup();
    try {
      const backup1 = backupWith(root, "/original-cwd", "s1");
      freezeScenario({
        repoPath: repo,
        sessionsDir,
        backupPath: backup1,
        manifest: manifest(),
        manifestPath,
        backupMode: "build",
      });
      // second freeze with a different backup + --force
      const backup2 = backupWith(root, "/original-cwd", "s2");
      freezeScenario({
        repoPath: repo,
        sessionsDir,
        backupPath: backup2,
        manifest: manifest(),
        backupMode: "build",
        manifestPath,
        force: true,
      });
      const frozen = JSON.parse(readFileSync(branchSessionFile(sessionsDir, "main"), "utf8").trim().split("\n")[0]);
      expect(frozen.id).toBe("s2"); // overwritten with backup2
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a manifestPath inside the repo (contamination guard)", () => {
    const { root, repo, sessionsDir } = setup();
    try {
      const backup = backupWith(root, "/original-cwd", "s1");
      const badManifest = join(repo, "manifest.json"); // INSIDE repo — forbidden
      expect(() =>
        freezeScenario({
          repoPath: repo,
          sessionsDir,
          backupPath: backup,
          manifest: manifest(),
          backupMode: "build",
          manifestPath: badManifest,
        }),
      ).toThrow(/manifest|repo|contamination/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a backupPath inside the repo (: the backup is full ground truth — git add -A would commit it)", () => {
    const { root, repo, sessionsDir } = setup();
    try {
      const badBackup = join(repo, "leaked-backup.jsonl"); // INSIDE repo — peekable via git show
      writeFileSync(badBackup, JSON.stringify({ type: "session", id: "s1", cwd: repo }));
      const manifestPath = join(root, "manifest.json");
      expect(() =>
        freezeScenario({
          repoPath: repo,
          sessionsDir,
          backupPath: badBackup,
          manifest: manifest(),
          backupMode: "build",
          manifestPath,
        }),
      ).toThrow(/contamination|inside|backup/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
