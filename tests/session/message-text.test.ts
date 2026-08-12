// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { extractContentText, messageText } from "../../src/session/message-text.js";

function entryWith(role: string, content: unknown): SessionEntry {
  return { type: "message", id: "x", parentId: null, timestamp: "", message: { role, content } } as SessionEntry;
}

describe("extractContentText", () => {
  it("concatenates the text blocks of a content array", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "toolCall", name: "read" },
      { type: "text", text: "world" },
    ];
    expect(extractContentText(content)).toBe("Hello world");
  });

  it("returns '' for a non-array content", () => {
    expect(extractContentText(undefined)).toBe("");
    expect(extractContentText("not an array")).toBe("");
    expect(extractContentText(null)).toBe("");
  });

  it("ignores non-text blocks + malformed blocks", () => {
    expect(extractContentText([{ type: "text", text: "ok" }, { type: "thinking" }, {}, null, { text: 5 }])).toBe("ok");
  });

  it("returns '' for an empty array", () => {
    expect(extractContentText([])).toBe("");
  });
});

describe("messageText", () => {
  it("extracts the text from a message entry", () => {
    expect(messageText(entryWith("assistant", [{ type: "text", text: "hi" }]))).toBe("hi");
  });

  it("returns '' for an entry with no message", () => {
    expect(messageText({ type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry)).toBe("");
  });

  it("returns '' for a message with non-array content", () => {
    expect(messageText(entryWith("user", "raw string content"))).toBe("");
  });
});
