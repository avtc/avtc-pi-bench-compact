// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the scoring orchestrator (src/orchestrate/score.ts). Built up
// incrementally: exact routing (C1/C3/C4), then C2, binary, comparative, and
// the full scoreRun assembly. Fixture helpers mirror the metrics/exact.test.ts
// patterns so the trace shapes match real session.jsonl.

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Pricing } from "../../src/metrics/pricing.js";
import { computeRunExact } from "../../src/orchestrate/score.js";
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
  const total = input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
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
  details: unknown | null,
): { entry: CompactionEntry; wallMs: number } {
  const entry = {
    type: "compaction",
    ...base(id, parentId),
    summary,
    firstKeptEntryId: "kept-1",
    tokensBefore: 1000,
    usage,
    ...(details !== null ? { details } : {}),
  } as CompactionEntry;
  return { entry, wallMs: 0 };
}

function traceOf(entries: SessionEntry[], compactions: { entry: CompactionEntry; wallMs: number }[]): RunTrace {
  return { branch: "arm-x-1", entries, compactions, tracePath: "/repo/session.jsonl" };
}

const ZERO_PRICING: Pricing = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

describe("computeRunExact (C1 guarded / C3 / C4)", () => {
  it("C1 = summary tokens when the run has a boundary compaction", () => {
    const summary = "abcdefghijkl"; // 12 chars / 4 = 3 tokens
    const c1 = compaction("c1", "u0", summary, makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 50)], [c1]);

    const exact = computeRunExact(trace, ZERO_PRICING);
    expect(exact.C1).toBe(summary.length / CHARS_PER_TOKEN_ESTIMATE);
  });

  it("C1 is undefined when the run has NO compaction (G4 guard)", () => {
    const trace = traceOf([userEntry("u0", null), assistantEntry("a1", "u0", 50)], []);

    const exact = computeRunExact(trace, ZERO_PRICING);
    expect(exact.C1).toBeUndefined();
  });

  it("C3 = post-compaction assistant output sum", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf(
      [
        userEntry("u0", null),
        assistantEntry("a0", "u0", 999),
        c1.entry,
        assistantEntry("a1", "c1", 120),
        assistantEntry("a2", "a1", 80),
      ],
      [c1],
    );

    const exact = computeRunExact(trace, ZERO_PRICING);
    expect(exact.C3).toBe(200);
  });

  it("C4 sums the compaction usage tokens (in/out) + native-summary stage", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 50)], [c1]);

    const exact = computeRunExact(trace, ZERO_PRICING);
    expect(exact.C4.tokensIn).toBe(100);
    expect(exact.C4.tokensOut).toBe(20);
    expect(exact.C4.stages).toEqual(["native-summary"]);
    expect(exact.C4.phase2Compactions).toEqual([]);
  });

  it("C4 reads per-stage names from details.compactionStages when present", () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), {
      compactionStages: ["observer", "builder", "selector"],
    });
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 50)], [c1]);

    const exact = computeRunExact(trace, ZERO_PRICING);
    expect(exact.C4.stages).toEqual(["observer", "builder", "selector"]);
  });
});

// --- C2 routing (21c) ------------------------------------------------------

import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { ArmAttemptRun } from "../../src/orchestrate/score.js";
import { gradeC2ForRun } from "../../src/orchestrate/score.js";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";
import { callTerminal, cleanResult, OK_MODEL } from "../judge/helpers.js";

const c2Manifest: ScenarioManifest = {
  id: "scen-1",
  description: "x",
  compactionBoundary: { phaseATokenBudget: 140_000, plan: "p" },
  recallFacts: [
    { id: "rf1", fact: "f1", accept: ["a1criterion"], entryIds: ["e1"], domain: "technical", lanes: [] },
    { id: "rf2", fact: "f2", accept: ["a2criterion"], entryIds: ["e2"], domain: "technical", lanes: [] },
  ],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "goal", testSpec: "" },
  probes: [],
};

/** Fake stage seams capturing a report_boundary payload (mirrors c2-boundary helpers). */
function c2Seams(payload: unknown): JsonToolStageSeams {
  return {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      callTerminal(input, "report_boundary", payload);
      return cleanResult();
    },
  };
}

