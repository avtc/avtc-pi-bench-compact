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

import { fitLine, joinSegments, type Segment } from "./fitline.js";

/** The 6 progression phases, in cell order (build → extract → compact → eval → probe → score). */
export const PHASE_ORDER = ["build", "extract", "compact", "eval", "probe", "score"] as const;
export type WidgetPhase = (typeof PHASE_ORDER)[number];

/** Terminal states. `running` is mid-phase; `done`/`stopped`/`prepared` stay visible.
 *  `prepared` is the prepare-scenario completion (build+extract done, run not started) —
 *  cells 0-1 ■, rest □, label "prepared" (distinct from the all-■ run-`done`). */
export type WidgetStatus = "running" | "done" | "stopped" | "prepared";

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
  /** Trailing hint (e.g. "/bench-compact:results" on done). */
  readonly hint: string | null;
}

/** The 🅑 marker prefixing every line, followed by a SINGLE space (not ` · ` —
 *  the design glues it to the first content segment: `🅑 <arm|phase-bar>`). */
export const GLYPH_PREFIX = "🅑 ";

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
  return state.status === "running" && state.phase !== "compact" && state.ctxUsage !== null && state.tok !== null;
}

/** The 6-cell phase-bar.
 *  - `done` → all ■.
 *  - `prepared` → build+extract (cells 0-1) ■, rest □ (prepare complete, run pending).
 *  - else cells before the active phase = ■, active = ◧, after = □. */
function phaseBar(state: WidgetState): string {
  if (state.status === "done") return CELL_DONE.repeat(PHASE_ORDER.length);
  if (state.status === "prepared") {
    return PHASE_ORDER.map((_, i) => (i <= PREPARED_LAST_DONE_CELL ? CELL_DONE : CELL_PENDING)).join("");
  }
  const activeIdx = PHASE_ORDER.indexOf(state.phase);
  return PHASE_ORDER.map((_, i) => (i < activeIdx ? CELL_DONE : i === activeIdx ? CELL_ACTIVE : CELL_PENDING)).join("");
}

/** Format a context-token count: `K` (>=1000, rounded), else raw. */
function formatCtxTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
}

/** Format the current-request output-token progress: `k` with 1 decimal. */
function formatTokTokens(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

/** The phase label: terminal name when done/prepared, else `<phase>[ <detail>]`. */
function phaseLabel(state: WidgetState): string {
  if (state.status === "done") return "done";
  if (state.status === "prepared") return "prepared";
  return state.detail === null ? state.phase : `${state.phase} ${state.detail}`;
}

/**
 * Build the ordered content segment list for the line (the 🅑 glyph prefix is
 * prepended separately by {@link renderLine}). The tool name (the FIRST segment
 * when an arm counter is present) is the single elastic segment; all others are
 * fixed. Exposed so the tracker can fit it to the terminal width via `fitLine`.
 */
export function buildContentSegments(state: WidgetState): Segment[] {
  const segs: Segment[] = [];

  // Arm counter (omitted during build/extract + the done/prepared terminals — no per-arm tool there).
  if (
    state.status !== "done" &&
    state.status !== "prepared" &&
    state.armIndex !== null &&
    state.armTotal !== null &&
    state.tool !== null
  ) {
    segs.push({ prefix: `${state.armIndex}/${state.armTotal} `, tail: state.tool });
  }

  // Phase-bar + phase label (always present).
  segs.push(`${phaseBar(state)} ${phaseLabel(state)}`);

  // ctx/tok (background agent generating, not compact).
  if (showCtxTok(state)) {
    const window = state.ctxWindow ?? 0;
    segs.push(`ctx ${formatCtxTokens(state.ctxUsage as number)}/${formatCtxTokens(window)}`);
    segs.push(`${formatTokTokens(state.tok as number)} tok`);
  }

  // Status word (stopped only; running has none; done is folded into the label).
  if (state.status === "stopped") {
    segs.push("stopped");
  }

  // Hint (trailing pointer).
  if (state.hint !== null) {
    segs.push(state.hint);
  }

  return segs;
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
