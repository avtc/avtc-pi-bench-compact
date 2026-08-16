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

describe("AUTHORING_SYSTEM_PROMPT (byte-compare against frozen fixture)", () => {
  it("matches the canonical prompt byte-for-byte (catches any drift)", () => {
    // If this fails, prompt.ts drifted from the frozen fixture — update the
    // fixture CONSCIOUSLY (it is the source of truth for the verbatim prompt).
    expect(AUTHORING_SYSTEM_PROMPT).toBe(canonicalFixture);
  });
});

describe("buildAuthoringSystemPrompt", () => {
  it("substitutes the <PATH> placeholder with the JSONL path (including $-bearing paths)", () => {
    // a path containing $ must not be mangled by String.replace's special $ patterns.
    const p = buildAuthoringSystemPrompt({ fullJsonlPath: "/tmp/$HOME/full.jsonl", tailStartsAtEntryId: "cut-1" });
    expect(p).toContain("/tmp/$HOME/full.jsonl");
    expect(p).not.toContain("<PATH>");
  });

  it("appends the knownConditions list when provided (build-mode anchors)", () => {
    const p = buildAuthoringSystemPrompt({
      fullJsonlPath: "/tmp/x-full.jsonl",
      tailStartsAtEntryId: "cut-1",
      knownConditions: [{ name: "key-decision", entryId: "e1" }],
    });
    expect(p).toContain("e1");
    expect(p).toContain("key-decision");
    expect(p).toMatch(/use as anchors/i);
  });

  it("does NOT append knownConditions data when absent (extract mode)", () => {
    // assert the appended anchor marker is ABSENT (not a tautological self-compare).
    const p = buildAuthoringSystemPrompt({ fullJsonlPath: "/tmp/x-full.jsonl", tailStartsAtEntryId: "cut-1" });
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

describe("AUTHORING_SYSTEM_PROMPT — tail validation", () => {
  const p = buildAuthoringSystemPrompt({ fullJsonlPath: "/tmp/full.jsonl", tailStartsAtEntryId: "cut-9" });

  it("marks the two segments (compacted-away span vs kept tail) with the boundary entry id", () => {
    expect(p).toContain("cut-9");
    expect(p).toMatch(/COMPACTED-AWAY SPAN/i);
    expect(p).toMatch(/KEPT TAIL/i);
  });

  it("carries the validation-only rule verbatim", () => {
    expect(p).toContain("The kept tail is context for validation only — never cite it in `targets`, never phrase");
    expect(p).toContain("`accept` from it.");
  });

  it("instructs both conflict kinds (answerable + superseded)", () => {
    expect(p).toMatch(/kind "answerable"/i);
    expect(p).toMatch(/kind "superseded"/i);
  });
});