function runWith(trace: RunTrace, arm: "A1" | "A3"): ArmAttemptRun {
  return { arm, attempt: 1, continuation: trace, probes: [], repo: "/repo", branch: "arm-x-1" };
}

describe("gradeC2ForRun (C2 boundary union -> per-fact computeC2)", () => {
  it("computes one C2Result per recallFact from the unioned boundary set", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf(
      [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 120), assistantEntry("a2", "a1", 80)],
      [c1],
    );
    const payload = {
      boundaries: [
        { factId: "rf1", entryId: "a1", evidence: "used rf1 at a1" },
        { factId: "rf2", entryId: null, evidence: "never recovered" },
      ],
    };
    const checkouts: [string, string][] = [];
    const results = await gradeC2ForRun(runWith(trace, "A3"), {
      manifest: c2Manifest,
      stageSeams: [c2Seams(payload)],
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: (repo, branch) => checkouts.push([repo, branch]),
    });

    expect(results).toEqual([
      { tokens: 120, notRecovered: false }, // rf1: post-compaction up to a1 inclusive
      { tokens: 200, notRecovered: true }, // rf2: never recovered -> full post-compaction sum
    ]);
    expect(checkouts).toEqual([["/repo", "arm-x-1"]]); // checked out before the judge call (G9)
  });

  it("returns [] (no judge call) when the manifest has no recallFacts", async () => {
    const trace = traceOf([userEntry("u0", null), assistantEntry("a1", "u0", 50)], []);
    const emptyManifest: ScenarioManifest = { ...c2Manifest, recallFacts: [] };
    let stageCalls = 0;
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => {
        stageCalls += 1;
        return cleanResult();
      },
    };
    const results = await gradeC2ForRun(runWith(trace, "A3"), {
      manifest: emptyManifest,
      stageSeams: [seams],
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: () => undefined,
    });
    expect(results).toEqual([]);
    expect(stageCalls).toBe(0);
  });

  it("unions K judges (a fact counts recovered if ANY judge found it)", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf(
      [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 120), assistantEntry("a2", "a1", 80)],
      [c1],
    );
    // judge1 recovers rf1 at a1, MISSES rf2; judge2 misses rf1, recovers rf2 at a2.
    const judge1 = c2Seams({
      boundaries: [
        { factId: "rf1", entryId: "a1", evidence: "j1" },
        { factId: "rf2", entryId: null, evidence: "j1miss" },
      ],
    });
    const judge2 = c2Seams({
      boundaries: [
        { factId: "rf1", entryId: null, evidence: "j2miss" },
        { factId: "rf2", entryId: "a2", evidence: "j2" },
      ],
    });
    const results = await gradeC2ForRun(runWith(trace, "A3"), {
      manifest: c2Manifest,
      stageSeams: [judge1, judge2],
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: () => undefined,
    });
    // union: rf1 recovered (judge1, at a1 -> 120 tokens); rf2 recovered (judge2, at a2 -> 200 tokens)
    expect(results).toEqual([
      { tokens: 120, notRecovered: false },
      { tokens: 200, notRecovered: false },
    ]);
  });
});

// --- Binary routing (21d) --------------------------------------------------

import type { CallJudge } from "../../src/judge/single-call.js";
import type { MetricId } from "../../src/metrics/defs.js";
import {
  E2_LONG_RUN_THRESHOLD_ENTRIES,
  gradeProbeAxesForRun,
  gradeTraceBinaryForRun,
} from "../../src/orchestrate/score.js";

/** A callJudge fake that returns a canned {pass, evidence} JSON per axis. It
 * extracts the axis from the system prompt (the rubric line "E<n> — "). */
function callJudgeByAxis(grades: Partial<Record<MetricId, boolean>>): CallJudge {
  return async (systemPrompt: string) => {
    const match = systemPrompt.match(/E\d+/);
    const axis = (match?.[0] ?? "E5") as MetricId;
    const pass = grades[axis] ?? true;
    return JSON.stringify({ pass, evidence: `fake ${axis}` });
  };
}

