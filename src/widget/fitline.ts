// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Elastic line-fitting for the live-progress widget. The bench renders a single
// full-width TUI line: fixed segments (🅑 marker, arm counter, phase-bar,
// phase name, ctx/tok counters, status/hint) joined by ` · `, with at most one
// elastic segment (the tool name) that middle-elides when the line overflows the
// terminal. Adapted from avtc-pi-featyard's fitLine (src/ui/featyard-widget.ts),
// simplified to a theme-less plain-string render (the bench widget carries no
// ANSI colors — only the 🅑/■/◧/□ glyphs).

/** A renderable line segment. A bare string is fixed (never shortened); an
 *  `{ prefix, tail }` is elastic — `prefix` is fixed, `tail` middle-elides. */
export type Segment = string | { readonly prefix: string; readonly tail: string };

/** The ` · ` separator between segments. */
export const SEGMENT_SEP = " · ";

/** Default terminal width when stdout.columns is unavailable. */
const TERM_DEFAULT = 80;
/** Safety margin (matches featyard — keeps the line off the right edge). */
const TERM_MARGIN = 2;

/** Usable terminal width (`process.stdout.columns` − margin, default 80). */
export function getTermWidth(): number {
  return (process.stdout.columns ?? TERM_DEFAULT) - TERM_MARGIN;
}

/** Middle-elide `text` to at most `maxLen` chars: keep head + tail, `…` between.
 *  maxLen<=0 → empty (never overflow); maxLen==1 → the ellipsis alone. */
export function elideMiddle(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (maxLen === 1) return "…";
  if (text.length <= maxLen) return text;
  const keep = maxLen - 1; // reserve 1 cell for the ellipsis
  const headLen = Math.ceil(keep / 2);
  const tailLen = keep - headLen;
  return `${text.slice(0, headLen)}…${text.slice(text.length - tailLen)}`;
}

/** Assemble segments with ` · ` separators (no elision). Exported so the
 *  render module reuses it (single source — avoids duplicating the join). */
export function joinSegments(segments: readonly Segment[]): string {
  return segments
    .map((s, i) => {
      const body = typeof s === "string" ? s : `${s.prefix}${s.tail}`;
      return i === 0 ? body : `${SEGMENT_SEP}${body}`;
    })
    .join("");
}

/** Length of the assembled line (no theme → plain char count). */
function lineWidth(segments: readonly Segment[]): number {
  return joinSegments(segments).length;
}

/**
 * Assemble segments with ` · ` separators; if the line overflows `termWidth`,
 * middle-elide the elastic-segment tails, sharing the available width
 * proportionally across whatever elastic segments are present. Fixed segments
 * (bare strings + elastic prefixes) are never shortened. When there are no
 * elastic segments, the line passes through unchanged even on overflow (the
 * caller's fixed segments are authoritative).
 */
export function fitLine(segments: readonly Segment[], termWidth: number): string {
  const elasticIdx = segments.map((s, i) => (typeof s === "string" ? -1 : i)).filter((i) => i >= 0);
  if (elasticIdx.length === 0 || lineWidth(segments) <= termWidth) {
    return joinSegments(segments);
  }

  const fullWidths = elasticIdx.map((i) => (segments[i] as { tail: string }).tail.length);
  // Width of everything except the elastic tail content (fixed segments +
  // separators + the elastic segments' fixed prefixes).
  const emptied = segments.map((s) => (typeof s === "string" ? s : { ...s, tail: "" }));
  const availForTails = termWidth - lineWidth(emptied);

  const budgets = proportionalBudgets(fullWidths, Math.max(availForTails, 0));
  const trimmed = segments.slice();
  for (let k = 0; k < elasticIdx.length; k++) {
    const i = elasticIdx[k] as number;
    const seg = segments[i] as { prefix: string; tail: string };
    trimmed[i] = { prefix: seg.prefix, tail: elideMiddle(seg.tail, budgets[k] as number) };
  }
  return joinSegments(trimmed);
}

/**
 * Allocate `total` cells across segments proportionally to their full widths,
 * each clamped to [1, fullWidth] (every tail stays visible), with the remainder
 * distributed to the largest fractional shares. If `total` already covers the
 * full widths, returns them unchanged (no trimming).
 */
function proportionalBudgets(fullWidths: readonly number[], total: number): number[] {
  const n = fullWidths.length;
  const sum = fullWidths.reduce((a, b) => a + b, 0);
  if (total >= sum) return fullWidths.slice(); // nothing to trim
  if (total <= 0) return fullWidths.map(() => 0);

  // Guarantee each tail at least 1 cell when the budget allows.
  let budget = total;
  const minPer = total >= n ? 1 : 0;
  budget -= minPer * n;

  const raw = fullWidths.map((w) => (sum > 0 ? (w * budget) / sum : 0));
  const floors = raw.map((r) => Math.max(0, Math.floor(r)));
  let leftover = budget - floors.reduce((a, b) => a + b, 0);

  // Hand leftover cells to the largest fractional remainders, capped at fullWidth-1.
  const cap = fullWidths.map((w) => w - minPer);
  const order = fullWidths.map((_, i) => i).sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])));
  let k = 0;
  while (leftover > 0 && k < n * 4) {
    const i = order[k % n] as number;
    if (floors[i] < (cap[i] ?? 0)) {
      floors[i] += 1;
      leftover--;
    }
    k++;
  }
  return floors.map((f) => f + minPer);
}
