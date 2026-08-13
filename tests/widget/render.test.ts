// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { PHASE_ORDER, renderLine, type WidgetState } from "../../src/widget/render.js";

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
    hint: null,
    ...over,
  };
}

describe("PHASE_ORDER", () => {
  it("is the 6-cell progression build → extract → compact → eval → probe → score", () => {
    expect(PHASE_ORDER).toEqual(["build", "extract", "compact", "eval", "probe", "score"]);
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
      hint: null,
    });
    expect(md).toBe("🅑 ◧□□□□□ build · ctx 142K/200K · 1.1k tok");
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
      hint: null,
    });
    expect(md).toBe("🅑 ■◧□□□□ extract · ctx 30K/200K · 0.5k tok");
  });

  it("compact: build+extract done, compact active, ctx/tok EXCLUDED", () => {
    const md = renderLine(running("compact", { tool: "memkeeper-builder" }));
    expect(md).toBe("🅑 1/5 memkeeper-builder · ■■◧□□□ compact");
  });

  it("eval: build+extract+compact done, eval active, attempt detail + ctx/tok", () => {
    const md = renderLine(running("eval", { detail: "3/10", ctxUsage: 12_000, tok: 300 }));
    expect(md).toBe("🅑 1/5 memkeeper-builder · ■■■◧□□ eval 3/10 · ctx 12K/200K · 0.3k tok");
  });

  it("probe: 4 done, probe active, probe detail + ctx/tok (judge)", () => {
    const md = renderLine(
      running("probe", { armIndex: 2, tool: "memkeeper-selector", detail: "5/7", ctxUsage: 8000, tok: 200 }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■◧□ probe 5/7 · ctx 8K/200K · 0.2k tok");
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
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■■◧ score 5/7 · ctx 124K/256K · 1.2k tok");
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
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■■◧□ probe 5/7");
  });
});

describe("renderLine — terminal states (stay visible)", () => {
  it("done: all cells ■, phase 'done', hint = results command", () => {
    const md = renderLine(running("score", { status: "done", hint: "/bench-compact:results" }));
    expect(md).toBe("🅑 ■■■■■■ done · /bench-compact:results");
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
      hint: "/bench-compact:run-scenario /tmp/scenario",
    });
    expect(md).toBe("🅑 ■■□□□□ prepared · /bench-compact:run-scenario /tmp/scenario");
  });

  it("stopped: bar reflects where it stopped, status word + resume hint", () => {
    const md = renderLine(
      running("eval", {
        status: "stopped",
        armIndex: 2,
        tool: "memkeeper-selector",
        detail: "3/10",
        hint: "/bench-compact:resume",
      }),
    );
    expect(md).toBe("🅑 2/5 memkeeper-selector · ■■■◧□□ eval 3/10 · stopped · /bench-compact:resume");
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
