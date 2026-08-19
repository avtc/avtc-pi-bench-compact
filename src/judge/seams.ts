// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Production factories for the judge seams. The judge modules (single-call,
// ranking, trajectory, summarize-trajectory, recall-cost-boundary) take `CallJudge` +
// `JsonToolStageSeams` as INJECTABLE seams (testability); this module is the
// production side — it turns a per-judge model spec + a transport (ctx +
// maxTokens/signal/rate-limit) into those seams by resolving the model +
// running a bench stage. `buildJudgeEnsemble` wires the K (1 or 3) judges from
// the bench config (judge1/2/3 model + thinkingLevel by `judgesNumber`).
//
// A `CallJudge` runs ONE no-tools LLM turn + returns the assistant text; a
// `JsonToolStageSeams` exposes resolveModel + runStage (the agentLoop the
// tool-bearing stages drive). Both throw `BenchJudgeError` on an unavailable
// model, a timeout, or an abort (the orchestrate layer catches these +
// stop-and-surfaces).

import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgeAgentSpec } from "../config/background-agents.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_STAGE_END_HOOK,
  runBenchStage,
  type StageRunInput,
  type StageRunResult,
  toStageReasoning,
} from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { extractAssistantText } from "../simulator/loop.js";
import { BenchJudgeError } from "./errors.js";
import { type RateLimitOptions, withRateLimit } from "./rate-limit.js";
import type { CallJudge } from "./single-call.js";
import type { JsonToolStageSeams } from "./stage-runner.js";

/** One judge's model + reasoning spec (resolved per judge member). */
export interface JudgeSpec {
  /** `provider/id`, or null to fall through to the session default. */
  readonly model: string | null;
  readonly reasoning: ThinkingLevel | null;
}

/** The shared judge transport: how to resolve a model + run a stage, plus the
 *  scoring-session ctx (model registry) + the per-call budget/signal/rate-limit.
 *  `resolveModel`/`runStage` default to the real implementations; tests inject fakes. */
/** Options for {@link defaultJudgeTransport} — the shared budget/timeout/event fields
 *  of a {@link JudgeTransport} without its seams (resolveModel/runStage/ctx). The
 *  event/model hooks carry the judge's ENSEMBLE INDEX (0-based): the K judges run
 *  in parallel, so per-judge consumers (the score widget's per-slot usage list)
 *  need to tell the streams apart. */
export interface JudgeTransportOptions {
  readonly maxTokens: number;
  /** Per-turn wall-clock cap for a single judge LLM call; null = no cap. */
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  readonly onEvent?: (event: AgentEvent, judge: number) => void;
  readonly onModelResolved?: (model: Model<Api>, judge: number) => void;
}

/** The judge transport: options + the injectable seams + the scoring-session ctx. */
export interface JudgeTransport extends JudgeTransportOptions {
  /** Resolve a model setting to a runnable model + api key (default = resolveBenchModel). */
  readonly resolveModel: (ctx: ExtensionContext, modelSetting: string | null) => Promise<ResolvedBenchModel>;
  /** Run a bench stage (default = runBenchStage). */
  readonly runStage: (input: StageRunInput) => Promise<StageRunResult>;
  /** The scoring-session context (model registry — passed to resolveModel). */
  readonly ctx: ExtensionContext;
}

/** Build a {@link JudgeTransport} wired to the real resolveBenchModel + runBenchStage. */
export function defaultJudgeTransport(ctx: ExtensionContext, opts: JudgeTransportOptions): JudgeTransport {
  return {
    resolveModel: resolveBenchModel,
    runStage: runBenchStage,
    ctx,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    rateLimitOptions: opts.rateLimitOptions,
    onEvent: opts.onEvent,
    onModelResolved: opts.onModelResolved,
  };
}

/** Resolve the per-judge specs from the resolved judge members: judge1 always;
 *  judge2 + judge3 when `judgesNumber >= 3` (the ensemble size is 1 or 3). Pure. */
export function judgeSpecs(
  judgesNumber: number,
  members: readonly [JudgeAgentSpec, JudgeAgentSpec, JudgeAgentSpec],
): readonly JudgeSpec[] {
  const toSpec = (m: JudgeAgentSpec): JudgeSpec => ({ model: m.model, reasoning: m.thinking });
  const specs: JudgeSpec[] = [toSpec(members[0])];
  if (judgesNumber >= ENSEMBLE_OF_THREE) {
    specs.push(toSpec(members[1]), toSpec(members[2]));
  }
  return specs;
}

