// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTuiWidgetDeps,
  WIDGET_KEY,
  WIDGET_PLACEMENT,
  WidgetController,
  type WidgetDeps,
} from "../../src/widget/tracker.js";

/** Fixed wide terminal width (no elision → exact line assertions). */
const TERM_WIDE = 200;

/** Capturing deps: records every published line + hide, fixed termWidth (no
 *  elision → exact assertions), real globals (controlled by vi fake timers). */
function capturingDeps(width: number): {
  deps: WidgetDeps;
  lines: string[];
  hideCount: () => number;
} {
  const lines: string[] = [];
  const hideBox = { n: 0 };
  return {
    lines,
    hideCount: () => hideBox.n,
    deps: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
      termWidth: () => width,
      publish: (line: string) => {
        lines.push(line);
      },
      hide: () => {
        hideBox.n++;
      },
    },
  };
}

describe("WidgetController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("show() publishes once (leading render); no further renders until state changes", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build" });
    c.show();
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toContain("◧□□□□□ build");
  });

  it("is inert until show() (mutations queue no renders)", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "compact" });
    c.setArm(1, 5, "memkeeper-builder");
    expect(cap.lines).toHaveLength(0);
    c.show();
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toContain("1/5 memkeeper-builder");
  });

  it("throttles rapid mutations: leading render + one trailing flush", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "compact" });
    c.show();
    expect(cap.lines).toHaveLength(1); // leading (show)

    // burst of mutations within the throttle window
    c.setDetail("a");
    c.setDetail("b");
    c.setDetail("c");
    expect(cap.lines).toHaveLength(1); // still only the leading render

    vi.advanceTimersByTime(200); // trailing flush fires
    expect(cap.lines).toHaveLength(2); // one trailing render with the final state
    expect(cap.lines[1]).toContain("compact c");
  });

  it("renders immediately again once the throttle window has elapsed (leading)", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "compact" });
    c.show();
    vi.advanceTimersByTime(200); // past the window
    c.setDetail("x");
    expect(cap.lines).toHaveLength(2); // leading render (window elapsed)
    expect(cap.lines[1]).toContain("compact x");
  });

  it("hide() clears the trailing timer + hides the line", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "compact" });
    c.show();
    c.setDetail("pending"); // schedules trailing
    c.hide();
    vi.advanceTimersByTime(200); // trailing would have fired — must NOT publish
    expect(cap.lines).toHaveLength(1); // only the leading show render
    expect(cap.hideCount()).toBe(1);
  });

  it("done status forces all-■ bar + 'done' label + hint, omits ctx/tok", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "score", status: "running", ctxUsage: 1000, tok: 500 });
    c.show();
    c.setStatus("done", "/bench-compact:results");
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toBe("🅑 ■■■■■■ done · /bench-compact:results");
  });

  it("advancePhase moves build→extract→compact→eval→probe→score", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build" });
    c.show();
    c.advancePhase();
    c.advancePhase();
    c.advancePhase();
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("■■■◧□□ eval");
  });
});

describe("WidgetController.onEvent — two-tier tok + ctx usage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mk = <T>(over: T): AgentEvent => over as unknown as AgentEvent;

  it("message_update accumulates fallback tokens (chars/4) when no provider usage", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build", ctxUsage: 1000, ctxWindow: 200_000 });
    c.show();
    // 8 chars of text delta → 2 tokens (chars/4).
    c.onEvent(
      mk({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "abcdefgh" },
      }),
    );
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("0.0k tok"); // 2 tokens → 0.0k (2/1000=0.002→0.0)
  });

  it("message_update prefers provider streamed usage.output over the fallback", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build", ctxUsage: 1000, ctxWindow: 200_000 });
    c.show();
    c.onEvent(
      mk({
        type: "message_update",
        message: { usage: { output: 1100 } },
        assistantMessageEvent: { type: "text_delta", delta: "abcdefgh" },
      }),
    );
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("1.1k tok"); // provider tier (1100), not fallback (2)
  });

  it("message_start resets the current-request tok counter", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build", ctxUsage: 1000, ctxWindow: 200_000 });
    c.show();
    c.onEvent(mk({ type: "message_update", message: { usage: { output: 5000 } } })); // 5.0k
    c.onEvent(mk({ type: "message_start" })); // reset
    c.onEvent(mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } })); // 1 token
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("0.0k tok"); // reset then 1 token → 0.0k
  });

  it("message_end sets ctxUsage from usage.totalTokens", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, {
      phase: "eval",
      armIndex: 1,
      armTotal: 5,
      tool: "t",
      ctxWindow: 200_000,
      tok: 100,
    });
    c.show();
    c.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 142_000 } } }));
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("ctx 142K/200K");
  });

  it("compact phase never shows ctx/tok even when set", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, {
      phase: "compact",
      armIndex: 1,
      armTotal: 5,
      tool: "memkeeper-builder",
      ctxUsage: 5000,
      tok: 999,
    });
    c.show();
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toBe("🅑 1/5 memkeeper-builder · ■■◧□□□ compact");
  });
});

describe("makeTuiWidgetDeps — TUI gate", () => {
  it("returns null for non-TUI modes (json/rpc/print)", () => {
    const ctx = { mode: "json", hasUI: true, ui: { setWidget: () => {} } };
    expect(makeTuiWidgetDeps(ctx)).toBeNull();
  });

  it("returns null when hasUI is false", () => {
    const ctx = { mode: "tui", hasUI: false, ui: { setWidget: () => {} } };
    expect(makeTuiWidgetDeps(ctx)).toBeNull();
  });

  it("publish wraps the fit line in a Text via ctx.ui.setWidget at the aboveEditor slot", () => {
    const calls: Array<{ key: string; content: unknown; opts: { placement: string } }> = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget: (key: string, content: unknown, opts: { placement: string }) => {
          calls.push({ key, content, opts });
        },
      },
    };
    const deps = makeTuiWidgetDeps(ctx);
    expect(deps).not.toBeNull();
    if (deps === null) return;

    deps.publish("🅑 ◧□□□□□ build");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(WIDGET_KEY);
    expect(calls[0]?.opts.placement).toBe(WIDGET_PLACEMENT);
    // the content is a renderFn returning a Text whose render() yields the line
    const renderFn = calls[0]?.content as () => { render: (w: number) => string[] };
    expect(typeof renderFn).toBe("function");
    expect(renderFn().render(200)[0]?.trim()).toBe("🅑 ◧□□□□□ build");
  });

  it("hide passes HIDE_WIDGET (undefined) at the same slot", () => {
    const calls: Array<{ key: string; content: unknown }> = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: { setWidget: (key: string, content: unknown) => calls.push({ key, content }) },
    };
    const deps = makeTuiWidgetDeps(ctx);
    if (deps === null) return;
    deps.hide();
    expect(calls[0]?.key).toBe(WIDGET_KEY);
    expect(calls[0]?.content).toBeUndefined();
  });
});

describe("WidgetController(null deps) — inert", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("every method is a no-op with null deps (no throw, no publish)", () => {
    const c = new WidgetController(null, { phase: "build" });
    expect(() => {
      c.show();
      c.setArm(1, 5, "tool");
      c.startPhase("compact", null);
      c.setStatus("done", null);
      c.onEvent({ type: "message_end", message: { usage: { totalTokens: 1 } } } as unknown as Parameters<
        WidgetController["onEvent"]
      >[0]);
      c.hide();
    }).not.toThrow();
    // nothing to assert beyond no-throw — null deps publishes nothing.
  });
});
