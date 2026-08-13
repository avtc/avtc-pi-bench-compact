// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  phaseOneCompactionIndex,
  postCompactionEntries,
  readTraceFromRepo,
  sumAssistantOutput,
} from "../../src/metrics/trace-read.js";

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function makeUsage(output: number): Usage {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function base(id: string, parentId: string | null) {
  return { id, parentId, timestamp: "2026-08-11T00:00:00.000Z" };
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, text: string, output: number): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "p",
      model: "m",
      usage: makeUsage(output),
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, parentId: string | null, summary: string): SessionEntry {
  return {
    type: "compaction",
    ...base(id, parentId),
    summary,
    firstKeptEntryId: "kept-1",
    tokensBefore: 1000,
    usage: makeUsage(50),
  } as unknown as SessionEntry;
}

function writeJsonl(repo: string, entries: object[]): void {
  const header = { type: "session", version: 3, id: "s1", timestamp: "2026-08-11T00:00:00.000Z", cwd: repo };
  const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(repo, "session.jsonl"), lines, "utf8");
}

describe("readTraceFromRepo", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-trace-read-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("parses the repo session.jsonl into real entries + isolated compaction entries", () => {
    writeJsonl(repo, [
      userEntry("u0", null, "start"),
      compactionEntry("c1", "u0", "the boundary summary"),
      assistantEntry("a1", "c1", "continued", 120),
      userEntry("u1", "a1", "again"),
      assistantEntry("a2", "u1", "more", 80),
    ]);

    const { entries, compactionEntries } = readTraceFromRepo(repo);

    // The session header is filtered; every real session entry is returned in file order.
    expect(entries.map((e) => e.id)).toEqual(["u0", "c1", "a1", "u1", "a2"]);
    // Compaction entries are isolated from the full entry list.
    expect(compactionEntries.map((e) => e.id)).toEqual(["c1"]);
    expect(compactionEntries[0]?.summary).toBe("the boundary summary");
  });

  it("returns an empty compaction list when the branch never compacted", () => {
    writeJsonl(repo, [userEntry("u0", null, "hi"), assistantEntry("a1", "u0", "hey", 10)]);
    const { entries, compactionEntries } = readTraceFromRepo(repo);
    expect(entries.map((e) => e.id)).toEqual(["u0", "a1"]);
    expect(compactionEntries).toEqual([]);
  });
});

describe("phaseOneCompactionIndex", () => {
  it("is the index of the first (boundary) compaction entry", () => {
    const entries: SessionEntry[] = [
      userEntry("u0", null, "x"),
      compactionEntry("c1", "u0", "s"),
      assistantEntry("a1", "c1", "y", 1),
    ];
    expect(phaseOneCompactionIndex(entries)).toBe(1);
  });

  it("is -1 when there is no compaction", () => {
    const entries: SessionEntry[] = [userEntry("u0", null, "x")];
    expect(phaseOneCompactionIndex(entries)).toBe(-1);
  });
});

describe("postCompactionEntries", () => {
  it("returns the entries strictly after the first (boundary) compaction", () => {
    const entries: SessionEntry[] = [
      userEntry("u0", null, "x"),
      compactionEntry("c1", "u0", "s"),
      assistantEntry("a1", "c1", "y", 1),
      userEntry("u2", "a1", "z"),
    ];
    expect(postCompactionEntries(entries).map((e) => e.id)).toEqual(["a1", "u2"]);
  });

  it("falls back to the whole run when there is no compaction (index -1 → slice 0)", () => {
    const entries: SessionEntry[] = [userEntry("u0", null, "x"), assistantEntry("a1", "u0", "y", 1)];
    expect(postCompactionEntries(entries).map((e) => e.id)).toEqual(["u0", "a1"]);
  });
});

describe("sumAssistantOutput", () => {
  it("sums the output tokens of assistant messages only (ignores user, tool results, compactions)", () => {
    const toolResult = {
      type: "message",
      ...base("t1", "a1"),
      message: {
        role: "toolResult",
        toolCallId: "tc",
        toolName: "n",
        content: [],
        isError: false,
        usage: makeUsage(999),
        timestamp: 0,
      },
    } as unknown as SessionEntry;
    const entries: SessionEntry[] = [
      userEntry("u0", null, "x"),
      assistantEntry("a1", "u0", "y", 120),
      compactionEntry("c1", "a1", "s"),
      assistantEntry("a2", "c1", "z", 80),
      toolResult,
    ];

    // a1 (120) + a2 (80) = 200. The tool result's usage.output (999) is excluded
    // (tool-result usage is not part of main LLM context accounting), as are the
    // user message and the compaction entry.
    expect(sumAssistantOutput(entries)).toBe(200);
  });

  it("is 0 when no assistant messages are present", () => {
    const entries: SessionEntry[] = [userEntry("u0", null, "x"), compactionEntry("c1", "u0", "s")];
    expect(sumAssistantOutput(entries)).toBe(0);
  });
});
