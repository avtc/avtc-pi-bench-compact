// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAuthoringSystemPrompt } from "../../src/manifest/author.js";
import { AUTHORING_SYSTEM_PROMPT } from "../../src/manifest/prompt.js";

const here = dirname(fileURLToPath(import.meta.url));
const canonicalFixture = readFileSync(join(here, "fixtures/section-4.18-prompt.txt"), "utf8").trimEnd();

describe("AUTHORING_SYSTEM_PROMPT (§4.18 byte-compare against frozen fixture)", () => {
  it("matches the canonical §4.18 prompt byte-for-byte (catches any drift)", () => {
    // If this fails, prompt.ts drifted from the frozen §4.18 fixture — update the
    // fixture CONSCIOUSLY (it is the source of truth for the verbatim prompt).
    expect(AUTHORING_SYSTEM_PROMPT).toBe(canonicalFixture);
  });
});

describe("buildAuthoringSystemPrompt", () => {
  it("substitutes the <PATH> placeholder with the JSONL path (including $-bearing paths)", () => {
    // R1-4: a path containing $ must not be mangled by String.replace's special $ patterns.
    const p = buildAuthoringSystemPrompt({ preSlicedJsonlPath: "/tmp/$HOME/sliced.jsonl" });
    expect(p).toContain("/tmp/$HOME/sliced.jsonl");
    expect(p).not.toContain("<PATH>");
  });

  it("appends the knownConditions list when provided (build-mode anchors)", () => {
    const p = buildAuthoringSystemPrompt({
      preSlicedJsonlPath: "/tmp/x.jsonl",
      knownConditions: [{ name: "key-decision", entryId: "e1" }],
    });
    expect(p).toContain("e1");
    expect(p).toContain("key-decision");
    expect(p).toMatch(/use as anchors/i);
  });

  it("does NOT append knownConditions data when absent (extract mode)", () => {
    // R1-6: assert the appended anchor marker is ABSENT (not a tautological self-compare).
    const p = buildAuthoringSystemPrompt({ preSlicedJsonlPath: "/tmp/x.jsonl" });
    expect(p).not.toMatch(/use as anchors/i);
    expect(p).not.toMatch(/the session was designed to contain these/i);
  });

  it("instructs TWO probes per reversal — latest-value accept + stale-value correctRefusal (E6 stale face)", () => {
    // The E6 abstention rubric grades BOTH faces (never-decided + supersession stale-item).
    // The authoring prompt must generate a stale-value probe per reversal (correctRefusal) so
    // the stale face is exercisable — otherwise E6 only tests never-decided.
    const p = AUTHORING_SYSTEM_PROMPT;
    expect(p).toMatch(/write TWO probes/i);
    expect(p).toMatch(/stale-value/i);
    expect(p).toMatch(/flag\s+the old value as outdated/i);
  });
});