/** Build a `CallJudge` (one no-tools LLM turn → assistant text) for one judge spec.
 *  Resolves the model, runs a single-turn stage with no tools, + returns the
 *  assistant's text. `judgeIndex` (the spec's ensemble position) tags the forwarded
 *  events so parallel judge streams stay distinguishable. Throws `BenchJudgeError`
 *  on an unavailable model, a timeout, or an abort (the orchestrate layer
 *  stop-and-surfaces). */
export function buildCallJudge(spec: JudgeSpec, transport: JudgeTransport, judgeIndex: number): CallJudge {
  return async (systemPrompt, userContent): Promise<string> => {
    const resolved = await transport.resolveModel(transport.ctx, spec.model);
    if (!resolved.ok) {
      throw new BenchJudgeError("model-unavailable", `judge model not available: ${resolved.error}`);
    }
    transport.onModelResolved?.(resolved.model, judgeIndex);
    const run = (): Promise<StageRunResult> =>
      transport.runStage({
        systemPrompt,
        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
        tools: [],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: transport.signal,
        // pi-agent-core's ThinkingLevel includes "off" (no reasoning); pi-ai's excludes
        // it (null = no reasoning). toStageReasoning maps "off" → null.
        reasoning: toStageReasoning(spec.reasoning),
        maxTurns: SINGLE_TURN,
        maxTokens: transport.maxTokens,
        // A per-turn wall-clock cap: a hung cloud-judge call surfaces as a
        // BenchJudgeError("timeout") instead of hanging until the run idle-alert.
        timeoutMs: transport.timeoutMs,
        onEvent: transport.onEvent === undefined ? NO_EVENT_SINK : (event) => transport.onEvent?.(event, judgeIndex),
        onStageEnd: NO_STAGE_END_HOOK,
        loopFn: NO_LOOP_OVERRIDE,
      });
    const result = await withRateLimit(run, transport.rateLimitOptions ?? null);
    if (result.timedOut) {
      throw new BenchJudgeError("timeout", "judge call exceeded its turn time budget");
    }
    if (result.aborted) {
      throw new BenchJudgeError("aborted", "judge call was aborted before completing");
    }
    return extractAssistantText(result.messages);
  };
}

/** Build a `JsonToolStageSeams` (multi-turn, tool-bearing agentLoop) for one judge
 *  spec. `resolveModel` resolves the spec's model; `runStage` is the transport's
 *  runStage (identity passthrough — the tool-bearing stages build the full
 *  StageRunInput themselves via runJsonToolStage). */
export function buildStageSeams(spec: JudgeSpec, transport: JudgeTransport, judgeIndex: number): JsonToolStageSeams {
  return {
    resolveModel: () => transport.resolveModel(transport.ctx, spec.model),
    runStage: transport.runStage,
    onEvent: transport.onEvent === undefined ? undefined : (event) => transport.onEvent?.(event, judgeIndex),
    onModelResolved:
      transport.onModelResolved === undefined ? undefined : (model) => transport.onModelResolved?.(model, judgeIndex),
  };
}

/** The K judge callJudges + stageSeams (both length K) built from the bench config. */
export interface JudgeEnsemble {
  readonly callJudges: readonly CallJudge[];
  readonly stageSeams: readonly JsonToolStageSeams[];
}

/** Build the K-judge ensemble (callJudges + stageSeams, both length K) from the
 *  resolved judge members + ensemble size. K = `judgesNumber` (1 or 3); each judge
 *  pair is built from its JudgeSpec. Pure aside from the transport (no model
 *  resolution yet). */
export function buildJudgeEnsemble(
  judgesNumber: number,
  members: readonly [JudgeAgentSpec, JudgeAgentSpec, JudgeAgentSpec],
  transport: JudgeTransport,
): JudgeEnsemble {
  const specs = judgeSpecs(judgesNumber, members);
  return {
    callJudges: specs.map((spec, i) => buildCallJudge(spec, transport, i)),
    stageSeams: specs.map((spec, i) => buildStageSeams(spec, transport, i)),
  };
}

/** A single-turn judge call (maxTurns = 1 — the judge answers in one shot). */
const SINGLE_TURN = 1;
/** The ensemble size at which judge2 + judge3 join (3 = full ensemble). */
const ENSEMBLE_OF_THREE = 3;
