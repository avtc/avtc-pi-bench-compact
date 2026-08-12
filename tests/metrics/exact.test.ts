// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { computeC1, computeC3, computeC4 } from "../../src/metrics/exact.js";
import type { Pricing } from "../../src/metrics/pricing.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";
import { CHARS_PER_TOKEN_ESTIMATE } from "../../src/runtime/streaming-tokens.js";

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function makeUsage(input: number, output: number): Usage {
  return makeUsageFull(input, output, 0, 0);
}

/** Full usage with explicit cache fields (for the compaction-cost fixtures). */
function makeUsageFull(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
  const total = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total,
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
      usage: makeUsage(0, output),
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function compaction(
  id: string,
  parentId: string | null,
  summary: string,
  usage: Usage,
  opts: { firstKeptEntryId?: string; details?: unknown; wallMs?: number } = {},
): { entry: CompactionEntry; wallMs: number } {
  const entry = {
    type: "compaction",
    ...base(id, parentId),
    summary,
    firstKeptEntryId: opts.firstKeptEntryId ?? "kept-1",
    tokensBefore: 1000,
    usage,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  } as CompactionEntry;
  return { entry, wallMs: opts.wallMs ?? 0 };
}

function traceOf(entries: SessionEntry[], compactions: { entry: CompactionEntry; wallMs: number }[]): RunTrace {
  return { branch: "branch-x", entries, compactions, tracePath: "/repo/session.jsonl" };
}

describe("computeC1 (summary footprint tokens)", () => {
  it("token-counts the summary via the shared chars-per-token estimate", () => {
    // 12 chars / 4 chars-per-token = 3 tokens.
    const summary = "abcdefghijkl";
    const { entry } = compaction("c1", null, summary, makeUsage(0, 0));

    expect(computeC1(entry)).toBe(summary.length / CHARS_PER_TOKEN_ESTIMATE);
  });

  it("rounds up to a whole token (the shared estimate's ceiling)", () => {
    // 10 chars / 4 = 2.5 → ceil → 3.
    const { entry } = compaction("c1", null, "0123456789", makeUsage(0, 0));
    expect(computeC1(entry)).toBe(3);
  });

  it("is 0 for an empty summary", () => {
    const { entry } = compaction("c1", null, "", makeUsage(0, 0));
    expect(computeC1(entry)).toBe(0);
  });
});

describe("computeC3 (post-compaction output tokens)", () => {
  it("sums the output tokens of assistant messages after the boundary compaction", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20));
    const entries: SessionEntry[] = [
      userEntry("u0", null),
      assistantEntry("a0", "u0", 999), // pre-compaction assistant — excluded
      c1.entry,
      assistantEntry("a1", "c1", 120), // post-compaction — counted
      userEntry("u1", "a1"),
      assistantEntry("a2", "u1", 80), // post-compaction — counted
    ];
    const trace = traceOf(entries, [c1]);

    expect(computeC3(trace)).toBe(200);
  });

  it("excludes the boundary compaction's own usage from the run-cost sum", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(1000, 500));
    const entries: SessionEntry[] = [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 30)];
    const trace = traceOf(entries, [c1]);

    // Only the post-compaction assistant output (30), not the compaction's usage.
    expect(computeC3(trace)).toBe(30);
  });

  it("is deterministic — the same trace yields the same number", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(10, 5));
    const entries: SessionEntry[] = [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 42)];
    const trace = traceOf(entries, [c1]);

    expect(computeC3(trace)).toBe(computeC3(trace));
  });
});

