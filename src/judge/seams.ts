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
import type { JudgeEnsembleConfig } from "../config/types.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  runBenchStage,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { extractAssistantText } from "../simulator/loop.js";
import { BenchJudgeError } from "./errors.js";
import { type RateLimitOptions, withRateLimit } from "./rate-limit.js";
import type { CallJudge } from "./single-call.js";
import type { JsonToolStageSeams } from "./stage-runner.js";

/** One judge's model + reasoning spec (judge1/2/3 from the bench config). */
export interface JudgeSpec {
  /** `provider/id`, or null to fall through to the session default. */
  readonly model: string | null;
  readonly reasoning: ThinkingLevel;
}

/** The shared judge transport: how to resolve a model + run a stage, plus the
 *  scoring-session ctx (model registry) + the per-call budget/signal/rate-limit.
 *  `resolveModel`/`runStage` default to the real implementations; tests inject fakes. */
export interface JudgeTransport {
  /** Resolve a model setting to a runnable model + api key (default = resolveBenchModel). */
  readonly resolveModel: (ctx: ExtensionContext, modelSetting: string | null) => Promise<ResolvedBenchModel>;
  /** Run a bench stage (default = runBenchStage). */
  readonly runStage: (input: StageRunInput) => Promise<StageRunResult>;
  /** The scoring-session context (model registry — passed to resolveModel). */
  readonly ctx: ExtensionContext;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  /** Optional event sink forwarded to the judge's runStage (the widget subscribes for ctx/tok during score). */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Optional hook fired after a successful model resolution (the widget sets its ctx window). */
  readonly onModelResolved?: (model: Model<Api>) => void;
}

/** Options for {@link defaultJudgeTransport}. */
export interface JudgeTransportOptions {
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly onModelResolved?: (model: Model<Api>) => void;
}

/** Build a {@link JudgeTransport} wired to the real resolveBenchModel + runBenchStage. */
export function defaultJudgeTransport(ctx: ExtensionContext, opts: JudgeTransportOptions): JudgeTransport {
  return {
    resolveModel: resolveBenchModel,
    runStage: runBenchStage,
    ctx,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    rateLimitOptions: opts.rateLimitOptions,
    onEvent: opts.onEvent,
    onModelResolved: opts.onModelResolved,
  };
}

/** Resolve the per-judge specs from the judge config: judge1 always; judge2/3 when
 *  `judgesNumber >= 3` (the ensemble size is 1 or 3). Pure. */
export function judgeSpecs(config: JudgeEnsembleConfig): readonly JudgeSpec[] {
  const specs: JudgeSpec[] = [{ model: config.judgeModel, reasoning: config.judgeThinkingLevel }];
  if (config.judgesNumber >= ENSEMBLE_OF_THREE) {
    specs.push({ model: config.judge2Model, reasoning: config.judge2ThinkingLevel });
    specs.push({ model: config.judge3Model, reasoning: config.judge3ThinkingLevel });
  }
  return specs;
}

/** Build a `CallJudge` (one no-tools LLM turn → assistant text) for one judge spec.
 *  Resolves the model, runs a single-turn stage with no tools, + returns the
 *  assistant's text. Throws `BenchJudgeError` on an unavailable model, a timeout,
 *  or an abort (the orchestrate layer stop-and-surfaces). */
export function buildCallJudge(spec: JudgeSpec, transport: JudgeTransport): CallJudge {
  return async (systemPrompt, userContent): Promise<string> => {
    const resolved = await transport.resolveModel(transport.ctx, spec.model);
    if (!resolved.ok) {
      throw new BenchJudgeError("model-unavailable", `judge model not available: ${resolved.error}`);
    }
    transport.onModelResolved?.(resolved.model);
    const run = (): Promise<StageRunResult> =>
      transport.runStage({
        systemPrompt,
        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
        tools: [],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: transport.signal,
        // pi-agent-core's ThinkingLevel includes "off" (no reasoning); pi-ai's excludes
        // it (null = no reasoning). Map "off" → null so the config level flows through.
        reasoning: spec.reasoning === "off" ? NO_REASONING : spec.reasoning,
        maxTurns: SINGLE_TURN,
        maxTokens: transport.maxTokens,
        // A per-turn wall-clock cap: a hung cloud-judge call surfaces as a
        // BenchJudgeError("timeout") instead of hanging until the run idle-alert.
        timeoutMs: JUDGE_TURN_TIMEOUT_MS,
        onEvent: transport.onEvent ?? NO_EVENT_SINK,
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
export function buildStageSeams(spec: JudgeSpec, transport: JudgeTransport): JsonToolStageSeams {
  return {
    resolveModel: () => transport.resolveModel(transport.ctx, spec.model),
    runStage: transport.runStage,
    onEvent: transport.onEvent,
  };
}

/** The K judge callJudges + stageSeams (both length K) built from the bench config. */
export interface JudgeEnsemble {
  readonly callJudges: readonly CallJudge[];
  readonly stageSeams: readonly JsonToolStageSeams[];
}

/** Build the K-judge ensemble (callJudges + stageSeams, both length K) from the
 *  judge config. K = `judgesNumber` (1 or 3); each judge pair is built from its
 *  JudgeSpec. Pure aside from the transport (no model resolution yet). */
export function buildJudgeEnsemble(config: JudgeEnsembleConfig, transport: JudgeTransport): JudgeEnsemble {
  const specs = judgeSpecs(config);
  return {
    callJudges: specs.map((spec) => buildCallJudge(spec, transport)),
    stageSeams: specs.map((spec) => buildStageSeams(spec, transport)),
  };
}

/** A single-turn judge call (maxTurns = 1 — the judge answers in one shot). */
const SINGLE_TURN = 1;
/** Per-turn wall-clock cap for a single judge LLM call (no tools — one request).
 *  A cloud judge that never responds surfaces as a timeout instead of hanging. */
const JUDGE_TURN_TIMEOUT_MS = 300_000;
/** The ensemble size at which judge2 + judge3 join (3 = full ensemble). */
const ENSEMBLE_OF_THREE = 3;
