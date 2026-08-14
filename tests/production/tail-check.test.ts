// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  parseTailCheckResponse,
  renderTailText,
  TAIL_CHECK_SYSTEM_PROMPT,
  TAIL_TEXT_CAP,
} from "../../src/production/tail-check.js";

describe("parseTailCheckResponse", () => {
  it("maps prompt kinds to condition-topic ids (name pairs differ)", () => {
    const ids = parseTailCheckResponse(
      `{"key-decision": true, "completed-work": true, "reversal": true, "open-question": true}`,
    );
    expect([...ids].sort()).toEqual(["change-mind", "completed-system", "key-decision", "open-question"]);
  });

  it("all-false → empty set", () => {
    expect(
      parseTailCheckResponse(
        `{"key-decision": false, "completed-work": false, "reversal": false, "open-question": false}`,
      ).size,
    ).toBe(0);
  });

  it("extracts a JSON object embedded in prose", () => {
    const ids = parseTailCheckResponse(
      `Here you go:\n{"key-decision": true, "completed-work": false, "reversal": false, "open-question": false}\nDone.`,
    );
    expect([...ids]).toEqual(["key-decision"]);
  });

  it("malformed JSON → conservative empty set (classify missing → surface)", () => {
    expect(parseTailCheckResponse(`{"key-decision": tru`).size).toBe(0);
  });

  it("no JSON object at all → conservative empty set", () => {
    expect(parseTailCheckResponse("I cannot answer that.").size).toBe(0);
  });

  it("non-boolean values ignored; unknown keys ignored", () => {
    const ids = parseTailCheckResponse(`{"key-decision": "yes", "mystery": true, "open-question": true}`);
    expect([...ids]).toEqual(["open-question"]);
  });

  it("the prompt names exactly the four kinds + demands a JSON-only reply", () => {
    expect(TAIL_CHECK_SYSTEM_PROMPT).toContain("key-decision");
    expect(TAIL_CHECK_SYSTEM_PROMPT).toContain("completed-work");
    expect(TAIL_CHECK_SYSTEM_PROMPT).toContain("reversal");
    expect(TAIL_CHECK_SYSTEM_PROMPT).toContain("open-question");
    expect(TAIL_CHECK_SYSTEM_PROMPT).toContain("Respond with ONLY a JSON object");
  });
});

describe("renderTailText", () => {
  const msg = (role: string, text: string): unknown => ({
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  });

  it("renders message entries as role-labeled blocks, skipping non-message + empty-text", () => {
    const out = renderTailText([
      msg("user", "Let's use a fixed-tick economy."),
      { type: "toolCall", id: "t1" },
      msg("assistant", "Done — economy module committed."),
      msg("assistant", "   "), // whitespace-only → skipped
      { type: "branch_summary", id: "b1" },
    ]);
    expect(out).toBe("[user] Let's use a fixed-tick economy.\n\n[assistant] Done — economy module committed.");
  });

  it("joins multiple text parts in one entry", () => {
    const out = renderTailText([
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        },
      },
    ]);
    expect(out).toBe("[user] Part one. Part two.");
  });

  it("caps the render at the safety limit (keeps the head)", () => {
    const big = "x".repeat(TAIL_TEXT_CAP + 500);
    const out = renderTailText([msg("user", big)]);
    expect(out.length).toBe(TAIL_TEXT_CAP);
  });
});
