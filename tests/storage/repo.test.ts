// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Integration tests for the scenario-repo git wrappers — real `git` in a temp dir.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkout, commitAll, diffFile, diffNameOnly, forkBranch, initScenarioRepo } from "../../src/storage/repo.js";

/** Run git directly in a repo (test-only helper for assertions/setup). */
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).toString();
}

describe("scenario repo git wrappers (real git, temp dir)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "bench-repo-"));
    // populate the working tree as a caller (Task 10 prepare) would
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

  it("diffFile returns the diff text for a single file", () => {
    initScenarioRepo(repo);
    const branch = "bench-compact/run-d-1/cfg-x/arm-bare-pi-2";
    forkBranch(repo, "main", branch);
    checkout(repo, branch);
    writeFileSync(path.join(repo, "session.jsonl"), '{"type":"session","cwd":"/x"}\n{"type":"message"}\n');
    commitAll(repo, "attempt 2");

    const diff = diffFile(repo, "main", branch, "session.jsonl");
    expect(diff).toContain('+{"type":"message"}');
  });

  it("diffNameOnly is empty when branches are identical", () => {
    initScenarioRepo(repo);
    forkBranch(repo, "main", "sibling");
    expect(diffNameOnly(repo, "main", "sibling")).toEqual([]);
  });

  it("commitAll with --allow-empty succeeds on a no-change tree (R1-9)", () => {
    initScenarioRepo(repo);
    expect(() => commitAll(repo, "no-op phase boundary")).not.toThrow();
  });

  it("git failures throw a contextual error with the command (R2-1, §3.8 stop-and-surface)", () => {
    initScenarioRepo(repo);
    // checkout a non-existent branch -> git fails; runGit must surface the command + failure
    expect(() => checkout(repo, "no-such-branch")).toThrow(/failed/i);
    expect(() => checkout(repo, "no-such-branch")).toThrow(/checkout no-such-branch/);
  });
});
