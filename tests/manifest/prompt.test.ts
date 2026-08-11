// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { AUTHORING_SYSTEM_PROMPT } from "../../src/manifest/prompt.js";

describe("AUTHORING_SYSTEM_PROMPT (§4.18 verbatim)", () => {
  it("frames the compaction-remember test", () => {
    const p = AUTHORING_SYSTEM_PROMPT.toLowerCase();
    expect(p).toMatch(/compacted/);
    expect(p).toMatch(/remember/);
  });

  it("introduces the session file at the <PATH> placeholder", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toContain("<PATH>");
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/JSONL file/i);
  });

  it("lists the 4 condition kinds to find (decision, completed work, reversal, open question)", () => {
    const p = AUTHORING_SYSTEM_PROMPT.toLowerCase();
    expect(p).toMatch(/decision or technical detail/);
    expect(p).toMatch(/already completed/);
    expect(p).toMatch(/reversal/);
    expect(p).toMatch(/open question/);
  });

  it("specifies probe rules (neutral wording, one fact per probe, accept list, correctRefusal)", () => {
    const lower = AUTHORING_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/neutral wording/);
    expect(lower).toMatch(/one fact per probe/);
    expect(AUTHORING_SYSTEM_PROMPT).toContain("accept");
    expect(AUTHORING_SYSTEM_PROMPT).toContain("correctRefusal");
  });

  it("includes the KNOWN CONDITIONS guidance (build-mode anchors)", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/KNOWN CONDITIONS/i);
  });

  it("specifies the write_manifest output shape with all 5 lists", () => {
    const p = AUTHORING_SYSTEM_PROMPT;
    expect(p).toContain("write_manifest");
    for (const key of ["recallFacts", "doneOps", "supersessions", "abstentions", "probes"]) {
      expect(p).toContain(key);
    }
  });

  it("states the constraints (real entryIds; leave empty if absent; prefer material over trivia)", () => {
    const p = AUTHORING_SYSTEM_PROMPT.toLowerCase();
    expect(p).toMatch(/every entryid you list must be a real id/);
    expect(p).toMatch(/do not invent/);
    expect(p).toMatch(/skip trivia/);
  });
});
