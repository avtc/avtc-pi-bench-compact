// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  makeAddTimeValidator,
  ProbeValidationStoppedError,
  type ProbeValidationTarget,
  type ProbeValidatorAgent,
  REPORT_VERDICT_TOOL,
  runProbeValidator,
} from "../../src/manifest/probe-validate.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";

const STUB_MODEL = { id: "stub", provider: "stub" } as unknown as Model<Api>;

function stageResult(): StageRunResult {
  return {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
    outputTokens: 0,
    aborted: false,
    timedOut: false,
  };
}

const TARGET: ProbeValidationTarget = {
  kind: "latent",
  question: "what were the economy constants before recalibration?",
  accept: ["TAKE_RATE was 0.05 with OVERHEAD 0.6"],
  citedEntryIds: ["e12"],
  claimedClass: "cued",
};

const AGENT: ProbeValidatorAgent = {
  model: STUB_MODEL,
  apiKey: "key",
  thinking: null,
  maxTokens: 4096,
  timeoutMs: 120000,
};

interface CallRecord {
  input: StageRunInput;
  payloads: unknown[];
}

/** Build a fake runStage that simulates the validator agent calling report_verdict
 *  once per stage call with the scripted payloads (empty = never calls it). */
function fakeStage(script: readonly unknown[]): {
  run: typeof import("../../src/runtime/agent-loop.js").runBenchStage;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  const run = async (input: StageRunInput): Promise<StageRunResult> => {
    const record: CallRecord = { input, payloads: [] };
    calls.push(record);
    const payload = script[i++];
    if (payload !== undefined && payload !== null) {
      const tool = input.tools.find((t) => t.name === REPORT_VERDICT_TOOL) as AgentTool | undefined;
      if (!tool) throw new Error("report_verdict tool not composed");
      await tool.execute("c1", payload as Record<string, unknown>);
      record.payloads.push(payload);
    }
    return stageResult();
  };
  return { run: run as unknown as Parameters<typeof runProbeValidator>[0]["runStage"], calls };
}

describe("runProbeValidator", () => {
  it("returns ok on a clean verdict capture", async () => {
    const { run, calls } = fakeStage([{ ok: true }]);
    const v = await runProbeValidator(baseInput(run));
    expect(v).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("returns problems on a rejection verdict capture", async () => {
    const { run } = fakeStage([
      { ok: false, problems: [{ check: "tail", what: "the arc tables list 17.2% for QuantumMind" }] },
    ]);
    const v = await runProbeValidator(baseInput(run));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems[0]?.check).toBe("tail");
  });

  it("carries the probe, summary, tail, and span path into the prompt", async () => {
    const { run, calls } = fakeStage([{ ok: true }]);
    await runProbeValidator(baseInput(run));
    const system = calls[0]?.input.systemPrompt ?? "";
    const user = messagesText(calls[0]?.input.messages ?? []);
    expect(system).toContain("probe validator");
    expect(system).toContain("## Compaction summary");
    expect(system).toContain("the trial summary text");
    expect(system).toContain("## Kept tail");
    expect(system).toContain("the tail text");
    expect(user).toContain("economy constants before recalibration");
    expect(user).toContain("TAKE_RATE was 0.05");
    expect(user).toContain("cued");
    expect(user).toContain("e12");
  });

  it("retries once when the stage ends without a verdict capture, then accepts the retry's verdict", async () => {
    const { run, calls } = fakeStage([null, { ok: true }]);
    const v = await runProbeValidator(baseInput(run));
    expect(v).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const retryUser = messagesText(calls[1]?.input.messages ?? []);
    expect(retryUser).toContain("report_verdict");
  });

  it("treats ok:false with no problems as malformed (retry once, then stop)", async () => {
    const { run, calls } = fakeStage([{ ok: false }, { ok: false }]);
    await expect(runProbeValidator(baseInput(run))).rejects.toThrow(ProbeValidationStoppedError);
    expect(calls).toHaveLength(2);
  });

  it("stops after a second capture-less stage (never silently accepts)", async () => {
    const { run, calls } = fakeStage([null, null]);
    await expect(runProbeValidator(baseInput(run))).rejects.toThrow(/report_verdict/);
    expect(calls).toHaveLength(2);
  });

  it("manifest targets carry no class line; latent targets do", async () => {
    const { run, calls } = fakeStage([{ ok: true }, { ok: true }]);
    await runProbeValidator(baseInput(run));
    await runProbeValidator({ ...baseInput(run), target: { ...TARGET, kind: "manifest", claimedClass: undefined } });
    const latentUser = messagesText(calls[0]?.input.messages ?? []);
    const manifestUser = messagesText(calls[1]?.input.messages ?? "");
    expect(latentUser).toContain("cued");
    expect(manifestUser).not.toContain("claimed class");
  });
});

function baseInput(run: Parameters<typeof runProbeValidator>[0]["runStage"]): Parameters<typeof runProbeValidator>[0] {
  return {
    target: TARGET,
    summary: "the trial summary text",
    tail: "the tail text",
    repoCwd: process.cwd(),
    spanPath: "C:/tmp/span.jsonl",
    agent: AGENT,
    runStage: run,
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof runProbeValidator>[0];
}

function messagesText(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages);
}

describe("makeAddTimeValidator — live-progress hooks", () => {
  const GOOD_VERDICT = { ok: true, problems: [] };

  function hookSet(): {
    hooks: import("../../src/manifest/probe-validate.js").ValidatorHooks;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      hooks: {
        onEvent: () => calls.push("event"),
        onModelResolved: () => calls.push("window"),
        onDone: () => calls.push("done"),
      },
    };
  }

  async function runOnce(
    hooks: import("../../src/manifest/probe-validate.js").ValidatorHooks,
    stageScript: readonly unknown[],
  ): Promise<{ calls: string[]; stageCalls: CallRecord[] }> {
    const { run, calls: stageCalls } = fakeStage(stageScript);
    const validate = makeAddTimeValidator({
      kind: "latent",
      summary: "a summary",
      tail: "a tail",
      repoCwd: process.cwd(),
      spanPath: "/tmp/span.jsonl",
      seams: {
        resolveModel: async () => ({ ok: true as const, model: STUB_MODEL, apiKey: "key" }),
        runStage: run,
        hooks,
      },
      budget: { thinking: null, maxTokens: 4096, timeoutMs: 120000 },
      signal: new AbortController().signal,
    });
    await validate({ question: TARGET.question, accept: TARGET.accept, citedEntryIds: ["e12"] });
    return { calls: [], stageCalls };
  }

  it("forwards onEvent into the stage input and fires onModelResolved + onDone (verdict ok)", async () => {
    const h = hookSet();
    const { stageCalls } = await runOnce(h.hooks, [GOOD_VERDICT]);
    expect(h.calls).toEqual(["window", "done"]);
    expect(stageCalls[0]?.input.onEvent).toBe(h.hooks.onEvent);
  });

  it("onDone fires even when the validator throws (stop-and-surface path)", async () => {
    const h = hookSet();
    await expect(runOnce(h.hooks, [])).rejects.toThrow();
    expect(h.calls).toEqual(["window", "done"]);
  });

  it("null hooks (no widget) never throw", async () => {
    const { stageCalls } = await runOnce({ onEvent: null, onModelResolved: null, onDone: null }, [GOOD_VERDICT]);
    expect(stageCalls[0]?.input.onEvent).toBeNull();
  });
});
