// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeContextMonitor } from "../../src/orchestrate/context-monitor.js";
import { fakeBus } from "../session/helpers.js";

/** A fake ctx exposing only `getContextUsage` (the surface the monitor reads). */
function makeCtx(usage: ContextUsage | undefined): { ctx: { getContextUsage: () => ContextUsage | undefined } } {
  return { ctx: { getContextUsage: () => usage } };
}

const TURN_EVENT = { type: "turn_end" };

describe("makeContextMonitor", () => {
  it("fires onApproachingWindow when usage reaches the default 0.9 of the window", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 180000, contextWindow: 200000, percent: 0.9 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).toHaveBeenCalledOnce();
    expect(onApproachingWindow.mock.calls[0]?.[0]).toEqual({ tokens: 180000, contextWindow: 200000, percent: 0.9 });
    monitor.dispose();
  });

  it("does NOT fire when usage is below the default threshold", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 179999, contextWindow: 200000, percent: 0.89 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("fires at/over the window (boundary crossed)", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 210000, contextWindow: 200000, percent: 1.05 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).toHaveBeenCalledOnce();
    monitor.dispose();
  });

  it("an explicit threshold overrides the default (lower → fires sooner)", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 80000, contextWindow: 200000, percent: 0.4 });
    // 0.4 default would NOT fire at 80k, but an explicit 0.3 threshold DOES (80k >= 60k).
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow, threshold: 0.3 });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).toHaveBeenCalledOnce();
    monitor.dispose();
  });

  it("an explicit higher threshold suppresses a fire that the default would trigger", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 180000, contextWindow: 200000, percent: 0.9 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow, threshold: 0.95 });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).not.toHaveBeenCalled(); // 180k < 190k (0.95 of 200k)
    monitor.dispose();
  });

  it("skips firing when ctx reports unknown tokens (null) — no usable signal", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: null, contextWindow: 200000, percent: null });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("skips firing when ctx reports no usage at all (undefined)", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx(undefined);
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);

    expect(onApproachingWindow).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("dispose() stops further firing (the turn_end listener is removed)", () => {
    const { pi, emit } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 180000, contextWindow: 200000, percent: 0.9 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    emit("turn_end", TURN_EVENT);
    expect(onApproachingWindow).toHaveBeenCalledOnce();

    monitor.dispose();
    emit("turn_end", TURN_EVENT); // must NOT fire after dispose
    expect(onApproachingWindow).toHaveBeenCalledOnce();
  });

  it("registers the listener on the provided pi (the FRESH pi after a session switch)", () => {
    // The monitor MUST register on the pi passed in — after switchSession the
    // command-handler pi is stale, so the caller passes the fresh pi (getBenchPi).
    const { pi, listenerCount } = fakeBus();
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 180000, contextWindow: 200000, percent: 0.9 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });

    expect(listenerCount("turn_end")).toBe(1);
    monitor.dispose();
    expect(listenerCount("turn_end")).toBe(0);
  });

  it("the pi arg is the ExtensionAPI carrying the event bus (typed for clarity)", () => {
    // Compile-time guard: the signature accepts an ExtensionAPI (the fresh pi).
    const pi = { events: { on: () => () => {} } } as unknown as ExtensionAPI;
    const onApproachingWindow = vi.fn();
    const { ctx } = makeCtx({ tokens: 0, contextWindow: 100, percent: 0 });
    const monitor = makeContextMonitor(pi, ctx, { onApproachingWindow });
    monitor.dispose();
    expect(true).toBe(true);
  });
});
