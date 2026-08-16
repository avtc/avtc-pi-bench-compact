// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The prepare-scenario orchestrator: build OR extract a pre-compaction
// backup, author + validate the manifest, then freeze. Reusable by the
// `/bench-compact:prepare-scenario` command AND the `run <idea>`
// Phase-0 entry point.
//
// - build mode (`scenario` given): `buildBackup` drives the simulator + returns the
//   authored manifest (condition-landing loop inside).
// - extract mode (`fromSessionPath` given): `extractBackup` guards + strips the real
//   session, then this orchestrator trial-compacts + pre-slices + authors (no
//   continue loop — a real session can't be continued).
// Either mode → `freezeScenario` (rewrites header cwd + commits + writes manifest).

import { dirname, join } from "node:path";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { CONDITION_TOPICS } from "../simulator/condition-topics.js";
import { assertNotInRepo } from "../storage/paths.js";
import {
  type BuildResume,
  type BuildSeams,
  buildBackup,
  SurfaceConditionsError,
  validateAuthoredManifest,
} from "./build.js";
import { type CopyTreeOptions, copyProjectTree } from "./copy-tree.js";
import { extractBackup } from "./extract.js";
import { freezeScenario } from "./freeze.js";
import { LANDING_FILE, type LandingState, writeLandingState } from "./landing-state.js";
import { BUILD_SESSION_NAME } from "./live-seams.js";
import { preSlice } from "./pre-slice.js";

/** `copyProjectFiles` options = none (real copy-tree defaults: git-listed copy). */
const DEFAULT_COPY_OPTS = null;
/** `validateAuthoredManifest` topics = every canonical topic (no skip narrowing). */
const ALL_TOPICS = null;

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
  /** The per-branch session-transcript store (sibling of the repo; agent-invisible). Passed to
   *  {@link freezeScenario}, which writes the frozen backup to `branchSessionFile(sessionsDir, "main")`. */
  readonly sessionsDir: string;
  readonly manifestPath: string;
  readonly preSliceDir: string;
  /** build-mode simulator/trial/author seams (trialCompact + author reused for extract). */
  readonly seams: BuildSeams;
  /** plant-and-continue recovery: resume the build loop at a later attempt, steering
   *  the previously-missing topics in (requires `scenario` — the persisted idea). */
  readonly resume?: BuildResume;
  /** skip-and-proceed recovery: drop safeToSkip topics + re-validate + freeze the
   *  persisted manifest (read from the surfaced prepare's landing.json by the caller). */
  readonly skipRecovery?: { readonly topics: readonly string[]; readonly state: LandingState };
  /** extract mode: copy the codebase from `sourceCwd` into `repoPath` (default = real
   *  copyProjectTree: git-listed or recursive, excluding .git/node_modules + the secret
   *  denylist; returns the skipped secret-like files). Build mode does not use this. */
  readonly copyProjectFiles?: (sourceCwd: string, repoPath: string, opts: CopyTreeOptions | null) => string[];
  /** Allow re-freezing an existing main. */
  readonly force?: boolean;
  /** The build seams' shared ctx holder — after prepare, `.current` is the FINAL
   *  fresh ctx (the command ctx is stale post-switch). Callers that continue with
   *  session work (the run shorthands' executeRun handoff) must use it. */
  readonly liveCtx?: { readonly current: unknown };
}

/** Validate deps: exactly one mode selected; extract has its output path; + contamination
 *  guards — intermediate artifacts (preSliceDir, extractOutputPath) must NOT be inside
 *  the agent-visible repo (else `git add -A` commits ground-truth the agent could peek). */
function validateDeps(deps: PrepareDeps): void {
  const buildMode = deps.scenario !== undefined;
  const extractMode = deps.fromSessionPath !== undefined;
  const skipMode = deps.skipRecovery !== undefined;
  const modeCount = [buildMode, extractMode, skipMode].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error(
      "prepareScenario requires exactly one of `scenario` (build), `fromSessionPath` (extract), or `skipRecovery` (skip)",
    );
  }
  if (extractMode && !deps.extractOutputPath) {
    throw new Error("extract mode requires `extractOutputPath`");
  }
  if (deps.resume !== undefined && !buildMode) {
    throw new Error("plant resume requires `scenario` (the persisted build idea)");
  }
  // Contamination guards on intermediate artifact paths.
  assertNotInRepo(deps.preSliceDir, deps.repoPath);
  if (deps.extractOutputPath !== undefined) {
    assertNotInRepo(deps.extractOutputPath, deps.repoPath);
  }
}

/**
 * Orchestrate prepare-scenario: build/extract → (trial → pre-slice → author) → freeze.
 * Returns the frozen repo + manifest paths.
 */
export interface PrepareScenarioResult {
  readonly repoPath: string;
  readonly manifestPath: string;
  /** The final fresh ctx when build-mode seams ran (absent for pure-extract/skip
   *  flows + test fakes — fall back to the command ctx, which stays live when no
   *  switchSession happened). */
  readonly liveCtx?: { readonly current: unknown };
}

