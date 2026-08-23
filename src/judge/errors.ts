// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared base for every judge-stage STOP+surface failure. The bench never
// auto-recovers a judge failure — it surfaces it (stop-and-surface) — so the
// orchestrate layer (run.ts) catches these, records WHY the run/arm failed in
// the result report, and notifies the operator. A single base + a `category`
// discriminator lets that layer classify by `instanceof BenchJudgeError` +
// `.category` instead of parsing message strings.
//
// Convention: each judge module throws `BenchJudgeError` (or a subclass) with a
// stable `category`. The message is human-readable + stage-prefixed; `category`
// is the machine-readable reason.

/** Why a judge stage STOP-and-surfaced. */
export type JudgeErrorCategory =
  /** The resolved model was unavailable (no judge/authoring model configured). */
  | "model-unavailable"
  /** The stage exceeded its time budget before the terminal tool was called. */
  | "timeout"
  /** The stage was aborted via the run signal. */
  | "aborted"
  /** The agent finished without ever calling the terminal tool (no capture). */
  | "no-capture"
  /** The agent finished without the terminal tool AT >=95% of the model's
   *  context window — it died on the window (common with local models that
   *  degrade to a plain reply instead of erroring), not on a lucid refusal. */
  | "context-exhausted"
  /** The judge emitted valid JSON but an incomplete/wrong set (missing/unknown/dup). */
  | "incomplete-output"
  /** The judge emitted malformed JSON that stayed unparseable past maxRetries. */
  | "malformed-json";

/** Base class for every judge-stage STOP+surface failure. */
export class BenchJudgeError extends Error {
  constructor(
    readonly category: JudgeErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "BenchJudgeError";
  }
}
