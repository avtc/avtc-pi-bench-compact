// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pure render of the live-progress widget line. The tracker owns the
// (throttled) publishing to ctx.ui.setWidget; this module owns the line's shape:
// which segments appear, in what order, and how tokens format. The tool name is
// the one elastic segment (middle-elided by fitLine when the line overflows the
// terminal); every other segment is fixed.
//
// Layout: `🅑 [<armN>/<total> <tool> ·] <phase-bar> <phase>[ <detail>]
//         [ · ctx <u>/<w> · <tok> tok][ · <status> · <hint>]`
//
// The widget shows the BACKGROUND agent (user-simulator build/resume, judge
// score) — NOT the main eval agent (already visible in pi's TUI). compact
// EXCLUDES ctx/tok: each memory tool renders its own progress widget for its
// internal stages, so the bench doesn't duplicate them.

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { fitLine, fitSegments, joinSegments, type Segment } from "./fitline.js";

/** The progression phases, in cell order (build → extract → compact → latent → eval → probe → score). */
export const PHASE_ORDER = ["build", "extract", "compact", "latent", "eval", "probe", "score"] as const;
export type WidgetPhase = (typeof PHASE_ORDER)[number];

/** Terminal states. `running` is mid-phase; `done`/`stopped`/`prepared` stay visible.
 *  `prepared` is the prepare-scenario completion (build+extract done, run not started) —
 *  cells 0-1 ■, rest □, label "prepared" (distinct from the all-■ run-`done`). */
export type WidgetStatus = "running" | "done" | "stopped" | "prepared";

/** One parallel judge's live usage (the score phase's per-judge ctx/tok
 *  segments — judges may run different models with different windows). */
export interface JudgeUsage {
  /** The judge's context usage (its last message_end totalTokens). */
  readonly ctxUsage: number;
  /** The judge's context window; null while its model is unresolved. */
  readonly ctxWindow: number | null;
  /** The judge's current-request output-token progress (two-tier). */
  readonly tok: number;
}

/** Pure render-time snapshot of the bench-run tracker. `null` fields are
 *  omitted from the line (arm counter absent during build/done; ctx/tok absent
 *  when no background agent is generating). */
export interface WidgetState {
  /** Current progression phase. Ignored when `status === "done"` (bar = all ■). */
  readonly phase: WidgetPhase;
  /** Terminal status — `done` forces bar all ■ + phase-label "done"; `stopped`
   *  appends the status word + keeps the bar at the stop point. */
  readonly status: WidgetStatus;
  /** Arm counter numerator (`armIndex/armTotal`); null during build + done. */
  readonly armIndex: number | null;
  readonly armTotal: number | null;
  /** Tool name (the elastic segment); null when no arm counter. */
  readonly tool: string | null;
  /** Trailing detail on the phase label (e.g. "3/10" attempt, "5/7" probe). */
  readonly detail: string | null;
  /** Background agent's context usage (its last message_end totalTokens);
   *  null = omit the ctx/tok segment. Always omitted during `compact`. */
  readonly ctxUsage: number | null;
  /** Context window (the <w> in `ctx <u>/<w>`); null when ctx omitted. */
  readonly ctxWindow: number | null;
  /** Current-request output-token progress (two-tier); null = omit. */
  readonly tok: number | null;
  /** Per-judge live usage (score phase, K parallel judges); null = omit.
   *  When present this REPLACES the single-agent ctx/tok segments (the score
   *  phase drives no single background agent). */
  readonly judgeUsages: readonly JudgeUsage[] | null;
  /** Trailing hint (e.g. "/bench-compact:results" on done). */
  readonly hint: string | null;
}

/** The 🅑 marker prefixing every line, followed by a SINGLE space (not ` · ` —
 *  the design glues it to the first content segment: `🅑 <arm|phase-bar>`). */
const GLYPH_PREFIX = "🅑 ";

/** Cell glyphs: ■ done, ◧ active, □ pending. */
const CELL_DONE = "■";
const CELL_ACTIVE = "◧";
const CELL_PENDING = "□";
/** In the `prepared` terminal, build + extract (cells 0-1) are done; the rest pending. */
const PREPARED_LAST_DONE_CELL = 1;

/** True when ctx/tok should display (a background agent is generating + not a
 *  terminal status + phase isn't compact). compact always excludes ctx/tok because
 *  the memory tool renders its own widget; terminals (done/stopped/prepared) omit it. */
function showCtxTok(state: WidgetState): boolean {
  if (state.status !== "running" || state.phase === "compact") return false;
  if (showJudgeCtxTok(state)) return false; // the judge list replaces the single-agent segment
  return state.ctxUsage !== null && state.tok !== null;
}

/** True when the per-judge ctx/tok list should display (score phase, K parallel
 *  judges generating). */
