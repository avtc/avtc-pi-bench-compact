// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Build a pre-compaction backup (§4.15 build mode): drive the user-simulator to the
// compaction boundary, capture the un-compacted session, run a trial compaction to
// find the cut, pre-slice the compacted-away span, author the manifest, + check
// condition-landing. Tail conditions auto-continue (re-drive → re-capture → re-trial
// → re-author); missing essential conditions surface to the user.
//
// The live parts (driving SimulatorDriver, capturing the session JSONL, trial-
// compacting a copy, authoring via the LLM) are injectable seams — their real
// wiring is Task 19. The orchestration flow + condition-landing loop are unit-tested.

import { join } from "node:path";
import type { ScenarioManifest } from "../manifest/schema.js";
import { CONDITION_TOPICS } from "../simulator/condition-topics.js";
import { buildEntryOrder, classifyLanding, decideLandingAction, type LandingAction } from "./condition-landing.js";
import { preSlice } from "./pre-slice.js";
import type { TrialCut } from "./trial-compaction.js";

/** The scenario context merged into the manifest (id/description/boundary/objective). */
export interface ScenarioContext {
  readonly id: string;
  readonly description: string;
  readonly compactionBoundary: { readonly phaseATokenBudget: number; readonly plan: string };
  readonly taskObjective: { readonly description: string; readonly testSpec: string; readonly lane: "embedded-test" };
}

/** Injectable seams over the live simulator/trial/author dependencies. */
export interface BuildSeams {
  /** Drive the simulator (or continue it) + capture the un-compacted session JSONL.
   *  `attempt` is 0 on the first drive, incrementing per continue-iteration. */
  driveAndCapture(attempt: number): Promise<{ backupPath: string; backupEntries: readonly { id: string }[] }>;
  /** Run a trial compaction on a copy of the backup → the cut point. */
  trialCompact(backupPath: string): Promise<TrialCut>;
  /** Author the manifest from the pre-sliced compacted-away JSONL. */
  author(preSlicedJsonlPath: string): Promise<ScenarioManifest>;
}

/** Input to {@link buildBackup}. */
export interface BuildBackupDeps {
  readonly scenario: string;
  readonly compactionBoundary: number;
  /** Directory for pre-sliced JSONL temp files. */
  readonly preSliceDir: string;
  readonly scenarioCtx: ScenarioContext;
  readonly seams: BuildSeams;
  /** Max condition-landing iterations before giving up (default 5). */
  readonly maxAttempts?: number;
}

/** Thrown when a condition never materialized + the user must decide (surface). */
export class SurfaceConditionsError extends Error {
  readonly action: Extract<LandingAction, { kind: "surface" }>;
  constructor(action: Extract<LandingAction, { kind: "surface" }>) {
    super(`condition-landing surfacing required (skipOffered=${action.skipOffered})`);
    this.name = "SurfaceConditionsError";
    this.action = action;
  }
}

/** Result of {@link buildBackup}: the captured backup + the authored+validated manifest. */
export interface BuildBackupResult {
  readonly backupPath: string;
  readonly backupEntries: readonly { id: string }[];
  readonly manifest: ScenarioManifest;
}

/**
 * Drive the build flow: simulator → capture → trial-compaction → (pre-slice → author →
 * condition-landing) loop. Returns when all conditions land in the compacted-away span.
 *
 * @throws {SurfaceConditionsError} when a condition never materialized (user decides).
 * @throws when the continue loop exceeds `maxAttempts` without converging.
 */
export async function buildBackup(deps: BuildBackupDeps): Promise<BuildBackupResult> {
  const maxAttempts = deps.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { backupPath, backupEntries } = await deps.seams.driveAndCapture(attempt);
    const { firstKeptEntryId } = await deps.seams.trialCompact(backupPath);

    const preSlicedPath = join(deps.preSliceDir, `sliced-${attempt}.jsonl`);
    preSlice(backupPath, firstKeptEntryId, preSlicedPath);

    const manifest = await deps.seams.author(preSlicedPath);
    const classification = classifyLanding(
      manifest,
      firstKeptEntryId,
      buildEntryOrder(backupEntries),
      CONDITION_TOPICS,
    );
    const action = decideLandingAction(classification);

    if (action.kind === "proceed") {
      return { backupPath, backupEntries, manifest };
    }
    if (action.kind === "surface") {
      throw new SurfaceConditionsError(action);
    }
    // action.kind === "continue" → loop again (driveAndCapture(attempt+1) continues the session)
  }
  throw new Error(`condition-landing did not converge after ${maxAttempts} attempts`);
}
