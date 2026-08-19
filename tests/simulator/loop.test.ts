// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";
import {
  driveUntilStop,
  extractAssistantText,
  makeDriveStop,
  nextInstruction,
  pacingDecision,
  SimulatorDriver,
  type SimulatorHooks,
  type SimulatorSeams,
} from "../../src/simulator/loop.js";

// --- pure helpers -----------------------------------------------------------

describe("pacingDecision", () => {
  it("context below boundary → continue", () => {
    expect(pacingDecision(50_000, 140_000)).toBe("continue");
  });
  it("context at/above boundary → stop (harness owns the stop)", () => {
    expect(pacingDecision(140_000, 140_000)).toBe("stop");
    expect(pacingDecision(141_000, 140_000)).toBe("stop");
  });
});

describe("nextInstruction", () => {
  it("step 0 → an opening instruction (request the first system)", () => {
    const s = nextInstruction({ step: 0 }).toLowerCase();
    expect(s).toMatch(/start|first|begin/);
  });
  it("step > 0 → a review + continue instruction", () => {
    const s = nextInstruction({ step: 3 }).toLowerCase();
    expect(s).toMatch(/review|next|continue/);
  });
  it("agentQuestion present → answer-the-question instruction (agent-asks-question path)", () => {
    const s = nextInstruction({ step: 2, agentQuestion: "Should I use a grid or list for the map?" });
    expect(s).toContain("Should I use a grid or list for the map?");
    expect(s.toLowerCase()).toMatch(/answer|as yourself|as the user/);
  });
});

describe("extractAssistantText", () => {
  it("reads the text of the last assistant message", () => {
    const msgs = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "Build the economy next." }], timestamp: 1 },
    ] as unknown as AgentMessage[];
    expect(extractAssistantText(msgs)).toBe("Build the economy next.");
  });
  it("concatenates multiple text parts of the last assistant message", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part A. " },
          { type: "text", text: "Part B." },
        ],
        timestamp: 0,
      },
    ] as unknown as AgentMessage[];
    expect(extractAssistantText(msgs)).toBe("Part A. Part B.");
  });
  it("returns '' when there is no assistant message", () => {
    const msgs = [{ role: "user", content: "hi", timestamp: 0 }] as unknown as AgentMessage[];
    expect(extractAssistantText(msgs)).toBe("");
  });
});

// --- SimulatorDriver (fake seams — no real LLM / session) -------------------

// entry fixtures (well-shaped plain objects cast to the entry union)
const eBase = (id: string) => ({ id, parentId: null as string | null, timestamp: "0" });
function eUser(id: string, text: string): SessionEntry {
  return {
    type: "message",
    ...eBase(id),
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}
function eAsst(id: string, text: string): SessionEntry {
  return {
    type: "message",
    ...eBase(id),
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function fakeStageResult(text: string) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }] as AgentMessage[],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
    outputTokens: 5,
    aborted: false,
    timedOut: false,
  };
}

function makeSeams(overrides: Partial<SimulatorSeams>): SimulatorSeams {
  return {
    getBranch: () => [],
    resolveModel: async () => ({ ok: true, model: { id: "fake" } as unknown as Model<Api>, apiKey: "k" }),
    runStage: async () => fakeStageResult("Build the next system."),
    inject: vi.fn(),
    ...overrides,
  };
}

function makeDriver(seams: SimulatorSeams, opts: { targetContext?: number; hooks?: SimulatorHooks } = {}) {
  return new SimulatorDriver({
    seams,
    systemPrompt: "SYSTEM",
    targetContext: opts.targetContext ?? 140_000,
    thinking: null,
    maxTokens: 1024,
    timeoutMs: null,
    signal: new AbortController().signal,
    hooks: opts.hooks,
  });
}

