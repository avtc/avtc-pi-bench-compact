// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Single-call slice grading. The judge gets one maxTurns:1 call with the axis
// rubric + the slice + an emit-JSON instruction, and returns `{pass, evidence}`.
// Malformed JSON is re-prompted up to `maxRetries` (default 2) times; after that
// the bench STOP-and-surfaces by throwing `JudgeMalformedJsonError` — the caller
// catches it, notifies the operator, and halts scoring (never silently scores on
// an unparseable response).
//
// The LLM call itself is abstracted behind the `CallJudge` seam so this module
// has NO cloud dependency — the caller (trajectory-judge wiring / integration)
// builds the real adapter over the bench stage runner + the resolved judge model,
// and tests inject a canned fake. Rate-limit resilience is layered on top by
// rate-limit.ts.

import type { MetricId } from "../metrics/defs.js";
import { JUDGE_RUBRICS } from "./rubrics.js";

/**
 * The judge-LLM call seam: given a system prompt + the user content (the slice),
 * return the model's raw text response. The adapter wraps `runBenchStage`
 * (maxTurns:1, no tools, the resolved judge model).
 */
export type CallJudge = (systemPrompt: string, userContent: string) => Promise<string>;

/** One slice grade: the pass/fail judgment + a one-line evidence citation. */
export interface SliceGrade {
  readonly pass: boolean;
  readonly evidence: string;
}

/** Inputs to {@link gradeSlice}. */
export interface GradeSliceInput {
  /** The axis being graded (selects the rubric). */
  readonly axis: MetricId;
  /** The slice content (the bounded rendering from slices.ts). */
  readonly slice: string;
  /** The judge-LLM call seam. */
  readonly callJudge: CallJudge;
  /** Malformed-JSON re-prompt budget (default 2). */
  readonly maxRetries?: number;
}

/** Default re-prompt budget for malformed JSON (re-prompt at most twice). */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Raised when the judge emits malformed JSON for `maxRetries + 1` consecutive
 * calls. The caller STOP-and-surfaces — never silently scores.
 */
export class JudgeMalformedJsonError extends Error {
  constructor(
    readonly axis: MetricId,
    readonly attempts: number,
  ) {
    super(`judge emitted malformed JSON for axis ${axis} after ${attempts} attempt(s) — STOP+surface`);
    this.name = "JudgeMalformedJsonError";
  }
}

/** Build the system prompt: the judge role + the axis rubric + the emit-JSON contract. */
function buildSystemPrompt(axis: MetricId, nudge: string | null): string {
  const rubric = JUDGE_RUBRICS[axis];
  if (rubric === undefined) {
    throw new Error(`no judge rubric for axis ${axis} (only effectiveness axes are judge-graded)`);
  }
  const base = [
    "You are a strict benchmark judge. Grade ONLY the axis named below.",
    rubric,
    "",
    "Respond with ONLY a single JSON object, no prose, no code fence:",
    '{"pass": <true|false>, "evidence": "<one-line citation of where you saw it>"}',
  ].join("\n");
  return nudge === null ? base : `${base}\n\nYour previous response was NOT valid JSON. ${nudge}`;
}

/** Extract the first balanced {...} object from a string (tolerates fences/prose). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the judge's raw text into a {pass, evidence} grade; null if unparseable. */
function parseGrade(raw: string): SliceGrade | null {
  const json = extractJsonObject(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { pass?: unknown; evidence?: unknown };
  if (typeof obj.pass !== "boolean") return null;
  const evidence = typeof obj.evidence === "string" ? obj.evidence : "";
  return { pass: obj.pass, evidence };
}

/**
 * Grade one slice on one axis via a single judge call. Parses the model's JSON
 * `{pass, evidence}`; on malformed JSON, re-prompts (nudging the model) up to
 * `maxRetries` (default 2) times. After that, throws `JudgeMalformedJsonError`
 * (STOP+surface — the caller halts scoring + notifies). Pure aside from the
 * `callJudge` seam.
 */
export async function gradeSlice(input: GradeSliceInput): Promise<SliceGrade> {
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  let nudge: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const systemPrompt = buildSystemPrompt(input.axis, nudge);
    const raw = await input.callJudge(systemPrompt, input.slice);
    const grade = parseGrade(raw);
    if (grade !== null) return grade;
    nudge = `Your last response was not valid JSON. Respond with ONLY the JSON object {"pass": <bool>, "evidence": "<string>"}.`;
  }
  throw new JudgeMalformedJsonError(input.axis, maxRetries + 1);
}
