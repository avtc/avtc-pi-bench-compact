// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Trajectory grading via an agentLoop + read-only tools. For trajectory-shaped
// axes (proactive-recall; redo/redo-plan/goal when the run is too long for a
// single-call slice), the judge inspects the post-compaction trajectory on the
// attempt branch (read/grep/find/ls pointed at the repo cwd) + emits one grade
// per axis via a single terminal `record_grades` call. The shared stage-run
// skeleton (resolve -> tools -> rate-limit-wrapped runStage -> read capture) lives
// in stage-runner.ts; this module owns the prompt + the grade mapping.

import { Type } from "typebox";
import type { ScenarioManifest } from "../manifest/schema.js";
import type { MetricId } from "../metrics/defs.js";
import { benchReadOnlyTools, type JsonOutputTool, makeJsonOutputTool, NO_CAPTURE } from "../runtime/tools.js";
import { renderDoneOps } from "./context.js";
import { BenchJudgeError } from "./errors.js";
import type { RateLimitOptions } from "./rate-limit.js";
import { JUDGE_RUBRICS } from "./rubrics.js";
import { buildStageDeps, type JsonToolStageSeams, runJsonToolStage } from "./stage-runner.js";

/** One trajectory grade: the axis + the pass/fail judgment + a one-line citation. */
export interface TrajectoryGrade {
  readonly axis: MetricId;
  readonly pass: boolean;
  readonly evidence: string;
}

/** Injectable seams (resolve the judge model + run the bench stage). */
export type TrajectorySeams = JsonToolStageSeams;

/** Inputs to {@link gradeTrajectory}. */
export interface GradeTrajectoryDeps {
  readonly seams: TrajectorySeams;
  /** The repo working dir, checked out to the attempt branch (read/grep operate here). */
  readonly cwd: string;
  /** Absolute path to the post-compaction session-transcript file (lives outside the repo). */
  readonly tracePath: string;
  /** The axes to grade (proactive-recall; redo/redo-plan/goal when the run is too long for a single-call slice). */
  readonly axes: readonly MetricId[];
  /** The scenario manifest (provides the recallFacts/doneOps context the rubrics reference). */
  readonly manifest: ScenarioManifest;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/** The schema of the `record_grades` tool's payload (one terminal call, all grades). */
const RECORD_GRADES_SCHEMA = Type.Object({
  grades: Type.Array(Type.Object({ axis: Type.String(), pass: Type.Boolean(), evidence: Type.String() })),
});

const RECORD_GRADES_DESCRIPTION = [
  "Record your trajectory grades. Call this ONCE after inspecting the trajectory.",
  "Arguments: { grades: [{ axis, pass, evidence }] } — one entry per axis you were asked to grade.",
  "axis = the metric id; pass = true|false per the rubric; evidence = a one-line citation",
  "(entry-id + what you saw). This is a terminal call: after it, reply Done.",
].join(" ");

/** Build the trajectory-grading system prompt: the rubric per axis + the manifest context. */
function buildSystemPrompt(
  axes: readonly MetricId[],
  manifest: ScenarioManifest,
  cwd: string,
  tracePath: string,
): string {
  const rubricLines = axes.map((axis) => {
    const rubric = JUDGE_RUBRICS[axis];
    return rubric === undefined ? `- ${axis}: (no rubric)` : `- ${axis}:\n${rubric}`;
  });
  const recallFacts = manifest.recallFacts
    .map((rf) => `  - ${rf.id}: ${rf.fact} (accept: ${rf.accept.join(" | ")})`)
    .join("\n");
  return [
    "You are a strict benchmark judge grading a post-compaction TRAJECTORY.",
    `The repo is checked out to the attempt branch at ${cwd}; use read/grep/find/ls to inspect`,
    `the project files + the session transcript at ${tracePath} (an absolute path outside the repo — read it directly).`,
    "",
    "GRADE THESE AXES (one grade each):",
    ...rubricLines,
    "",
    "MANIFEST CONTEXT (the ground truth you grade against):",
    "recallFacts:",
    recallFacts.length > 0 ? recallFacts : "  (none)",
    "doneOps (completed work — re-executing a [done] one is a redo):",
    renderDoneOps(manifest),
    "",
    "Inspect the trajectory, then call record_grades ONCE with a grade per axis above.",
  ].join("\n");
}

/**
 * Grade a trajectory on the given axes via an agentLoop + read-only tools on the
 * attempt branch. The judge inspects the session transcript (absolute path passed
 * in the prompt) + the project files, then emits one grade per axis via a single terminal `record_grades` call. Rate-limit-
 * resilient + STOP-and-surfaces on failure (delegated to runJsonToolStage).
 * Pure aside from the seams.
 */
export async function gradeTrajectory(deps: GradeTrajectoryDeps): Promise<TrajectoryGrade[]> {
  const terminalTool: JsonOutputTool = makeJsonOutputTool(
    "record_grades",
    RECORD_GRADES_DESCRIPTION,
    RECORD_GRADES_SCHEMA,
    NO_CAPTURE,
  );
  const stageDeps = buildStageDeps(deps, {
    tools: benchReadOnlyTools(deps.cwd), // terminal tool auto-appended by runJsonToolStage
    systemPrompt: buildSystemPrompt(deps.axes, deps.manifest, deps.cwd, deps.tracePath),
    terminalTool,
    label: "trajectory grading",
    userMessageContent: `Inspect the trajectory at ${deps.tracePath} and grade the axes. Call record_grades once with all your grades.`,
  });
  const payload = (await runJsonToolStage(stageDeps)) as { grades?: unknown };
  const raw = Array.isArray(payload.grades) ? (payload.grades as TrajectoryGrade[]) : [];
  return validateAxisCompleteness(raw, deps.axes);
}

/**
 * STOP+surface guard: the judge's grades must cover EXACTLY the requested axes —
 * one each, no missing, no unknown, no duplicates. A hallucinated axis id,
 * misspelled, or omitted axis is judge misbehavior the bench must surface
 * (stop-and-surface philosophy), not silently drop/propagate into the statistics keyed by MetricId.
 */
function validateAxisCompleteness(grades: TrajectoryGrade[], requestedAxes: readonly MetricId[]): TrajectoryGrade[] {
  const expected = new Set(requestedAxes);
  const seen = new Set<MetricId>();
  for (const g of grades) {
    if (!expected.has(g.axis)) {
      throw new BenchJudgeError(
        "incomplete-output",
        `trajectory grading: unknown axis "${g.axis}" (not a requested axis) — STOP+surface`,
      );
    }
    if (seen.has(g.axis)) {
      throw new BenchJudgeError(
        "incomplete-output",
        `trajectory grading: duplicate axis "${g.axis}" in judge response — STOP+surface`,
      );
    }
    seen.add(g.axis);
  }
  for (const axis of expected) {
    if (!seen.has(axis)) {
      throw new BenchJudgeError(
        "incomplete-output",
        `trajectory grading: missing axis "${axis}" (judge omitted a requested axis) — STOP+surface`,
      );
    }
  }
  return grades;
}
