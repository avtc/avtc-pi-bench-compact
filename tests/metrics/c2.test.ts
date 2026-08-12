// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { computeC2 } from "../../src/metrics/c2.js";
import { computeC3 } from "../../src/metrics/exact.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";

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

function userEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: { role: "user", content: "x", timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, output: number): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "y" }],
      api: "anthropic-messages",
      provider: "p",
      model: "m",
      usage: makeUsage(output),
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function compaction(id: string, parentId: string | null): { entry: CompactionEntry; wallMs: number } {
  return {
    entry: {
      type: "compaction",
      ...base(id, parentId),
      summary: "s",
      firstKeptEntryId: "kept-1",
      tokensBefore: 1000,
      usage: makeUsage(50),
    } as CompactionEntry,
    wallMs: 0,
  };
}

/** A trace whose post-compaction range is three assistant turns (100, 200, 50). */
function sampleTrace(): RunTrace {
  const c1 = compaction("c1", "u0");
  const entries: SessionEntry[] = [
    userEntry("u0", null),
    assistantEntry("a0", "u0", 999), // pre-compaction — excluded
    c1.entry,
    assistantEntry("a1", "c1", 100),
    assistantEntry("a2", "a1", 200),
    assistantEntry("a3", "a2", 50),
  ];
  return { branch: "branch-x", entries, compactions: [c1], tracePath: "/repo/session.jsonl" };
}

describe("computeC2 (recall-cost tokens to the judge boundary)", () => {
  it("sums post-compaction assistant output up to and including the boundary entry", () => {
    const trace = sampleTrace();

    // Boundary at a2 → a1 (100) + a2 (200) = 300 (inclusive of the boundary turn).
    expect(computeC2(trace, "a2")).toEqual({ tokens: 300, notRecovered: false });
  });

  it("flags notRecovered when no boundary was identified (tokens = the full post-compaction output)", () => {
    const trace = sampleTrace();

    const result = computeC2(trace, null);
    expect(result.notRecovered).toBe(true);
    // Never recovered → the whole post-compaction output (== computeC3).
    expect(result.tokens).toBe(computeC3(trace));
    expect(result.tokens).toBe(350);
  });

  it("sums to the boundary when it is the first post-compaction turn", () => {
    const trace = sampleTrace();
    expect(computeC2(trace, "a1")).toEqual({ tokens: 100, notRecovered: false });
  });

  it("falls back to the full post-compaction sum when the boundary id is not in the post-compaction range", () => {
    const trace = sampleTrace();
    // A provided-but-unknown boundary: lenient — recovery happened, sum all.
    expect(computeC2(trace, "no-such-entry")).toEqual({ tokens: 350, notRecovered: false });
  });

  it("is deterministic — the same trace + boundary yield the same result", () => {
    const trace = sampleTrace();
    expect(computeC2(trace, "a2")).toEqual(computeC2(trace, "a2"));
  });
});
