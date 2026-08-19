// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared fake builders for the end-to-end smoke test. The smoke drives the REAL
// run driver + REAL scoring orchestrator, so the fakes here stand in for the
// parts that need a LIVE session (the Phase-1/2/probe phase functions) + the
// judge/pricing dependencies (canned LLM grades + a small pricing map). Mirrors
// the proven fake patterns from tests/orchestrate/run.test.ts (phase mocks +
// StartRunDeps) and tests/orchestrate/score.test.ts (CallJudge / stage seams /
// realistic RunTrace), consolidated into one place so the two smoke cases stay DRY.

import { join } from "node:path";
import type { CompactionEntry, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VersionResolver } from "../../src/arms/version.js";
import type { ArmId, BenchConfig } from "../../src/config/types.js";
import type { Shuffle } from "../../src/judge/ranking.js";
import type { CallJudge } from "../../src/judge/single-call.js";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { MetricId } from "../../src/metrics/defs.js";
import type { Pricing } from "../../src/metrics/pricing.js";
import type { ArmBase } from "../../src/orchestrate/phase1.js";
import type { ProbeTrace } from "../../src/orchestrate/probes.js";
import type { BuildScoreDepsArgs, StartRunDeps } from "../../src/orchestrate/run.js";
import type { ScoreRunDeps } from "../../src/orchestrate/score.js";
import { scoreRun } from "../../src/orchestrate/score.js";
import type { RunTrace } from "../../src/orchestrate/trace.js";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";
import type { JsonOutputTool } from "../../src/runtime/tools.js";
import { callTerminal, cleanResult, OK_MODEL } from "../judge/helpers.js";

/** The usage shape the exact metrics read (the four token kinds + cost). */
type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/** A small non-zero pricing so the compaction-cost dollars field is non-zero. */
const SMOKE_PRICING: Pricing = {
  inputPerM: 1,
  outputPerM: 2,
  cacheReadPerM: 0.1,
  cacheWritePerM: 0.2,
};

/** Build a usage object with the four token kinds + a matching cost block. */
function makeUsage(input: number, output: number): Usage {
  const total = input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: input * 0.000001, output: output * 0.000001, cacheRead: 0, cacheWrite: 0, total: total * 0.000001 },
  };
}

/** Base SessionEntry fields (id + parentId + timestamp). */
function base(id: string, parentId: string | null): { id: string; parentId: string | null; timestamp: string } {
  return { id, parentId, timestamp: "2026-08-11T00:00:00.000Z" };
}

/** A user message entry. */
function userEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: { role: "user", content: "build the next system", timestamp: 0 },
  } as unknown as SessionEntry;
}

/** An assistant message entry whose usage.output contributes to the run-cost metric. */
function assistantEntry(id: string, parentId: string | null, output: number): SessionEntry {
  return {
    type: "message",
    ...base(id, parentId),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "continuing the build" }],
      api: "anthropic-messages",
      provider: "test",
      model: "model",
      usage: makeUsage(0, output),
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

/** Build a boundary CompactionEntry with the given summary + usage (+ optional stage details).
 * The per-stage names live under the entry's `details.compactionStages` field (the field the
 * compaction-cost metric reads); null details → the native single-stage arm. */
function makeCompactionEntry(summary: string, stages: readonly string[] | null): CompactionEntry {
  const stageDetails = stages === null ? null : { compactionStages: stages };
  return {
    type: "compaction",
    ...base("c1", "u0"),
    summary,
    firstKeptEntryId: "kept-1",
    tokensBefore: 150000,
    usage: makeUsage(BOUNDARY_USAGE_INPUT, BOUNDARY_USAGE_OUTPUT),
    fromHook: false,
    ...(stageDetails !== null ? { details: stageDetails } : {}),
  } as CompactionEntry;
}