function showJudgeCtxTok(state: WidgetState): boolean {
  return (
    state.status === "running" && state.phase === "score" && state.judgeUsages !== null && state.judgeUsages.length > 0
  );
}

/** One phase-bar cell with its theme color (success = done, accent = active,
 *  dim = pending — the sibling widgets' convention). */
interface PhaseCell {
  readonly glyph: string;
  readonly color: ThemeColor;
}

/** The 6 phase-bar cells.
 *  - `done` → all ■ (success).
 *  - `prepared` → build+extract (cells 0-1) ■, rest □ (prepare complete, run pending).
 *  - else cells before the active phase = ■, active = ◧, after = □. */
function phaseCells(state: WidgetState): PhaseCell[] {
  const cells: PhaseCell[] = [];
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    if (state.status === "done") {
      cells.push({ glyph: CELL_DONE, color: "success" });
      continue;
    }
    if (state.status === "prepared") {
      cells.push({ glyph: i <= PREPARED_LAST_DONE_CELL ? CELL_DONE : CELL_PENDING, color: "success" });
      continue;
    }
    const active = PHASE_ORDER.indexOf(state.phase);
    if (i < active) cells.push({ glyph: CELL_DONE, color: "success" });
    else if (i === active) cells.push({ glyph: CELL_ACTIVE, color: "accent" });
    else cells.push({ glyph: CELL_PENDING, color: "dim" });
  }
  return cells;
}

/** The plain (unthemed) bar text — must equal the themed one without colors. */
function phaseBar(state: WidgetState): string {
  return phaseCells(state)
    .map((c) => c.glyph)
    .join("");
}

/** The themed bar text (per-cell colors). */
function phaseBarThemed(state: WidgetState, theme: Theme): string {
  return phaseCells(state)
    .map((c) => theme.fg(c.color, c.glyph))
    .join("");
}

/** Format a context-token count: `M` (>= 1M, rounded), `K` (>= 1000, rounded),
 *  else raw. */
function formatCtxTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
}

/** Format the context window: `262K`, or `?` while unresolved (the model
 *  resolution is still in flight). Shared by the single-agent + judge segments. */
function formatCtxWindow(w: number | null): string {
  return w === null ? "?" : formatCtxTokens(w);
}

