// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The mechanical probe leak-gate: instant, LLM-free, HIGH-PRECISION detection of
// answers that are already recoverable from the compacted agent's own context
// (the compaction summary / the kept tail). Runs before the LLM probe validator
// on every add_*_probe call; anything it flags needs no semantic judgment.
//
// Two checks only — both chosen so a hit is essentially never a false positive:
//   1. NUMERIC literals from accept[] appearing in summary/tail. Numbers are
//      unambiguous answer-essence (values, percentages, measured outputs), and
//      the observed tail-leak failure mode was exactly numeric (arc tables:
//      "17.2%", "-$0.9B"). Topic words in the summary are fine (cued probes are
//      legitimate by design) — names and identifiers are deliberately NOT
//      checked mechanically, because a topic word can appear inside an accept
//      phrasing without the answer being present; those cases belong to the
//      LLM validator, which can weigh substance.
//   2. LONG VERBATIM accept[] phrases (≥30 normalized chars) appearing in
//      summary/tail — a restated answer, whitespace/case-insensitive.
//
// Pure; returns a one-line problem description or null.

/** Minimal probe shape the gate reads. */
export interface LeakGateProbe {
  readonly question: string;
  readonly accept: readonly string[];
}

/** The texts a compacted agent still sees. */
export interface LeakGateTexts {
  readonly summary: string;
  readonly tail: string;
}

/** Numbers worth checking: at least 2 significant chars (skips bare turn/small numbers). */
const NUMBER_PATTERN = /\d[\d.,]*\d|\d{2,}/g;
/** A verbatim phrase must be at least this many normalized characters to count. */
const VERBATIM_MIN_CHARS = 30;

/** Normalize text for verbatim comparison: collapse whitespace, lowercase. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Extract distinctive numeric literals from an accept phrasing. */
function numbersOf(acceptItem: string): readonly string[] {
  return (acceptItem.match(NUMBER_PATTERN) ?? []).map((n) => n.replace(/[.,]+$/, ""));
}

/**
 * Check one probe against the summary + tail. Returns a one-line problem
 * description when an answer element is mechanically recoverable, else null.
 * Pure.
 */
export function mechanicalLeak(probe: LeakGateProbe, texts: LeakGateTexts): string | null {
  const summary = normalize(texts.summary);
  const tail = normalize(texts.tail);
  for (const item of probe.accept) {
    for (const num of numbersOf(item)) {
      const where = summary.includes(num) ? "summary" : tail.includes(num) ? "tail" : null;
      if (where !== null) {
        return `answer value "${num}" from accept[] already appears in the ${where} — the probe is answerable from context`;
      }
    }
    const phrase = normalize(item);
    if (phrase.length >= VERBATIM_MIN_CHARS) {
      const where = summary.includes(phrase) ? "summary" : tail.includes(phrase) ? "tail" : null;
      if (where !== null) {
        return `an accept[] phrasing appears verbatim in the ${where} — the probe is answerable from context`;
      }
    }
  }
  return null;
}