const probeManifest: ScenarioManifest = {
  id: "scen-1",
  description: "x",
  compactionBoundary: { phaseATokenBudget: 140_000, plan: "p" },
  recallFacts: [{ id: "rf1", fact: "f1", accept: ["yes"], entryIds: [], domain: "technical", lanes: [] }],
  doneOps: [
    {
      id: "do1",
      description: "built the economy",
      artifact: "src/econ.ts",
      reworkable: false,
      entryIds: [],
      lanes: [],
    },
  ],
  supersessions: [],
  abstentions: [{ id: "ab1", question: "undecided?", correctRefusal: true, entryIds: [], lanes: [] }],
  taskObjective: { description: "goal", testSpec: "" },
  probes: [
    { question: "what is rf1?", accept: ["yes"], targets: ["rf1"], lanes: ["direct-probe"] }, // E5
    { question: "decide X?", correctRefusal: true, targets: ["ab1"], lanes: ["direct-probe"] }, // E6
  ],
};

describe("gradeProbeAxesForRun (E5/E6/E8 probe binary)", () => {
  it("resolves each probe's axis + grades it (one {axis,pass} per probe)", async () => {
    const trace = traceOf([userEntry("u0", null), assistantEntry("a1", "u0", 10)], []);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [
        { arm: "A3", attempt: 1, probeId: "1", branch: "b", answer: "yes", kept: true },
        { arm: "A3", attempt: 1, probeId: "2", branch: "b", answer: "I refuse to guess", kept: true },
      ],
      repo: "/repo",
      branch: "arm-x-1",
    };
    const results = await gradeProbeAxesForRun(run, {
      manifest: probeManifest,
      callJudges: [callJudgeByAxis({ E5: true, E6: false })],
      maxRetries: 2,
    });
    expect(results).toEqual([
      { axis: "E5", pass: true },
      { axis: "E6", pass: false },
    ]);
  });

  it("E6 stale-value face: correctRefusal probe targeting a supersession → slice says FLAG AS STALE (not REFUSE)", async () => {
    const manifest: ScenarioManifest = {
      ...probeManifest,
      supersessions: [
        {
          id: "s1",
          subject: "org structure",
          oldValue: "flat",
          latestValue: "hierarchical",
          entryIds: ["e-s1"],
          lanes: ["direct-probe"],
        },
      ],
      probes: [
        { question: "what's the org structure?", correctRefusal: true, targets: ["e-s1"], lanes: ["direct-probe"] },
      ],
    };
    const trace = traceOf([userEntry("u0", null)], []);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [{ arm: "A3", attempt: 1, probeId: "1", branch: "b", answer: "that's outdated", kept: true }],
      repo: "/repo",
      branch: "arm-x-1",
    };
    let captured = "";
    const capturingCallJudge = async (_systemPrompt: string, userContent: string): Promise<string> => {
      captured = userContent;
      return JSON.stringify({ pass: true, evidence: "flagged stale" });
    };
    const results = await gradeProbeAxesForRun(run, {
      manifest,
      callJudges: [capturingCallJudge],
      maxRetries: 2,
    });
    expect(results).toEqual([{ axis: "E6", pass: true }]);
    // The slice (embedded in the judge systemPrompt) carries the stale-value criteria, NOT never-decided REFUSE.
    expect(captured.toLowerCase()).toContain("flag the value as stale");
    expect(captured).not.toMatch(/correct answer = refuse/i);
  });

  it("skips probes whose axis cannot be resolved (malformed) + out-of-range probeIds", async () => {
    const trace = traceOf([userEntry("u0", null)], []);
    const malformedManifest: ScenarioManifest = {
      ...probeManifest,
      probes: [{ question: "q?", targets: ["rf1"], lanes: ["direct-probe"] }], // no accept, no correctRefusal -> null
    };
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [
        { arm: "A3", attempt: 1, probeId: "1", branch: "b", answer: "x", kept: true },
        { arm: "A3", attempt: 1, probeId: "9", branch: "b", answer: "y", kept: true },
      ],
      repo: "/repo",
      branch: "arm-x-1",
    };
    const results = await gradeProbeAxesForRun(run, {
      manifest: malformedManifest,
      callJudges: [callJudgeByAxis({})],
      maxRetries: 2,
    });
    expect(results).toEqual([]);
  });
});

