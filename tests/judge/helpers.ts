// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared scaffolding for the agentLoop-stage judge tests (stage-runner /
// trajectory / c2-boundary): a fake resolved model, a clean StageRunResult
// factory, + a seams fake that captures a canned payload into a named terminal
// tool. Extracted so the three stages' tests share one source (R11).

import type { Api, Model } from "@earendil-works/pi-ai";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../../src/runtime/model.js";
import type { JsonOutputTool } from "../../src/runtime/tools.js";

const FAKE_MODEL: Model<Api> = { id: "fake" } as unknown as Model<Api>;
export const OK_MODEL: ResolvedBenchModel = { ok: true, model: FAKE_MODEL, apiKey: "key" };

/** A successful, empty StageRunResult (no messages, zero usage, not aborted/timed-out). */
export function cleanResult(): StageRunResult {
  return {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
    outputTokens: 0,
    aborted: false,
    timedOut: false,
    finalContextTokens: 0,
  };
}

/** Find the named terminal tool in a stage input + call its execute with `payload`. */
export function callTerminal(input: StageRunInput, terminalName: string, payload: unknown): void {
  const tool = input.tools.find((t) => t.name === terminalName) as JsonOutputTool | undefined;
  if (tool === undefined) throw new Error(`test fake: ${terminalName} tool not found`);
  void tool.execute("c1", payload as Record<string, unknown>);
}

/**
 * Build fake seams (resolveModel=OK; runStage=fake) that capture `payload` into
 * the named terminal tool's `._captured` and record every stage input. Throws if
 * the terminal tool isn't in the stage's tools (the runner auto-appends it).
 */
export function capturingSeams(
  terminalName: string,
  payload: unknown,
): { seams: JsonToolStageSeams; inputs: StageRunInput[] } {
  const inputs: StageRunInput[] = [];
  const seams: JsonToolStageSeams = {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      inputs.push(input);
      callTerminal(input, terminalName, payload);
      return cleanResult();
    },
  };
  return { seams, inputs };
}
