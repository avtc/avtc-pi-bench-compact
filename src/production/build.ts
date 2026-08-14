// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Build a pre-compaction backup: drive the user-simulator to the
// compaction boundary, capture the un-compacted session, run a trial compaction to
// find the cut, pre-slice the compacted-away span, author the manifest, + check
// condition-landing. Tail conditions auto-continue (re-drive → re-capture → re-trial
// → re-author); missing essential conditions surface to the user.
//
// The live parts (driving SimulatorDriver, capturing the session JSONL, trial-
// compacting a copy, authoring via the LLM) are injectable seams — their real wiring
// is `buildLiveSeams` (src/production/live-seams.ts). The orchestration flow +
// condition-landing loop are unit-tested here.

import { join } from "node:path";
import type { ScenarioManifest } from "../manifest/schema.js";

import { type ConditionListName, validateManifest } from "../manifest/validate.js";
import { CONDITION_TOPICS, type ConditionTopic } from "../simulator/condition-topics.js";
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
  /** Detect which condition-topics' content lives in the KEPT TAIL (at/after the
   *  trial cut `firstKeptEntryId` — the same tail boundary classifyLanding uses), for
   *  topics the author found nothing for. Optional — when absent, missing topics are
   *  treated as never-materialized (surface). `buildLiveSeams` wires the tail check
   *  (single-call kind-level presence check on the rendered tail). */
  findTailContent?(backupPath: string, firstKeptEntryId: string): Promise<ReadonlySet<string>>;
}

/** Resume inputs for the plant-and-continue recovery (`--plant`): continue the
 *  FAILED build's loop from a later attempt, steering the missing topics in. */
export interface BuildResume {
  /** The attempt the resumed loop restarts AT. Callers pass the SURFACED attempt + 1:
   *  restarting at the surfaced attempt itself would pace-stop immediately (the
   *  session's usage already crossed that attempt's target); +1 grows the target one
   *  continue-step so the first resumed cycle continues + injects the plant text. */
  readonly attempt: number;
  /** The plant steering text (the resumed drive's FIRST harness instruction). */
  readonly plantInstruction?: string;
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
  /** Plant-and-continue recovery: resume the loop at a later attempt with a plant
   *  instruction (the build session persists across attempts, so the drive continues). */
  readonly resume?: BuildResume;
}

/** Thrown when a condition never materialized + the user must decide (surface).
 *  Carries the landing CONTEXT (cut + attempt + last authored manifest) so the
 *  orchestrator can persist the recovery state (`landing.json`) before re-throwing. */
export class SurfaceConditionsError extends Error {
  readonly action: Extract<LandingAction, { kind: "surface" }>;
  /** The trial compaction's cut point at the surfaced attempt. */
  readonly firstKeptEntryId: string;
  /** The build attempt that surfaced (the --plant resume restarts one past it). */
  readonly attempt: number;
  /** The last authored manifest (--skip re-validates + freezes it with topics dropped). */
  readonly manifest: ScenarioManifest;
  constructor(
    action: Extract<LandingAction, { kind: "surface" }>,
    context: { firstKeptEntryId: string; attempt: number; manifest: ScenarioManifest },
  ) {
    super(`condition-landing surfacing required (skipOffered=${action.skipOffered})`);
    this.name = "SurfaceConditionsError";
    this.action = action;
    this.firstKeptEntryId = context.firstKeptEntryId;
    this.attempt = context.attempt;
    this.manifest = context.manifest;
  }
}

/** Result of {@link buildBackup}: the captured backup + the authored+validated manifest. */
export interface BuildBackupResult {
  readonly backupPath: string;
  readonly backupEntries: readonly { id: string }[];
  readonly manifest: ScenarioManifest;
}

/** `topics` = every canonical topic (the default validation scope). */
const ALL_TOPICS = null;

