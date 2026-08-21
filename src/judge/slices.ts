// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Slice builders: each produces the minimal bounded content for ONE judge
// single-call grade. The judge gets the slice + the manifest context + the axis
// rubric (single-call.ts prefixes the rubric). Slices are deliberately small so
// a cloud judge's context window is never overflowed (whole post-compaction runs
// do not fit).
//
//   start-slice       (resume axis)   — compaction summary + first post-compaction actions
//   probe-answer      (probe axes)    — the probe question + accept[]/refusal + the answer text
//   done-snapshot     (quality axis)  — task objective + testSpec result + final actions
//   two-checkpoint    (redo axis)     — completed doneOps + the run's action list (when short)
//
// All builders are PURE transformations of their inputs.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DoneOp, Probe, ScenarioManifest, TaskObjective } from "../manifest/schema.js";
import type { TestSpecResult } from "../orchestrate/testspec.js";
import type { RunTrace } from "../orchestrate/trace.js";
import { messageText } from "../session/message-text.js";

/** Options for slice builders that bound the rendered action count. */
export interface SliceOptions {
  readonly maxEntries?: number;
}

/** Default cap on rendered actions in a slice (keeps each call small). */
const DEFAULT_START_MAX = 5;
/** The default cap on rendered actions in a done/two-checkpoint slice. Exported so
 *  the orchestrator can size its done-snapshot tail to match (showing the LAST
 *  actions, then the render cap is a no-op). */
export const DEFAULT_ACTIONS_MAX = 8;

/** A minimal view of a session message entry (the fields the renderer reads). */
interface MessageLike {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
}

/** Render a message entry as a "role: text" line; "" for non-message entries. */
function renderEntry(entry: SessionEntry): string {
  const message = (entry as MessageLike).message;
  if (message === undefined) return "";
  const role = message.role ?? "entry";
  const text = messageText(entry).trim();
  if (text.length === 0) return "";
  return `${role}: ${text}`;
}

/** Render up to `max` message entries as non-empty "role: text" lines. */
function renderActions(entries: readonly SessionEntry[], max: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= max) break;
    const line = renderEntry(entry);
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

/** The index of the first (boundary) compaction entry; -1 if none. */
function boundaryIndex(entries: readonly SessionEntry[]): number {
  return entries.findIndex((e) => (e as { type?: string }).type === "compaction");
}

/**
 * Build the resume start-slice: the compaction summary + the manifest's task context
 * + the first few post-compaction actions. The summary tells the judge what the
 * agent had to resume from; the first actions show whether it resumed toward the
 * next step or stalled/re-asked. Pure.
 */
export function buildStartSlice(trace: RunTrace, manifest: ScenarioManifest, options: SliceOptions | null): string {
  const max = options?.maxEntries ?? DEFAULT_START_MAX;
  const boundary = trace.compactions[0]?.entry;
  const summary = boundary?.summary ?? "(no compaction summary)";
  const start = boundaryIndex(trace.entries) + 1;
  const postCompaction = trace.entries.slice(start);
  const actions = renderActions(postCompaction, max);
  return [
    "TASK CONTEXT",
    `Objective: ${manifest.taskObjective.description}`,
    `Plan / next step: ${manifest.compactionBoundary.plan}`,
    "",
    "COMPACTION SUMMARY (what the agent resumed from)",
    summary,
    "",
    "FIRST POST-COMPACTION ACTIONS",
    actions.length > 0 ? actions : "(no post-compaction actions captured)",
  ].join("\n");
}

/** Inputs to {@link buildProbeAnswerSlice}. */
export interface ProbeAnswerSliceInput {
  readonly probe: Probe;
  readonly answerText: string;
  /** Ground-truth excerpts of the pre-compaction transcript entries the probe
   *  cites (latent entryIds / manifest targets), rendered IN FULL. Shown as a
   *  reference block so the judge grades substance over accept[] phrasing;
   *  absent/null = no block (the slice is unchanged). */
  readonly groundTruth?: readonly GroundTruthExcerpt[] | null;
  /** The reversal this supersession-latest probe tests — rendered as the
   *  SUPERSESSION UNDER TEST block (subject + latestValue, the authoritative
   *  current answer). Absent/null = no block. */
  readonly supersession?: SupersessionUnderTest | null;
}

