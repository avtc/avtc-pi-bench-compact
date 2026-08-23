// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setBaseLoggerForTest } from "../../src/log.js";
import {
  makeTuiWidgetDeps,
  scoreJudgeHooks,
  WIDGET_KEY,
  WIDGET_PLACEMENT,
  WidgetController,
  type WidgetDeps,
  widgetStageHooks,
  widgetValidatorHooks,
} from "../../src/widget/tracker.js";

/** Fixed wide terminal width (no elision → exact line assertions). */
const TERM_WIDE = 200;

/** Capturing deps: records every published line + hide, fixed termWidth (no
 * elision → exact assertions), real globals (controlled by vi fake timers). */
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
      publish: (render: (theme: import("@earendil-works/pi-coding-agent").Theme) => string) => {
        const line = render(PLAIN_THEME);
        lines.push(line);
      },
      hide: () => {
        hideBox.n++;
      },
    },
  };
}

/** Identity theme fake — the plain-string assertions keep working (fg = no-op). */
const PLAIN_THEME = { fg: (_c: string, t: string) => t } as unknown as import("@earendil-works/pi-coding-agent").Theme;

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
    expect(cap.lines[0]).toContain("◧□□□□□□ build");
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
    expect(cap.lines.at(-1)).toBe("🅑 ■■■■■■■ done · /bench-compact:results");
  });

  it("advancePhase moves build→extract→compact→latent→eval→probe→score", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "build" });
    c.show();
    c.advancePhase();
    c.advancePhase();
    c.advancePhase();
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("■■■◧□□□ latent"); // 4th cell active
    c.advancePhase();
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("■■■■◧□□ eval");
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
    expect(cap.lines.at(-1)).toContain("2 tok"); // 2 tokens → raw (adaptive <1K)
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
    expect(cap.lines.at(-1)).toContain("1 tok"); // reset then 1 token (raw)
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
    expect(cap.lines.at(-1)).toContain("ctx 142k/200k");
  });

  it("startPhase retires the finished background agent's ctx/tok (no stale carry into a phase without one)", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, {
      phase: "latent",
      armIndex: 1,
      armTotal: 2,
      tool: "memkeeper-builder",
      ctxWindow: 262_144,
    });
    c.show();
    // the latent-authoring agent's final request lands 223k ctx + streamed output
    c.onEvent(mk({ type: "message_update" })); // fallback tier accumulates nothing (no text)
    c.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 223_000 } } }));
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("ctx 223k/262k");
    // authoring done → probes run on the main session (no background agent):
    // the phase transition must clear the dead agent's segments, not linger them
    c.startPhase("probe", null);
    c.setDetail("probe 25/26 · attempt 2/3");
    vi.advanceTimersByTime(200);
    const line = cap.lines.at(-1) ?? "";
    expect(line).toContain("probe 25/26");
    expect(line).not.toContain("ctx");
    expect(line).not.toContain("tok");
  });

  it("clearAgent retires the segments when the harness reports the agent finished (mid-phase)", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, {
      phase: "latent",
      armIndex: 1,
      armTotal: 2,
      tool: "om-full",
      ctxWindow: 262_144,
    });
    c.show();
    c.onEvent(mk({ type: "message_update" })); // sets tok=0 (renders the ctx segment)
    c.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 190_000 } } }));
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("ctx 190k/262k");
    // the per-arm authoring agent finished; the NEXT arm's authoring has not
    // streamed yet — the phase is still "latent", so only clearAgent applies
    c.clearAgent();
    vi.advanceTimersByTime(200);
    const line = cap.lines.at(-1) ?? "";
    expect(line).toContain("latent"); // phase untouched
    expect(line).not.toContain("ctx");
    expect(line).not.toContain("tok");
  });

  it("onValidatorEvent feeds the second slot without touching the author slot; clearValidator hides the segment", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "latent", ctxUsage: 183_000, ctxWindow: 262_000, tok: 3300 });
    c.show();
    // validation request starts: window resolved, message_start → tok 0
    c.setValidatorCtxWindow(262_000);
    c.onValidatorEvent(mk({ type: "message_start" }));
    // 5.2k of text delta → 1300 tokens while streaming (ctx not yet ended → 0)
    c.onValidatorEvent(
      mk({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a".repeat(5200) },
      }),
    );
    vi.advanceTimersByTime(200);
    const line = cap.lines.at(-1) ?? "";
    expect(line).toContain("validating probe · ctx 0/262k · 1.3k tok");
    expect(line).toContain("ctx 183k/262k · 3.3k tok"); // the author's frozen segments stay
    // the validator's request ends → ctx fills; then the validation finishes → segment hides
    c.onValidatorEvent(mk({ type: "message_end", message: { usage: { totalTokens: 5_100 } } }));
    c.clearValidator();
    vi.advanceTimersByTime(200);
    const done = cap.lines.at(-1) ?? "";
    expect(done).not.toContain("validating");
    expect(done).toContain("ctx 183k/262k"); // the author slot survives
  });

  it("widgetValidatorHooks wires onEvent→onValidatorEvent, onModelResolved→setValidatorCtxWindow, onDone→clearValidator", () => {
    const calls: string[] = [];
    const widget = {
      onValidatorEvent: () => calls.push("event"),
      setValidatorCtxWindow: () => calls.push("window"),
      clearValidator: () => calls.push("clear"),
    };
    const hooks = widgetValidatorHooks(widget);
    expect(hooks).toBeDefined();
    hooks?.onEvent(mk({ type: "message_start" }));
    hooks?.onModelResolved({ contextWindow: 262_000 } as unknown as Parameters<
      NonNullable<typeof hooks.onModelResolved>
    >[0]);
    hooks?.onDone();
    expect(calls).toEqual(["event", "window", "clear"]);
    expect(widgetValidatorHooks(null)).toBeNull();
  });

  it("widgetStageHooks wires onDone to clearAgent", () => {
    const calls: string[] = [];
    const widget = {
      onEvent: () => calls.push("event"),
      setCtxWindow: () => calls.push("window"),
      clearAgent: () => calls.push("clear"),
    };
    const hooks = widgetStageHooks(widget);
    expect(hooks).toBeDefined();
    hooks?.onDone();
    expect(calls).toEqual(["clear"]);
    expect(widgetStageHooks(null)).toBeUndefined();
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
    expect(cap.lines.at(-1)).toBe("🅑 1/5 memkeeper-builder · ■■◧□□□□ compact");
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

    deps.publish(() => "🅑 ◧□□□□□□ build");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(WIDGET_KEY);
    expect(calls[0]?.opts.placement).toBe(WIDGET_PLACEMENT);
    // the content is a renderFn returning a Text whose render() yields the line
    const renderFn = calls[0]?.content as () => { render: (w: number) => string[] };
    expect(typeof renderFn).toBe("function");
    expect(renderFn().render(200)[0]?.trim()).toBe("🅑 ◧□□□□□□ build");
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

describe("makeTuiWidgetDeps publish — paint safe-degrade", () => {
  it("a throwing themed render logs the fault and paints a blank Text (no TUI death)", async () => {
    const lines: string[] = [];
    const prev = _setBaseLoggerForTest({
      info: () => {},
      warn: () => {},
      error: (m: string) => lines.push(m),
      debug: () => {},
    });
    try {
      const calls: { content: unknown }[] = [];
      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: { setWidget: (_k: string, content: unknown) => void calls.push({ content }) },
      };
      const deps = makeTuiWidgetDeps(ctx as unknown as Parameters<typeof makeTuiWidgetDeps>[0]);
      if (deps === null) throw new Error("expected TUI deps");
      deps.publish((theme) => {
        void theme;
        throw new Error("render boom");
      });
      expect(calls).toHaveLength(1);
      const renderFn = calls[0]?.content as (tui: unknown, theme: unknown) => { render(): string[] };
      const painted = renderFn({}, { fg: () => "x" });
      expect(painted.render()).toEqual([]); // blank, not a crash
      expect(lines.some((m) => m.includes("widget render threw"))).toBe(true);
    } finally {
      _setBaseLoggerForTest(prev);
    }
  });
});

describe("scoreJudgeHooks — per-judge slot accumulators", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mk = <T>(over: T): AgentEvent => over as unknown as AgentEvent;
  const mkModel = <T>(over: T): Model<Api> => over as unknown as Model<Api>;

  it("keeps two judges' streams separate; renders one ctx/tok pair per judge", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "score", armIndex: 1, armTotal: 5, tool: "bare-pi" });
    c.show();
    const hooks = scoreJudgeHooks(() => c);
    // judge 0: 8 chars → 2 tok fallback; window 200k, ctx 20k
    hooks.onModelResolved(mkModel({ id: "j0", contextWindow: 200_000 }), 0);
    hooks.onEvent(mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcdefgh" } }), 0);
    hooks.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 20_000 } } }), 0);
    // judge 1: 12 chars → 3 tok; window 1.0M, ctx 900k
    hooks.onModelResolved(mkModel({ id: "j1", contextWindow: 1_000_000 }), 1);
    hooks.onEvent(
      mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "aaaaaaaaaaaa" } }),
      1,
    );
    hooks.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 900_000 } } }), 1);
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("ctx 20k/200k 900k/1.0M · 2 3 tok");
  });

  it("message_start resets only ITS judge's tiers (parallel requests stay independent)", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "score" });
    c.show();
    const hooks = scoreJudgeHooks(() => c);
    hooks.onModelResolved(mkModel({ contextWindow: 100_000 }), 0);
    hooks.onEvent(mk({ type: "message_start" }), 0);
    hooks.onEvent(mk({ type: "message_start" }), 1);
    hooks.onEvent(
      mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(4000) } }),
      0,
    );
    hooks.onEvent(
      mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b".repeat(4000) } }),
      1,
    );
    // judge 1 restarts its request — judge 0's 1000 tok must survive
    hooks.onEvent(mk({ type: "message_start" }), 1);
    hooks.onEvent(
      mk({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "c".repeat(400) } }),
      1,
    );
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toContain("1.0k 100 tok");
  });

  it("null widget (non-TUI) is inert — no throw", () => {
    const hooks = scoreJudgeHooks(() => null);
    expect(() => {
      hooks.onModelResolved(mkModel({ contextWindow: 1 }), 0);
      hooks.onEvent(mk({ type: "message_end", message: { usage: { totalTokens: 1 } } }), 0);
    }).not.toThrow();
  });

  it("setJudgeUsages(null) clears the segments; clearArm drops the counter", () => {
    const cap = capturingDeps(TERM_WIDE);
    const c = new WidgetController(cap.deps, { phase: "score", armIndex: 3, armTotal: 5, tool: "om-full" });
    c.show();
    c.setJudgeUsages([{ ctxUsage: 10_000, ctxWindow: 100_000, tok: 500 }]);
    c.clearArm();
    c.setJudgeUsages(null);
    vi.advanceTimersByTime(200);
    expect(cap.lines.at(-1)).toBe("🅑 ■■■■■■◧ score");
  });
});