/** Structural validation gate shared by build (after condition-landing
 *  'proceed') + extract (after authoring). The source backup is pre-compaction by
 *  construction (build captures before trial; extract guards none) → expected 0.
 *  Failures stop-and-surface. `topics` narrows the check to a subset (skip-and-proceed
 *  recovery drops safeToSkip topics — their essential-list requirement goes too).
 *  Throws on validation failure. */
export function validateAuthoredManifest(
  manifest: ScenarioManifest,
  preSliced: { readonly entryIds: readonly string[]; readonly entryTextById: ReadonlyMap<string, string> },
  backupPath: string,
  topics: readonly ConditionTopic[] | null,
): void {
  const active = topics ?? CONDITION_TOPICS;
  const essentialLists: ReadonlySet<ConditionListName> = new Set(
    active.filter((t) => t.tag === "essential").map((t) => `${t.metricAxis}s` as ConditionListName),
  );
  const validation = validateManifest(manifest, {
    preSlicedEntryIds: new Set(preSliced.entryIds),
    entryTextById: preSliced.entryTextById,
    essentialLists,
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
 * AND the final manifest passes structural validation.
 *
 * @throws {SurfaceConditionsError} when a condition never materialized (user decides).
 * @throws when the final manifest fails validation, or the continue loop exceeds `maxAttempts`.
 */
export async function buildBackup(deps: BuildBackupDeps): Promise<BuildBackupResult> {
  const maxAttempts = deps.maxAttempts ?? 5;
  // A resumed (--plant) build gets its OWN maxAttempts-sized window from its start
  // attempt — sharing the global cap with the fresh build would make a surface at
  // the last original attempt resume at exactly maxAttempts and never enter the
  // loop body, failing with a convergence error before the plant is ever tried.
  const startAttempt = deps.resume?.attempt ?? 0;
  const endAttempt = startAttempt + maxAttempts;
  for (let attempt = startAttempt; attempt < endAttempt; attempt++) {
    const { backupPath, backupEntries } = await deps.seams.driveAndCapture(attempt);
    const { firstKeptEntryId } = await deps.seams.trialCompact(backupPath);

    const preSlicedPath = join(deps.preSliceDir, `sliced-${attempt}.jsonl`);
    const preSliced = preSlice(backupPath, firstKeptEntryId, preSlicedPath);

    const manifest = await deps.seams.author(preSliced.jsonlPath);

    // Tail detection: which topics' content is in the kept tail (separate from the
    // manifest's citations, since the author only saw the span). Only topics whose
    // manifest condition-list is EMPTY can be tail-rescued — when the author produced
    // conditions for every topic (the common case) the call is skipped entirely
    // (a model resolve + stage round + timeout for a set nobody would read).
    const topicsWithoutConditions = CONDITION_TOPICS.filter(
      (t) => (manifest[`${t.metricAxis}s` as keyof ScenarioManifest] as readonly unknown[]).length === 0,
    );
    const tailContent =
      deps.seams.findTailContent !== undefined && topicsWithoutConditions.length > 0
        ? await deps.seams.findTailContent(backupPath, firstKeptEntryId)
        : new Set<string>();

    const classification = classifyLanding(
      manifest,
      firstKeptEntryId,
      buildEntryOrder(backupEntries),
      CONDITION_TOPICS,
      tailContent,
    );
    const action = decideLandingAction(classification);

    if (action.kind === "proceed") {
      validateAuthoredManifest(manifest, preSliced, backupPath, ALL_TOPICS);
      return { backupPath, backupEntries, manifest };
    }
    if (action.kind === "surface") {
      throw new SurfaceConditionsError(action, { firstKeptEntryId, attempt, manifest });
    }
    // action.kind === "continue" → loop again (driveAndCapture(attempt+1) continues the session)
  }
  throw new Error(
    `condition-landing did not converge after ${maxAttempts} attempts (attempts ${startAttempt}..${endAttempt - 1})`,
  );
}
