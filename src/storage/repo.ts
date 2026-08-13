// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Thin git wrappers for the scenario repo. The repo tracks ONLY project files (the session
// transcript lives outside the repo, in the per-branch sessions store — see paths.ts); a branch
// per (arm × attempt | probe) lets states coexist + be diffed (the judge inspects via plain
// `git diff`/`git log`). These run `git` via the bench's OWN exec (node:child_process), NOT the
// agent's bash tool — the harness drives git directly at phase boundaries.
//
// Sequential, single worktree: the harness `checkout`s the active branch, the agent works
// in the repo cwd, and the harness commits ONLY at agent_settled / phase boundary (the live file is
// uncommitted mid-run). One branch live at a time → no worktrees.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bench-internal, never tracked scenario content: `.pi/` holds the arm-isolation settings
 *  (`settings.json` observational-memory section + memkeeper env) that `writeArmConfig` writes per arm.
 *  Committing them would (a) reveal the active arm to the agent (anti-peek violation) + (b) pollute
 *  every arm branch's diff vs `main`. `.git/info/exclude` is local-only + doesn't survive a fresh
 *  clone, so a committed `.gitignore` is the robust choice. */
const SCENARIO_GITIGNORE = ".pi/\n";

/** Run `git` in `cwd` with `args`; returns stdout (utf8). Throws a contextual error on failure. */
function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${e.message ?? err}\n${stderr}`);
  }
}

/**
 * Initialize a scenario repo at `repoPath` (its working tree already populated with the project
 * files by the caller — the prepare flow; the session transcript lives outside the repo). Creates
 * a `main` branch + commits the tree. Sets a local git identity so commits succeed in a fresh repo.
 */
export function initScenarioRepo(repoPath: string, opts: { message?: string } = {}): string {
  // Ignore bench-internal `.pi/` BEFORE the first add — persists across forks/branches.
  writeFileSync(join(repoPath, ".gitignore"), SCENARIO_GITIGNORE, "utf-8");
  runGit(repoPath, ["init", "-b", "main"]);
  // local identity — a fresh repo has none, so commits would fail without this.
  runGit(repoPath, ["config", "user.email", "bench-compact@local"]);
  runGit(repoPath, ["config", "user.name", "bench-compact"]);
  runGit(repoPath, ["add", "-A"]);
  runGit(repoPath, ["commit", "-m", opts.message ?? "prepare scenario"]);
  return repoPath;
}

/** Create `toBranch` pointing at `fromBranch` (does not switch). */
export function forkBranch(repo: string, fromBranch: string, toBranch: string): void {
  runGit(repo, ["branch", toBranch, fromBranch]);
}

/** Switch the working tree to `branch`. */
export function checkout(repo: string, branch: string): void {
  runGit(repo, ["checkout", branch]);
}

/** Stage all changes + commit them with `message` (called at agent_settled / phase boundary).
 *  `--allow-empty`: a boundary may have no working-tree changes (the agent only read files); the
 *  harness still records the boundary as a commit. */
export function commitAll(repo: string, message: string): void {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "--allow-empty", "-m", message]);
}

/** List the file paths that differ between two branches (`git diff --name-only a b`). */
export function diffNameOnly(repo: string, a: string, b: string): string[] {
  const out = runGit(repo, ["diff", "--name-only", a, b]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The raw diff text for a single `file` between two branches (`git diff a b -- file`). */
export function diffFile(repo: string, a: string, b: string, file: string): string {
  return runGit(repo, ["diff", a, b, "--", file]);
}

/** True when `branch` exists in `repo` (has been committed at least once). Used by freeze
 *  to enforce main immutability — re-prepare is refused without `--force`. */
export function branchExists(repo: string, branch: string): boolean {
  try {
    runGit(repo, ["rev-parse", "--verify", branch]);
    return true;
  } catch {
    return false;
  }
}

/** Delete `branch`'s ref so the next commit recreates it fresh. Used by freeze
 *  for the `--force` re-prepare path: reset main, then `initScenarioRepo` re-commits the
 *  (new) working tree as a fresh main. */
export function resetBranch(repo: string, branch: string): void {
  runGit(repo, ["update-ref", "-d", `refs/heads/${branch}`]);
}