describe("computeC4 (compaction cost: tokens + dollars + wall-clock)", () => {
  const pricing: Pricing = { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.3, cacheWritePerM: 2.5 };

  it("sums every compaction's usage, prices it, and sums the bench wall-clock", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsageFull(90000, 1500, 80000, 0), {
      wallMs: 2000,
      details: { compactionStages: [{ stage: "Observer" }, { stage: "Builder" }] },
    });
    const c2 = compaction("c2", "a1", "second summary", makeUsageFull(50000, 300, 40000, 100), { wallMs: 5000 });
    const entries: SessionEntry[] = [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 1), c2.entry];
    const trace = traceOf(entries, [c1, c2]);

    const result = computeC4(trace, pricing);

    // Token quadruple summed across both compactions.
    expect(result.tokensIn).toBe(140000);
    expect(result.tokensOut).toBe(1800);
    expect(result.cacheRead).toBe(120000);
    expect(result.cacheWrite).toBe(100);
    // Dollars priced from the summed tokens (140000/1e6*2 + 1800/1e6*6 + 120000/1e6*0.3 + 100/1e6*2.5).
    expect(result.dollars).toBeCloseTo(0.32705, 10);
    // Wall-clock summed from the bench-captured per-compaction timings.
    expect(result.wallMs).toBe(7000);
    // Stages read from the boundary compaction's per-stage details.
    expect(result.stages).toEqual([{ name: "Observer" }, { name: "Builder" }]);
    // The continuation compaction's cost is aggregated separately.
    expect(result.phase2Compactions).toEqual({
      count: 1,
      tokensIn: 50000,
      tokensOut: 300,
      cacheRead: 40000,
      cacheWrite: 100,
      dollars: 0.11405,
      wallMs: 5000,
    });
  });

  it("reads stage names whether emitted as objects or as bare strings", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(1, 1), {
      details: { compactionStages: ["Observer", "Builder"] },
    });
    const trace = traceOf([userEntry("u0", null), c1.entry], [c1]);

    expect(computeC4(trace, pricing).stages).toEqual([{ name: "Observer" }, { name: "Builder" }]);
  });

  it("defaults stages to native-summary when the boundary compaction has no per-stage details (native arm)", () => {
    // The native pi compaction emits details = { readFiles, modifiedFiles } (no
    // compactionStages) — or no details at all. Both default to a single
    // native-summary stage.
    const withNativeDetails = compaction("c1", "u0", "summary", makeUsage(1, 1), {
      details: { readFiles: [], modifiedFiles: [] },
    });
    expect(
      computeC4(traceOf([userEntry("u0", null), withNativeDetails.entry], [withNativeDetails]), pricing).stages,
    ).toEqual([{ name: "native-summary" }]);

    const noDetails = compaction("c1", "u0", "summary", makeUsage(1, 1));
    expect(computeC4(traceOf([userEntry("u0", null), noDetails.entry], [noDetails]), pricing).stages).toEqual([
      { name: "native-summary" },
    ]);
  });

  it("treats a compaction with missing usage as zero tokens (never undefined)", () => {
    const noUsage = {
      ...compaction("c1", "u0", "summary", makeUsage(0, 0)).entry,
      usage: undefined,
    } as CompactionEntry;
    const wrapped = { entry: noUsage, wallMs: 100 };
    const result = computeC4(traceOf([userEntry("u0", null), noUsage], [wrapped]), pricing);

    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.cacheRead).toBe(0);
    expect(result.cacheWrite).toBe(0);
    expect(result.dollars).toBe(0);
    expect(result.wallMs).toBe(100);
  });

  it("aggregates phase2Compactions to zero count when the run never re-compacted", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsageFull(100, 10, 50, 0), { wallMs: 300 });
    const trace = traceOf([userEntry("u0", null), c1.entry], [c1]);

    const phase2 = computeC4(trace, pricing).phase2Compactions;
    expect(phase2.count).toBe(0);
    expect(phase2.tokensIn).toBe(0);
    expect(phase2.dollars).toBe(0);
    expect(phase2.wallMs).toBe(0);
  });

  it("is deterministic — the same trace + pricing yield the same result", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 10), {
      wallMs: 300,
      details: { compactionStages: ["s1"] },
    });
    const trace = traceOf([userEntry("u0", null), c1.entry], [c1]);

    expect(computeC4(trace, pricing)).toEqual(computeC4(trace, pricing));
  });
});
