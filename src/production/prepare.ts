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
import { type BuildSeams, buildBackup, type ScenarioContext } from "./build.js";
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
  /** Allow re-freezing an existing main. */
  readonly force?: boolean;
}

/** Validate that exactly one mode is selected + extract has its output path. */
function validateDeps(deps: PrepareDeps): void {
  const buildMode = deps.scenario !== undefined;
  const extractMode = deps.fromSessionPath !== undefined;
  if (buildMode === extractMode) {
    throw new Error("prepareScenario requires exactly one of `scenario` (build) or `fromSessionPath` (extract)");
  }
  if (extractMode && !deps.extractOutputPath) {
    throw new Error("extract mode requires `extractOutputPath`");
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
    // extract mode: guard + strip the real session, then author (no continue loop).
    const extracted = extractBackup({
      fromSessionPath: deps.fromSessionPath,
      outputPath: deps.extractOutputPath as string,
      cwd: deps.extractCwd,
    });
    backupPath = extracted.backupPath;
    const trial = await deps.seams.trialCompact(backupPath);
    const preSliced = preSlice(backupPath, trial.firstKeptEntryId, join(deps.preSliceDir, "extract-sliced.jsonl"));
    manifest = await deps.seams.author(preSliced.jsonlPath);
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
