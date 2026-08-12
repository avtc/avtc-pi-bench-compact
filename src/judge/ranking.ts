// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Comparative ranking of the enabled arms per axis (the comparative-channel
// metrics: resume / redo-plan / task-quality / goal). Two strategies:
//   - combined: rank all arms' anonymized, shuffled slices in ONE call (best —
//     fewest calls, but the combined slice must fit the judge's context window).
//   - pairwise: rank every C(N,2) pair in its own call + aggregate by win-count
//     (the fallback when the combined slice overflows).
// `auto` (default) picks combined when the slice fits a budget, else pairwise.
//
// Anonymization: arm ids are replaced with neutral labels (A, B, C...) and the
// presentation order is shuffled so the judge cannot infer arm identity from
// position. The label->armId map restores real ids in the returned order.
//
// The judge call is the `CallJudge` seam (maxTurns:1, no tools); malformed JSON
// is re-prompted <= maxRetries then STOP+surface. Pure aside from the seam.

import type { MetricId } from "../metrics/defs.js";
import { JUDGE_RUBRICS } from "./rubrics.js";
import { type CallJudge, extractJsonObject } from "./single-call.js";

/** A comparative ranking: arm ids best -> worst. */
export interface Ranking {
  readonly order: readonly string[];
}

/** How to rank: one combined call, all pairs, or pick by slice size. */
export type RankStrategy = "combined" | "pairwise" | "auto";

/** A shuffle of a list (used to anonymize presentation order). */
export type Shuffle<T> = (items: readonly T[]) => T[];

/** Options for {@link rankAxis}. */
export interface RankAxisOptions {
  readonly strategy?: RankStrategy;
  readonly maxRetries?: number;
  /** `auto` uses pairwise when the combined slice exceeds this many chars (default 50000). */
  readonly maxCombinedChars?: number;
}

/** Inputs to {@link rankAxis}. */
export interface RankAxisInput {
  readonly callJudge: CallJudge;
  readonly axis: MetricId;
  readonly armSlices: Readonly<Record<string, string>>;
  /**
   * REQUIRED: the presentation-order shuffle (anonymizes arm position to kill
   * position bias). No unsafe identity default: the wiring MUST inject a
   * real (seeded, recorded-for-reproducibility) shuffle.
   */
  readonly shuffle: Shuffle<string>;
  readonly options?: RankAxisOptions | null;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_COMBINED_CHARS = 50_000;

/** Internal: signal a malformed response that warrants one more re-prompt. */
class RankNeedsReprompt extends Error {
  constructor() {
    super("rank response malformed — re-prompt");
    this.name = "RankNeedsReprompt";
  }
}

/** Raised when the judge's ranking response stays malformed past maxRetries (STOP+surface). */
export class RankMalformedJsonError extends Error {
  constructor(
    readonly axis: MetricId,
    readonly reason: string,
  ) {
    super(`ranking for axis ${axis} malformed after retries — ${reason} — STOP+surface`);
    this.name = "RankMalformedJsonError";
  }
}

/** Neutral labels (A, B, C, ...) for `count` arms, in the order arm ids are given. */
function labelsFor(armIds: readonly string[]): string[] {
  if (armIds.length > 26) {
    throw new Error(`too many arms to anonymize (${armIds.length} > 26 labels A..Z) — STOP+surface`);
  }
  return armIds.map((_, i) => String.fromCharCode("A".charCodeAt(0) + i));
}

function effectiveOptions(options: RankAxisOptions | null | undefined): {
  maxRetries: number;
  maxCombinedChars: number;
  strategy: RankStrategy;
} {
  return {
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxCombinedChars: options?.maxCombinedChars ?? DEFAULT_MAX_COMBINED_CHARS,
    strategy: options?.strategy ?? "auto",
  };
}

/**
 * Call the judge with <= maxRetries re-prompts on malformed JSON. `parse` returns
 * the parsed value or throws RankNeedsReprompt (retry) / RankMalformedJsonError
 * (surface — e.g. an invented label). Shared by the combined + pairwise rankers.
 */
async function callJudgeWithRetry<T>(
  callJudge: CallJudge,
  baseSystem: string,
  body: string,
  parse: (raw: string, retriesLeft: number) => T,
  maxRetries: number,
  axis: MetricId,
): Promise<T> {
  let nudge: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const systemPrompt =
      nudge === null ? baseSystem : `${baseSystem}\n\nYour previous response was not valid JSON. ${nudge}`;
    const raw = await callJudge(systemPrompt, body);
    try {
      return parse(raw, maxRetries - attempt);
    } catch (error) {
      if (error instanceof RankNeedsReprompt) {
        nudge = "Respond with ONLY the JSON object shown above.";
        continue;
      }
      throw error;
    }
  }
  throw new RankMalformedJsonError(axis, `stayed malformed after ${maxRetries + 1} attempts`);
}