describe("gradeTraceBinaryForRun (E4 trajectory + E2 short/long)", () => {
  function trajSeams(payload: {
    grades: Array<{ axis: string; pass: boolean; evidence: string }>;
  }): JsonToolStageSeams {
    return {
      resolveModel: async () => OK_MODEL,
      runStage: async (input: StageRunInput) => {
        callTerminal(input, "record_grades", payload);
        return cleanResult();
      },
    };
  }

  it("short run: E4 via trajectory + E2 via two-checkpoint slice (gradeSlice)", async () => {
    // few post-compaction entries -> E2 short (slice path)
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const entries: SessionEntry[] = [userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)];
    const trace = traceOf(entries, [c1]);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "arm-x-1",
    };
    const checkouts: [string, string][] = [];
    const result = await gradeTraceBinaryForRun(run, {
      manifest: probeManifest,
      callJudges: [callJudgeByAxis({ E2: true })], // E2 slice grade
      stageSeams: [trajSeams({ grades: [{ axis: "E4", pass: true, evidence: "e4" }] })], // E4 trajectory grade
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: (repo, branch) => checkouts.push([repo, branch]),
    });
    expect(result).toEqual({ E4: true, E2: true });
    expect(checkouts).toEqual([["/repo", "arm-x-1"]]); // checked out once before the trajectory call
  });

  it("long run: E4 + E2 BOTH via one trajectory call (no slice)", async () => {
    // > E2_LONG_RUN_THRESHOLD_ENTRIES post-compaction entries -> E2 long (trajectory path)
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const entries: SessionEntry[] = [userEntry("u0", null), c1.entry];
    for (let i = 0; i < E2_LONG_RUN_THRESHOLD_ENTRIES + 5; i++) entries.push(assistantEntry(`a${i}`, "c1", 5));
    const trace = traceOf(entries, [c1]);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "arm-x-1",
    };
    let sliceCalls = 0;
    const callJudges: CallJudge[] = [
      async () => {
        sliceCalls += 1;
        return JSON.stringify({ pass: true, evidence: "x" });
      },
    ];
    const result = await gradeTraceBinaryForRun(run, {
      manifest: probeManifest,
      callJudges,
      stageSeams: [
        trajSeams({
          grades: [
            { axis: "E4", pass: false, evidence: "e4" },
            { axis: "E2", pass: true, evidence: "e2" },
          ],
        }),
      ],
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: () => undefined,
    });
    expect(result).toEqual({ E4: false, E2: true });
    expect(sliceCalls).toBe(0); // E2 NOT graded via slice (trajectory path) -> callJudges unused
  });
});

// --- Comparative routing (21e) ---------------------------------------------

import type { Shuffle } from "../../src/judge/ranking.js";
import { gradeSliceComparative, gradeSummaryComparative } from "../../src/orchestrate/score.js";

const identityShuffle: Shuffle<string> = (xs) => [...xs];

function comparativeRun(arm: "A1" | "A3", trace: RunTrace): ArmAttemptRun {
  return { arm, attempt: 1, continuation: trace, probes: [], repo: "/repo", branch: `${arm}-arm-1` };
}

describe("gradeSliceComparative (E1/E7 slices, grouped by attempt)", () => {
  it("ranks the enabled arms per attempt from pure RunTrace slices (no checkout)", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace1 = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)], [c1]);
    const trace3 = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 20)], [c1]);
    // callJudge ranks B(=A3) > A(=A1) on E1
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["B", "A"] });
    const checkouts: [string, string][] = [];
    const result = await gradeSliceComparative([comparativeRun("A1", trace1), comparativeRun("A3", trace3)], {
      manifest: probeManifest,
      callJudges: [callJudge],
      stageSeams: [],
      maxTokens: 4096,
      signal: new AbortController().signal,
      shuffle: identityShuffle,
      checkout: (repo, branch) => checkouts.push([repo, branch]),
    });
    expect(result.E1).toEqual([{ order: ["A3", "A1"] }]);
    expect(result.E7).toEqual([{ order: ["A3", "A1"] }]);
    expect(checkouts).toEqual([]); // slice axes need NO checkout
  });

  it("groups by attempt: one ranking per attempt-slot across N attempts", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)], [c1]);
    const run1: ArmAttemptRun = {
      arm: "A1",
      attempt: 1,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "A1-1",
    };
    const run2: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "A3-1",
    };
    const run3: ArmAttemptRun = {
      arm: "A1",
      attempt: 2,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "A1-2",
    };
    const run4: ArmAttemptRun = {
      arm: "A3",
      attempt: 2,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "A3-2",
    };
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A", "B"] }); // A1 > A3
    const result = await gradeSliceComparative([run1, run2, run3, run4], {
      manifest: probeManifest,
      callJudges: [callJudge],
      stageSeams: [],
      maxTokens: 4096,
      signal: new AbortController().signal,
      shuffle: identityShuffle,
      checkout: () => undefined,
    });
    // E1 has one ranking PER attempt (2 attempts -> 2 rankings)
    expect(result.E1).toEqual([{ order: ["A1", "A3"] }, { order: ["A1", "A3"] }]);
  });
});

