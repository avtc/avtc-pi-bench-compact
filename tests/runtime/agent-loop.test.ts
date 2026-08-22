// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _setBaseLoggerForTest } from "../../src/log.js";
import {
  makeTurnCap,
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_STREAM_FN,
  NO_TURN_LIMIT,
  runBenchStage,
  StageRunError,
  type StageRunInput,
  toStageReasoning,
} from "../../src/runtime/agent-loop.js";

// --- fake agentLoop seam ---------------------------------------------------

/** Build a fake `agentLoop` (the `loopFn` test seam) that yields scripted events,
 * honors abort (stops on signal) and the turn cap (stops when the loop's
 * `shouldStopAfterTurn` returns true), and awaits a microtask between events so a
 * fake-clock per-turn timer can fire mid-stream. `.result()` returns the scripted
 * final messages. */
function fakeLoop(
  events: AgentEvent[],
  finalMessages: AgentMessage[],
): typeof import("@earendil-works/pi-agent-core").agentLoop {
  const fn = (
    _messages: AgentMessage[],
    _ctx: unknown,
    config: AgentLoopConfig,
    signal: AbortSignal,
    _stream: unknown,
  ) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        if (signal.aborted) return;
        yield event;
        await Promise.resolve(); // yield to the microtask queue (lets fake-clock timers fire)
        if (signal.aborted) return;
        if (event.type === "turn_end" && typeof config.shouldStopAfterTurn === "function") {
          if (
            await config.shouldStopAfterTurn(
              {} as unknown as Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0],
            )
          )
            return;
        }
      }
    },
    async result(): Promise<AgentMessage[]> {
      return finalMessages;
    },
  });
  return fn as unknown as typeof import("@earendil-works/pi-agent-core").agentLoop;
}

function msgEnd(usage: Record<string, number | { total: number }>): AgentEvent {
  return { type: "message_end", message: { usage } } as unknown as AgentEvent;
}
function textDelta(text: string): AgentEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as AgentEvent;
}
const TURN_END = { type: "turn_end" } as unknown as AgentEvent;

const STUB_MODEL = { id: "m", name: "m", api: "test" as Api } as unknown as Model<Api>;

/** Build a StageRunInput with sensible test defaults; override per-test. */
function baseInput(over: Partial<StageRunInput>): StageRunInput {
  return {
    systemPrompt: "",
    messages: [],
    tools: [],
    model: STUB_MODEL,
    apiKey: "key",
    signal: new AbortController().signal,
    reasoning: NO_REASONING,
    maxTurns: NO_TURN_LIMIT,
    maxTokens: 4096,
    timeoutMs: null,
    onEvent: NO_EVENT_SINK,
    onStageEnd: NO_STAGE_END_HOOK,
    loopFn: NO_LOOP_OVERRIDE,
    streamFn: NO_STREAM_FN,
    ...over,
  };
}

describe("toStageReasoning", () => {
  it("maps config thinking levels (pi-agent-core) to stage-input reasoning (pi-ai)", () => {
    // "off" is a config-only level: it means no reasoning, which pi-ai expresses as null.
    expect(toStageReasoning("off")).toBeNull();
    expect(toStageReasoning(null)).toBeNull();
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(toStageReasoning(level)).toBe(level);
    }
  });
});

describe("runBenchStage — tool-call logging (every background agent's tool calls land in the log)", () => {
  let lines: { level: string; msg: string }[];
  let prev: ReturnType<typeof _setBaseLoggerForTest>;
  const capture = (): void => {
    lines = [];
    prev = _setBaseLoggerForTest({
      info: (m) => lines.push({ level: "info", msg: m }),
      warn: (m) => lines.push({ level: "warn", msg: m }),
      error: (m) => lines.push({ level: "error", msg: m }),
      debug: () => {},
    });
  };
  afterEach(() => {
    if (prev !== null) _setBaseLoggerForTest(prev);
  });

  it("logs every tool call (info, label + name + truncated args) and failed tools (warn)", async () => {
    const events: AgentEvent[] = [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "add_latent_probe",
        args: { question: "q", probeClass: "cued", entryIds: ["e1"] },
      } as unknown as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "add_latent_probe",
        result: { content: [{ type: "text", text: "recorded add_latent_probe; keep going" }] },
        isError: false,
      } as unknown as AgentEvent,
      {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "bash",
        args: { command: "x".repeat(500) },
      } as unknown as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "t2",
        toolName: "bash",
        result: { content: [{ type: "text", text: `boom: exit 1 ${"y".repeat(400)}` }] },
        isError: true,
      } as unknown as AgentEvent,
      TURN_END,
    ];
    capture();
    await runBenchStage(baseInput({ loopFn: fakeLoop(events, []), label: "latent authoring" }));
    const infos = lines.filter((l) => l.level === "info").map((l) => l.msg);
    expect(infos).toContainEqual(expect.stringContaining("tool call [latent authoring]: add_latent_probe"));
    expect(infos.join("\n")).toContain('"question":"q"');
    // the 500-char bash command is truncated (400 cap + ellipsis)
    const bashLine = infos.find((m) => m.includes("bash"));
    expect(bashLine).toBeDefined();
    expect(bashLine).toContain("…");
    expect(bashLine?.length).toBeLessThan(550);
    const warns = lines.filter((l) => l.level === "warn").map((l) => l.msg);
    expect(warns).toContainEqual(expect.stringContaining("tool failed [latent authoring]: bash"));
    expect(warns.join("\n")).toContain("boom: exit 1");
  });

  it("omits the label bracket when no label is set", async () => {
    const events: AgentEvent[] = [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "read",
        args: { path: "/tmp/x" },
      } as unknown as AgentEvent,
      TURN_END,
    ];
    capture();
    await runBenchStage(baseInput({ loopFn: fakeLoop(events, []) }));
    const infos = lines.filter((l) => l.level === "info").map((l) => l.msg);
    expect(infos).toContain('tool call: read {"path":"/tmp/x"}');
  });
});

