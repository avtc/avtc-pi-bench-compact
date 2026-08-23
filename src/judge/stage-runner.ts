// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared bench judge stage-runner: an agentLoop + caller-supplied tools (one of
// which is a terminal JSON-output tool), rate-limit-wrapped. This is the skeleton
// the trajectory grader (record_grades), the recall-cost boundary finder
// (report_boundary), AND the manifest-authoring agent (write_manifest) share —
// extracted so none duplicate the resolve -> runStage -> check -> read-captured
// flow. The caller builds the tools (read-only / read-only+bash / coding) + the
// system prompt + maps the captured payload to its own shape; this module owns
// the run + the StageRunInput literal (single source of truth).

import type { AgentEvent, AgentTool, ThinkingLevel as CoreThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_STREAM_FN,
  NO_TURN_LIMIT,
  type StageRunInput,
  type StageRunResult,
  toStageReasoning,
} from "../runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../runtime/model.js";
import type { JsonOutputTool } from "../runtime/tools.js";
import { BenchJudgeError } from "./errors.js";
import { type RateLimitOptions, withRateLimit } from "./rate-limit.js";

/** Injectable seams: resolve the judge model + run the bench stage (faked in tests). */
export interface JsonToolStageSeams {
  readonly resolveModel: () => Promise<ResolvedBenchModel>;
  readonly runStage: (input: StageRunInput) => Promise<StageRunResult>;
  /** Optional event sink forwarded to the stage's runStage (the widget subscribes for ctx/tok). */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Optional hook fired after a successful model resolution (the widget sets its ctx window). */
  readonly onModelResolved?: (model: Model<Api>) => void;
  /** Optional hook fired when the stage's agent finishes — ANY exit (success, timeout,
   *  abort, thrown error). The widget retires its ctx/tok segments here so a dead
   * agent's last request cannot linger while nothing is streaming. */
  readonly onDone?: () => void;
}

/** The transport fields every stage caller threads straight from its own deps
 *  (the "how to run" subset of {@link RunJsonToolStageDeps}). Extracted so the
 *  stage callers do not duplicate the seams/maxTokens/signal/rateLimitOptions
 *  pass-through (the trajectory grader + the trajectory-summary builder share it). */