describe("gradeSummaryComparative (E3/E10 summaries, grouped by attempt)", () => {
  it("per-judge summarize (checkout per arm) -> rank; returns one ranking per attempt", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace1 = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)], [c1]);
    const trace3 = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 20)], [c1]);
    // summarize stage fake: write_summary captures a summary string
    let summaryCounter = 0;
    const summarySeams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input: StageRunInput) => {
        summaryCounter += 1;
        callTerminal(input, "write_summary", { summary: `summary-${summaryCounter}` });
        return cleanResult();
      },
    };
    // callJudge ranks A(=A1) > B(=A3) on E3
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A", "B"] });
    const checkouts: [string, string][] = [];
    const result = await gradeSummaryComparative([comparativeRun("A1", trace1), comparativeRun("A3", trace3)], {
      manifest: probeManifest,
      callJudges: [callJudge],
      stageSeams: [summarySeams],
      maxTokens: 4096,
      signal: new AbortController().signal,
      shuffle: identityShuffle,
      checkout: (repo, branch) => checkouts.push([repo, branch]),
    });
    expect(result.E3).toEqual([{ order: ["A1", "A3"] }]);
    expect(result.E10).toEqual([{ order: ["A1", "A3"] }]);
    // 2 summarize calls per axis (A1 + A3) x 2 axes = 4; 4 checkouts (one per (axis,arm))
    expect(summaryCounter).toBe(4);
    expect(checkouts.length).toBe(4);
  });
});

// --- scoreRun assembly (21f) — full integration ---------------------------

import type { ScoreRunDeps, ScoreRunMeta } from "../../src/orchestrate/score.js";
import { scoreRun } from "../../src/orchestrate/score.js";
import type { JsonOutputTool } from "../../src/runtime/tools.js";
import type { RunConfig } from "../../src/storage/branches.js";

/** A stage seams fake that dispatches on the terminal tool name (report_boundary /
 * record_grades / write_summary) so ONE fake serves the C2 + trajectory + summarize stages. */
function multiStageSeams(handlers: Readonly<Record<string, () => unknown>>): JsonToolStageSeams {
  return {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      for (const [name, makePayload] of Object.entries(handlers)) {
        const tool = input.tools.find((t) => t.name === name) as JsonOutputTool | undefined;
        if (tool !== undefined) {
          callTerminal(input, name, makePayload());
          break;
        }
      }
      return cleanResult();
    },
  };
}

const integManifest: ScenarioManifest = {
  id: "scen-integ",
  description: "integration scenario",
  compactionBoundary: { phaseATokenBudget: 140_000, plan: "continue building" },
  recallFacts: [{ id: "rf1", fact: "the formula", accept: ["formula"], entryIds: [], domain: "technical", lanes: [] }],
  doneOps: [{ id: "do1", description: "built X", artifact: "src/x.ts", reworkable: false, entryIds: [], lanes: [] }],
  supersessions: [],
  abstentions: [{ id: "ab1", question: "undecided?", correctRefusal: true, entryIds: [], lanes: [] }],
  taskObjective: { description: "build the thing", testSpec: "" },
  probes: [
    { question: "what is the formula?", accept: ["formula"], targets: ["rf1"], lanes: ["direct-probe"] }, // E5
    { question: "decide Y?", correctRefusal: true, targets: ["ab1"], lanes: ["direct-probe"] }, // E6
  ],
};

/** A callJudge fake: binary axes -> {pass,evidence}; comparative -> {order} (A1 > A3). */
function integCallJudge(binaryPasses: Partial<Record<MetricId, boolean>>): CallJudge {
  return async (sys: string) => {
    if (sys.includes("RANKING")) return JSON.stringify({ order: ["A", "B"] }); // A(=A1) > B(=A3)
    const axis = (sys.match(/E\d+/)?.[0] ?? "E5") as MetricId;
    return JSON.stringify({ pass: binaryPasses[axis] ?? true, evidence: `fake ${axis}` });
  };
}