/** Parse + validate a combined {order:[labels]} response; throw on malformed. */
function parseOrderResponse(raw: string, knownLabels: ReadonlySet<string>, retries: number, axis: MetricId): string[] {
  const json = extractJsonObject(raw);
  if (json === null) {
    if (retries <= 0) throw new RankMalformedJsonError(axis, "no JSON object found");
    throw new RankNeedsReprompt();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    if (retries <= 0) throw new RankMalformedJsonError(axis, "JSON.parse failed");
    throw new RankNeedsReprompt();
  }
  const obj = parsed as { order?: unknown };
  if (!Array.isArray(obj.order) || obj.order.length === 0) {
    if (retries <= 0) throw new RankMalformedJsonError(axis, "missing/empty order array");
    throw new RankNeedsReprompt();
  }
  const labels = obj.order as unknown[];
  for (const label of labels) {
    if (typeof label !== "string" || !knownLabels.has(label)) {
      // R5: an invented label is tool-misuse -> re-prompt like other malformed JSON
      if (retries <= 0) throw new RankMalformedJsonError(axis, `unknown/invented label: ${String(label)}`);
      throw new RankNeedsReprompt();
    }
  }
  return labels as string[];
}

/** Parse a pairwise {better: label} response; throw RankNeedsReprompt / RankMalformedJsonError. */
function parsePairResponse(raw: string, known: ReadonlySet<string>, retries: number, axis: MetricId): string {
  const json = extractJsonObject(raw);
  if (json === null) {
    if (retries <= 0) throw new RankMalformedJsonError(axis, "no JSON object in pairwise response");
    throw new RankNeedsReprompt();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    if (retries <= 0) throw new RankMalformedJsonError(axis, "pairwise JSON.parse failed");
    throw new RankNeedsReprompt();
  }
  const better = (parsed as { better?: unknown }).better;
  if (typeof better !== "string" || !known.has(better)) {
    // R5: missing/unknown {better} is tool-misuse -> re-prompt like other malformed JSON
    if (retries <= 0)
      throw new RankMalformedJsonError(axis, `pairwise response missing/unknown better: ${String(better)}`);
    throw new RankNeedsReprompt();
  }
  return better;
}

/** Build the combined ranking prompt body (the anonymized, shuffled slices). */
function combinedSliceBody(labelToSlice: ReadonlyMap<string, string>, shuffle: Shuffle<string>): string {
  const labels = shuffle([...labelToSlice.keys()]);
  return labels.map((label) => `--- Arm ${label} ---\n${labelToSlice.get(label) ?? ""}`).join("\n\n");
}

/** Rank all arms in one combined call, with <= maxRetries re-prompts on malformed JSON. */
async function rankCombined(
  callJudge: CallJudge,
  axis: MetricId,
  labelToSlice: ReadonlyMap<string, string>,
  knownLabels: ReadonlySet<string>,
  maxRetries: number,
  shuffle: Shuffle<string>,
): Promise<string[]> {
  const baseSystem = [
    "You are a strict benchmark judge RANKING anonymized arms on one axis (best first).",
    JUDGE_RUBRICS[axis] ?? "",
    "",
    "Each arm is labeled with a neutral letter (A, B, C, ...). Rank them best -> worst.",
    'Respond with ONLY a JSON object: {"order": ["<label>", ...]} (best first, every label exactly once).',
  ].join("\n");
  const body = combinedSliceBody(labelToSlice, shuffle);
  return callJudgeWithRetry(
    callJudge,
    baseSystem,
    body,
    (raw, retriesLeft) => parseOrderResponse(raw, knownLabels, retriesLeft, axis),
    maxRetries,
    axis,
  );
}