/** The boundary compaction's input/output tokens (drives the compaction-cost metric). */
const BOUNDARY_USAGE_INPUT = 100;
const BOUNDARY_USAGE_OUTPUT = 20;
/** The post-compaction assistant output (drives the run-cost + recall-cost metrics). */
const POST_COMPACTION_OUTPUT = 50;
/** The bench-captured wall-clock of the boundary compaction (drives the compaction-cost wall field). */
const BOUNDARY_WALL_MS = 4200;
/** The post-compaction assistant entry id (the recall-cost judge recovers the fact here). */
const POST_COMPACTION_ENTRY_ID = "post-1";
/** The recallFact id planted in the smoke manifest (referenced by the recall-cost judge). */
const SMOKE_RECALL_FACT_ID = "rf1";

/**
 * Build a realistic continuation RunTrace for one arm: a user turn, ONE boundary
 * compaction (with real usage so the compaction-cost metric is non-zero), and one
 * post-compaction assistant turn (whose usage.output drives the run-cost + recall-cost
 * metrics). `stages` selects the compaction's per-stage names (null = the native
 * single-stage arm; a list = a memory arm with named stages).
 */
function buildRealisticTrace(arm: ArmId, branch: string, stages: readonly string[] | null): RunTrace {
  const compactionEntry = makeCompactionEntry(SMOKE_SUMMARY, stages);
  const entries: SessionEntry[] = [
    userEntry("u0", null),
    compactionEntry,
    assistantEntry(POST_COMPACTION_ENTRY_ID, "c1", POST_COMPACTION_OUTPUT),
  ];
  return {
    arm,
    attempt: 1,
    branch,
    entries,
    compactions: [{ entry: compactionEntry, wallMs: BOUNDARY_WALL_MS }],
    tracePath: "/repo/session.jsonl",
  };
}

/** The boundary summary (12 chars / 4 chars-per-token = 3 footprint tokens). */
const SMOKE_SUMMARY = "summary text";

/** The smoke scenario manifest: one recallFact, one doneOp, one abstention, two direct probes. */
export function makeSmokeManifest(): ScenarioManifest {
  return {
    id: "smoke-scen",
    description: "an incremental economic tycoon scenario for the end-to-end smoke",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "build to the boundary then compact" },
    recallFacts: [
      {
        id: SMOKE_RECALL_FACT_ID,
        fact: "the production formula",
        accept: ["the production formula"],
        entryIds: ["pre-1"],
        domain: "technical",
        lanes: ["direct-probe"],
      },
    ],
    doneOps: [
      {
        id: "do1",
        description: "built the economy system",
        artifact: "src/economy.ts",
        reworkable: false,
        entryIds: ["pre-2"],
        lanes: ["embedded"],
      },
    ],
    supersessions: [],
    abstentions: [
      {
        id: "ab1",
        question: "should I pick the untested option?",
        correctRefusal: true,
        entryIds: ["pre-3"],
        lanes: ["direct-probe"],
      },
    ],
    taskObjective: { description: "build the tycoon economy", testSpec: "" },
    probes: [
      {
        question: "what is the production formula?",
        accept: ["the production formula"],
        targets: [SMOKE_RECALL_FACT_ID],
        lanes: ["direct-probe"],
      },
      {
        question: "should I pick the untested option?",
        correctRefusal: true,
        face: "refuse",
        targets: ["ab1"],
        lanes: ["direct-probe"],
      },
    ],
  };
}

/**
 * The smoke bench config. Mirrors the run-driver test's config shape (the cast is
 * safe: buildRunConfig reads only the ensemble + run fields, not the per-arm
 * boolean toggles — those are only read by getBenchConfig via the settings handle).
 */