describe("SimulatorDriver", () => {
  it("threads thinking + timeoutMs into the stage input (off → null)", async () => {
    const capturedStage: { input: StageRunInput | null } = { input: null };
    const seams = makeSeams({
      runStage: async (input) => {
        capturedStage.input = input;
        return fakeStageResult("Build the next system.");
      },
    });
    const driver = new SimulatorDriver({
      seams,
      systemPrompt: "SYSTEM",
      targetContext: 140_000,
      thinking: "off",
      maxTokens: 1024,
      timeoutMs: 45000,
      signal: new AbortController().signal,
    });
    driver.trackContext(50_000);
    await driver.onAgentSettled();
    expect(capturedStage.input?.reasoning).toBeNull(); // "off" = no reasoning = null
    expect(capturedStage.input?.timeoutMs).toBe(45000);
    expect(capturedStage.input?.maxTokens).toBe(1024);
  });

  it("context < boundary → runs the stage + injects the canned reply via followUp", async () => {
    const seams = makeSeams({ runStage: async () => fakeStageResult("Build the combat system next.") });
    const driver = makeDriver(seams, { targetContext: 140_000 });
    driver.trackContext(50_000);
    await driver.onAgentSettled();
    expect(seams.inject).toHaveBeenCalledOnce();
    expect((seams.inject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("Build the combat system next.");
  });

  it("context ≥ boundary → signals stop, does NOT inject (harness captures backup)", async () => {
    const onStop = vi.fn();
    const seams = makeSeams({});
    const driver = makeDriver(seams, { targetContext: 140_000, hooks: { onStop } });
    driver.trackContext(150_000);
    await driver.onAgentSettled();
    expect(seams.inject).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop.mock.calls[0][0]).toMatchObject({ reason: "boundary" });
  });

  it("model resolution failure → stop+surface (error), no inject", async () => {
    const onStop = vi.fn();
    const seams = makeSeams({ resolveModel: async () => ({ ok: false, error: "no model" }) });
    const driver = makeDriver(seams, { hooks: { onStop } });
    driver.trackContext(10_000);
    await driver.onAgentSettled();
    expect(seams.inject).not.toHaveBeenCalled();
    expect(onStop.mock.calls[0][0]).toMatchObject({ reason: "error" });
  });

  it("agent-asks-question: the answer instruction is passed to the simulator", async () => {
    let captured: AgentMessage[] = [];
    const seams = makeSeams({
      runStage: async (input) => {
        captured = input.messages;
        return fakeStageResult("Use a grid.");
      },
    });
    const driver = makeDriver(seams);
    driver.trackContext(20_000);
    driver.setAgentQuestion("Grid or list for the map?");
    await driver.onAgentSettled();
    const body = typeof (captured[0] as UserMessage).content === "string" ? (captured[0] as UserMessage).content : "";
    expect(body).toContain("Grid or list for the map?");
    expect((seams.inject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("Use a grid.");
  });

  it("advances the step counter across cycles", async () => {
    const seams = makeSeams({});
    const driver = makeDriver(seams);
    driver.trackContext(10_000);
    await driver.onAgentSettled();
    driver.trackContext(20_000);
    await driver.onAgentSettled();
    expect(driver.step).toBe(2);
    expect(seams.inject).toHaveBeenCalledTimes(2);
  });

  it("aborted run (signal) → stop+surface, no inject", async () => {
    const onStop = vi.fn();
    const ac = new AbortController();
    const seams = makeSeams({ runStage: async () => ({ ...fakeStageResult("x"), aborted: true }) });
    const driver = new SimulatorDriver({
      seams,
      systemPrompt: "SYSTEM",
      targetContext: 100_000,
      maxTokens: 1024,
      thinking: null,
      timeoutMs: null,
      signal: ac.signal,
      hooks: { onStop },
    });
    driver.trackContext(10_000);
    await driver.onAgentSettled();
    expect(seams.inject).not.toHaveBeenCalled();
    expect(onStop.mock.calls[0][0]).toMatchObject({ reason: "error" });
  });

  it("empty reply (no assistant text) → stop+surface, does NOT inject an empty message (R2)", async () => {
    const onStop = vi.fn();
    // stage returns a result with NO assistant message
    const seams = makeSeams({
      runStage: async () => ({
        messages: [{ role: "user", content: "x", timestamp: 0 }] as AgentMessage[],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      }),
    });
    const driver = makeDriver(seams, { hooks: { onStop } });
    driver.trackContext(10_000);
    await driver.onAgentSettled();
    expect(seams.inject).not.toHaveBeenCalled();
    expect(onStop.mock.calls[0][0]).toMatchObject({ reason: "error" });
  });

  it("runStage THROWS (LLM/network/rate-limit failure) → stop+surface via onStop, no unhandled rejection", async () => {
    const onStop = vi.fn();
    const seams = makeSeams({
      runStage: async () => {
        throw new Error("upstream LLM failed");
      },
    });
    const driver = makeDriver(seams, { hooks: { onStop } });
    driver.trackContext(10_000);
    // must NOT reject — the thrown error is funneled into onStop
    await expect(driver.onAgentSettled()).resolves.toBeUndefined();
    expect(seams.inject).not.toHaveBeenCalled();
    expect(onStop.mock.calls[0][0]).toMatchObject({ reason: "error" });
    expect(onStop.mock.calls[0][0].error).toContain("upstream LLM failed");
  });

  it("full-transcript input: sees its own previous message + ALL prior agent work (real participant)", async () => {
    // cycle 1 branch: [seed, agent-resp-1]
    // cycle 2 branch: [seed, agent-resp-1, sim-msg-1, agent-resp-2]
    const branch1 = [eUser("seed", "build it"), eAsst("a1", "made the core loop")];
    const branch2 = [
      eUser("seed", "build it"),
      eAsst("a1", "made the core loop"),
      eUser("sim1", "please add a combat system"),
      eAsst("a2", "done, combat is in place now"),
    ];
    const branches = [branch1, branch2];
    let branchIdx = 0;
    const captured: string[] = [];
    const seams = makeSeams({
      getBranch: () => branches[Math.min(branchIdx++, branches.length - 1)],
      runStage: async (input) => {
        const content = (input.messages[0] as UserMessage).content;
        const body = typeof content === "string" ? content : "";
        captured.push(body);
        return fakeStageResult("ok");
      },
    });
    const driver = makeDriver(seams);
    driver.trackContext(10_000);
    await driver.onAgentSettled(); // cycle 1
    driver.trackContext(20_000);
    await driver.onAgentSettled(); // cycle 2
    // cycle 2's input is the FULL transcript: the new response AND everything
    // before it — the simulator's own previous beat + earlier agent work. A real
    // session participant keeps the whole conversation in view every call.
    expect(captured[1]).toContain("combat is in place");
    expect(captured[1]).toContain("please add a combat system"); // its own voice
    expect(captured[1]).toContain("made the core loop"); // earlier agent work
    expect(captured[1]).toContain("build it"); // the session's opening message
  });

  it("forwards onEvent to runStage + calls onModelResolved after a successful resolve", async () => {
    const events: string[] = [];
    const resolvedModels: unknown[] = [];
    const fakeEvent = { type: "message_update" } as unknown as AgentEvent;
    const seams = makeSeams({
      runStage: async (input) => {
        (input.onEvent as (e: AgentEvent) => void)?.(fakeEvent);
        return fakeStageResult("Build the next system.");
      },
    });
    const driver = new SimulatorDriver({
      seams,
      systemPrompt: "SYSTEM",
      targetContext: 140_000,
      maxTokens: 1024,
      thinking: null,
      timeoutMs: null,
      signal: new AbortController().signal,
      onEvent: (e) => {
        events.push(e.type);
      },
      onModelResolved: (m) => {
        resolvedModels.push(m);
      },
    });
    await driver.onAgentSettled();
    expect(events).toEqual(["message_update"]); // the fake event reached the onEvent sink
    expect(resolvedModels).toHaveLength(1); // onModelResolved fired after a successful resolve
  });
});

// --- driveUntilStop (the shared drive loop) ----------------------------------

/** A faithful fake driver: injects (records) on non-stop cycles; on the stopAfter-th
 * cycle fires the boundary-stop WITHOUT injecting — the real SimulatorDriver's order
 * (the pacing check precedes the inject). */
function makeFaithfulDriver(stopAfter: number, onStop: () => void) {
  let cycles = 0;
  const injects: number[] = [];
  return {
    injects,
    driver: {
      async onAgentSettled(): Promise<void> {
        cycles += 1;
        if (cycles >= stopAfter) {
          onStop(); // boundary-stop — NO inject
          return;
        }
        injects.push(cycles);
      },
    },
  };
}

describe("driveUntilStop — boundary-stop control flow (no hang)", () => {
  /** An awaitSettled faithful to the real awaitAgentSettled: it resolves only after the
   * agent was DRIVEN (an inject happened). Called when the last cycle injected nothing,
   * it would block forever — model that as a throw so a regression fails loudly instead
   * of hanging the suite. */
  function makeEventGatedAwaitSettled(injectCount: () => number) {
    let settledFor = 0;
    const calls: number[] = [];
    const awaitSettled = async (): Promise<void> => {
      calls.push(settledFor);
      if (settledFor >= injectCount()) {
        throw new Error("awaitSettled called with no pending inject — would HANG forever");
      }
      settledFor += 1;
    };
    return { awaitSettled, calls };
  }

  it("a mid-loop boundary-stop cycle (no inject) exits WITHOUT awaiting the settle", async () => {
    // stopAfter=3 → cycles 1-2 inject; cycle 3 boundary-stops (injects nothing).
    // The loop must exit after cycle 3 without calling awaitSettled again — the real
    // awaitAgentSettled is an awaitOnce one-shot that resolves only on the NEXT
    // agent_settled event, which never fires when nothing drove the agent.
    const { stop, onStop } = makeDriveStop();
    const { driver, injects } = makeFaithfulDriver(3, () => onStop({ contextTokens: 0, reason: "boundary" }));
    const { awaitSettled, calls } = makeEventGatedAwaitSettled(() => injects.length);
    await driveUntilStop({
      driver,
      stop,
      awaitSettled,
      shouldBreak: () => stop.stopped,
      makeCycleError: (error) => new Error(`cycle error: ${error ?? "unknown"}`),
    });
    expect(injects).toEqual([1, 2]); // two injecting cycles
    expect(calls).toEqual([0, 1]); // awaitSettled called once per inject — and NEVER after the stop cycle
  });

  it("a kick-off boundary-stop (continue case: already at boundary) exits WITHOUT any awaitSettled", async () => {
    // stopAfter=1 → even the kick-off cycle stops without injecting. The loop must
    // exit immediately — awaiting would hang (nothing was ever injected).
    const { stop, onStop } = makeDriveStop();
    const { driver } = makeFaithfulDriver(1, () => onStop({ contextTokens: 0, reason: "boundary" }));
    let called = 0;
    await driveUntilStop({
      driver,
      stop,
      awaitSettled: async () => {
        called += 1;
        throw new Error("awaitSettled called after a kick-off boundary-stop — would HANG forever");
      },
      shouldBreak: () => stop.stopped,
      makeCycleError: (error) => new Error(`cycle error: ${error ?? "unknown"}`),
    });
    expect(called).toBe(0);
  });

  it("the budget check (shouldBreak) still fires AFTER the await — no extra cycle past the budget", async () => {
    // The budget monitor fires DURING the agent's run (onApproachingWindow at 90% of
    // the window) while pacing-stop fires at the window — so shouldBreak must be
    // checked AFTER the settle, or a budget-reached run would inject one more cycle
    // past the budget before breaking.
    const { stop } = makeDriveStop();
    let budgetReached = false;
    let injects = 0;
    const alwaysInjectDriver = {
      async onAgentSettled(): Promise<void> {
        injects += 1;
      },
    };
    let settled = 0;
    await driveUntilStop({
      driver: alwaysInjectDriver,
      stop,
      awaitSettled: async () => {
        settled += 1;
        if (settled >= 2) budgetReached = true; // budget fires during the 2nd run
      },
      shouldBreak: () => stop.stopped || budgetReached,
      makeCycleError: (error) => new Error(`cycle error: ${error ?? "unknown"}`),
    });
    // kick-off inject + ONE more cycle after the first settle; the budget fired during
    // the 2nd settle → the loop breaks with NO 3rd cycle.
    expect(injects).toBe(2);
    expect(settled).toBe(2);
  });

  it("a cycle error-stop throws makeCycleError (never silently exits)", async () => {
    const { stop, onStop } = makeDriveStop();
    const errorDriver = {
      async onAgentSettled(): Promise<void> {
        onStop({ contextTokens: 0, reason: "error", error: "simulator stage failed" });
      },
    };
    await expect(
      driveUntilStop({
        driver: errorDriver,
        stop,
        awaitSettled: async () => {},
        shouldBreak: () => stop.stopped,
        makeCycleError: (error) => new Error(`cycle error: ${error ?? "unknown"}`),
      }),
    ).rejects.toThrow("cycle error: simulator stage failed");
  });
});

describe("SimulatorDriver — firstInstruction (plant-and-continue resume)", () => {
  it("cycle 0 uses the plant override; later cycles fall back to the pacing instruction", async () => {
    const runStage = vi.fn(async (input: { messages: { content: unknown }[] }) => {
      const content = input.messages[0].content;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      return fakeStageResult(`sim reply ${text.length}`);
    });
    const seams = makeSeams({ runStage: runStage as unknown as SimulatorSeams["runStage"] });
    const driver = new SimulatorDriver({
      seams,
      systemPrompt: "SYSTEM",
      targetContext: 140_000,
      maxTokens: 1024,
      thinking: null,
      timeoutMs: null,
      signal: new AbortController().signal,
      hooks: undefined,
      firstInstruction: "Bring up the changed-mind topic now.",
    });
    const firstInstructionCall = await captureInstruction(runStage, driver);
    expect(firstInstructionCall).toContain("Bring up the changed-mind topic now.");
    driver.trackContext(1); // still under target
    const secondInstructionCall = await captureInstruction(runStage, driver);
    expect(secondInstructionCall).not.toContain("Bring up the changed-mind");
    expect(secondInstructionCall).toContain("Review what the agent did");
  });

  async function captureInstruction(runStage: ReturnType<typeof vi.fn>, driver: SimulatorDriver): Promise<string> {
    await driver.onAgentSettled();
    const call = runStage.mock.calls.at(-1) as unknown as [{ messages: { content: unknown }[] }];
    const content = call[0].messages[0].content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
});
