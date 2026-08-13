// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Freeze a prepared scenario: commit the project files to the scenario repo's `main`, write the
// backup `session.jsonl` to the per-branch sessions store (OUTSIDE the repo), + write the manifest
// OUTSIDE the repo (contamination rule — the agent must never see the manifest or the session).
// The frozen backup's header `cwd` is rewritten to the repo path for BOTH modes (build + extract)
// so every arm's `loadSession` lands the agent in the repo cwd (CR-3: `SessionManager.open` reads
// `header.cwd`; `ctx.switchSession` has no `cwdOverride`).
//
// `main` is immutable: re-prepare is refused without `--force` (which resets main + re-commits the
// new working tree). The session transcript lives at `branchSessionFile(sessionsDir, "main")` —
// pi appends to it mid-run, so keeping it OUT of the repo avoids a dirty git tree + agent peeking.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScenarioManifest } from "../manifest/schema.js";
import { assertNotInRepo, branchSessionFile } from "../storage/paths.js";
import { branchExists, initScenarioRepo, resetBranch } from "../storage/repo.js";

/** The branch name frozen as the shared pre-compaction backup (every arm forks from it). */
const MAIN_BRANCH = "main";

/** Input to {@link freezeScenario}. */
export interface FreezeOptions {
  /** The scenario repo path (its working tree holds ONLY project files — the session transcript
   *  is written to {@link FreezeOptions.sessionsDir}, not the repo). */
  readonly repoPath: string;
  /** The per-branch session-transcript store (sibling of the repo; agent-invisible). The frozen
   *  backup is written to `branchSessionFile(sessionsDir, "main")`. */
  readonly sessionsDir: string;
  /** The captured pre-compaction backup JSONL (header cwd rewritten → repoPath). */
  readonly backupPath: string;
  /** The authored + validated manifest (written outside the repo). */
  readonly manifest: ScenarioManifest;
  /** Where to write manifest.json — MUST be outside the repo (contamination rule). */
  readonly manifestPath: string;
  /** Allow re-freezing an existing main (resets main + re-commits). Default false. */
  readonly force?: boolean;
}

/** Rewrite the backup's session header `cwd` to `repoPath` (CR-3). */
function rewriteHeaderCwd(backupJson: string, repoPath: string): string {
  const lines = backupJson.split("\n").filter((l) => l.trim().length > 0);
  const rewritten = lines.map((line) => {
    const entry = JSON.parse(line) as { type?: string; cwd?: string };
    if (entry.type === "session") {
      return JSON.stringify({ ...entry, cwd: repoPath });
    }
    return line;
  });
  return `${rewritten.join("\n")}\n`;
}

/**
 * Freeze the scenario: rewrite the backup header cwd → repoPath, write `session.jsonl`
 * to the per-branch sessions store (outside the repo), write the manifest outside the
 * repo, then commit `main` (project files only).
 *
 * @throws when `main` already exists + `force` is not set (immutability), or when
 *   `manifestPath` is inside the repo (contamination).
 */
export function freezeScenario(opts: FreezeOptions): { repoPath: string; manifestPath: string } {
  // Contamination guard FIRST — never let bench ground truth land in the repo.
  assertNotInRepo(opts.manifestPath, opts.repoPath);
  // R2-1: the backup is the FULL pre-compaction session (fullest ground truth). If it
  // lives inside the repo, `git add -A` commits it + the agent could `git show main:` it.
  assertNotInRepo(opts.backupPath, opts.repoPath);
  // The sessions store is a sibling of the repo (agent-invisible) — guard against a
  // misconfigured sessionsDir that lands inside the repo (the transcript is peekable).
  assertNotInRepo(opts.sessionsDir, opts.repoPath);

  const mainExists = branchExists(opts.repoPath, MAIN_BRANCH);
  if (mainExists && !opts.force) {
    throw new Error(`scenario repo "${opts.repoPath}" already has a main commit — re-prepare requires --force`);
  }

  // Rewrite the frozen backup's header cwd → repoPath, write it to main's session file in
  // the sessions store (OUTSIDE the repo — pi appends to it mid-run, so keeping it out of the
  // repo avoids a dirty git tree + the agent peeking at its own transcript).
  const backupJson = readFileSync(opts.backupPath, "utf8");
  mkdirSync(opts.sessionsDir, { recursive: true });
  writeFileSync(branchSessionFile(opts.sessionsDir, MAIN_BRANCH), rewriteHeaderCwd(backupJson, opts.repoPath));

  // Write the manifest OUTSIDE the repo.
  mkdirSync(dirname(opts.manifestPath), { recursive: true });
  writeFileSync(opts.manifestPath, `${JSON.stringify(opts.manifest, null, 2)}\n`);

  // --force re-prepare: reset main so initScenarioRepo re-commits the new tree fresh.
  if (mainExists && opts.force) {
    resetBranch(opts.repoPath, MAIN_BRANCH);
  }

  initScenarioRepo(opts.repoPath, { message: "prepare scenario: project files" });
  return { repoPath: opts.repoPath, manifestPath: opts.manifestPath };
}
