// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type CallJudge, gradeSlice, JudgeMalformedJsonError } from "../../src/judge/single-call.js";

/** Build a fake callJudge that returns the given raw texts in sequence. */
function fakeJudge(responses: string[]): { call: CallJudge; calls: string[][] } {
  let i = 0;
  const calls: string[][] = [];
  const call: CallJudge = async (systemPrompt, userContent) => {
    calls.push([systemPrompt, userContent]);
    return responses[i++] ?? "";
  };
  return { call, calls };
}

describe("gradeSlice", () => {
  it("parses a clean JSON {pass, evidence} response", async () => {
    const { call } = fakeJudge(['{"pass": true, "evidence": "answer matches accept[0]"}']);
    const grade = await gradeSlice({ axis: "E5.1", slice: "PROBE QUESTION\n...", callJudge: call });
    expect(grade).toEqual({ pass: true, evidence: "answer matches accept[0]" });
  });

  it("parses JSON wrapped in a ```json code fence", async () => {
    const { call } = fakeJudge(['```json\n{"pass": false, "evidence": "fabricated"}\n```']);
    const grade = await gradeSlice({ axis: "E6", slice: "x", callJudge: call });
    expect(grade.pass).toBe(false);
    expect(grade.evidence).toBe("fabricated");
  });

  it("parses JSON embedded in surrounding prose (extracts the {...} block)", async () => {
    const { call } = fakeJudge(['Sure! Here is my grade:\n{"pass": true, "evidence": "used latest"}\nThanks.']);
    const grade = await gradeSlice({ axis: "E8", slice: "x", callJudge: call });
    expect(grade.pass).toBe(true);
  });

  it("defaults evidence to '' when the model omits it", async () => {
    const { call } = fakeJudge(['{"pass": true}']);
    const grade = await gradeSlice({ axis: "E5.1", slice: "x", callJudge: call });
    expect(grade).toEqual({ pass: true, evidence: "" });
  });

  it("re-prompts on malformed JSON, then succeeds (≤ maxRetries)", async () => {
    const { call, calls } = fakeJudge(["not json at all", '{"pass": true, "evidence": "ok"}']);
    const grade = await gradeSlice({ axis: "E2", slice: "x", callJudge: call, maxRetries: 2 });
    expect(grade.pass).toBe(true);
    expect(calls).toHaveLength(2); // initial + 1 re-prompt
    // The re-prompt nudges the model about the malformed prior response.
    expect(calls[1]?.[0]).toMatch(/valid json|not valid|malformed/i);
  });

  it("throws JudgeMalformedJsonError after maxRetries malformed responses (STOP+surface)", async () => {
    const { call, calls } = fakeJudge(["garbage", "still garbage", "more garbage"]);
    await expect(gradeSlice({ axis: "E5.1", slice: "x", callJudge: call, maxRetries: 2 })).rejects.toBeInstanceOf(
      JudgeMalformedJsonError,
    );
    // initial + 2 re-prompts = 3 calls total.
    expect(calls).toHaveLength(3);
  });

  it("uses the default maxRetries=2 when maxRetries is omitted", async () => {
    const { call, calls } = fakeJudge(["bad", "bad", "bad"]);
    await expect(gradeSlice({ axis: "E5.1", slice: "x", callJudge: call })).rejects.toBeInstanceOf(
      JudgeMalformedJsonError,
    );
    expect(calls).toHaveLength(3);
  });

  it("includes the axis rubric in the system prompt", async () => {
    const { call, calls } = fakeJudge(['{"pass": true, "evidence": ""}']);
    await gradeSlice({ axis: "E5.1", slice: "x", callJudge: call });
    expect(calls[0]?.[0]).toContain("accept");
  });
});
