// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The stateful bench-run widget controller. Owns the {@link WidgetState} +
// the two-tier streaming-token accumulator; publishes the rendered line through
// injectable {@link WidgetDeps} (the publish target is TUI-only — a non-TUI ctx
// yields null deps + an inert controller). Throttled re-render: leading render
// on the first change in a 200ms window, plus a single trailing flush capturing
// the settled state — no polling loop.
//
// The widget shows the BACKGROUND agent (user-simulator build/resume, judge
// score) — the harness subscribes this controller to that agent's event stream.
// The main eval agent is already visible in pi's TUI and is NOT mirrored here.

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { log } from "../log.js";
import { deltaTextOf, deltaTokens, messageEndUsage, streamedOutputUsage } from "../runtime/streaming-tokens.js";
import { getTermWidth } from "./fitline.js";
import {
  fitThemedRenderedLine,
  type JudgeUsage,
  PHASE_ORDER,
  type WidgetPhase,
  type WidgetState,
  type WidgetStatus,
} from "./render.js";

/** Throttle window (ms) — leading + trailing edge. */
const THROTTLE_MS = 200;

/** No detail — the named null for `startPhase`'s detail arg (no-bare-literals). */
export const NO_DETAIL: string | null = null;

/** The widget key + placement (above the editor). */
export const WIDGET_KEY = "bench_compact_progress";
export const WIDGET_PLACEMENT = "aboveEditor" as const;

/** The safe-degrade blank painted when the themed render throws. */
const WIDGET_FALLBACK_LINE = "";

/** `setWidget` is not on the no-bare-literals allowlist → a bare `undefined`
 *  2nd arg fails lint; pass this named constant to hide the line. */
const HIDE_WIDGET: undefined = undefined;

/** A timer handle (opaque across Node + the test seam). */
export type WidgetTimer = ReturnType<typeof setTimeout>;

/** Fully-injected runtime + publishing surface. `null` deps → inert controller
 *  (non-TUI ctx). `termWidth`/`publish`/`hide` are pure seams for testability. */
export interface WidgetDeps {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => WidgetTimer;
  readonly clearTimeout: (handle: WidgetTimer) => void;
  /** Usable terminal width for the fit (default {@link getTermWidth}). */
  readonly termWidth: () => number;
  /** Publish the rendered (already fit) line. */
  /** Publish a render pass: the TUI hands the live theme to the setWidget renderFn,
   *  and the fitted + themed line is computed per render. */
  readonly publish: (render: (theme: Theme) => string) => void;
  /** Hide the widget line. */
  readonly hide: () => void;
}

/** Default state: build phase, running, no arm/tool/counters. */
const DEFAULT_STATE: WidgetState = {
  phase: "build",
  status: "running",
  armIndex: null,
  armTotal: null,
  tool: null,
  detail: null,
  ctxUsage: null,
  ctxWindow: null,
  tok: null,
  judgeUsages: null,
  hint: null,
};

/**
 * The bench-run widget controller. Construct one per run (cheap). When `deps`
 * is null (non-TUI) every method is a no-op — the harness freely calls into an
 * inert controller in batch/print mode.
 */
export class WidgetController {
  private state: WidgetState;
  private primaryTokens = 0; // two-tier provider-output max (per request)
  private fallbackTokens = 0; // two-tier chars/4 accumulation (per request)
  private shown = false;
  private lastRender = 0;
  private trailing: WidgetTimer | null = null;

  constructor(
    private readonly deps: WidgetDeps | null,
    initial: Partial<WidgetState>,
  ) {
    this.state = { ...DEFAULT_STATE, ...initial };
  }

  // --- arm counter (omitted during build — harness leaves armIndex null) ---
  setArm(index: number, total: number, tool: string): void {
    this.state = { ...this.state, armIndex: index, armTotal: total, tool };
    this.schedule();
  }

  /** Clear the arm counter (cross-arm stages — comparative scoring — where no
   *  single arm is the subject; the counter segment is omitted until set again). */
  clearArm(): void {
    this.state = { ...this.state, armIndex: null, armTotal: null, tool: null };
    this.schedule();
  }

  // --- phase progression ---
  startPhase(phase: WidgetPhase, detail: string | null): void {
    // A phase boundary retires the background-agent segments: ctx/tok belong to
    // the CURRENT phase's background agent (observer / authoring / simulator /
    // judge). Without this reset, a finished agent's last request lingers into a
    // phase that runs no background agent (e.g. probes on the main session).
    this.primaryTokens = 0;
    this.fallbackTokens = 0;
    this.state = { ...this.state, phase, detail, status: "running", ctxUsage: null, ctxWindow: null, tok: null };
    this.schedule();
  }

  setDetail(detail: string | null): void {
    this.state = { ...this.state, detail };
    this.schedule();
  }

