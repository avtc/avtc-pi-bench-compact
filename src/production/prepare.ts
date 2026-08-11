// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The prepare-scenario orchestrator (§4.15): build OR extract a pre-compaction
// backup, author + validate the manifest, then freeze. Reusable by the
// `/bench-compact:prepare-scenario` command (Task 10h) AND Task 19's `run <idea>`
// Phase-0 entry point.
//
// - build mode (`scenario` given): `buildBackup` drives the simulator + returns the
//   authored manifest (condition-landing loop inside).
// - extract mode (`fromSessionPath` given): `extractBackup` guards + strips the real
//   session, then this orchestrator trial-compacts + pre-slices + authors (no
//   continue loop — a real session can't be continued).
// Either mode → `freezeScenario` (rewrites header cwd + commits + writes manifest).

import { join } from "node:path";
import type { ScenarioManifest } from "../manifest/schema.js";
import { validateManifest } from "../manifest/validate.js";
import { assertNotInRepo } from "../storage/paths.js";
import { type BuildSeams, buildBackup, ESSENTIAL_LISTS, type ScenarioContext } from "./build.js";
import { copyProjectTree } from "./copy-tree.js";
import { extractBackup } from "./extract.js";
import { freezeScenario } from "./freeze.js";
import { preSlice } from "./pre-slice.js";

/** Input to {@link prepareScenario}. Exactly one of `scenario` / `fromSessionPath` is required. */
export interface PrepareDeps {
  /** build mode: the scenario idea (drives the user-simulator). */
  readonly scenario?: string;
  /** extract mode: path to a real pre-compaction session JSONL. */
  readonly fromSessionPath?: string;
  /** extract mode: where to write the cleaned backup. Required when `fromSessionPath` is set. */
  readonly extractOutputPath?: string;
  /** extract mode: the coherent cwd (header.cwd must match). Defaults to process.cwd(). */
  readonly extractCwd?: string;
  readonly compactionBoundary: number;
  readonly repoPath: string;
  readonly manifestPath: string;
  readonly preSliceDir: string;
  readonly scenarioCtx: ScenarioContext;
  /** build-mode simulator/trial/author seams (trialCompact + author reused for extract). */
  readonly seams: BuildSeams;
  /** extract mode: copy the codebase from `sourceCwd` into `repoPath` (default = real
   *  copyProjectTree excluding .git + node_modules). Build mode does not use this. */
  readonly copyProjectFiles?: (sourceCwd: string, repoPath: string) => void;
  /** Allow re-freezing an existing main. */
  readonly force?: boolean;
}

/** Validate deps: exactly one mode selected; extract has its output path; + contamination
 *  guards — intermediate artifacts (preSliceDir, extractOutputPath) must NOT be inside
 *  the agent-visible repo (else `git add -A` commits ground-truth the agent could peek). */
function validateDeps(deps: PrepareDeps): void {
  const buildMode = deps.scenario !== undefined;
  const extractMode = deps.fromSessionPath !== undefined;
  if (buildMode === extractMode) {
    throw new Error("prepareScenario requires exactly one of `scenario` (build) or `fromSessionPath` (extract)");
  }
  if (extractMode && !deps.extractOutputPath) {
    throw new Error("extract mode requires `extractOutputPath`");
  }
  // R1-3: contamination guards on intermediate artifact paths.
  assertNotInRepo(deps.preSliceDir, deps.repoPath);
  if (deps.extractOutputPath !== undefined) {
    assertNotInRepo(deps.extractOutputPath, deps.repoPath);
  }
}

/**
 * Orchestrate prepare-scenario: build/extract → (trial → pre-slice → author) → freeze.
 * Returns the frozen repo + manifest paths.
 */
export async function prepareScenario(deps: PrepareDeps): Promise<{ repoPath: string; manifestPath: string }> {
  validateDeps(deps);

  let backupPath: string;
  let manifest: ScenarioManifest;

  if (deps.fromSessionPath) {
    // extract mode: guard + strip the real session, copy the codebase into the repo,
    // then author (no continue loop — a real session can't be continued).
    const extracted = extractBackup({
      fromSessionPath: deps.fromSessionPath,
      outputPath: deps.extractOutputPath as string,
      cwd: deps.extractCwd,
    });
    backupPath = extracted.backupPath;
    // CR-4: copy the coherent codebase (sourceCwd) into the repo so its files are
    // committed to main (the agent resumes work on them in the repo cwd).
    const copyFn = deps.copyProjectFiles ?? copyProjectTree;
    copyFn(extracted.sourceCwd, deps.repoPath);
    const trial = await deps.seams.trialCompact(backupPath);
    const preSliced = preSlice(backupPath, trial.firstKeptEntryId, join(deps.preSliceDir, "extract-sliced.jsonl"));
    manifest = await deps.seams.author(preSliced.jsonlPath);
    // §4.15 step 4 — structural validation gate (extract: 0 compactions, stricter since
    // ground truth is discovered). Failures stop-and-surface (§3.8).
    const validation = validateManifest(manifest, {
      preSlicedEntryIds: new Set(preSliced.entryIds),
      entryTextById: preSliced.entryTextById,
      essentialLists: ESSENTIAL_LISTS,
      compactionCount: 0, // extract source is un-compacted
      expectedCompactionCount: 0,
    });
    if (!validation.ok) {
      throw new Error(`manifest validation failed: ${validation.reasons.join("; ")}`);
    }
  } else {
    // build mode: simulator → capture → trial → pre-slice → author → condition-landing loop.
    const built = await buildBackup({
      scenario: deps.scenario as string,
      compactionBoundary: deps.compactionBoundary,
      preSliceDir: deps.preSliceDir,
      scenarioCtx: deps.scenarioCtx,
      seams: deps.seams,
    });
    backupPath = built.backupPath;
    manifest = built.manifest;
  }

  return freezeScenario({
    repoPath: deps.repoPath,
    backupPath,
    manifest,
    manifestPath: deps.manifestPath,
    force: deps.force,
  });
}