/** Format the current-request output-token progress: `k` with 1 decimal. */
function formatTokTokens(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

/** The phase label: terminal name when done/prepared, else the phase + its detail.
 *  The detail joins the phase with a single space (short counters, e.g. `eval 3/10`);
 *  the latent detail (the cued/uncued tally — already a ` · `-joined string) joins
 *  with ` · ` so every tally reads as a separate line part. */
function phaseLabel(state: WidgetState): string {
  if (state.status === "done") return "done";
  if (state.status === "prepared") return "prepared";
  if (state.detail === null) return state.phase;
  return state.phase === "latent" ? `${state.phase} · ${state.detail}` : `${state.phase} ${state.detail}`;
}

/**
 * Build the ordered content segment list for the line (the 🅑 glyph prefix is
 * prepended separately by {@link renderLine}). The tool name (the FIRST segment
 * when an arm counter is present) is the single elastic segment; all others are
 * fixed. Exposed so the tracker can fit it to the terminal width via `fitLine`.
 */
/** A renderable content part with its theme role. `cells` parts carry their own
 *  themed painter (the phase bar colors PER CELL); everything else takes one color. */
type Part =
  | { readonly kind: "fixed"; readonly text: string; readonly color: ThemeColor }
  | { readonly kind: "cells"; readonly text: string; readonly themed: (theme: Theme) => string }
  | { readonly kind: "elastic"; readonly prefix: string; readonly tail: string; readonly color: ThemeColor };

/** Theme roles (the sibling widgets' convention): identity muted, phase accent,
 *  counters dim, success/error for terminal states. */
const COLOR_TOOL = "muted" as const;
const COLOR_PHASE = "accent" as const;
const COLOR_COUNTER = "dim" as const;
const COLOR_STOPPED = "error" as const;
const COLOR_HINT = "dim" as const;
const COLOR_SUCCESS = "success" as const;

/** The ordered content parts (the 🅑 glyph prefix is prepended separately). The
 *  tool name (the first part when an arm counter is present) is the single
 *  elastic part; all others are fixed. */
function renderParts(state: WidgetState): Part[] {
  const parts: Part[] = [];

  // Arm counter (omitted during build/extract + the done/prepared terminals — no per-arm tool there).
  if (
    state.status !== "done" &&
    state.status !== "prepared" &&
    state.armIndex !== null &&
    state.armTotal !== null &&
    state.tool !== null
  ) {
    parts.push({
      kind: "elastic",
      prefix: `${state.armIndex}/${state.armTotal} `,
      tail: state.tool,
      color: COLOR_TOOL,
    });
  }

  // Phase-bar + phase label (always present, ONE part — a space joins them, not
  // the ` · ` segment separator). The cells part carries the per-cell themed bar +
  // the label (accent while running; success on the done/prepared terminals —
  // stopped keeps accent, its status word is the error).
  const labelColor: ThemeColor = state.status === "running" ? COLOR_PHASE : COLOR_SUCCESS;
  const label = phaseLabel(state);
  parts.push({
    kind: "cells",
    text: `${phaseBar(state)} ${label}`,
    themed: (theme) => `${phaseBarThemed(state, theme)} ${theme.fg(labelColor, label)}`,
  });

  /** Format one judge's ctx pair: `45K/262K`, or `45K/?` while its window is
   *  unresolved (the model resolution is still in flight). */
  function formatJudgeCtx(u: JudgeUsage): string {
    return `${formatCtxTokens(u.ctxUsage)}/${formatCtxWindow(u.ctxWindow)}`;
  }

  // ctx/tok (background agent generating, not compact).
  if (showJudgeCtxTok(state)) {
    const usages = state.judgeUsages as readonly JudgeUsage[];
    parts.push({
      kind: "fixed",
      text: `ctx ${usages.map(formatJudgeCtx).join(" ")}`,
      color: COLOR_COUNTER,
    });
    parts.push({
      kind: "fixed",
      text: `${usages.map((u) => formatTokTokens(u.tok)).join(" ")} tok`,
      color: COLOR_COUNTER,
    });
  } else if (showCtxTok(state)) {
    parts.push({
      kind: "fixed",
      text: `ctx ${formatCtxTokens(state.ctxUsage as number)}/${formatCtxWindow(state.ctxWindow)}`,
      color: COLOR_COUNTER,
    });
    parts.push({ kind: "fixed", text: `${formatTokTokens(state.tok as number)} tok`, color: COLOR_COUNTER });
  }

  // Status word (stopped only; running has none; done is folded into the label).
  if (state.status === "stopped") {
    parts.push({ kind: "fixed", text: "stopped", color: COLOR_STOPPED });
  }

  // Hint (trailing pointer).
  if (state.hint !== null) {
    parts.push({ kind: "fixed", text: state.hint, color: COLOR_HINT });
  }

  return parts;
}

/** Strip parts to plain fitline segments (fixed text / elastic prefix+tail). */
function partsToSegments(parts: readonly Part[]): Segment[] {
  return parts.map((p) => (p.kind === "elastic" ? { prefix: p.prefix, tail: p.tail } : p.text));
}

/** The plain content segments (single source: parts stripped). */
function buildContentSegments(state: WidgetState): Segment[] {
  return partsToSegments(renderParts(state));
}

/** Render the line (un-fit; the tracker applies `fitRenderedLine` to the width). */
export function renderLine(state: WidgetState): string {
  return GLYPH_PREFIX + joinSegments(buildContentSegments(state));
}

/** Render + fit the line to `termWidth`: reserve the `🅑 ` glyph prefix, then fit
 *  the content segments into the remainder (the tool name elides if needed). */
export function fitRenderedLine(state: WidgetState, termWidth: number): string {
  const contentWidth = termWidth - GLYPH_PREFIX.length;
  return GLYPH_PREFIX + fitLine(buildContentSegments(state), Math.max(contentWidth, 1));
}

/** The plain ` · ` separator between content parts (fits fitline's join). */
const SEGMENT_SEP_TEXT = " · ";
/** The bare glyph (colored at themed render; the plain prefix keeps its trailing space). */
const GLYPH = "🅑";
const GLYPH_SPACE = " ";

/** Render + fit + THEME the line (the widget's publish target — the TUI hands
 *  the live theme to the setWidget renderFn). Colors follow the sibling widgets'
 *  convention: glyph + phase accent, phase-bar cells success/accent/dim, tool
 *  muted, ctx/tok + hint dim, stopped error. Fitting is decided on PLAIN widths
 *  (theme codes never enter the width math), then colors wrap the fitted text. */
export function fitThemedRenderedLine(state: WidgetState, theme: Theme, termWidth: number): string {
  const parts = renderParts(state);
  const contentWidth = termWidth - GLYPH_PREFIX.length;
  const fitted = fitSegments(partsToSegments(parts), Math.max(contentWidth, 1));
  const body = fitted
    .map((seg, i) => {
      const part = parts[i] as Part;
      if (part.kind === "cells") return part.themed(theme);
      const text = typeof seg === "string" ? seg : `${seg.prefix}${seg.tail}`;
      return theme.fg(part.color, text);
    })
    .join(SEGMENT_SEP_TEXT);
  return `${theme.fg(COLOR_PHASE, GLYPH)}${GLYPH_SPACE}${body}`;
}