const INTEG_RUN_CONFIG: RunConfig = {
  evaluatedModel: "m",
  evaluatedThinkingLevel: "high",
  judgeModel: "j",
  judgeThinkingLevel: "high",
  judgesNumber: 1,
  judge2Model: null,
  judge2ThinkingLevel: "high",
  judge3Model: null,
  judge3ThinkingLevel: "high",
  N: 1,
  compactionBoundary: 140_000,
  armsEnabled: ["A1", "A3"],
  omFullReflectionThresholdTokens: 4000,
  backupMode: "build",
  fastEval: "off",
  toolVersions: {},
};

function integMeta(): ScoreRunMeta {
  return {
    runId: "run-1",
    cfgId: "cfg-abc123",
    timestamp: "2026-08-12T00:00:00Z",
    scenario: { id: "scen-integ", manifestRef: "/manifest.json" },
    runConfig: INTEG_RUN_CONFIG,
    armRunCounts: { A1: { completed: 1, failed: 0 }, A3: { completed: 1, failed: 0 } },
    failures: [],
    artifacts: { scenarioRepo: "/repo", branches: [], judgeDir: "/judge", config: "/config.json" },
    root: "/root",
  };
}

describe("scoreRun (full assembly: A1 + A3, N=1)", () => {
  it("produces a BenchResultJson + markdown with every routed metric", async () => {
    const c1 = compaction("c1", "u0", "summary text", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 50)], [c1]);
    const probes = [
      { arm: "A1" as const, attempt: 1, probeId: "1", branch: "A1-1", answer: "formula", kept: true },
      { arm: "A1" as const, attempt: 1, probeId: "2", branch: "A1-1", answer: "I refuse", kept: true },
    ];
    const runs: ArmAttemptRun[] = [
      {
        arm: "A1",
        attempt: 1,
        continuation: trace,
        probes,
        testSpecResult: { kind: "skipped" },
        repo: "/repo",
        branch: "A1-1",
      },
      {
        arm: "A3",
        attempt: 1,
        continuation: trace,
        probes,
        testSpecResult: { kind: "skipped" },
        repo: "/repo",
        branch: "A3-1",
      },
    ];
    const deps: ScoreRunDeps = {
      manifest: integManifest,
      callJudges: [integCallJudge({ E2: false, E4: true, E5: true, E6: true })],
      stageSeams: [
        multiStageSeams({
          report_boundary: () => ({ boundaries: [{ factId: "rf1", entryId: "a1", evidence: "used rf1" }] }),
          record_grades: () => ({ grades: [{ axis: "E4", pass: true, evidence: "proactive" }] }),
          write_summary: () => ({ summary: "stayed on goal" }),
        }),
      ],
      shuffle: identityShuffle,
      maxTokens: 4096,
      signal: new AbortController().signal,
      bootstrapOptions: null,
      pricing: ZERO_PRICING,
      checkout: () => undefined,
      meta: integMeta(),
    };

    const { resultJson, markdown } = await scoreRun(runs, deps);

    // result-JSON shape
    expect(resultJson.schema).toBe("bench-compact.result-v1");
    expect(resultJson.runId).toBe("run-1");
    expect(Object.keys(resultJson.arms).sort()).toEqual(["A1", "A3"]);

    // exact metrics (C1/C3/C4) present on A3
    const a3 = resultJson.arms.A3;
    expect(a3?.metrics.C1).toBeDefined();
    expect(a3?.metrics.C3).toBeDefined();
    expect(a3?.metrics.C4).toBeDefined();

    // binary metrics present (E2 + E4 trace, E5 + E6 probe)
    expect(a3?.metrics.E2).toBeDefined();
    expect(a3?.metrics.E4).toBeDefined();
    expect(a3?.metrics.E5).toBeDefined();
    expect(a3?.metrics.E6).toBeDefined();

    // comparative ranks present for all 4 axes
    expect(resultJson.ranks.E1?.order).toEqual(["A1", "A3"]);
    expect(resultJson.ranks.E3?.order).toEqual(["A1", "A3"]);
    expect(resultJson.ranks.E7?.order).toEqual(["A1", "A3"]);
    expect(resultJson.ranks.E10?.order).toEqual(["A1", "A3"]);

    // E2 polarity preserved (lowerBetter — redo-rate) (G8)
    expect(resultJson.metricDefs.E2.polarity).toBe("lowerBetter");

    // markdown is a non-empty report naming the scenario
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain("scen-integ");
  });

  it("C2 recall-cost flows through (recovered fact -> finite mean; notRecoveredRate 0)", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 50)], [c1]);
    const runs: ArmAttemptRun[] = [
      { arm: "A3", attempt: 1, continuation: trace, probes: [], repo: "/repo", branch: "A3-1" },
    ];
    const deps: ScoreRunDeps = {
      manifest: integManifest,
      callJudges: [integCallJudge({})],
      stageSeams: [
        multiStageSeams({
          report_boundary: () => ({ boundaries: [{ factId: "rf1", entryId: "a1", evidence: "used rf1" }] }),
          record_grades: () => ({ grades: [{ axis: "E4", pass: true, evidence: "x" }] }),
          write_summary: () => ({ summary: "s" }),
        }),
      ],
      shuffle: identityShuffle,
      maxTokens: 4096,
      signal: new AbortController().signal,
      bootstrapOptions: null,
      pricing: ZERO_PRICING,
      checkout: () => undefined,
      meta: integMeta(),
    };
    const { resultJson } = await scoreRun(runs, deps);
    const c2 = resultJson.arms.A3?.metrics.C2 as { mean: number | null; notRecoveredRate: number } | undefined;
    expect(c2).toBeDefined();
    expect(c2?.mean).toBe(50); // post-compaction output up to a1 inclusive
    expect(c2?.notRecoveredRate).toBe(0);
  });
});

