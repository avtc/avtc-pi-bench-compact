// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { mechanicalLeak } from "../../src/manifest/probe-leak-gate.js";

const SUMMARY = "R&D lifecycle locked; personas cost ~×0.75 price, aggressive ×1.35 budget.";
const TAIL = `turn | leader
4 | QuantumMind 17.2%
9 | QuantumMind 24.2%
6 | DeepVertex share 4.4% cash -$0.9B rep 45
TAKE_RATE was 0.05 before the recalibration to 0.08`;

describe("mechanicalLeak — numeric answer leaks", () => {
  it("flags an accept[] numeric literal that appears in the tail", () => {
    const r = mechanicalLeak(
      { question: "which rivals topped the arcs?", accept: ["QuantumMind led with ~17.2% share"] },
      { summary: SUMMARY, tail: TAIL },
    );
    expect(r).toContain("17.2");
    expect(r).toContain("tail");
  });

  it("flags an accept[] numeric literal that appears in the summary", () => {
    const r = mechanicalLeak(
      { question: "what budget multiplier does the aggressive persona use?", accept: ["1.35× research budget"] },
      { summary: SUMMARY, tail: "unrelated" },
    );
    expect(r).toContain("1.35");
    expect(r).toContain("summary");
  });

  it("clean when the numbers exist nowhere in summary/tail", () => {
    const r = mechanicalLeak(
      { question: "what was MODEL_MAINT before recalibration?", accept: ["MODEL_MAINT was 0.25"] },
      { summary: SUMMARY, tail: TAIL },
    );
    expect(r).toBeNull();
  });

  it("ignores tiny numbers (turn numbers, single digits) to keep precision", () => {
    const r = mechanicalLeak(
      { question: "how many rivals?", accept: ["6 rivals"] },
      { summary: "the game", tail: "turn 4 QuantumMind" },
    );
    expect(r).toBeNull();
  });
});

describe("mechanicalLeak — verbatim answer leaks", () => {
  it("flags a long verbatim accept[] phrase appearing in the tail (case/whitespace-insensitive)", () => {
    const r = mechanicalLeak(
      {
        question: "what did the forced-bankruptcy check originally assert?",
        accept: ["the field shrank by exactly one firm (at least the victim exited)"],
      },
      { summary: "x", tail: "assertion (c): THE FIELD SHRANK BY EXACTLY ONE FIRM (at least the victim exited)" },
    );
    expect(r).toContain("verbatim");
  });

  it("topic words shared with the summary alone are NOT leaks (cued probes are legitimate)", () => {
    const r = mechanicalLeak(
      { question: "why was write-through caching rejected?", accept: ["it serialized writes"] },
      { summary: "We discussed write-through caching and picked another approach.", tail: "later work" },
    );
    expect(r).toBeNull();
  });
});
