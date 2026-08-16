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
import { readFileSync, writeFileSync } from "node:fs";
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
  // APPEND to a pre-existing .gitignore (extract mode copies the project's own one in —
  // its rules must survive) instead of overwriting it; skip when `.pi/` is already there
  // (re-init on the same repo must not duplicate the line).
  const gitignorePath = join(repoPath, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    existing = ""; // no pre-existing .gitignore → fresh write below
  }
  const hasPiLine = existing.split(/\r?\n/).some((line) => line.trim() === ".pi/" || line.trim() === ".pi");
  if (!hasPiLine) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${existing}${separator}${SCENARIO_GITIGNORE}`, "utf-8");
  }
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

/** List local branch names matching a glob pattern (e.g. `bench-compact/run-*`).
 *  The crash-resume flow scans the run namespace off the branch list. */
export function listBranches(repo: string, pattern: string): string[] {
  const out = runGit(repo, ["branch", "--list", pattern, "--format=%(refname:short)"]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** How many commits `branch` has beyond `base` — the crash-resume completion
 *  discriminator: a phase commits its boundary on completion, so >0 ahead of the
 *  fork point means the work finished (a crash mid-work leaves a bare fork = 0). */
export function commitCountAhead(repo: string, branch: string, base: string): number {
  const out = runGit(repo, ["rev-list", "--count", branch, `^${base}`]);
  const count = Number.parseInt(out.trim(), 10);
  if (Number.isNaN(count)) throw new Error(`git rev-list returned a non-numeric count (${out.trim()})`);
  return count;
}

/** Branch names matching a glob pattern, most-recently-committed first (empty when
 *  none). The `--reuse-bases` resume fallback scans arm candidates across tool
 *  versions this way (newest commit first; the caller shape-checks base vs
 *  attempt/probe branches — an attempt carries a later committer date than its base). */
export function newestBranches(repo: string, pattern: string): string[] {
  const out = runGit(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    `refs/heads/${pattern}`,
  ]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