/** Rank one pair; return the winner label. */
async function rankPair(
  callJudge: CallJudge,
  axis: MetricId,
  labelA: string,
  sliceA: string,
  labelB: string,
  sliceB: string,
  maxRetries: number,
  shuffle: Shuffle<string>,
): Promise<string> {
  const known = new Set([labelA, labelB]);
  const baseSystem = [
    "You are a strict benchmark judge comparing TWO anonymized arms on one axis.",
    JUDGE_RUBRICS[axis] ?? "",
    "",
    `Respond with ONLY a JSON object: {"better": "<${labelA}|${labelB}>"} (the better arm on this axis).`,
  ].join("\n");
  const [first, second] = shuffle([labelA, labelB]); // mitigate position bias
  const body = `--- Arm ${first} ---\n${first === labelA ? sliceA : sliceB}\n\n--- Arm ${second} ---\n${second === labelA ? sliceA : sliceB}`;
  return callJudgeWithRetry(
    callJudge,
    baseSystem,
    body,
    (raw, retriesLeft) => parsePairResponse(raw, known, retriesLeft, axis),
    maxRetries,
    axis,
  );
}

/** Rank every C(N,2) pair + aggregate by win-count (ties broken by arm id, ascending). */
async function rankPairwise(
  callJudge: CallJudge,
  axis: MetricId,
  labelToArm: ReadonlyMap<string, string>,
  labelToSlice: ReadonlyMap<string, string>,
  labels: readonly string[],
  maxRetries: number,
  shuffle: Shuffle<string>,
): Promise<string[]> {
  const wins = new Map<string, number>();
  for (const label of labels) wins.set(label, 0);
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i] as string;
      const b = labels[j] as string;
      const winner = await rankPair(
        callJudge,
        axis,
        a,
        labelToSlice.get(a) ?? "",
        b,
        labelToSlice.get(b) ?? "",
        maxRetries,
        shuffle,
      );
      wins.set(winner, (wins.get(winner) ?? 0) + 1);
    }
  }
  return [...labels].sort((x, y) => {
    const diff = (wins.get(y) ?? 0) - (wins.get(x) ?? 0);
    if (diff !== 0) return diff;
    const ax = labelToArm.get(x) ?? x;
    const ay = labelToArm.get(y) ?? y;
    return ax < ay ? -1 : ax > ay ? 1 : 0;
  });
}

/**
 * Rank the enabled arms on one axis. Anonymizes arm ids to neutral labels +
 * shuffles presentation order, then ranks (combined by default; pairwise when
 * the combined slice would overflow the budget). Re-prompts on malformed JSON
 * (<= maxRetries) then STOP+surfaces. Returns the arm-id order, best -> worst.
 * A single arm is ranked trivially with no judge call. Pure aside from the seam.
 */
export async function rankAxis(input: RankAxisInput): Promise<Ranking> {
  const armIds = Object.keys(input.armSlices).sort();
  if (armIds.length <= 1) {
    return { order: armIds };
  }
  const opts = effectiveOptions(input.options);
  const labels = labelsFor(armIds);
  const labelToArm = new Map(labels.map((label, i) => [label, armIds[i] as string]));
  const labelToSlice = new Map(labels.map((label, i) => [label, input.armSlices[armIds[i] as string] ?? ""]));
  const knownLabels = new Set(labels);

  const combinedChars = [...labelToSlice.values()].reduce((sum, s) => sum + s.length, 0);
  const usePairwise =
    opts.strategy === "pairwise" || (opts.strategy === "auto" && combinedChars > opts.maxCombinedChars);

  const rankedLabels = usePairwise
    ? await rankPairwise(input.callJudge, input.axis, labelToArm, labelToSlice, labels, opts.maxRetries, input.shuffle)
    : await rankCombined(input.callJudge, input.axis, labelToSlice, knownLabels, opts.maxRetries, input.shuffle);

  return { order: rankedLabels.map((label) => labelToArm.get(label) ?? label) };
}
