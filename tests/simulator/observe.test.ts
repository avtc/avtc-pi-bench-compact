// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildChunks,
  type ChunkOptions,
  computeUnobserved,
  isRenderableEntry,
  lastUserMessageId,
} from "../../src/simulator/observe.js";

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
function asstToolCall(id: string, callId: string, name: string, args: string): SessionEntry {
  return {
    type: "message",
    ...base(id),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: args }],
    },
  } as unknown as SessionEntry;
}

function toolResult(id: string, callId: string, text: string, isError = false): SessionEntry {
  return {
    type: "message",
    ...base(id),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "x",
      content: [{ type: "text", text }],
      isError,
    },
  } as unknown as SessionEntry;
}

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
const OPTS_WITH_IDS: ChunkOptions = { ...OPTS_NO_IDS, includeEntryId: true };

describe("lastUserMessageId", () => {
  it("returns the id of the last user-role message in the branch", () => {
    const entries = [user("u1", "seed"), asst("a1", "resp"), user("u2", "sim inject"), asst("a2", "resp2")];
    expect(lastUserMessageId(entries)).toBe("u2");
  });

  it("returns the seed when it is the only user message (cycle 1)", () => {
    const entries = [user("seed", "task"), asst("a1", "resp")];
    expect(lastUserMessageId(entries)).toBe("seed");
  });

  it("returns null when there is no user message", () => {
    expect(lastUserMessageId([asst("a1", "hi")])).toBeNull();
    expect(lastUserMessageId([])).toBeNull();
  });

  it("ignores non-message entries (operational) when scanning", () => {
    const entries = [user("u1", "seed"), modelChange("m"), asst("a1", "resp")];
    expect(lastUserMessageId(entries)).toBe("u1");
  });
});

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

describe("computeUnobserved", () => {
  it("null frontier → renderable entries strictly AFTER the first user message", () => {
    const entries = [
      asst("a0", "pre"),
      user("u1", "task"),
      asst("a1", "did"),
      modelChange("m"),
      customMessage("c", "note"),
    ];
    expect(computeUnobserved(entries, null).map((e) => e.id)).toEqual(["a1", "c"]);
  });

  it("null frontier + no user message → empty (no anchor)", () => {
    const entries = [asst("a0", "hi"), customMessage("c", "note")];
    expect(computeUnobserved(entries, null)).toEqual([]);
  });

  it("frontier = entry id → renderable entries strictly after it", () => {
    const entries = [user("u1", "task"), asst("a1", "one"), asst("a2", "two"), user("u2", "more")];
    expect(computeUnobserved(entries, "a1").map((e) => e.id)).toEqual(["a2", "u2"]);
  });

  it("stale frontier id (not on branch) → empty", () => {
    const entries = [user("u1", "task"), asst("a1", "one")];
    expect(computeUnobserved(entries, "gone")).toEqual([]);
  });

  it("frontier = last entry → empty", () => {
    const entries = [user("u1", "task"), asst("a1", "one")];
    expect(computeUnobserved(entries, "a1")).toEqual([]);
  });
});

describe("buildChunks", () => {
  it("empty input → no chunks", () => {
    expect(buildChunks([], OPTS_NO_IDS)).toEqual([]);
  });

  it("groups entry-bound + token-gated: a big entry flushes its own chunk", () => {
    // ~400 chars = ~100 tokens; threshold 50 → one chunk per big message
    const big = "x".repeat(400);
    const entries = [user("u1", big), asst("a1", big)];
    const chunks = buildChunks(entries, { ...OPTS_NO_IDS, tokenThreshold: 50 });
    expect(chunks.length).toBe(2); // each big entry its own chunk
    expect(chunks[0].firstEntryId).toBe("u1");
    expect(chunks[0].lastEntryId).toBe("u1");
    expect(chunks[1].firstEntryId).toBe("a1");
  });

  it("small entries batch into one chunk under a high threshold", () => {
    const entries = [user("u1", "hi"), asst("a1", "hello")];
    const chunks = buildChunks(entries, OPTS_NO_IDS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].firstEntryId).toBe("u1");
    expect(chunks[0].lastEntryId).toBe("a1");
  });

  it("pairs a tool call with its tool result inside one block sequence", () => {
    const entries = [asstToolCall("a1", "call1", "read", '"file.ts"'), toolResult("r1", "call1", "file contents")];
    const [chunk] = buildChunks(entries, OPTS_NO_IDS);
    expect(chunk.text).toContain("<TOOLCALL:read>");
    expect(chunk.text).toContain("<TOOLRESULT>");
    expect(chunk.text).toContain("file contents");
  });

  it("includeEntryId: false omits entry= attributes (simulator doesn't cite)", () => {
    const [chunk] = buildChunks([user("u1", "hi")], OPTS_NO_IDS);
    expect(chunk.text).not.toContain("entry=");
  });

  it("includeEntryId: true emits entry= attributes", () => {
    const [chunk] = buildChunks([user("u1", "hi")], OPTS_WITH_IDS);
    expect(chunk.text).toContain("entry=u1");
  });

  it("allowedIds = the entry ids cited in the chunk's blocks", () => {
    const entries = [user("u1", "hi"), asst("a1", "hello")];
    const [chunk] = buildChunks(entries, OPTS_NO_IDS);
    expect([...chunk.allowedIds].sort()).toEqual(["a1", "u1"]);
  });

  it("strips ANSI escape sequences from rendered text", () => {
    // \x1b[31m red, \x1b[0m reset
    const entries = [user("u1", "\x1b[31mred text\x1b[0m")];
    const [chunk] = buildChunks(entries, OPTS_NO_IDS);
    expect(chunk.text).toContain("red text");
    expect(chunk.text).not.toContain("\x1b[");
  });

  it("skips an empty user message (no block emitted)", () => {
    const [chunk] = buildChunks([user("u1", ""), asst("a1", "real")], OPTS_NO_IDS);
    expect(chunk.text).not.toContain("<USER>");
    expect(chunk.text).toContain("<ASSISTANT>");
  });

  it("toolBlockCapTokens truncates a long tool result (head + tail + marker)", () => {
    const long = "y".repeat(400);
    const entries = [asstToolCall("a1", "call1", "read", '"f"'), toolResult("r1", "call1", long)];
    const [chunk] = buildChunks(entries, { ...OPTS_NO_IDS, toolBlockCapTokens: 10 });
    expect(chunk.text).toContain("[…truncated…]");
  });
});