// --- K-ensemble coverage — majority vote + comparative Borda + checkout race ---

describe("K-judge ensemble (K>1)", () => {
  it("gradeProbeAxesForRun: K=3 majority vote (2 pass + 1 fail -> pass)", async () => {
    const trace = traceOf([userEntry("u0", null)], []);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [{ arm: "A3", attempt: 1, probeId: "1", branch: "b", answer: "yes", kept: true }],
      repo: "/repo",
      branch: "arm-x-1",
    };
    const manifest: ScenarioManifest = {
      ...probeManifest,
      probes: [{ question: "q?", accept: ["yes"], targets: ["rf1"], lanes: ["direct-probe"] }],
    };
    // 3 judges: pass, fail, pass -> majority pass
    const passes = [true, false, true];
    const callJudges: CallJudge[] = passes.map((p) => async (sys: string) => {
      const axis = (sys.match(/E\d+/)?.[0] ?? "E5") as MetricId;
      return JSON.stringify({ pass: p && axis === "E5", evidence: "x" });
    });
    const results = await gradeProbeAxesForRun(run, { manifest, callJudges });
    expect(results).toEqual([{ axis: "E5", pass: true }]); // 2 of 3 -> pass
  });

  it("gradeTraceBinaryForRun: K=3 majority vote on the trajectory axis", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)], [c1]);
    const run: ArmAttemptRun = {
      arm: "A3",
      attempt: 1,
      continuation: trace,
      probes: [],
      repo: "/repo",
      branch: "arm-x-1",
    };
    // 3 judges: E4 pass, E4 fail, E4 pass -> majority pass
    const trajGrades = [true, false, true];
    const stageSeams: JsonToolStageSeams[] = trajGrades.map((pass) => ({
      resolveModel: async () => OK_MODEL,
      runStage: async (input: StageRunInput) => {
        callTerminal(input, "record_grades", { grades: [{ axis: "E4", pass, evidence: "x" }] });
        return cleanResult();
      },
    }));
    const result = await gradeTraceBinaryForRun(run, {
      manifest: probeManifest,
      callJudges: [callJudgeByAxis({})],
      stageSeams,
      maxTokens: 4096,
      signal: new AbortController().signal,
      checkout: () => undefined,
    });
    expect(result.E4).toBe(true); // 2 of 3 -> pass
  });

  it("gradeSummaryComparative K=2: ONE checkout per arm (no concurrent-checkout race); each judge's summarize sees the correct branch (regression)", async () => {
    const c1 = compaction("c1", "u0", "summary", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry, assistantEntry("a1", "c1", 10)], [c1]);
    let currentBranch = "initial";
    const checkoutLog: string[] = [];
    const summarizeBranches: string[] = [];
    function makeSeams(): JsonToolStageSeams {
      return {
        resolveModel: async () => OK_MODEL,
        runStage: async (input: StageRunInput) => {
          summarizeBranches.push(currentBranch); // record which branch THIS summarize saw
          callTerminal(input, "write_summary", { summary: "s" });
          return cleanResult();
        },
      };
    }
    const callJudge: CallJudge = async () => JSON.stringify({ order: ["A", "B"] });
    await gradeSummaryComparative([comparativeRun("A1", trace), comparativeRun("A3", trace)], {
      manifest: probeManifest,
      callJudges: [callJudge, callJudge],
      stageSeams: [makeSeams(), makeSeams()],
      maxTokens: 4096,
      signal: new AbortController().signal,
      shuffle: identityShuffle,
      checkout: (_repo, branch) => {
        currentBranch = branch;
        checkoutLog.push(branch);
      },
    });
    // ONE checkout per arm PER AXIS (E3 then E10): 2 axes x [A1, A3] = 4 total.
    // The race bug would produce 8 (each judge checks out both arms per axis).
    expect(checkoutLog).toEqual(["A1-arm-1", "A3-arm-1", "A1-arm-1", "A3-arm-1"]);
    // 8 summarizes (2 axes x 2 judges x 2 arms); every summarize saw the branch
    // checked out for ITS arm (no race — never "initial" nor a mismatched branch).
    // Consecutive pairs are homogeneous: both judges summarize one arm (during its
    // checkout) before the next arm is checked out.
    expect(summarizeBranches.length).toBe(8);
    expect(summarizeBranches.every((b) => b === "A1-arm-1" || b === "A3-arm-1")).toBe(true);
    for (let i = 0; i < summarizeBranches.length; i += 2) {
      expect(summarizeBranches[i]).toBe(summarizeBranches[i + 1]); // homogeneous pair
    }
  });
});

