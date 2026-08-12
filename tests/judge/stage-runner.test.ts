// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type JsonToolStageSeams, runJsonToolStage } from "../../src/judge/stage-runner.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../../src/runtime/model.js";
import { type JsonOutputTool, makeJsonOutputTool } from "../../src/runtime/tools.js";

const FAKE_MODEL: Model<Api> = { id: "fake" } as unknown as Model<Api>;
const OK_MODEL: ResolvedBenchModel = { ok: true, model: FAKE_MODEL, apiKey: "key" };

function cleanResult(): StageRunResult {
  return {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
    outputTokens: 0,
    aborted: false,
    timedOut: false,
  };
}

const SCHEMA = Type.Object({ value: Type.String() });

/** A seams fake that finds the terminal tool in the input + calls execute with the payload. */
function seamsCapturing(
  payload: unknown,
  terminalName: string,
): { seams: JsonToolStageSeams; inputs: StageRunInput[] } {
  const inputs: StageRunInput[] = [];
  const seams: JsonToolStageSeams = {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      inputs.push(input);
      const tool = input.tools.find((t) => t.name === terminalName) as JsonOutputTool | undefined;
      if (tool === undefined) throw new Error(`test fake: ${terminalName} tool not found`);
      void tool.execute("c1", payload as Record<string, unknown>);
      return cleanResult();
    },
  };
  return { seams, inputs };
}

describe("runJsonToolStage", () => {
  it("returns the last captured payload from the terminal tool", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA);
    const { seams } = seamsCapturing({ value: "hello" }, "emit");
    const payload = await runJsonToolStage({
      seams,
      tools: [terminal] as AgentTool[],
      systemPrompt: "system",
      terminalTool: terminal,
      label: "test-stage",
      userMessageContent: "go",
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(payload).toEqual({ value: "hello" });
  });

  it("throws when the model is unavailable", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA);
    const seams: JsonToolStageSeams = {
      resolveModel: async () => ({ ok: false, error: "no model" }),
      runStage: async () => cleanResult(),
    };
    await expect(
      runJsonToolStage({
        seams,
        tools: [terminal] as AgentTool[],
        systemPrompt: "s",
        terminalTool: terminal,
        label: "x",
        userMessageContent: "g",
        maxTokens: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/model not available/i);
  });

  it("throws on a timed-out stage", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA);
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        const tool = input.tools.find((t) => t.name === "emit") as JsonOutputTool;
        void tool.execute("c1", { value: "x" });
        return { ...cleanResult(), timedOut: true };
      },
    };
    await expect(
      runJsonToolStage({
        seams,
        tools: [terminal] as AgentTool[],
        systemPrompt: "s",
        terminalTool: terminal,
        label: "my-stage",
        userMessageContent: "g",
        maxTokens: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/my-stage.*timed out/i);
  });

  it("throws on an aborted stage", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA);
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => ({ ...cleanResult(), aborted: true }),
    };
    await expect(
      runJsonToolStage({
        seams,
        tools: [terminal] as AgentTool[],
        systemPrompt: "s",
        terminalTool: terminal,
        label: "x",
        userMessageContent: "g",
        maxTokens: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("throws when the terminal tool was never called (no capture)", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA);
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(),
    };
    await expect(
      runJsonToolStage({
        seams,
        tools: [terminal] as AgentTool[],
        systemPrompt: "s",
        terminalTool: terminal,
        label: "x",
        userMessageContent: "g",
        maxTokens: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/did not call emit|no.*captured/i);
  });
});
