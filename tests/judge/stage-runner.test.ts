// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { BenchJudgeError } from "../../src/judge/errors.js";
import { buildStageDeps, type JsonToolStageSeams, runJsonToolStage } from "../../src/judge/stage-runner.js";
import { type JsonOutputTool, makeJsonOutputTool, NO_CAPTURE } from "../../src/runtime/tools.js";
import { callTerminal, capturingSeams, cleanResult, OK_MODEL } from "./helpers.js";

const SCHEMA = Type.Object({ value: Type.String() });

describe("runJsonToolStage", () => {
  it("returns the last captured payload from the terminal tool", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const { seams } = capturingSeams("emit", { value: "hello" });
    const payload = await runJsonToolStage({
      seams,
      tools: [terminal] as AgentTool[],
      systemPrompt: "system",
      terminalTool: terminal,
      label: "test-stage",
      userMessageContent: "go",
      maxTokens: 4096,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    });
    expect(payload).toEqual({ value: "hello" });
  });

  it("fires onModelResolved after resolve + forwards onEvent to runStage", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const resolvedModels: unknown[] = [];
    const fakeEvent = { type: "message_update" } as unknown as Parameters<
      NonNullable<JsonToolStageSeams["onEvent"]>
    >[0];
    let runStageOnEvent: ((e: unknown) => void) | undefined;
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        runStageOnEvent = input.onEvent as ((e: unknown) => void) | undefined;
        runStageOnEvent?.(fakeEvent);
        callTerminal(input, "emit", { value: "x" });
        return cleanResult();
      },
      onEvent: (e) => {
        resolvedModels.push(`event:${(e as { type: string }).type}`); // reuse the array to capture events
      },
      onModelResolved: (m) => {
        resolvedModels.push(`model:${(m as { id?: string }).id ?? "?"}`);
      },
    };
    await runJsonToolStage({
      seams,
      tools: [terminal] as AgentTool[],
      systemPrompt: "s",
      terminalTool: terminal,
      label: "test-stage",
      userMessageContent: "go",
      maxTokens: 4096,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    });
    // onModelResolved fired after resolve; the forwarded onEvent reached seams.onEvent.
    expect(resolvedModels).toContainEqual(expect.stringMatching(/^model:/));
    expect(resolvedModels).toContainEqual("event:message_update");
    expect(runStageOnEvent).toBeDefined();
  });

  it("throws when the model is unavailable, naming the stage in the message", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
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
        label: "authoring",
        userMessageContent: "g",
        maxTokens: 1,
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authoring model not available/i);
  });

  it("auto-appends the terminal tool when the caller omits it from tools (R7)", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    let seenTools: readonly AgentTool[] = [];
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        seenTools = input.tools;
        const tool = input.tools.find((t) => t.name === "emit") as JsonOutputTool;
        void tool.execute("c1", { value: "auto" });
        return cleanResult();
      },
    };
    const payload = await runJsonToolStage({
      seams,
      tools: [], // caller omitted the terminal tool — runner must append it
      systemPrompt: "s",
      terminalTool: terminal,
      label: "test-stage",
      userMessageContent: "g",
      maxTokens: 4096,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    });
    expect(payload).toEqual({ value: "auto" });
    expect(seenTools.map((t) => t.name)).toContain("emit");
  });

  it("does not double-append the terminal tool when the caller already included it (R7)", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    let count = 0;
    const seams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        count = input.tools.filter((t) => t.name === "emit").length;
        const tool = input.tools.find((t) => t.name === "emit") as JsonOutputTool;
        void tool.execute("c1", { value: "once" });
        return cleanResult();
      },
    };
    await runJsonToolStage({
      seams,
      tools: [terminal] as AgentTool[],
      systemPrompt: "s",
      terminalTool: terminal,
      label: "test-stage",
      userMessageContent: "g",
      maxTokens: 4096,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    });
    expect(count).toBe(1);
  });

  it("throws on a timed-out stage, naming the stage in the message", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
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
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/my-stage.*timed out/i);
  });

  it("throws on an aborted stage", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
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
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("throws when the terminal tool was never called (no capture)", async () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
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
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/did not call emit|no.*captured/i);
  });

  it("classifies a no-capture stage that ended at >=95% of the model window as context-exhausted", async () => {
    const t = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const windowed: JsonToolStageSeams = {
      resolveModel: async () =>
        ({ ok: true, model: { id: "m", contextWindow: 262_144 }, apiKey: "k" }) as unknown as typeof OK_MODEL,
      runStage: async () => ({
        ...cleanResult(),
        finalContextTokens: 250_000, // 95.4% of the window
      }),
    };
    const err = (await runJsonToolStage({
      seams: windowed,
      tools: [t] as AgentTool[],
      systemPrompt: "s",
      terminalTool: t,
      label: "latent authoring",
      userMessageContent: "go",
      maxTokens: 1,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)) as unknown as { category?: string; message: string };
    expect(err).toBeInstanceOf(BenchJudgeError);
    expect((err as { category?: string }).category).toBe("context-exhausted");
    expect(err.message).toMatch(/exhausted its context window.*250[ ,]?000.*262[ ,]?144/);
  });

  it("keeps plain no-capture below the threshold and when the window is unknown", async () => {
    const t = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const nearMiss: JsonToolStageSeams = {
      resolveModel: async () =>
        ({ ok: true, model: { id: "m", contextWindow: 262_144 }, apiKey: "k" }) as unknown as typeof OK_MODEL,
      runStage: async () => ({ ...cleanResult(), finalContextTokens: 200_000 }),
    };
    await expect(
      runJsonToolStage({
        seams: nearMiss,
        tools: [t] as AgentTool[],
        systemPrompt: "s",
        terminalTool: t,
        label: "x",
        userMessageContent: "g",
        maxTokens: 1,
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ category: "no-capture" });
    const noWindow: JsonToolStageSeams = {
      ...nearMiss,
      resolveModel: async () => OK_MODEL, // no contextWindow on the fake model
    };
    await expect(
      runJsonToolStage({
        seams: noWindow,
        tools: [t] as AgentTool[],
        systemPrompt: "s",
        terminalTool: t,
        label: "x",
        userMessageContent: "g",
        maxTokens: 1,
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ category: "no-capture" });
  });
});

describe("buildStageDeps", () => {
  it("threads the transport fields (seams/maxTokens/signal/rateLimitOptions) + content into RunJsonToolStageDeps", () => {
    const terminal = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const ctrl = new AbortController();
    const transportSeams: JsonToolStageSeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(),
    };
    const deps = buildStageDeps(
      { seams: transportSeams, maxTokens: 1234, signal: ctrl.signal, rateLimitOptions: null },
      {
        tools: [terminal] as AgentTool[],
        systemPrompt: "sys",
        terminalTool: terminal,
        label: "my-stage",
        userMessageContent: "go",
      },
    );
    expect(deps.seams).toBe(transportSeams);
    expect(deps.maxTokens).toBe(1234);
    expect(deps.signal).toBe(ctrl.signal);
    expect(deps.rateLimitOptions).toBeNull();
    expect(deps.systemPrompt).toBe("sys");
    expect(deps.label).toBe("my-stage");
    expect(deps.terminalTool).toBe(terminal);
    expect(deps.userMessageContent).toBe("go");
    expect(deps.tools).toEqual([terminal]);
  });
});

