// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Trajectory-summary builder for the comparative trajectory axes (redo-plan /
// goal). The slice-grade axes (resume / task-quality) get a single-call slice;
// the trajectory axes need an agentLoop to inspect the WHOLE post-compaction
// trajectory (no bounded slice captures "did it re-tread abandoned ground?" or
// "did it wander off-goal?"). So this stage builds ONE arm's per-axis slice as a
// bounded summary string, which the scoring orchestrator then feeds to
// rankAxis (rank the enabled arms' summaries in one call).
//
// The stage mirrors the trajectory grader (resolve -> read-only tools + a
// terminal write_summary JSON tool -> rate-limit-wrapped runStage -> read
// capture) but emits a BOUNDED SUMMARY instead of pass/fail grades. The summary
// schema enforces <= MAX_SUMMARY_CHARS chars; an overlong summary is rejected at
// the tool (Value.Check fails) so the agent self-corrects in the multi-turn loop
// (runJsonToolStage runs with no turn limit). If the agent never emits a valid
// summary, runJsonToolStage raises no-capture (STOP+surface).

import type { ScenarioManifest } from "../manifest/schema.js";
import type { MetricId } from "../metrics/defs.js";
import { benchReadOnlyTools, type JsonOutputTool, makeJsonOutputTool, Type } from "../runtime/tools.js";
import { renderDoneOps } from "./context.js";
import { BenchJudgeError } from "./errors.js";
import type { RateLimitOptions } from "./rate-limit.js";
import { JUDGE_RUBRICS } from "./rubrics.js";
import { buildStageDeps, type JsonToolStageSeams, runJsonToolStage } from "./stage-runner.js";

/** Maximum summary length (chars). The terminal tool's schema rejects anything
 *  longer so the summary fits a comparative-ranking call alongside the other
 *  arms' summaries (5 summaries ~ 10K chars, well under the judge budget). */
const MAX_SUMMARY_CHARS = 2000;

/** Injectable seams (resolve the judge model + run the bench stage). */
export type TrajectorySummarySeams = JsonToolStageSeams;

/** Inputs to {@link summarizeTrajectory}. */
export interface TrajectorySummaryDeps {
  readonly seams: TrajectorySummarySeams;
  /** The repo working dir, checked out to the attempt branch (read/grep operate here). */
  readonly cwd: string;
  /** The comparative trajectory axis to summarize (redo-plan or goal). */
  readonly axis: MetricId;
  /** The scenario manifest (doneOps for redo-plan context; taskObjective for goal context). */
  readonly manifest: ScenarioManifest;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/** The schema of the `write_summary` tool's payload (one terminal call). */
const WRITE_SUMMARY_SCHEMA = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_CHARS }),
});

const WRITE_SUMMARY_DESCRIPTION = [
  "Write your bounded trajectory summary. Call this ONCE after inspecting the trajectory.",
  `Arguments: { summary: string } — <= ${MAX_SUMMARY_CHARS} chars, focused on the axis you were asked to summarize.`,
  "This summary will be RANKED against other arms' summaries (anonymized), so capture what distinguishes a",
  "strong run from a weak one on this axis (concrete actions/entries you observed). This is a terminal",
  "call: after it, reply Done.",
].join(" ");

/** Build the trajectory-summary system prompt: the axis rubric + the manifest
 *  context the judge summarizes against. doneOps is the redo-plan axis's signal;
 *  the scripted goal is the goal-adherence axis's signal. To keep each axis's
 *  prompt focused, doneOps is included only for the redo-plan axis. */