/** The supersession data a supersession-latest probe's judge slice carries. */
export interface SupersessionUnderTest {
  readonly subject: string;
  readonly latestValue: string;
}

/** One ground-truth excerpt: the message text of one cited transcript entry. */
export interface GroundTruthExcerpt {
  /** The cited entry id (rendered as the tag's entry attribute). */
  readonly id: string;
  /** Who said it — the tag name (USER/ASSISTANT), mirroring the memory tools'
   *  role-tagged render so judges see provenance (a user decision vs an agent
   *  claim grades differently). */
  readonly role: GroundTruthRole;
  /** The entry's extracted message text, rendered IN FULL — never truncated: a
   *  mid-entry character cut drops the very detail the probe asks about (often
   *  late in the entry) and leaves the judge reading garbage. */
  readonly text: string;
}

/** The excerpt tag names (the memory tools' role tags; custom messages and
 *  branch summaries render as USER — the user-side content convention). */
export type GroundTruthRole = "USER" | "ASSISTANT";

/** Render the ground-truth block for a probe slice. Returns null when there is
 *  nothing to show (no excerpts / all empty) so the caller can omit the section
 *  entirely. Full-length entries, no truncation, each wrapped in a role-tagged
 *  block with the entry id as the attribute — the same LLM-facing convention the
 *  memory tools use for verbatim transcript content (`<USER entry=id>`), so
 *  judges see who said what. Pure. */
export function renderGroundTruthBlock(excerpts: readonly GroundTruthExcerpt[]): string | null {
  const blocks: string[] = [];
  for (const excerpt of excerpts) {
    const text = excerpt.text.trim();
    if (text.length === 0) continue;
    blocks.push(`<${excerpt.role} entry=${excerpt.id}>\n${text}\n</${excerpt.role}>`);
  }
  if (blocks.length === 0) return null;
  return [
    "GROUND-TRUTH REFERENCE (full excerpts of the pre-compaction transcript entries this probe cites — the source accept[] was derived from; a correct answer may word it differently)",
    ...blocks,
  ].join("\n");
}

/** Render the SUPERSESSION UNDER TEST block (subject + latestValue). */
function renderSupersessionBlock(s: SupersessionUnderTest): string {
  return [
    "SUPERSESSION UNDER TEST (this fact changed during the session — the LATEST value is the correct current answer)",
    `Subject: ${s.subject}`,
    `latestValue: ${s.latestValue}`,
  ].join("\n");
}

/**
 * Build the probe-answer slice (recall, abstention, supersession): the probe question + the grading
 * criteria (accept[] for recall, or the correctRefusal note for abstention) +
 * the agent's answer text. Pure.
 */
