// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Integration tests for the scenario-repo git wrappers — real `git` in a temp dir.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  branchExists,
  checkout,
  commitAll,
  commitCountAhead,
  diffNameOnly,
  forkBranch,
  initScenarioRepo,
  listBranches,
  resetBranch,
} from "../../src/storage/repo.js";

/** Run git directly in a repo (test-only helper for assertions/setup). */
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).toString();
}

describe("scenario repo git wrappers (real git, temp dir)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "bench-repo-"));
    // populate the working tree as a caller (prepare) would
    writeFileSync(path.join(repo, "session.jsonl"), '{"type":"session","cwd":"/x"}\n');
    writeFileSync(path.join(repo, "game.ts"), "export const x = 1;\n");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "util.ts"), "export const y = 2;\n");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("initScenarioRepo commits session.jsonl + project files to main", () => {
    initScenarioRepo(repo);
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
    const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(files).toContain("session.jsonl");
    expect(files).toContain("game.ts");
    expect(files).toContain("src/util.ts");
  });

  it("initScenarioRepo writes a .gitignore so writeArmConfig's .pi/ arm-isolation files are never tracked", () => {
    initScenarioRepo(repo);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(".gitignore");
    // simulate writeArmConfig writing .pi/settings.json, then commitAll must NOT stage it
    mkdirSync(path.join(repo, ".pi"));
    writeFileSync(path.join(repo, ".pi", "settings.json"), '{"observational-memory":{"enabled":false}}');
    commitAll(repo, "arm isolation written");
    const tracked = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(tracked).not.toContain(".pi/settings.json");
    expect(tracked).toContain(".gitignore"); // the gitignore itself is tracked
  });

  it("branchExists reports whether a branch has been committed", () => {
    expect(branchExists(repo, "main")).toBe(false); // not yet init'd
    initScenarioRepo(repo);
    expect(branchExists(repo, "main")).toBe(true);
    expect(branchExists(repo, "nonexistent")).toBe(false);
  });

  it("resetBranch deletes the branch ref so a fresh commit recreates it (--force re-prepare)", () => {
    initScenarioRepo(repo);
    expect(branchExists(repo, "main")).toBe(true);
    resetBranch(repo, "main");
    expect(branchExists(repo, "main")).toBe(false);
    initScenarioRepo(repo); // re-commit recreates main
    expect(branchExists(repo, "main")).toBe(true);
  });

  it("initScenarioRepo accepts a custom commit message", () => {
    initScenarioRepo(repo, { message: "prepare scenario s1 (build)" });
    expect(git(repo, ["log", "-1", "--pretty=%s"]).trim()).toBe("prepare scenario s1 (build)");
  });

  it("fork + checkout + commit round-trip: diff isolates the changed file", () => {
    initScenarioRepo(repo);
    forkBranch(repo, "main", "bench-compact/run-d-1/cfg-x/arm-memkeeper-builder-g1-1");
    checkout(repo, "bench-compact/run-d-1/cfg-x/arm-memkeeper-builder-g1-1");
    writeFileSync(path.join(repo, "game.ts"), "export const x = 2;\n");
    commitAll(repo, "attempt 1");

    expect(diffNameOnly(repo, "main", "bench-compact/run-d-1/cfg-x/arm-memkeeper-builder-g1-1")).toEqual(["game.ts"]);
  });

  it("diffNameOnly is empty when branches are identical", () => {
    initScenarioRepo(repo);
    forkBranch(repo, "main", "sibling");
    expect(diffNameOnly(repo, "main", "sibling")).toEqual([]);
  });

  it("commitAll with --allow-empty succeeds on a no-change tree", () => {
    initScenarioRepo(repo);
    expect(() => commitAll(repo, "no-op phase boundary")).not.toThrow();
  });

  it("git failures throw a contextual error with the command (, stop-and-surface)", () => {
    initScenarioRepo(repo);
    // checkout a non-existent branch -> git fails; runGit must surface the command + failure
    expect(() => checkout(repo, "no-such-branch")).toThrow(/failed/i);
    expect(() => checkout(repo, "no-such-branch")).toThrow(/checkout no-such-branch/);
  });

  it("listBranches returns only branches matching the pattern (resume namespace scan)", () => {
    initScenarioRepo(repo);
    const armA = "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-bare-pi";
    const armB = "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-full-g9785fb";
    forkBranch(repo, "main", armA);
    forkBranch(repo, "main", armB);
    forkBranch(repo, "main", "unrelated-feature");
    expect(listBranches(repo, "bench-compact/run-*").sort()).toEqual([armA, armB]);
    expect(listBranches(repo, "*")).toContain("main");
  });

  it("commitCountAhead distinguishes a committed completion from a bare fork (the resume discriminator)", () => {
    initScenarioRepo(repo);
    const base = "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-bare-pi";
    forkBranch(repo, "main", base);
    checkout(repo, base);
    commitAll(repo, "phase-1: compacted base for arm A1");
    expect(commitCountAhead(repo, base, "main")).toBe(1);

    // an attempt forked but never committed (crashed mid-attempt) is 0 ahead
    const attempt = `${base}-1`;
    forkBranch(repo, base, attempt);
    expect(commitCountAhead(repo, attempt, base)).toBe(0);

    // a completed attempt carries its boundary commit
    checkout(repo, attempt);
    commitAll(repo, "phase-2: continuation attempt 1");
    expect(commitCountAhead(repo, attempt, base)).toBe(1);
  });
});

describe("initScenarioRepo .gitignore preservation (extract mode copies a project .gitignore in)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "bench-repo-gi-"));
    writeFileSync(path.join(repo, "session.jsonl"), '{"type":"session","cwd":"/x"}\n');
    writeFileSync(path.join(repo, "game.ts"), "export const x = 1;\n");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("APPENDS .pi/ to a pre-existing .gitignore instead of overwriting it", () => {
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
    initScenarioRepo(repo);
    const lines = readFileSync(path.join(repo, ".gitignore"), "utf-8").split(/\r?\n/);
    expect(lines).toContain("node_modules/");
    expect(lines).toContain("dist/");
    expect(lines).toContain(".pi/");
  });

  it("appends on a newline when the existing .gitignore lacks a trailing newline", () => {
    writeFileSync(path.join(repo, ".gitignore"), "dist/");
    initScenarioRepo(repo);
    const content = readFileSync(path.join(repo, ".gitignore"), "utf-8");
    expect(content.split(/\r?\n/)).toEqual(["dist/", ".pi/", ""]);
  });

  it("a pre-existing .pi/ line is kept WITHOUT duplication (already-ignoring source)", () => {
    writeFileSync(path.join(repo, ".gitignore"), "dist/\n.pi/\n");
    initScenarioRepo(repo);
    const content = readFileSync(path.join(repo, ".gitignore"), "utf-8");
    const piLines = content.split(/\r?\n/).filter((l) => l.trim() === ".pi/");
    expect(piLines).toHaveLength(1);
    expect(content).toContain("dist/");
  });

  it("the appended rules stay in force (gitignored project files + .pi/ both untracked)", () => {
    writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
    mkdirSync(path.join(repo, "dist"));
    writeFileSync(path.join(repo, "dist", "bundle.js"), "bundled");
    initScenarioRepo(repo);
    const tracked = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(tracked).not.toContain("dist/bundle.js");
    expect(tracked).not.toContain(".pi/settings.json");
  });
});
