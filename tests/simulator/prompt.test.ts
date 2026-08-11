// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { CONDITION_TOPICS } from "../../src/simulator/condition-topics.js";
import { buildSimulatorSystemPrompt } from "../../src/simulator/prompt.js";

const TASK = "Build a terminal chess engine with UCI support.";
const TARGET = 140000;

describe("buildSimulatorSystemPrompt", () => {
  const prompt = buildSimulatorSystemPrompt({ task: TASK, conditionTopics: CONDITION_TOPICS, targetContext: TARGET });

  it("embeds the task (the theme is a PARAMETER — works for any idea)", () => {
    expect(prompt).toContain(TASK);
  });

  it("frames the simulator as the USER (role-play, not a tool/bench agent)", () => {
    expect(prompt.toLowerCase()).toMatch(/you're the user|you are the user/);
    expect(prompt.toLowerCase()).toContain("you don't write code");
  });

  it("includes EVERY conditionTopic hint + its tag (essential vs optional)", () => {
    for (const t of CONDITION_TOPICS) {
      expect(prompt).toContain(t.hint);
      expect(prompt).toContain(t.label);
    }
    expect(prompt.toLowerCase()).toContain("essential");
    expect(prompt.toLowerCase()).toMatch(/optional|nice-to-have|safe to skip/);
  });

  it("contains NO bench jargon: no [STOP], no record_steer, no tool names, no metric ids", () => {
    expect(prompt).not.toContain("[STOP]");
    expect(prompt).not.toContain("record_steer");
    expect(prompt).not.toMatch(/\bE[0-9]\b/); // metric ids like E4/E5
    expect(prompt).not.toContain("recallFact");
    expect(prompt).not.toContain("doneOp");
    expect(prompt).not.toContain("supersession");
    expect(prompt).not.toContain("abstention");
    expect(prompt).not.toContain("conditionTopics"); // the field name — jargon
  });

  it("does NOT tell the simulator to stop (the harness owns the stop, §4.17)", () => {
    expect(prompt.toLowerCase()).not.toMatch(/stop (at|when|after|now)|stop building|\[stop\]/);
    expect(prompt).not.toMatch(/\b\d{4,}\s*tokens?\b/i); // no raw token-count stop instruction
  });

  it("gives qualitative pacing guidance (substantial / keep going / don't rush)", () => {
    const lower = prompt.toLowerCase();
    expect(lower.match(/substantial|long build|keep going|don't rush|don't try to wrap up/)).not.toBeNull();
  });

  it("targetContext below the long-build threshold (< 80000) → 'moderate build' pacing (R2.2)", () => {
    const p = buildSimulatorSystemPrompt({ task: TASK, conditionTopics: CONDITION_TOPICS, targetContext: 40_000 });
    expect(p.toLowerCase()).toContain("moderate build");
    expect(p.toLowerCase()).not.toContain("long, substantial build");
  });

  it("stays in character (talk like a real person pair-programming)", () => {
    expect(prompt.toLowerCase()).toMatch(/stay in character|talk like a real person|pair-program/);
  });

  it("works with a totally different task (no scenario assumptions baked in)", () => {
    const p2 = buildSimulatorSystemPrompt({
      task: "Refactor a Python ML pipeline into typed modules.",
      conditionTopics: CONDITION_TOPICS,
      targetContext: TARGET,
    });
    expect(p2).toContain("Refactor a Python ML pipeline into typed modules.");
    // still frames the user role + all topics
    expect(p2.toLowerCase()).toMatch(/you're the user|you are the user/);
    for (const t of CONDITION_TOPICS) expect(p2).toContain(t.hint);
  });

  it("is a single string (the system prompt — no structured return)", () => {
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
