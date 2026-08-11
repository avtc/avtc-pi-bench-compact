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

export type { ScenarioContext } from "../manifest/schema.js";

import { type ConditionListName, validateManifest } from "../manifest/validate.js";
import { CONDITION_TOPICS } from "../simulator/condition-topics.js";
import { buildEntryOrder, classifyLanding, decideLandingAction, type LandingAction } from "./condition-landing.js";
import { countCompactions, preSlice } from "./pre-slice.js";
import type { TrialCut } from "./trial-compaction.js";

/** Injectable seams over the live simulator/trial/author dependencies. */
export interface BuildSeams {
  /** Drive the simulator (or continue it) + capture the un-compacted session JSONL.
   *  `attempt` is 0 on the first drive, incrementing per continue-iteration. */
  driveAndCapture(attempt: number): Promise<{ backupPath: string; backupEntries: readonly { id: string }[] }>;
  /** Run a trial compaction on a copy of the backup → the cut point. */
  trialCompact(backupPath: string): Promise<TrialCut>;
  /** Author the manifest from the pre-sliced compacted-away JSONL. */
  author(preSlicedJsonlPath: string): Promise<ScenarioManifest>;
  /** Detect which condition-topics' content lives in the KEPT TAIL (not the span the
   *  author saw). Optional — when absent, missing topics are treated as
   *  never-materialized (surface). Task 19 wires the real detection (re-author
   *  against the full backup or tail-text search); default empty = conservative. */
  findTailContent?(backupPath: string): Promise<ReadonlySet<string>>;
}

/** Input to {@link buildBackup}. */
export interface BuildBackupDeps {
  readonly scenario: string;
  readonly compactionBoundary: number;
  /** Directory for pre-sliced JSONL temp files. */
  readonly preSliceDir: string;
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

/** The essential condition-list names derived from CONDITION_TOPICS (the
 *  `essential`-tagged axes). Passed to validateManifest's essential-lists check. */
export const ESSENTIAL_LISTS: ReadonlySet<ConditionListName> = new Set(
  CONDITION_TOPICS.filter((t) => t.tag === "essential").map((t) => `${t.metricAxis}s` as ConditionListName),
);

/** §4.15 step 4 — structural validation gate shared by build (after condition-landing
 *  'proceed') + extract (after authoring). The source backup is pre-compaction by
 *  construction (build captures before trial; extract guards none) → expected 0.
 *  Failures stop-and-surface (§3.8). Throws on validation failure. */
export function validateAuthoredManifest(
  manifest: ScenarioManifest,
  preSliced: { readonly entryIds: readonly string[]; readonly entryTextById: ReadonlyMap<string, string> },
  backupPath: string,
): void {
  const validation = validateManifest(manifest, {
    preSlicedEntryIds: new Set(preSliced.entryIds),
    entryTextById: preSliced.entryTextById,
    essentialLists: ESSENTIAL_LISTS,
    compactionCount: countCompactions(backupPath),
    expectedCompactionCount: 0,
  });
  if (!validation.ok) {
    throw new Error(`manifest validation failed: ${validation.reasons.join("; ")}`);
  }
}

/**
 * Drive the build flow: simulator → capture → trial-compaction → (pre-slice → author →
 * condition-landing) loop. Returns when all conditions land in the compacted-away span
 * AND the final manifest passes structural validation (§4.15 step 4).
 *
 * @throws {SurfaceConditionsError} when a condition never materialized (user decides).
 * @throws when the final manifest fails validation, or the continue loop exceeds `maxAttempts`.
 */
export async function buildBackup(deps: BuildBackupDeps): Promise<BuildBackupResult> {
  const maxAttempts = deps.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { backupPath, backupEntries } = await deps.seams.driveAndCapture(attempt);
    const { firstKeptEntryId } = await deps.seams.trialCompact(backupPath);

    const preSlicedPath = join(deps.preSliceDir, `sliced-${attempt}.jsonl`);
    const preSliced = preSlice(backupPath, firstKeptEntryId, preSlicedPath);

    const manifest = await deps.seams.author(preSliced.jsonlPath);

    // Tail detection: which topics' content is in the kept tail (separate from the
    // manifest's citations, since the author only saw the span). Default = none.
    const tailContent = deps.seams.findTailContent ? await deps.seams.findTailContent(backupPath) : new Set<string>();

    const classification = classifyLanding(
      manifest,
      firstKeptEntryId,
      buildEntryOrder(backupEntries),
      CONDITION_TOPICS,
      tailContent,
    );
    const action = decideLandingAction(classification);

    if (action.kind === "proceed") {
      validateAuthoredManifest(manifest, preSliced, backupPath);
      return { backupPath, backupEntries, manifest };
    }
    if (action.kind === "surface") {
      throw new SurfaceConditionsError(action);
    }
    // action.kind === "continue" → loop again (driveAndCapture(attempt+1) continues the session)
  }
  throw new Error(`condition-landing did not converge after ${maxAttempts} attempts`);
}