describe("runBenchStage", () => {
  it("accumulates per-message-end usage (input/output/cacheRead/cacheWrite/cost) + counts turns", async () => {
    const events = [
      msgEnd({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } }),
      TURN_END,
      msgEnd({ input: 200, output: 60, cacheRead: 20, cacheWrite: 8, cost: { total: 0.02 } }),
      TURN_END,
    ];
    const r = await runBenchStage(baseInput({ loopFn: fakeLoop(events, []) }));
    expect(r.usage).toMatchObject({ input: 300, output: 100, cacheRead: 30, cacheWrite: 13, cost: 0.03, turns: 2 });
    // provider reports output -> authoritative outputTokens = sum of usage.output
    expect(r.outputTokens).toBe(100);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.usage.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("outputTokens falls back to chars/4 over streamed deltas when the provider reports no output usage", async () => {
    const events = [textDelta("abcdefgh"), textDelta("abcd"), TURN_END]; // 8+4 chars = 12 -> 3 tokens
    const r = await runBenchStage(baseInput({ loopFn: fakeLoop(events, []) }));
    expect(r.usage.output).toBe(0); // no usage.output
    expect(r.outputTokens).toBe(3); // ceil(12/4)
  });

  it("forwards every event to onEvent and fires onStageEnd with accumulated usage", async () => {
    const seen: AgentEvent[] = [];
    let ended: { turns: number } | null = null;
    const events = [msgEnd({ input: 1, output: 2 }), TURN_END];
    await runBenchStage(
      baseInput({
        loopFn: fakeLoop(events, []),
        onEvent: (e) => seen.push(e),
        onStageEnd: (u) => {
          ended = { turns: u.turns };
        },
      }),
    );
    expect(seen.map((e) => e.type)).toEqual(["message_end", "turn_end"]);
    expect(ended).toEqual({ turns: 1 });
  });

  it("returns aborted:true when the run signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    const r = await runBenchStage(baseInput({ signal: ac.signal, loopFn: fakeLoop([TURN_END], []) }));
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false); // aborted by the RUN signal, not the per-turn timer
  });

  it("returns aborted:true when the run signal aborts mid-stream (after a turn landed)", async () => {
    const ac = new AbortController();
    // a fake that yields one turn, then blocks until the run signal aborts
    const blocking = (_m: AgentMessage[], _ctx: unknown, _cfg: AgentLoopConfig, signal: AbortSignal, _s: unknown) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
        if (signal.aborted) return;
        yield TURN_END;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async result(): Promise<AgentMessage[]> {
        return [];
      },
    });
    const p = runBenchStage(
      baseInput({
        signal: ac.signal,
        loopFn: blocking as unknown as typeof import("@earendil-works/pi-agent-core").agentLoop,
        timeoutMs: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // let the first turn land + block on the signal
    ac.abort(new Error("user cancelled mid-run"));
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false); // RUN signal aborted, not the per-turn timer
    expect(r.usage.turns).toBe(1); // the turn that landed before the abort
  });

  it("stops after maxTurns completed turns (shouldStopAfterTurn wiring)", async () => {
    // 5 turn_ends scripted; maxTurns=3 -> stops after the 3rd
    const events = [TURN_END, TURN_END, TURN_END, TURN_END, TURN_END];
    const r = await runBenchStage(baseInput({ loopFn: fakeLoop(events, []), maxTurns: 3 }));
    expect(r.usage.turns).toBe(3);
    expect(r.aborted).toBe(false);
  });

  it("per-turn timeoutMs fires timedOut:true (fake clock) — distinct from a run-signal abort", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController(); // run signal NOT aborted
      // A fake that yields one event, then BLOCKS on a long fake-clock wait that
      // bails when the per-turn signal aborts — so the 50ms per-turn timer fires
      // mid-stream (before the fake would naturally finish).
      const blocking = (
        _m: AgentMessage[],
        _ctx: unknown,
        _config: AgentLoopConfig,
        signal: AbortSignal,
        _s: unknown,
      ) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          if (signal.aborted) return;
          yield TURN_END;
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const t = setTimeout(resolve, 1000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
        },
        async result(): Promise<AgentMessage[]> {
          return [];
        },
      });
      const p = runBenchStage(
        baseInput({
          signal: ac.signal,
          loopFn: blocking as unknown as typeof import("@earendil-works/pi-agent-core").agentLoop,
          timeoutMs: 50,
        }),
      );
      await vi.advanceTimersByTimeAsync(60); // fire the per-turn timer
      const r = await p;
      expect(r.timedOut).toBe(true);
      expect(r.aborted).toBe(true); // aborted by the per-turn timer's controller
      expect(r.usage.turns).toBe(1); // the one turn_end before the timer fired
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps a throwing loop in StageRunError AND fires onStageEnd in finally (partial usage)", async () => {
    const boom = (): never => {
      throw new Error("kaboom");
    };
    const throwing = () => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            boom();
          },
        };
      },
      async result() {
        return [];
      },
    });
    const ended: { elapsedMs: number }[] = [];
    await expect(
      runBenchStage(
        baseInput({
          loopFn: throwing as unknown as typeof import("@earendil-works/pi-agent-core").agentLoop,
          onStageEnd: (u) => {
            ended.push({ elapsedMs: u.elapsedMs });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(StageRunError);
    // the finally hook must fire even on failure (StageRunError doc: fires regardless)
    expect(ended).toHaveLength(1);
    expect(ended[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("makeTurnCap", () => {
  it("returns false until the Nth call, then true (null = never)", () => {
    const cap = makeTurnCap(3);
    expect(cap({} as unknown as Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0])).toBe(false); // after turn 1
    expect(cap({} as unknown as Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0])).toBe(false); // after turn 2
    expect(cap({} as unknown as Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0])).toBe(true); // after turn 3 -> stop
  });
  it("null -> never stops", () => {
    const never = makeTurnCap(null);
    for (let i = 0; i < 50; i++)
      expect(never({} as unknown as Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0])).toBe(false);
  });
});

describe('runBenchStage — model-request errors surface (pi ends the turn with stopReason "error")', () => {
  it("throws StageRunError carrying the model + errorMessage when the final assistant message errored", async () => {
    const erroredMsg = {
      role: "assistant",
      model: "local-server/Qwen3.8-27B",
      stopReason: "error",
      errorMessage: "fetch failed: connection refused",
      content: [],
    } as unknown as AgentMessage;
    await expect(runBenchStage(baseInput({ loopFn: fakeLoop([TURN_END], [erroredMsg]) }))).rejects.toThrow(
      /Qwen3.8-27B request failed: fetch failed/,
    );
  });

  it("a clean stopReason flows through unchanged (no throw)", async () => {
    const ok = {
      role: "assistant",
      model: "m",
      stopReason: "stop",
      content: [{ type: "text", text: "hi" }],
    } as unknown as AgentMessage;
    const r = await runBenchStage(baseInput({ loopFn: fakeLoop([msgEnd({})], [ok]) }));
    expect(r.messages).toHaveLength(1);
  });
});

describe("runBenchStage — streamFn (provider retries for background stages)", () => {
  it("passes the retrying streamFn by default (not the undefined global fallback)", async () => {
    const seen: unknown[] = [];
    const captureLoop = ((
      messages: AgentMessage[],
      ctx: AgentContext,
      config: AgentLoopConfig,
      signal: AbortSignal,
      stream: unknown,
    ) => {
      seen.push(stream);
      return fakeLoop([], [])(messages, ctx, config, signal, stream as unknown as StreamFn);
    }) as unknown as StageRunInput["loopFn"];
    await runBenchStage(baseInput({ loopFn: captureLoop }));
    expect(seen[0]).toBeInstanceOf(Function);
  });

  it("passes an explicit streamFn seam through untouched", async () => {
    const mine: StreamFn = async () => "mine" as unknown as ReturnType<StreamFn>;
    let seen: unknown = "unset";
    const captureLoop = ((
      messages: AgentMessage[],
      ctx: AgentContext,
      config: AgentLoopConfig,
      signal: AbortSignal,
      stream: unknown,
    ) => {
      seen = stream;
      return fakeLoop([], [])(messages, ctx, config, signal, stream as unknown as StreamFn);
    }) as unknown as StageRunInput["loopFn"];
    await runBenchStage(baseInput({ loopFn: captureLoop, streamFn: mine }));
    expect(seen).toBe(mine);
  });
});