function buildSystemPrompt(axis: MetricId, manifest: ScenarioManifest, cwd: string): string {
  const rubric = JUDGE_RUBRICS[axis] ?? `(no rubric for ${axis})`;
  const goal = manifest.taskObjective.description;
  const lines = [
    "You are a strict benchmark judge summarizing ONE arm's post-compaction TRAJECTORY for comparative ranking.",
    `The repo is checked out to the attempt branch at ${cwd}; use read/grep/find/ls to inspect session.jsonl + the project files.`,
    "",
    "AXIS YOU ARE SUMMARIZING:",
    rubric,
    "",
    "MANIFEST CONTEXT (the ground truth you summarize against):",
  ];
  // doneOps is the redo-plan axis's signal; omit it for the goal axis to keep the prompt focused.
  if (axis === "E3") {
    lines.push(
      "doneOps (completed work — re-proposing a [done] one, or re-proposing an abandoned approach, is the axis signal):",
      renderDoneOps(manifest),
    );
  }
  lines.push(
    "scripted goal (taskObjective — wandering from this is the goal-axis signal):",
    `  ${goal}`,
    "",
    `Inspect the WHOLE post-compaction trajectory in ${cwd}, then call write_summary ONCE with a <= ${MAX_SUMMARY_CHARS}-char summary focused on THIS axis. Capture concrete actions/entries (e.g. "re-proposed the market-pricing loop (do1) at entry a22", "wandered into building a settings menu unrelated to the goal"). Be specific + comparative-grade (enough to rank against other arms).`,
  );
  return lines.join("\n");
}

/**
 * Summarize one arm's post-compaction trajectory on a comparative trajectory
 * axis (redo-plan / goal) via an agentLoop + read-only tools on the attempt
 * branch. The judge inspects session.jsonl + project files, then emits ONE
 * bounded summary (<= 2000 chars) via a terminal write_summary call. The summary
 * is the per-axis slice the scoring orchestrator feeds to rankAxis.
 *
 * Rate-limit-resilient + STOP-and-surfaces on failure (model-unavailable /
 * timeout / abort / no-capture — delegated to runJsonToolStage). Pure aside from
 * the seams.
 *
 * Re-prompt policy: malformed terminal-tool args are rejected at the typebox
 * schema (Value.Check) + the agent self-corrects in the multi-turn loop
 * (runJsonToolStage runs with no turn limit — the SAME pattern as the sibling
 * gradeTrajectory + manifest-authoring stages). The explicit retry cap in the
 * design's edge-handling is the single-call + ranking paths' maxRetries; the agentLoop+tools path self-corrects via multi-turn bounded by
 * the no-capture STOP+surface floor (the agent never emits a valid summary ->
 * runJsonToolStage raises no-capture). A hard turn cap on the agentLoop+tools
 * stages is a separate hardening concern (it would also affect gradeTrajectory +
 * manifest-authoring); the rate-limit + STOP+surface paths bound the risk without it.
 */
export async function summarizeTrajectory(deps: TrajectorySummaryDeps): Promise<string> {
  const terminalTool: JsonOutputTool = makeJsonOutputTool(
    "write_summary",
    WRITE_SUMMARY_DESCRIPTION,
    WRITE_SUMMARY_SCHEMA,
  );
  const stageDeps = buildStageDeps(deps, {
    tools: benchReadOnlyTools(deps.cwd),
    systemPrompt: buildSystemPrompt(deps.axis, deps.manifest, deps.cwd),
    terminalTool,
    label: "trajectory summary",
    userMessageContent: `Inspect the trajectory in ${deps.cwd} and write a bounded summary for the ${deps.axis} axis. Call write_summary once.`,
  });
  const payload = (await runJsonToolStage(stageDeps)) as { summary?: unknown };
  const summary = payload.summary;
  if (typeof summary !== "string") {
    // Unreachable: the write_summary typebox schema guarantees summary:string on
    // any captured payload (Value.Check rejects non-matching args). A non-string
    // here is an internal-invariant violation — STOP+surface as a judge error so
    // Task-19 failure classification (BenchJudgeError) handles it uniformly.
    throw new BenchJudgeError(
      "incomplete-output",
      "trajectory summary: captured write_summary payload has no string summary — STOP+surface",
    );
  }
  return summary;
}