export function buildProbeAnswerSlice(input: ProbeAnswerSliceInput, options: SliceOptions | null): string {
  void options;
  const { probe, answerText } = input;
  // The abstention axis has two faces: a never-decided question (REFUSE) and a
  // superseded value (FLAG AS STALE). Both are correctRefusal probes; the authored
  // `face` field decides which criteria the judge grades against.
  const criteria =
    probe.correctRefusal === true
      ? probe.face === "stale"
        ? "CORRECT ANSWER = FLAG THE VALUE AS STALE/OUTDATED (the decision changed after this value was set; a correct agent flags the old value as superseded rather than confirming it)."
        : "CORRECT ANSWER = REFUSE (no decision/answer on this question has been committed; a correct agent declines rather than fabricates). Grade the refusal itself: accurate supplementary context alongside a correct refusal still passes — including the current/default state, the deferral history, or conditions for a future decision; it fails only when the agent asserts a decision/commitment that was never made or answers the open question with a fabricated committed value."
      : `accept[] (a correct answer matches one of): ${(probe.accept ?? []).join(" | ") || "(none)"}`;
  const groundTruth =
    input.groundTruth === undefined || input.groundTruth === null ? null : renderGroundTruthBlock(input.groundTruth);
  const sections = ["PROBE QUESTION", probe.question, "", "GRADING CRITERIA", criteria];
  if (input.supersession !== undefined && input.supersession !== null) {
    sections.push("", renderSupersessionBlock(input.supersession));
  }
  if (groundTruth !== null) {
    sections.push("", groundTruth);
  }
  sections.push(
    "",
    "AGENT'S ANSWER",
    answerText.length > 0 ? answerText : "(no answer text — tool-call-only or empty response)",
  );
  return sections.join("\n");
}

/** Inputs to {@link buildDoneSnapshot}. */
export interface DoneSnapshotInput {
  readonly branch: string;
  readonly taskObjective: TaskObjective;
  readonly testSpecResult: TestSpecResult;
  readonly finalEntries: readonly SessionEntry[];
}

/** Render a testSpec result as a one-line summary for the done-snapshot. */
function renderTestSpec(result: TestSpecResult): string {
  switch (result.kind) {
    case "skipped":
      return "SKIPPED (no embedded test — judge quality by the artifacts alone).";
    case "ran":
      return result.runError
        ? `RUN ERROR (testSpec failed to run): ${result.output}`
        : result.pass
          ? `PASS — ${result.output}`
          : `FAIL — ${result.output}`;
  }
}

/**
 * Build the quality done-snapshot: the task objective + the testSpec command + its
 * result (pass/fail/output or skipped — a SECONDARY signal) + the final actions.
 * The judge ranks resumed+continued work quality from this. Pure.
 */
export function buildDoneSnapshot(input: DoneSnapshotInput, options: SliceOptions | null): string {
  const max = options?.maxEntries ?? DEFAULT_ACTIONS_MAX;
  const { branch, taskObjective, testSpecResult, finalEntries } = input;
  return [
    `BRANCH: ${branch}`,
    "",
    "TASK OBJECTIVE",
    taskObjective.description,
    "",
    "EMBEDDED TEST (secondary signal)",
    `Command: ${taskObjective.testSpec.length > 0 ? taskObjective.testSpec : "(none)"}`,
    `Result: ${renderTestSpec(testSpecResult)}`,
    "",
    "FINAL ACTIONS",
    renderActions(finalEntries, max),
  ].join("\n");
}

/** Inputs to {@link buildTwoCheckpointSlice}. */
export interface TwoCheckpointInput {
  readonly doneOps: readonly DoneOp[];
  readonly runActions: readonly SessionEntry[];
}

/**
 * Build the redo two-checkpoint slice (when the run is short enough for one call):
 * the completed doneOps (marked which are reworkable = exempt) + the run's action
 * list. The judge checks whether the agent re-executed a completed (non-reworkable)
 * doneOp. Pure.
 */
export function buildTwoCheckpointSlice(input: TwoCheckpointInput, options: SliceOptions | null): string {
  const max = options?.maxEntries ?? DEFAULT_ACTIONS_MAX;
  const { doneOps, runActions } = input;
  const doneOpsText =
    doneOps.length === 0
      ? "(no completed doneOps in the manifest)"
      : doneOps
          .map((op) => `- [${op.reworkable ? "reworkable" : "done"}] ${op.description} (${op.artifact})`)
          .join("\n");
  return [
    "COMPLETED WORK (doneOps) — re-executing a [done] item is a redo; [reworkable] is exempt",
    doneOpsText,
    "",
    "RUN'S POST-COMPACTION ACTIONS",
    renderActions(runActions, max),
  ].join("\n");
}
