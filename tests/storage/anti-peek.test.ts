// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";

describe("ANTI_PEEK_PROMPT", () => {
  it("is a non-empty instruction string", () => {
    expect(typeof ANTI_PEEK_PROMPT).toBe("string");
    expect(ANTI_PEEK_PROMPT.length).toBeGreaterThan(80);
  });

  it("reveals the benchmark subject: summarization tools/approaches, not the agent", () => {
    const lower = ANTI_PEEK_PROMPT.toLowerCase();
    expect(lower).toMatch(/summari[sz]/);
    expect(lower).toMatch(/tool|approach/);
  });

  it("forbids inspecting other git branches (sibling summarization approaches)", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toMatch(/do not inspect other git branches|other git branch/);
  });

  it("states the fairness reason (each approach gets its fair score)", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toMatch(/fair score|fair/);
  });

  it("scopes work to the current branch", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toMatch(/current branch/);
  });
});
