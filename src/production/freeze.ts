// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Freeze a prepared scenario: commit the backup `session.jsonl` + project files to
// the scenario repo's `main`, + write the manifest OUTSIDE the repo (contamination
// rule — the agent must never see the manifest). The frozen backup's header `cwd`
// is rewritten to the repo path for BOTH modes (build + extract) so every arm's
// `loadSession` lands the agent in the repo cwd (CR-3: `SessionManager.open` reads
// `header.cwd`; `ctx.switchSession` has no `cwdOverride`).
//
// `main` is immutable: re-prepare is refused without `--force` (which resets main +
// re-commits the new working tree).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScenarioManifest } from "../manifest/schema.js";
import { assertNotInRepo } from "../storage/paths.js";
import { branchExists, initScenarioRepo, resetBranch } from "../storage/repo.js";

const SESSION_JSONL = "session.jsonl";

/** Input to {@link freezeScenario}. */
export interface FreezeOptions {
  /** The scenario repo path (its working tree holds the project files; session.jsonl is written here). */
  readonly repoPath: string;
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
 * into the repo, write the manifest outside the repo, then commit to `main`.
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

  const mainExists = branchExists(opts.repoPath, "main");
  if (mainExists && !opts.force) {
    throw new Error(`scenario repo "${opts.repoPath}" already has a main commit — re-prepare requires --force`);
  }

  // Rewrite the frozen backup's header cwd → repoPath, write session.jsonl into the repo.
  const backupJson = readFileSync(opts.backupPath, "utf8");
  writeFileSync(`${opts.repoPath}/${SESSION_JSONL}`, rewriteHeaderCwd(backupJson, opts.repoPath));

  // Write the manifest OUTSIDE the repo.
  mkdirSync(dirname(opts.manifestPath), { recursive: true });
  writeFileSync(opts.manifestPath, `${JSON.stringify(opts.manifest, null, 2)}\n`);

  // --force re-prepare: reset main so initScenarioRepo re-commits the new tree fresh.
  if (mainExists && opts.force) {
    resetBranch(opts.repoPath, "main");
  }

  initScenarioRepo(opts.repoPath, { message: "prepare scenario: backup + project files" });
  return { repoPath: opts.repoPath, manifestPath: opts.manifestPath };
}