export async function prepareScenario(deps: PrepareDeps): Promise<PrepareScenarioResult> {
  validateDeps(deps);
  const mode =
    deps.fromSessionPath !== undefined
      ? "extract"
      : deps.skipRecovery !== undefined
        ? "skip-recovery"
        : deps.resume !== undefined
          ? `plant-resume (attempt ${deps.resume.attempt})`
          : "build";
  log.info(`prepare: ${mode} — repo ${deps.repoPath}, manifest ${deps.manifestPath}`);

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
    // Copy the coherent codebase (sourceCwd) into the repo so its files are
    // committed to main (the agent resumes work on them in the repo cwd).
    const copyFn = deps.copyProjectFiles ?? copyProjectTree;
    const skipped = copyFn(extracted.sourceCwd, deps.repoPath, DEFAULT_COPY_OPTS);
    if (skipped.length > 0) {
      // The scenario repo is judge-readable — every skipped secret-like file is a
      // load-bearing security decision, so it must be visible (log), not silent.
      log.warn(
        `extract copy skipped ${skipped.length} secret-like file(s) (never committed to the scenario repo): ${skipped.join(", ")}`,
      );
    }
    const trial = await deps.seams.trialCompact(backupPath);
    const preSliced = preSlice(backupPath, trial.firstKeptEntryId, join(deps.preSliceDir, "extract-sliced.jsonl"));
    manifest = await deps.seams.author(preSliced.jsonlPath, backupPath, trial.firstKeptEntryId);
    // Structural validation gate (extract: stricter since ground truth is
    // discovered). Failures stop-and-surface.
    validateAuthoredManifest(manifest, preSliced, backupPath, ALL_TOPICS);
  } else if (deps.skipRecovery !== undefined) {
    // skip-and-proceed recovery: validate the requested drops against the persisted
    // landing state, re-validate the manifest without those topics, freeze it.
    const rec = deps.skipRecovery;
    const missingById = new Map(rec.state.missingTopics.map((t) => [t.id, t]));
    for (const id of rec.topics) {
      const topic = missingById.get(id);
      if (topic === undefined) {
        throw new Error(
          `skip-topics "${id}" is not among this prepare's missing topics (${[...missingById.keys()].join(", ")})`,
        );
      }
      if (topic.tag !== "safeToSkip") {
        throw new Error(`skip-topics "${id}" is essential — only safeToSkip topics can be skipped`);
      }
    }
    const keptTopics = CONDITION_TOPICS.filter((t) => !rec.topics.includes(t.id));
    const preSliced = preSlice(
      rec.state.buildSessionPath,
      rec.state.firstKeptEntryId,
      join(deps.preSliceDir, "skip-sliced.jsonl"),
    );
    validateAuthoredManifest(rec.state.manifest, preSliced, rec.state.buildSessionPath, keptTopics);
    return freezeScenario({
      repoPath: deps.repoPath,
      sessionsDir: deps.sessionsDir,
      backupPath: rec.state.buildSessionPath,
      manifest: rec.state.manifest,
      manifestPath: deps.manifestPath,
      force: deps.force,
    });
  } else {
    // build mode: simulator → capture → trial → pre-slice → author → condition-landing
    // loop. A plant-resume (`resume`) restarts the loop at the surfaced attempt, steering
    // the missing topics in. On surface: persist the recovery state BEFORE re-throwing.
    try {
      const built = await buildBackup({
        scenario: deps.scenario as string,
        compactionBoundary: deps.compactionBoundary,
        preSliceDir: deps.preSliceDir,
        seams: deps.seams,
        resume: deps.resume,
      });
      backupPath = built.backupPath;
      manifest = built.manifest;
    } catch (err) {
      if (err instanceof SurfaceConditionsError) {
        const landingPath = join(dirname(deps.manifestPath), LANDING_FILE);
        writeLandingState(landingPath, {
          missingTopics: err.action.missing.map((t) => ({ id: t.id, label: t.label, tag: t.tag })),
          skipOffered: err.action.skipOffered,
          buildSessionPath: join(deps.preSliceDir, BUILD_SESSION_NAME),
          firstKeptEntryId: err.firstKeptEntryId,
          attempt: err.attempt,
          scenario: deps.scenario as string,
          manifest: err.manifest,
        });
        log.warn(
          `condition topics did not land — recovery state written to ${landingPath} (plant + continue, or skip safeToSkip topics)`,
        );
      }
      throw err;
    }
  }

  const frozen = freezeScenario({
    repoPath: deps.repoPath,
    sessionsDir: deps.sessionsDir,
    backupPath,
    manifest,
    manifestPath: deps.manifestPath,
    force: deps.force,
  });
  log.info(`prepare: scenario frozen — manifest ${frozen.manifestPath}`);
  return { ...frozen, liveCtx: deps.liveCtx };
}
