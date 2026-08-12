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

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_TURN_LIMIT,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../runtime/model.js";
import type { JsonOutputTool } from "../runtime/tools.js";
import { type RateLimitOptions, withRateLimit } from "./rate-limit.js";

/** Injectable seams: resolve the judge model + run the bench stage (faked in tests). */
export interface JsonToolStageSeams {
  readonly resolveModel: () => Promise<ResolvedBenchModel>;
  readonly runStage: (input: StageRunInput) => Promise<StageRunResult>;
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
  readonly maxTokens: number;
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
export async function runJsonToolStage(deps: RunJsonToolStageDeps): Promise<unknown> {
  const resolved = await deps.seams.resolveModel();
  if (!resolved.ok) {
    throw new Error(`judge model not available: ${resolved.error}`);
  }
  const runStage = (): Promise<StageRunResult> =>
    deps.seams.runStage({
      systemPrompt: deps.systemPrompt,
      messages: [{ role: "user", content: deps.userMessageContent, timestamp: Date.now() }],
      tools: deps.tools,
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal: deps.signal,
      reasoning: NO_REASONING,
      maxTurns: NO_TURN_LIMIT, // multi-turn: inspect, then the terminal tool
      maxTokens: deps.maxTokens,
      timeoutMs: null, // tool-bearing stage may run slow reads/greps/bash
      onEvent: NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: NO_LOOP_OVERRIDE,
    });
  const result = await withRateLimit(runStage, deps.rateLimitOptions ?? null);
  if (result.timedOut) {
    throw new Error(`${deps.label} stage timed out before ${deps.terminalTool.name}`);
  }
  if (result.aborted) {
    throw new Error(`${deps.label} stage was aborted before ${deps.terminalTool.name}`);
  }
  const captured = deps.terminalTool._captured;
  if (captured.length === 0) {
    throw new Error(`${deps.label} agent did not call ${deps.terminalTool.name} — nothing captured`);
  }
  return captured[captured.length - 1];
}
