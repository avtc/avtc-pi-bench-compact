// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type ChunkOptions, isRenderableEntry, renderFullTranscript } from "../../src/simulator/observe.js";

// --- fixture builders (well-shaped plain objects cast to the entry union) ---

const base = (id: string) => ({ id, parentId: null as string | null, timestamp: "0" });

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    ...base(id),
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

/** A short assistant text message (minimal content array — renderGroups reads part.type + part.text). */
function asst(id: string, text: string): SessionEntry {
  return {
    type: "message",
    ...base(id),
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

/** An assistant message carrying ONE tool call (matched to a toolResult by toolCall.id). */
function customMessage(id: string, text: string): SessionEntry {
  return { type: "custom_message", ...base(id), customType: "note", content: text } as unknown as SessionEntry;
}

function branchSummary(id: string, summary: string): SessionEntry {
  return { type: "branch_summary", ...base(id), fromId: "x", summary } as unknown as SessionEntry;
}

function modelChange(id: string): SessionEntry {
  return { type: "model_change", ...base(id), provider: "p", modelId: "m" } as unknown as SessionEntry;
}

const OPTS_NO_IDS: ChunkOptions = {
  tokenThreshold: Number.POSITIVE_INFINITY,
  toolBlockCapTokens: null,
  includeThinking: true,
  includeEntryId: false,
};

describe("isRenderableEntry", () => {
  it("accepts message / custom_message / branch_summary", () => {
    expect(isRenderableEntry(user("u", "hi"))).toBe(true);
    expect(isRenderableEntry(asst("a", "hi"))).toBe(true);
    expect(isRenderableEntry(customMessage("c", "hi"))).toBe(true);
    expect(isRenderableEntry(branchSummary("b", "hi"))).toBe(true);
  });

  it("rejects operational entries (model_change / label / session_info / custom)", () => {
    expect(isRenderableEntry(modelChange("m"))).toBe(false);
    expect(
      isRenderableEntry({ type: "label", ...base("l"), targetId: "x", label: "y" } as unknown as SessionEntry),
    ).toBe(false);
  });
});

describe("renderFullTranscript (the simulator's full-session input)", () => {
  it("renders EVERY renderable entry — user + assistant + thinking + tool pair — from the start", () => {
    const entries = [
      user("u0", "build the game"),
      asst("a1", "made the core loop"),
      user("u1", "add combat"),
      asst("a2", "done, combat is in"),
    ];
    const text = renderFullTranscript(entries, OPTS_NO_IDS);
    expect(text).toContain("build the game"); // the opening user message
    expect(text).toContain("made the core loop");
    expect(text).toContain("add combat"); // the simulator's OWN earlier beat
    expect(text).toContain("done, combat is in");
  });

  it("excludes operational entries (model_change etc.)", () => {
    const entries = [modelChange("m1"), user("u0", "hi"), asst("a1", "yo")];
    const text = renderFullTranscript(entries, OPTS_NO_IDS);
    expect(text).toContain("hi");
    expect(text).not.toContain("model");
  });

  it("deterministic + append-only: rendering a grown session extends the prior text", () => {
    const a = [user("u0", "one"), asst("a1", "two")];
    const b = [...a, user("u2", "three"), asst("a3", "four")];
    const t1 = renderFullTranscript(a, OPTS_NO_IDS);
    const t2 = renderFullTranscript(b, OPTS_NO_IDS);
    expect(t2.startsWith(t1)).toBe(true); // byte-stable prefix (cache friendly)
  });
});
