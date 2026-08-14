// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Phase-2 context monitor. The continuation runs are budget-bounded by the
// resolved model's context window (not a separate bench knob — overriding the
// window is forbidden; the model config owns it). This helper watches the active
// session's context usage each turn_end and fires `onApproachingWindow` when usage
// approaches the window, so the orchestration can steer the user-simulator to wrap
// up before the window fills (Phase-2 auto-compactions are allowed + captured, but
// the run should converge as the budget nears its ceiling).
//
// The monitor reads `ctx.getContextUsage()` — `.contextWindow` is the resolved
// model's window + `.tokens` is the current usage (null right after a compaction,
// before the next LLM response). It registers a `turn_end` listener on the FRESH
// `pi` (the one re-stashed by activation after a session switch — the command-
// handler pi goes stale on switchSession). The ctx is the fresh session ctx (held
// here, read live each turn_end): the raw event-bus handler receives only the event
// data, so the ctx cannot be pulled from the handler args and must be threaded in.

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subscribeAgentEvent } from "../session/events.js";

/** Default fire threshold — 90% of the model's context window. Dimensionless ratio. */
const DEFAULT_WINDOW_THRESHOLD = 0.9;

/** The narrow ctx surface the monitor reads (keeps the public contract minimal). */
export type ContextMonitorCtx = Pick<ExtensionContext, "getContextUsage">;

/** Options for {@link makeContextMonitor}. */
export interface ContextMonitorOptions {
  /** Fired on each qualifying turn_end (usage at/over the threshold) with the live
   *  usage slice. Fires every qualifying turn_end (the caller owns dedupe policy). */
  readonly onApproachingWindow: (usage: ContextUsage) => void;
  /** Fire threshold as a ratio of `contextWindow` (0..1). Defaults to 0.9. */
  readonly threshold?: number;
}

/** A disposable turn_end monitor. Call `dispose()` to guard the listener off
 *  (no further fires; pi offers no removal — the registration dies with the pi's
 *  runner at the next session switch). */
export interface ContextMonitor {
  /** Guard the turn_end listener off (idempotent). */
  dispose(): void;
}

/**
 * Register a `turn_end` listener on `pi` that fires `onApproachingWindow` when the
 * session's context usage (read from the held `ctx`) reaches the threshold fraction
 * of the model's context window. Returns a disposer.
 *
 * @param pi — the FRESH pi (after a session switch); carries the event bus.
 * @param ctx — the fresh session ctx; `getContextUsage()` is read live each turn_end.
 * @param options — `onApproachingWindow` callback + optional `threshold` ratio.
 */
export function makeContextMonitor(
  pi: ExtensionAPI,
  ctx: ContextMonitorCtx,
  options: ContextMonitorOptions,
): ContextMonitor {
  const ratio = options.threshold ?? DEFAULT_WINDOW_THRESHOLD;
  const dispose = subscribeAgentEvent(pi, "turn_end", () => {
    const usage = ctx.getContextUsage();
    if (usage === undefined) return; // no usage signal yet
    if (usage.tokens === null) return; // unknown (e.g. right after a compaction)
    const limit = ratio * usage.contextWindow;
    if (usage.tokens >= limit) {
      options.onApproachingWindow(usage);
    }
  });
  return {
    dispose() {
      dispose();
    },
  };
}