export interface StageTransport {
  readonly seams: JsonToolStageSeams;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/** The content fields that vary per stage (the "what to run" subset). */
export interface StageContent {
  readonly tools: AgentTool[];
  readonly systemPrompt: string;
  readonly terminalTool: JsonOutputTool;
  readonly label: string;
  readonly userMessageContent: string;
}

/** Build a {@link RunJsonToolStageDeps} from the shared transport fields + the
 *  stage's content. Single source for the field-pass-through the stage callers
 *  share; callers supply only their content (tools/prompt/terminal/label/msg). */
export function buildStageDeps(transport: StageTransport, content: StageContent): RunJsonToolStageDeps {
  return {
    seams: transport.seams,
    tools: content.tools,
    systemPrompt: content.systemPrompt,
    terminalTool: content.terminalTool,
    label: content.label,
    userMessageContent: content.userMessageContent,
    maxTokens: transport.maxTokens,
    // Judge tool-stages run with reasoning omitted (single-shot structured output).
    reasoning: NO_REASONING,
    // Judge tool-stages run uncapped (slow reads/greps/bash); per-call judge caps live elsewhere.
    timeoutMs: null,
    signal: transport.signal,
    rateLimitOptions: transport.rateLimitOptions,
  };
}

/** Inputs to {@link runJsonToolStage}. */
export interface RunJsonToolStageDeps {
  readonly seams: JsonToolStageSeams;
  /** The full tool set for the stage (read-only / read-only+bash / coding + the terminal tool — caller-built). */
  readonly tools: AgentTool[];
  /** The stage's system prompt (caller-built). */
  readonly systemPrompt: string;
  /** The terminal JSON-output tool the agent calls once with its structured output. */
  readonly terminalTool: JsonOutputTool;
  /** A short label for error messages (e.g. "trajectory grading"). */
  readonly label: string;
  /** The user-message content that kicks off the stage. */
  readonly userMessageContent: string;
  /** The stage's thinking level; NO_REASONING (null) omits the reasoning field. */
  readonly reasoning: CoreThinkingLevel | null;
  readonly maxTokens: number;
  /** Wall-clock cap per stage; null = no cap (the judge stages run uncapped — their
   *  tool calls may run slow reads/greps/bash). */
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/**
 * Run a judge/authoring stage: resolve the model, run the agentLoop with the
 * caller's tools (rate-limit-wrapped, multi-turn), then return the LAST captured
 * payload from the terminal tool. THROWS on an unavailable model, a timed-out/
 * aborted stage, or no capture (STOP+surface — the `label` names the stage).
 * Pure aside from the seams.
 */
/** Fraction of the model's context window at or above which a no-capture stage
 *  is classified as context-exhausted (died on the window, not a lucid refusal). */
export const CONTEXT_EXHAUSTED_FRACTION = 0.95;

export async function runJsonToolStage(deps: RunJsonToolStageDeps): Promise<unknown> {
  const resolved = await deps.seams.resolveModel();
  if (!resolved.ok) {
    throw new BenchJudgeError("model-unavailable", `${deps.label} model not available: ${resolved.error}`);
  }
  deps.seams.onModelResolved?.(resolved.model);
  // Auto-append the terminal tool if the caller didn't (R7: source of truth is
  // terminalTool alone; dedup by name so an explicit inclusion isn't duplicated).
  const stageTools: AgentTool[] = deps.tools.some((t) => t.name === deps.terminalTool.name)
    ? deps.tools
    : [...deps.tools, deps.terminalTool];
  const runStage = (): Promise<StageRunResult> =>
    deps.seams.runStage({
      systemPrompt: deps.systemPrompt,
      messages: [{ role: "user", content: deps.userMessageContent, timestamp: Date.now() }],
      tools: stageTools,
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal: deps.signal,
      reasoning: toStageReasoning(deps.reasoning),
      maxTurns: NO_TURN_LIMIT, // multi-turn: inspect, then the terminal tool
      maxTokens: deps.maxTokens,
      timeoutMs: deps.timeoutMs,
      onEvent: deps.seams.onEvent ?? NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: NO_LOOP_OVERRIDE,
      streamFn: NO_STREAM_FN,
      label: deps.label,
    });
  let result: StageRunResult;
  try {
    result = await withRateLimit(runStage, deps.rateLimitOptions ?? null);
  } finally {
    deps.seams.onDone?.();
  }
  if (result.timedOut) {
    throw new BenchJudgeError("timeout", `${deps.label} stage timed out before ${deps.terminalTool.name}`);
  }
  if (result.aborted) {
    throw new BenchJudgeError("aborted", `${deps.label} stage was aborted before ${deps.terminalTool.name}`);
  }
  const captured = deps.terminalTool._captured;
  if (captured.length === 0) {
    // A no-capture stage that ended at (nearly) the whole window died on the
    // window — local models often degrade to a plain tool-less reply instead of
    // erroring. Classified distinctly so retry-capable callers (the latent
    // authoring pass loop) can restart in a fresh context.
    const window = resolved.model.contextWindow ?? 0;
    if (window > 0 && result.finalContextTokens >= CONTEXT_EXHAUSTED_FRACTION * window) {
      throw new BenchJudgeError(
        "context-exhausted",
        `${deps.label} agent exhausted its context window before ${deps.terminalTool.name} — final context ${result.finalContextTokens}/${window} tokens`,
      );
    }
    throw new BenchJudgeError(
      "no-capture",
      `${deps.label} agent did not call ${deps.terminalTool.name} — nothing captured`,
    );
  }
  return captured[captured.length - 1];
}