describe("scoreRun — fast eval (probes-only): continuation lanes skipped", () => {
  it("grades C1/C2/C4 + probe lanes, skips trace-binary + comparative", async () => {
    const c1 = compaction("c1", "u0", "summary text", makeUsage(100, 20), null);
    const trace = traceOf([userEntry("u0", null), c1.entry], [c1]); // base-shaped: no continuation entries
    const probes = [{ arm: "A1" as const, attempt: 1, probeId: "1", branch: "A1-base", answer: "formula", kept: true }];
    const runs: ArmAttemptRun[] = [
      {
        arm: "A1",
        attempt: 1,
        continuation: trace,
        probes,
        testSpecResult: undefined,
        repo: "/repo",
        branch: "A1-base",
      },
    ];
    let traceBinaryCalls = 0;
    let comparativeCalls = 0;
    const deps: ScoreRunDeps = {
      manifest: integManifest,
      callJudges: [integCallJudge({ E2: false, E4: true, E5: true, E6: true })],
      stageSeams: [
        multiStageSeams({
          report_boundary: () => ({ boundaries: [{ factId: "rf1", entryId: "a1", evidence: "used rf1" }] }),
          record_grades: () => {
            traceBinaryCalls += 1;
            return { grades: [{ axis: "E4", pass: true, evidence: "proactive" }] };
          },
          write_summary: () => {
            comparativeCalls += 1;
            return { summary: "stayed on goal" };
          },
        }),
      ],
      shuffle: identityShuffle,
      maxTokens: 4096,
      signal: new AbortController().signal,
      bootstrapOptions: null,
      pricing: ZERO_PRICING,
      checkout: () => undefined,
      probesOnly: true,
      meta: integMeta(),
    };

    const { resultJson } = await scoreRun(runs, deps);
    // exact + probe lanes present
    expect(resultJson.arms.A1?.metrics.C4).toBeDefined();
    // continuation-judged lanes never ran
    expect(traceBinaryCalls).toBe(0);
    expect(comparativeCalls).toBe(0);
    expect(resultJson.arms.A1?.metrics.E5).toBeDefined(); // probe lane graded
    expect(resultJson.arms.A1?.metrics.E4).toBeUndefined(); // trajectory lane absent
    expect(resultJson.ranks).toEqual({}); // no comparative axes
  });
});
