// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";

describe("ANTI_PEEK_PROMPT (§3.14)", () => {
  it("is a non-empty instruction string", () => {
    expect(typeof ANTI_PEEK_PROMPT).toBe("string");
    expect(ANTI_PEEK_PROMPT.length).toBeGreaterThan(80);
  });

  it("forbids browsing/checkout of other git branches", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toMatch(/git checkout|other branch|sibling branch/);
  });

  it("forbids reading the session.jsonl file directly", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toContain("session.jsonl");
  });

  it("names the forbidden bench artifacts (manifest / runs / configs)", () => {
    const lower = ANTI_PEEK_PROMPT.toLowerCase();
    expect(lower).toContain("manifest");
    expect(lower).toMatch(/runs\b|results|judge/);
    expect(lower).toContain("configs");
  });

  it("scopes permitted work to the current branch's repo working files", () => {
    expect(ANTI_PEEK_PROMPT.toLowerCase()).toMatch(/current branch|working (tree|dir|files)|project cwd/);
  });
});