function makeBenchConfig(arms: readonly ArmId[]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    judgesNumber: 1,
    judge2Model: null,
    judge2ThinkingLevel: "high",
    judge3Model: null,
    judge3ThinkingLevel: "high",
    N: 1,
    compactionBoundary: 140000,
    omFullReflectionThresholdTokens: 4000,
    outputDir: null,
    latentProbes: "off",
    judgeMaxTokens: 32768,
    latentStageMaxTokens: null,
    judgeTurnTimeoutMs: 300000,
    testspecTimeoutMs: 120000,
    backgroundModel: null,
    backgroundThinkingLevel: null,
    backgroundMaxTokens: 32768,
    backgroundTimeoutMs: 1200000,
    authorModel: null,
    authorThinkingLevel: null,
    authorMaxTokens: null,
    authorTimeoutMs: null,
    tailCheckModel: null,
    tailCheckThinkingLevel: null,
    tailCheckMaxTokens: null,
    tailCheckTimeoutMs: null,
    simulatorModel: null,
    simulatorThinkingLevel: null,
    simulatorMaxTokens: null,
    simulatorTurnTimeoutMs: null,
    latentModel: null,
    latentThinkingLevel: null,
    latentTimeoutMs: null,
    armsEnabled: [...arms],
  } as BenchConfig;
}

/** Identity shuffle (no anonymization reordering) for the comparative ranking. */
const identityShuffle: Shuffle<string> = (items: readonly string[]): string[] => [...items];

/**
 * A canned single-call judge: binary axes -> {pass, evidence} (axis parsed from the
 * rubric line); comparative rankings -> {order: ["A","B"]} (A = A1 ranks above B = A3).
 */
function makeCallJudge(binaryPasses: Readonly<Partial<Record<MetricId, boolean>>>): CallJudge {
  return async (systemPrompt: string): Promise<string> => {
    if (systemPrompt.includes("RANKING")) return JSON.stringify({ order: ["A", "B"] });
    const axis = detectBinaryAxis(systemPrompt);
    return JSON.stringify({ pass: binaryPasses[axis] ?? true, evidence: `smoke ${axis}` });
  };
}

/** Detect the binary axis from a judge system prompt by its grading title (the
 *  rubrics carry no metric ids). */
function detectBinaryAxis(systemPrompt: string): MetricId {
  if (systemPrompt.includes("abstention")) return "E6";
  if (systemPrompt.includes("supersession")) return "E8";
  if (systemPrompt.includes("redo-execution")) return "E2";
  if (systemPrompt.includes("proactive recall")) return "E4";
  return "E5.1"; // recall accuracy
}

/**
 * A canned stage-seams fake dispatching on the terminal tool name so ONE fake serves
 * the recall-cost (report_boundary), trajectory (record_grades), + summary
 * (write_summary) stages. Mirrors the multiStageSeams pattern in the score test.
 */