  /** Advance to the next phase in {@link PHASE_ORDER} (build→…→score). No-op at score. */
  advancePhase(): void {
    const idx = PHASE_ORDER.indexOf(this.state.phase);
    const next = PHASE_ORDER[idx + 1];
    if (next !== undefined) this.startPhase(next, NO_DETAIL);
  }

  /** Terminal status — `done` (bar all ■, stays visible) / `stopped` (stays at phase). */
  setStatus(status: WidgetStatus, hint: string | null): void {
    this.state = { ...this.state, status, hint };
    this.schedule();
  }

  /** Harness sets the background agent's context window when it starts the agent. */
  setCtxWindow(ctxWindow: number | null): void {
    this.state = { ...this.state, ctxWindow };
    this.schedule();
  }

  /** Set the per-judge usage list (score phase — K parallel judges). Replaces the
   *  single-agent ctx/tok segments; null clears it back. */
  setJudgeUsages(list: readonly JudgeUsage[] | null): void {
    this.state = { ...this.state, judgeUsages: list };
    this.schedule();
  }

  // --- background-agent event stream (user-simulator / judge) ---
  onEvent(event: AgentEvent): void {
    if (this.deps === null) return;
    if (event.type === "message_start") {
      // New request → reset the current-request token tiers (reset per request).
      this.primaryTokens = 0;
      this.fallbackTokens = 0;
      this.state = { ...this.state, tok: 0 };
    } else if (event.type === "message_end") {
      const u = messageEndUsage((event as { message: Parameters<typeof messageEndUsage>[0] }).message);
      if (u !== null) this.state = { ...this.state, ctxUsage: u.totalTokens };
    } else if (event.type === "message_update") {
      // Two-tier: provider usage.output (primary, running max) + chars/4 fallback
      // (accumulates so the counter always moves, incl. during extended thinking).
      const streamed = streamedOutputUsage(event);
      if (streamed !== null && streamed > this.primaryTokens) this.primaryTokens = streamed;
      const delta = deltaTextOf(event);
      if (delta !== null) this.fallbackTokens += deltaTokens(delta);
      this.state = { ...this.state, tok: Math.max(this.primaryTokens, this.fallbackTokens) };
    } else {
      return; // turn_start/tool_* etc. — no widget state change
    }
    this.schedule();
  }

  // --- lifecycle ---
  /** Show immediately (leading render). */
  show(): void {
    if (this.deps === null) return;
    this.shown = true;
    this.render();
  }

  /** Hide the line + cancel any pending trailing render. */
  hide(): void {
    if (this.deps === null) return;
    this.shown = false;
    if (this.trailing !== null) {
      this.deps.clearTimeout(this.trailing);
      this.trailing = null;
    }
    this.deps.hide();
  }

  // --- throttled render (leading + trailing, no polling) ---
  private schedule(): void {
    if (this.deps === null || !this.shown) return;
    const elapsed = this.deps.now() - this.lastRender;
    if (elapsed >= THROTTLE_MS) {
      this.render(); // leading edge
    } else if (this.trailing === null) {
      // schedule a single trailing flush capturing the latest state
      const wait = THROTTLE_MS - elapsed;
      this.trailing = this.deps.setTimeout(() => {
        this.trailing = null;
        this.render();
      }, wait);
    }
  }

  private render(): void {
    if (this.deps === null) return;
    this.lastRender = this.deps.now();
    const deps = this.deps;
    if (deps === null) return;
    this.deps.publish((theme) => fitThemedRenderedLine(this.state, theme, deps.termWidth()));
  }
}

/**
 * Build TUI {@link WidgetDeps} from a pi {@link ExtensionContext}, or `null`
 * when the ctx is not a TUI (rpc/json/print → inert controller). The publish
 * wraps the fit line in a pi-tui `Text` via `ctx.ui.setWidget`; hide passes
 * `undefined` (the no-bare-literals-safe hide value).
 */
export function makeTuiWidgetDeps(ctx: {
  mode: string;
  hasUI: boolean;
  ui: { setWidget: (key: string, content: unknown, opts: { placement: string }) => void };
}): WidgetDeps | null {
  if (ctx.mode !== "tui" || !ctx.hasUI) return null;
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    termWidth: getTermWidth,
    publish: (render) => {
      // The TUI hands the live theme to the renderFn on every paint — the fitted
      // line is computed (and colored) per render (the sibling widgets' pattern).
      // A throwing render (bad state, theme shape drift) must not kill the TUI
      // paint loop: log the fault and paint a blank line instead.
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui: unknown, theme: Theme) => {
          try {
            return new Text(render(theme), 0, 0);
          } catch (err) {
            log.error("bench widget render threw (painting blank)", err);
            return new Text(WIDGET_FALLBACK_LINE, 0, 0);
          }
        },
        {
          placement: WIDGET_PLACEMENT,
        },
      );
    },
    hide: () => {
      ctx.ui.setWidget(WIDGET_KEY, HIDE_WIDGET, { placement: WIDGET_PLACEMENT });
    },
  };
}

