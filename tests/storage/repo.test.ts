// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Integration tests for the scenario-repo git wrappers — real `git` in a temp dir.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  newestBranches,
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

  it("initScenarioRepo sets the local git identity exactly once (config survives re-init)", () => {
    initScenarioRepo(repo);
    expect(git(repo, ["config", "user.email"]).trim()).toBe("bench-compact@local");
    expect(git(repo, ["config", "user.name"]).trim()).toBe("bench-compact");
    // freeze --force re-runs initScenarioRepo on the same repo (after resetBranch):
    // the identity block must not stack a duplicate [user] section, and the re-commit
    // must keep working.
    writeFileSync(path.join(repo, "game.ts"), "// forced re-prepare");
    initScenarioRepo(repo, { message: "prepare scenario: project files" });
    expect(git(repo, ["config", "--get-all", "user.email"]).trim()).toBe("bench-compact@local");
    expect(git(repo, ["log", "-1", "--pretty=%s"]).trim()).toBe("prepare scenario: project files");
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
    forkBranch(repo, "main", "bench-compact/run-d-1/cfg-x/arm-session-owl-builder-g1-1");
    checkout(repo, "bench-compact/run-d-1/cfg-x/arm-session-owl-builder-g1-1");
    writeFileSync(path.join(repo, "game.ts"), "export const x = 2;\n");
    commitAll(repo, "attempt 1");

    expect(diffNameOnly(repo, "main", "bench-compact/run-d-1/cfg-x/arm-session-owl-builder-g1-1")).toEqual(["game.ts"]);
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

  it("newestBranches orders matches most-recently-committed first (empty when none)", () => {
    initScenarioRepo(repo);
    const old = "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-default-g9785fb";
    const fresh = "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-default-g0c42d9";
    forkBranch(repo, "main", old);
    checkout(repo, old);
    commitAll(repo, "phase-1: compacted base (old version)");
    forkBranch(repo, "main", fresh);
    checkout(repo, fresh);
    commitAll(repo, "phase-1: compacted base (new version)");
    expect(newestBranches(repo, "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-default-*")[0]).toBe(fresh);
    expect(newestBranches(repo, "bench-compact/run-2099-01-01-1/*")).toEqual([]);
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