function makeStageSeams(handlers: Readonly<Record<string, () => unknown>>): JsonToolStageSeams {
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

/**
 * The fake ScoreRunDeps factory: stands in for buildProductionScoreDeps. Returns a
 * REAL ScoreRunDeps (the type the real scoreRun consumes) with canned judge grades
 * (one judge, every binary axis passing), canned stage payloads (the recall-cost
 * boundary recovers the planted fact at the post-compaction entry; the trajectory
 * records a proactive-recall pass; the summary writes a goal-staying summary), the
 * identity shuffle, a small non-zero pricing, + a no-op checkout. The run-meta is
 * threaded straight through from the run driver.
 */
function makeScoreDeps(args: BuildScoreDepsArgs): ScoreRunDeps {
  return {
    manifest: args.manifest,
    callJudges: [makeCallJudge({ E2: false, E4: true, "E5.1": true, E6: true })],
    stageSeams: [
      makeStageSeams({
        report_boundary: () => ({
          boundaries: [{ factId: SMOKE_RECALL_FACT_ID, entryId: POST_COMPACTION_ENTRY_ID, evidence: "recovered" }],
        }),
        record_grades: () => ({ grades: [{ axis: "E4", pass: true, evidence: "proactive recall" }] }),
        write_summary: () => ({ summary: "stayed on the scripted goal" }),
      }),
    ],
    shuffle: identityShuffle,
    maxTokens: 4096,
    signal: args.signal,
    bootstrapOptions: null,
    pricing: SMOKE_PRICING,
    checkout: () => undefined,
    meta: args.meta,
  };
}

/** A fake tool-version resolver (A3 resolves to a git commit; A1 carries no version). */
function makeVersionResolver(): VersionResolver {
  return {
    resolveRoot: () => "/fake/memkeeper",
    gitHead: () => "abcdef1234567890",
    npmVersion: () => null,
  };
}

/** Sentinel for the threaded fresh ctx (so tests can assert it is forwarded, not the original cmdCtx). */
export const FINAL_CTX = { __finalCtx: true } as unknown as ExtensionCommandContext;

/** The descriptive tool name for each arm id (mirrors the production arm→tool map). */
const ARM_TOOL: Record<ArmId, string> = {
  A1: "bare-pi",
  A2: "om-default",
  A3: "memkeeper-builder",
  A4: "memkeeper-selector",
  A5: "om-full",
};

/** The boundary wall-clock every compacted base reports. */
const BASE_WALL_MS = 4200;

/** Build the per-arm compacted bases (one per enabled arm). */
export function fakeBases(arms: readonly ArmId[]): ArmBase[] {
  return arms.map((arm) => ({
    arm,
    tool: ARM_TOOL[arm],
    ver: arm === "A1" ? undefined : "gabcdef",
    cfgId: "cfg-x",
    branch: `arm-${arm}-base`,
    wallMs: BASE_WALL_MS,
    usage: undefined,
  }));
}

/** The compaction stage names a memory arm carries (the native arm passes null). */
const MEMORY_STAGES: readonly string[] = ["observer", "builder", "selector"];

/** Build the two direct-probe answers for one arm (matching the smoke manifest's probes by position). */
export function buildProbeAnswers(arm: ArmId): ProbeTrace[] {
  return [
    { arm, attempt: 1, probeId: "1", branch: `probe-${arm}-1`, answer: "the production formula", kept: true },
    {
      arm,
      attempt: 1,
      probeId: "2",
      branch: `probe-${arm}-2`,
      answer: "I cannot decide without more information",
      kept: true,
    },
  ];
}

/** Build the realistic continuation traces for the enabled arms (native arm single-stage; memory arms multi-stage). */
export function buildArmTraces(arms: readonly ArmId[]): RunTrace[] {
  return arms.map((arm) =>
    arm === "A1"
      ? buildRealisticTrace("A1", "arm-A1-1", null)
      : buildRealisticTrace(arm, `arm-${arm}-1`, MEMORY_STAGES),
  );
}

/**
 * Build a complete StartRunDeps for a 2-arm (or wider) run: plain (non-spy) phase
 * functions returning realistic traces, the REAL scoring orchestrator, the canned
 * judge/pricing deps, + the fake version resolver. Used by tests that drive the
 * full pipeline for determinism/shape assertions WITHOUT needing per-phase call
 * counts (the smoke test wires its OWN vi.fn spies for those). Pure: every call
 * rebuilds fresh closures, so two drives with the same args behave identically.
 */
export function makeSmokeDeps(root: string, arms: readonly ArmId[]): StartRunDeps {
  const traces = buildArmTraces(arms);
  const bases = fakeBases(arms);
  return {
    cmdCtx: {} as unknown as ExtensionCommandContext,
    config: makeBenchConfig(arms),
    scenarioRepo: join(root, "scenario-repo"),
    manifest: makeSmokeManifest(),
    root,
    now: () => new Date("2026-08-11T10:00:00Z"),
    widget: null,
    phase1: async () => ({ bases, finalCtx: FINAL_CTX }),
    continuations: async () => ({ traces, finalCtx: FINAL_CTX }),
    probes: async (d: { armBase: ArmBase }) => ({ traces: buildProbeAnswers(d.armBase.arm), finalCtx: FINAL_CTX }),
    testSpec: () => ({ kind: "skipped" as const }),
    score: scoreRun,
    buildScoreDeps: makeScoreDeps,
    versionResolver: makeVersionResolver(),
  } as unknown as StartRunDeps;
}
