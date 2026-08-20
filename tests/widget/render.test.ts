// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  fitRenderedLine,
  fitThemedRenderedLine,
  PHASE_ORDER,
  renderLine,
  type WidgetState,
} from "../../src/widget/render.js";

/** Minimal running state for a given phase (arm/tool/detail present). */
function running(phase: WidgetState["phase"], over: Partial<WidgetState>): WidgetState {
  return {
    phase,
    status: "running",
    armIndex: 1,
    armTotal: 5,
    tool: "memkeeper-builder",
    detail: null,
    ctxUsage: 12_000,
    ctxWindow: 200_000,
    tok: 300,
    judgeUsages: null,
    hint: null,
    ...over,
  };
}

describe("PHASE_ORDER", () => {
  it("is the 7-cell progression build → extract → compact → latent → eval → probe → score", () => {
    expect(PHASE_ORDER).toEqual(["build", "extract", "compact", "latent", "eval", "probe", "score"]);
  });
});

describe("renderLine — phase-bar + phase name", () => {
  it("build: active cell 0, user-simulator ctx/tok, NO arm counter", () => {
    const md = renderLine({
      phase: "build",
      status: "running",
      armIndex: null,
      armTotal: null,
      tool: null,
      detail: null,
      ctxUsage: 142_000,
      ctxWindow: 200_000,
      tok: 1100,
      judgeUsages: null,
      hint: null,
    });
    expect(md).toBe("🅑 ◧□□□□□□ build · ctx 142K/200K · 1.1k tok");
  });

  it("extract: build done, extract active, authoring-agent ctx/tok, NO arm counter", () => {
    const md = renderLine({
      phase: "extract",
      status: "running",
      armIndex: null,
      armTotal: null,
      tool: null,
      detail: null,
      ctxUsage: 30_000,
      ctxWindow: 200_000,
      tok: 500,
      judgeUsages: null,
      hint: null,
    });
    expect(md).toBe("🅑 ■◧□□□□□ extract · ctx 30K/200K · 0.5k tok");
  });

  it("compact: build+extract done, compact active, ctx/tok EXCLUDED", () => {
    const md = renderLine(running("compact", { tool: "memkeeper-builder" }));
    expect(md).toBe("🅑 1/5 memkeeper-builder · ■■◧□□□□ compact");
  });

  it("eval: build+extract+compact done, eval active, attempt detail + ctx/tok", () => {
    const md = renderLine(running("eval", { detail: "3/10", ctxUsage: 12_000, tok: 300 }));
    expect(md).toBe("🅑 1/5 memkeeper-builder · ■■■■◧□□ eval 3/10 · ctx 12K/200K · 0.3k tok");
  });

  it("latent: detail dot-joins the phase (cued/uncued tally), same ctx/tok format as the other phases", () => {
    const md = renderLine(
      running("latent", { armIndex: 2, tool: "om-full", detail: "cued 1/3 · uncued 2/3", ctxUsage: 45_000, tok: 3200 }),
    );
    expect(md).toBe("🅑 2/5 om-full · ■■■◧□□□ latent · cued 1/3 · uncued 2/3 · ctx 45K/200K · 3.2k tok");
  });

  it("probe: 4 done, probe active, probe detail + ctx/tok (judge)", () => {
    const md = renderLine(
      running("probe", { armIndex: 2, tool: "memkeeper-selector", detail: "5/7", ctxUsage: 8000, tok: 200 }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■■◧□ probe 5/7 · ctx 8K/200K · 0.2k tok");
  });

  it("score: 5 done, score active, score detail + ctx/tok (judge)", () => {
    const md = renderLine(
      running("score", {
        armIndex: 2,
        tool: "memkeeper-selector",
        detail: "5/7",
        ctxUsage: 124_000,
        ctxWindow: 256_000,
        tok: 1200,
      }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■■■◧ score 5/7 · ctx 124K/256K · 1.2k tok");
  });

  it("score with judgeUsages (K=3, mixed windows): one ctx pair + one tok per judge", () => {
    const md = renderLine(
      running("score", {
        armIndex: 1,
        tool: "bare-pi",
        detail: "run 3/15 — exact metrics",
        judgeUsages: [
          { ctxUsage: 45_000, ctxWindow: 262_144, tok: 3200 },
          { ctxUsage: 32_000, ctxWindow: 200_000, tok: 1300 },
          { ctxUsage: 200_000, ctxWindow: 1_000_000, tok: 10_100 },
        ],
      }),
    );
    expect(md).toBe(
      "🅑 1/5 bare-pi · ■■■■■■◧ score run 3/15 — exact metrics · ctx 45K/262K 32K/200K 200K/1M · 3.2k 1.3k 10.1k tok",
    );
  });

  it("single-agent ctx segment: unresolved window renders ? (parity with the judge list)", () => {
    const md = renderLine(
      running("latent", { armIndex: 2, tool: "om-full", ctxUsage: 45_000, ctxWindow: null, tok: 3200 }),
    );
    expect(md).toBe("🅑 2/5 om-full · ■■■◧□□□ latent · ctx 45K/? · 3.2k tok");
  });

  it("score with judgeUsages (K=1): single pair, unresolved window renders ?", () => {
    const md = renderLine(
      running("score", {
        detail: "probe 45/57 grading",
        judgeUsages: [{ ctxUsage: 8_400, ctxWindow: null, tok: 250 }],
      }),
    );
    expect(md).toBe("🅑 1/5 memkeeper-builder · ■■■■■■◧ score probe 45/57 grading · ctx 8K/? · 0.3k tok");
  });

  it("score with judgeUsages present ignores the single-agent ctx/tok fields", () => {
    const md = renderLine(
      running("score", {
        ctxUsage: 999_000, // would render 999K — must be suppressed by the judge list
        judgeUsages: [{ ctxUsage: 8_000, ctxWindow: 100_000, tok: 400 }],
      }),
    );
    expect(md).toContain("ctx 8K/100K · 0.4k tok");
    expect(md).not.toContain("999K");
  });

  it("comparative (arm counter cleared): no arm segment, judge list still shows", () => {
    const md = renderLine(
      running("score", {
        armIndex: null,
        armTotal: null,
        tool: null,
        detail: "comparative",
        judgeUsages: [{ ctxUsage: 20_000, ctxWindow: 200_000, tok: 2000 }],
      }),
    );
    expect(md).toBe("🅑 ■■■■■■◧ score comparative · ctx 20K/200K · 2.0k tok");
  });

  it("probe with no judge (ctxUsage null): ctx/tok omitted", () => {
    const md = renderLine(
      running("probe", {
        armIndex: 2,
        tool: "memkeeper-selector",
        detail: "5/7",
        ctxUsage: null,
        ctxWindow: null,
        tok: null,
      }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■■◧□ probe 5/7");
  });
});

describe("renderLine — terminal states (stay visible)", () => {
  it("done: all cells ■, phase 'done', hint = results command", () => {
    const md = renderLine(running("score", { status: "done", hint: "/bench-compact:results" }));
    expect(md).toBe("🅑 ■■■■■■■ done · /bench-compact:results");
  });

  it("prepared: build+extract cells ■, rest □, label 'prepared', run-scenario hint", () => {
    const md = renderLine({
      phase: "extract",
      status: "prepared",
      armIndex: null,
      armTotal: null,
      tool: null,
      detail: null,
      ctxUsage: null,
      ctxWindow: null,
      tok: null,
      judgeUsages: null,
      hint: "/bench-compact:run-scenario /tmp/scenario",
    });
    expect(md).toBe("🅑 ■■□□□□□ prepared · /bench-compact:run-scenario /tmp/scenario");
  });

  it("stopped: bar reflects where it stopped, status word + resume hint", () => {
    const md = renderLine(
      running("eval", {
        status: "stopped",
        armIndex: 2,
        tool: "memkeeper-selector",
        detail: "3/10",
        judgeUsages: null,
        hint: "/bench-compact:resume",
      }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■◧□□ eval 3/10 · stopped · /bench-compact:resume");
  });
});

describe("renderLine — formatting", () => {
  it("ctx tokens format as K (>=1000), raw (<1000)", () => {
    expect(renderLine(running("eval", { ctxUsage: 999, tok: 1 }))).toContain("ctx 999/200K");
    expect(renderLine(running("eval", { ctxUsage: 1500, tok: 1 }))).toContain("ctx 2K/200K"); // rounds up
  });

  it("tok formats as k with 1 decimal", () => {
    expect(renderLine(running("eval", { tok: 0 }))).toContain("0.0k tok");
    expect(renderLine(running("eval", { tok: 50 }))).toContain("0.1k tok"); // 0.05 → 0.1 (round half up)
    expect(renderLine(running("eval", { tok: 12_345 }))).toContain("12.3k tok");
  });
});

/** Markup theme fake: fg(color, text) → `<color>text</color>` for assertions. */
const MARKUP_THEME = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as unknown as Parameters<
  typeof fitThemedRenderedLine
>[1];

describe("fitThemedRenderedLine — sibling-widget color scheme", () => {
  it("running: glyph+bar-active+label accent, done cells success, pending dim, tool muted, counters dim", () => {
    const themed = fitThemedRenderedLine(
      {
        phase: "eval",
        status: "running",
        armIndex: 2,
        armTotal: 5,
        tool: "memkeeper-builder",
        detail: "3/10",
        ctxUsage: 124000,
        ctxWindow: 200000,
        tok: 300,
        judgeUsages: null,
        hint: null,
      },
      MARKUP_THEME,
      200,
    );
    // glyph accent; bar: 3 done (success) + active (accent) + 2 pending (dim); label accent w/ detail
    expect(themed).toContain("<accent>🅑</accent>");
    expect(themed).toContain(
      "<success>■</success><success>■</success><success>■</success><success>■</success><accent>◧</accent><dim>□</dim><dim>□</dim>",
    );
    expect(themed).toContain("<accent>eval 3/10</accent>");
    expect(themed).toContain("<muted>2/5 memkeeper-builder</muted>");
    expect(themed).toContain("<dim>ctx 124K/200K</dim>");
    expect(themed).toContain("<dim>0.3k tok</dim>");
  });

  it("stopped: status word error, hint dim, bar stays at the stop point", () => {
    const themed = fitThemedRenderedLine(
      {
        phase: "eval",
        status: "stopped",
        armIndex: 1,
        armTotal: 5,
        tool: "bare-pi",
        detail: null,
        ctxUsage: null,
        ctxWindow: null,
        tok: null,
        judgeUsages: null,
        hint: "/bench-compact:resume",
      },
      MARKUP_THEME,
      200,
    );
    expect(themed).toContain("<error>stopped</error>");
    expect(themed).toContain("<dim>/bench-compact:resume</dim>");
  });

  it("done: all cells success + label success + hint dim", () => {
    const themed = fitThemedRenderedLine(
      {
        phase: "score",
        status: "done",
        armIndex: null,
        armTotal: null,
        tool: null,
        detail: null,
        ctxUsage: null,
        ctxWindow: null,
        tok: null,
        judgeUsages: null,
        hint: "/bench-compact:results",
      },
      MARKUP_THEME,
      200,
    );
    expect(themed).toBe(
      "<accent>🅑</accent> <success>■</success>".repeat(0) +
        "<accent>🅑</accent> " +
        Array.from({ length: 7 }, () => "<success>■</success>").join("") +
        " <success>done</success> · <dim>/bench-compact:results</dim>",
    );
    expect(themed).toContain("<success>done</success>");
    expect(themed).toContain("<dim>/bench-compact:results</dim>");
  });

  it("themed strip equals the plain fitted line (no drift between pipelines)", () => {
    const state = {
      phase: "build",
      status: "running",
      armIndex: null,
      armTotal: null,
      tool: null,
      detail: null,
      ctxUsage: 142000,
      ctxWindow: 200000,
      tok: 1100,
      judgeUsages: null,
      hint: null,
    } as const;
    const strip = (t: string): string => t.replace(/<[^>]+>/g, "");
    expect(strip(fitThemedRenderedLine(state, MARKUP_THEME, 200))).toBe(fitRenderedLine(state, 200));
  });
});