describe("runJsonToolStage — agent-done hook", () => {
  const terminal = (): JsonOutputTool => makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);

  it("fires seams.onDone after a successful stage", async () => {
    const t = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const { seams } = capturingSeams("emit", { value: "x" });
    const done: number[] = [];
    const hooked: JsonToolStageSeams = { ...seams, onDone: () => done.push(1) };
    await runJsonToolStage({
      seams: hooked,
      tools: [t] as AgentTool[],
      systemPrompt: "s",
      terminalTool: t,
      label: "t",
      userMessageContent: "go",
      maxTokens: 1,
      reasoning: null,
      timeoutMs: null,
      signal: new AbortController().signal,
    });
    expect(done).toEqual([1]);
  });

  it("fires seams.onDone when the stage times out (any exit)", async () => {
    const t = makeJsonOutputTool("emit", "desc", SCHEMA, NO_CAPTURE);
    const { seams } = capturingSeams("emit", { value: "x" });
    const timedOutSeams: JsonToolStageSeams = {
      ...seams,
      runStage: async () => ({
        messages: [],
        timedOut: true,
        finalContextTokens: 0,
        aborted: false,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0, elapsedMs: 0 },
        outputTokens: 0,
      }),
    };
    const done: number[] = [];
    const hooked: JsonToolStageSeams = { ...timedOutSeams, onDone: () => done.push(1) };
    await expect(
      runJsonToolStage({
        seams: hooked,
        tools: [t] as AgentTool[],
        systemPrompt: "s",
        terminalTool: t,
        label: "t",
        userMessageContent: "go",
        maxTokens: 1,
        reasoning: null,
        timeoutMs: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("timed out");
    expect(done).toEqual([1]);
  });
});