// --- stage-hook binding (shared by the simulator + judge transports) ------

/** The widget hooks a background-agent stage forwards: the event sink (drives the
 *  two-tier accumulator) + the model-resolved hook (sets the ctx window). */
export interface WidgetStageHooks {
  readonly onEvent: (event: AgentEvent) => void;
  readonly onModelResolved: (model: Model<Api>) => void;
}

/** Build the widget stage-hook pair bound to `widget`, or `undefined` when the widget
 *  is absent (non-TUI). Shared by the user-simulator factory (resume) + the judge
 *  transport (score) so the `.bind` + `setCtxWindow` plumbing lives in one place.
 *  Callers that must suppress ctx/tok (e.g. K>1 parallel judges whose events would
 *  interleave into the shared accumulator) pass `undefined` instead. */
export function widgetStageHooks(
  widget: { onEvent(event: AgentEvent): void; setCtxWindow(ctxWindow: number | null): void } | null | undefined,
): WidgetStageHooks | undefined {
  if (widget === null || widget === undefined) return undefined;
  return {
    onEvent: widget.onEvent.bind(widget),
    onModelResolved: (model) => widget.setCtxWindow(model.contextWindow ?? null),
  };
}

// --- per-judge score hooks (K parallel judges → per-slot usage list) --------

/** The judge-tagged hooks the score phase forwards: like {@link WidgetStageHooks}
 *  but every callback carries the judge's ensemble index (0-based) so K parallel
 *  judge streams keep SEPARATE per-slot accumulators instead of interleaving into
 *  one. */
export interface JudgeStageHooks {
  readonly onEvent: (event: AgentEvent, judge: number) => void;
  readonly onModelResolved: (model: Model<Api>, judge: number) => void;
}

/** One judge slot's mutable two-tier accumulator (mirror of the controller's
 *  single-agent fields, scoped to one judge stream). */
interface JudgeSlot {
  primaryTokens: number;
  fallbackTokens: number;
  ctxUsage: number | null;
  ctxWindow: number | null;
}

const newSlot = (): JudgeSlot => ({ primaryTokens: 0, fallbackTokens: 0, ctxUsage: null, ctxWindow: null });

/** Build the per-judge score hooks. Events from concurrent judge calls land in
 *  their own slot (keyed by the ensemble index); every event republishes the
 *  slot list (in index order) via `setJudgeUsages`. The widget is resolved
 *  lazily per event (the run command owns the active-widget lifecycle — hooks
 *  built once per score-deps must survive widget re-creation). Null widget →
 *  inert hooks (non-TUI). */
export function scoreJudgeHooks(
  getWidget: () => { setJudgeUsages(list: readonly JudgeUsage[] | null): void } | null,
): JudgeStageHooks {
  const slots = new Map<number, JudgeSlot>();
  const slotOf = (judge: number): JudgeSlot => {
    let slot = slots.get(judge);
    if (slot === undefined) {
      slot = newSlot();
      slots.set(judge, slot);
    }
    return slot;
  };
  const publish = (): void => {
    const widget = getWidget();
    if (widget === null) return;
    const list: JudgeUsage[] = [...slots.keys()]
      .sort((a, b) => a - b)
      .map((judge) => {
        const s = slots.get(judge) as JudgeSlot;
        return { ctxUsage: s.ctxUsage ?? 0, ctxWindow: s.ctxWindow, tok: Math.max(s.primaryTokens, s.fallbackTokens) };
      });
    widget.setJudgeUsages(list);
  };
  return {
    onEvent: (event, judge) => {
      const slot = slotOf(judge);
      if (event.type === "message_start") {
        // New request → reset THIS judge's current-request token tiers.
        slot.primaryTokens = 0;
        slot.fallbackTokens = 0;
      } else if (event.type === "message_end") {
        const u = messageEndUsage((event as { message: Parameters<typeof messageEndUsage>[0] }).message);
        if (u !== null) slot.ctxUsage = u.totalTokens;
      } else if (event.type === "message_update") {
        const streamed = streamedOutputUsage(event);
        if (streamed !== null && streamed > slot.primaryTokens) slot.primaryTokens = streamed;
        const delta = deltaTextOf(event);
        if (delta !== null) slot.fallbackTokens += deltaTokens(delta);
      } else {
        return; // turn_start/tool_* etc. — no state change
      }
      publish();
    },
    onModelResolved: (model, judge) => {
      slotOf(judge).ctxWindow = model.contextWindow ?? null;
      publish();
    },
  };
}
