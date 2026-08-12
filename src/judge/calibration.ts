// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Judge calibration gate. Before the judge grades real runs, it must be
// calibrated against a hand-scored reference set: a judge that disagrees with
// the operator on simple reference cases cannot be trusted on real ones. The
// gate is two-pronged:
//
//   (1) binary agreement  >= 0.85 — on the binary axes the judge's pass/fail
//       must match the operator's gold on >=85% of reference samples.
//   (2) comparative rank  >= 0.80 — on the comparative axes a slot passes only
//       when EVERY gold arm lands within +/-1 of its gold position; >=80% of
//       slots must pass (an empty/omitting judge order fails a non-empty slot).
//
// A failing gate STOP-and-surfaces: the bench halts scoring + notifies the
// operator (the judge needs re-prompting / a stronger model / more calibration
// samples). Never silently scores under an uncalibrated judge.
//
// The LLM calls are the same `CallJudge` (binary, reusing the slice grader) + a
// `RankSlices` seam (comparative — the real ranking call is built in the
// trajectory-judge task). Both are injectable so the gate is fully testable with
// no cloud dependency.

import type { MetricId } from "../metrics/defs.js";
import { BINARY_METRICS, COMPARATIVE_METRICS } from "../metrics/defs.js";
import { type CallJudge, gradeSlice } from "./single-call.js";

/** The calibration gate: >=85% binary agreement. */
export const BINARY_GATE = 0.85;
/** The calibration gate: +/-1 rank on >=80% of slots. */
export const RANK_GATE = 0.8;
/** ±1 rank window (a judge rank within ±1 of gold counts as a match). */
const RANK_TOLERANCE = 1;

/** A binary-axis reference sample (hand-scored pass/fail). */
export interface BinaryCalibrationSample {
  readonly kind: "binary";
  readonly id: string;
  /** A binary axis (a BINARY_METRICS member). */
  readonly axis: MetricId;
  /** The slice content for this sample. */
  readonly slice: string;
  /** The operator's gold pass/fail. */
  readonly goldPass: boolean;
}

/** A comparative-axis reference slot (hand-ranked arm order). */
export interface ComparativeCalibrationSample {
  readonly kind: "comparative";
  readonly id: string;
  /** A comparative axis (a COMPARATIVE_METRICS member). */
  readonly axis: MetricId;
  /** The arms' slice contents, keyed by arm id. */
  readonly armSlices: Readonly<Record<string, string>>;
  /** The operator's gold order (arm ids, best → worst). */
  readonly goldOrder: readonly string[];
}

/** A calibration sample (discriminated by kind). */
export type CalibrationSample = BinaryCalibrationSample | ComparativeCalibrationSample;

/**
 * The comparative-ranking judge seam: given an axis + the arms' slice contents,
 * return the judge's ordering (arm ids, best → worst). The real adapter (built in
 * Task 16b) wraps the comparative-ranking call over the enabled arms' slices.
 */
export type RankSlices = (axis: MetricId, armSlices: Readonly<Record<string, string>>) => Promise<readonly string[]>;

/** Inputs to {@link runCalibrationGate}. */
export interface CalibrationGateInput {
  readonly callJudge: CallJudge;
  readonly rankSlices: RankSlices;
  readonly samples: readonly CalibrationSample[];
}

/** Result of {@link runCalibrationGate}. */
export interface CalibrationGateResult {
  /** True iff both gates pass (or the respective sample set is empty). */
  readonly pass: boolean;
  /** Fraction of binary samples where the judge matched gold (0 when no binary samples). */
  readonly binaryAgreement: number;
  /** Fraction of slots whose WHOLE judge order is within +/-1 of gold (0 when none). */
  readonly rankAccuracy: number;
  readonly binaryCount: number;
  readonly comparativeCount: number;
  /** Sample ids that disagreed (binary mismatch; or a comparative slot where any gold arm was missing OR landed > +/-1 from its gold position). */
  readonly failures: readonly string[];
}

function assertBinaryAxis(axis: MetricId): void {
  if (!(BINARY_METRICS as readonly string[]).includes(axis)) {
    throw new Error(`binary calibration sample uses non-binary axis ${axis}`);
  }
}

function assertComparativeAxis(axis: MetricId): void {
  if (!(COMPARATIVE_METRICS as readonly string[]).includes(axis)) {
    throw new Error(`comparative calibration sample uses non-comparative axis ${axis}`);
  }
}

/**
 * Does the judge's order pass ONE slot: every gold arm present in the judge's
 * order AND within +/-1 of its gold position. A vacuous slot (empty gold) passes.
 * A judge order that omits every gold arm, or is empty, fails a non-empty slot
 * (never let a broken/empty ranking report perfect accuracy).
 */
function slotPasses(goldOrder: readonly string[], judgeOrder: readonly string[]): boolean {
  if (goldOrder.length === 0) return true; // vacuous slot
  for (let pos = 0; pos < goldOrder.length; pos++) {
    const arm = goldOrder[pos];
    const judgePos = judgeOrder.indexOf(arm);
    if (judgePos === -1) return false; // arm missing from the judge order -> slot fails
    if (Math.abs(judgePos - pos) > RANK_TOLERANCE) return false;
  }
  return true;
}

/**
 * Run the calibration gate over the hand-scored reference set. Grades each binary
 * sample via `gradeSlice` (reusing `callJudge`) + ranks each comparative slot via
 * `rankSlices`, then compares to gold. STOP-and-surfaces via a `pass: false`
 * result — the caller notifies + halts scoring. THROWS `JudgeMalformedJsonError`
 * (from `gradeSlice`) if a binary sample's judge response stays malformed past
 * its re-prompt budget — the caller treats that as STOP+surface too. Pure aside
 * from the seams.
 */
export async function runCalibrationGate(input: CalibrationGateInput): Promise<CalibrationGateResult> {
  const failures: string[] = [];
  let binaryMatched = 0;
  let binaryTotal = 0;
  let rankPassed = 0;
  let rankSlots = 0;

  for (const sample of input.samples) {
    if (sample.kind === "binary") {
      assertBinaryAxis(sample.axis);
      binaryTotal += 1;
      const grade = await gradeSlice({ axis: sample.axis, slice: sample.slice, callJudge: input.callJudge });
      if (grade.pass === sample.goldPass) binaryMatched += 1;
      else failures.push(sample.id);
    } else {
      assertComparativeAxis(sample.axis);
      rankSlots += 1;
      const judgeOrder = await input.rankSlices(sample.axis, sample.armSlices);
      if (slotPasses(sample.goldOrder, judgeOrder)) rankPassed += 1;
      else failures.push(sample.id); // any slot that does not fully match is flagged
    }
  }

  const binaryAgreement = binaryTotal === 0 ? 1 : binaryMatched / binaryTotal;
  const rankAccuracy = rankSlots === 0 ? 1 : rankPassed / rankSlots;
  // A gate is satisfied if its threshold is met OR its sample set is empty (trivial).
  const binaryOk = binaryTotal === 0 || binaryAgreement >= BINARY_GATE;
  const rankOk = rankSlots === 0 || rankAccuracy >= RANK_GATE;
  return {
    pass: binaryOk && rankOk,
    binaryAgreement,
    rankAccuracy,
    binaryCount: binaryTotal,
    comparativeCount: rankSlots,
    failures,
  };
}
