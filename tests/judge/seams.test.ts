import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { BenchConfig } from "../../src/config/types.js";
import {
  buildCallJudge,
  buildJudgeEnsemble,
  buildStageSeams,
  defaultJudgeTransport,
  type JudgeTransport,
  judgeSpecs,
} from "../../src/judge/seams.js";
import type { CallJudge } from "../../src/judge/single-call.js";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../../src/runtime/model.js";

/** A bench config factory for judge-ensemble tests (only the judge fields matter). */
function config(judgesNumber: 1 | 3): BenchConfig {
  return {
    evaluatedModel: null,
    evaluatedThinkingLevel: "high",
    N: 1,
    compactionBoundary: 140_000,
    fastEval: "off",
    latentProbes: "off",
    scenario: null,
    outputDir: null,
    armBarePiEnabled: true,
    armOmDefaultEnabled: false,
    armMemkeeperObservationsRootEnabled: false,
    armMemkeeperSelectedRootEnabled: false,
    armOmFullEnabled: false,
    omFullReflectionThresholdTokens: 4000,
    armsEnabled: ["A1"],
    judgeModel: "p1/m1",
    judgeThinkingLevel: "high",
    judgesNumber,
    judge2Model: "p2/m2",
    judge2ThinkingLevel: "medium",
    judge3Model: "p3/m3",
    judge3ThinkingLevel: "low",
  };
}

/** A fake ctx (the resolveModel seam ignores it; only the type must hold). */
const FAKE_CTX = {} as ExtensionContext;

/** A resolved-model ok value (the model object is opaque to the seams). */
const OK_MODEL: ResolvedBenchModel = { ok: true, model: {} as unknown as StageRunInput["model"], apiKey: "key" };

/** A clean StageRunResult carrying one assistant message. */
function stageResult(text: string): StageRunResult {
  const messages: AgentMessage[] = [
    { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage,
  ];
  return { messages, usage: makeUsage(), outputTokens: 1, aborted: false, timedOut: false };
}

function makeUsage(): StageRunResult["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs: 0 };
}

/** Build a transport with injectable resolve/run seams (capture the run input). */
function transport(resolve: ResolvedBenchModel, run: StageRunResult, captured: StageRunInput[] | null): JudgeTransport {
  return {
    resolveModel: async () => resolve,
    runStage: async (input: StageRunInput) => {
      if (captured !== null) captured.push(input);
      return run;
    },
    ctx: FAKE_CTX,
    maxTokens: 4096,
    signal: new AbortController().signal,
    rateLimitOptions: null,
  };
}

describe("judgeSpecs", () => {
  it("K=1 returns only judge1", () => {
    const specs = judgeSpecs(config(1));
    expect(specs).toEqual([{ model: "p1/m1", reasoning: "high" }]);
  });

  it("K=3 returns judge1/2/3 in order", () => {
    const specs = judgeSpecs(config(3));
    expect(specs).toEqual([
      { model: "p1/m1", reasoning: "high" },
      { model: "p2/m2", reasoning: "medium" },
      { model: "p3/m3", reasoning: "low" },
    ]);
  });
});

describe("buildCallJudge", () => {
  it("resolves the model, runs a 1-turn no-tools stage, returns the assistant text", async () => {
    const captured: StageRunInput[] = [];
    const callJudge: CallJudge = buildCallJudge(
      { model: "p1/m1", reasoning: "high" },
      transport(OK_MODEL, stageResult("the answer"), captured),
    );
    const text = await callJudge("sys", "user content");
    expect(text).toBe("the answer");
    // exactly one stage run; no tools; one user message; maxTurns=1
    expect(captured).toHaveLength(1);
    const run0 = captured[0];
    expect(run0).toBeDefined();
    if (run0 === undefined) return;
    expect(run0.tools).toEqual([]);
    expect(run0.maxTurns).toBe(1);
    expect(run0.systemPrompt).toBe("sys");
    expect(run0.messages[0]).toMatchObject({ role: "user", content: "user content" });
    expect(run0.reasoning).toBe("high");
  });

  it("forwards transport.onEvent to runStage + fires onModelResolved after resolve", async () => {
    const events: string[] = [];
    const resolvedWindows: unknown[] = [];
    const fakeEvent = { type: "message_update" } as unknown as AgentEvent;
    const captured: StageRunInput[] = [];
    const callJudge = buildCallJudge(
      { model: "p/m", reasoning: "high" },
      {
        resolveModel: async () => ({
          ok: true,
          model: { id: "m", contextWindow: 200000 } as unknown as StageRunInput["model"],
          apiKey: "k",
        }),
        runStage: async (input) => {
          captured.push(input);
          (input.onEvent as (e: unknown) => void)?.(fakeEvent);
          return stageResult("answer");
        },
        ctx: FAKE_CTX,
        maxTokens: 4096,
        signal: new AbortController().signal,
        rateLimitOptions: null,
        onEvent: (e) => {
          events.push((e as { type: string }).type);
        },
        onModelResolved: (m) => {
          resolvedWindows.push((m as { contextWindow?: number }).contextWindow);
        },
      },
    );
    await callJudge("sys", "u");
    expect(events).toEqual(["message_update"]); // transport.onEvent reached runStage's onEvent
    expect(resolvedWindows).toEqual([200000]); // onModelResolved fired with the resolved model's window
    expect(captured[0]?.onEvent).toBeDefined();
  });

  it("throws BenchJudgeError(model-unavailable) when the model does not resolve", async () => {
    const callJudge = buildCallJudge(
      { model: "bad/m", reasoning: "high" },
      transport({ ok: false, error: "not found" }, stageResult("x"), null),
    );
    await expect(callJudge("sys", "u")).rejects.toMatchObject({
      name: "BenchJudgeError",
      category: "model-unavailable",
    });
  });

  it("throws BenchJudgeError(timeout) when the stage times out", async () => {
    const run = { ...stageResult("x"), timedOut: true };
    const callJudge = buildCallJudge({ model: "p/m", reasoning: "high" }, transport(OK_MODEL, run, null));
    await expect(callJudge("sys", "u")).rejects.toMatchObject({
      name: "BenchJudgeError",
      category: "timeout",
    });
  });

  it("throws BenchJudgeError(aborted) when the stage is aborted (not timed out)", async () => {
    const run = { ...stageResult("x"), aborted: true };
    const callJudge = buildCallJudge({ model: "p/m", reasoning: "high" }, transport(OK_MODEL, run, null));
    await expect(callJudge("sys", "u")).rejects.toMatchObject({
      name: "BenchJudgeError",
      category: "aborted",
    });
  });
});

describe("buildStageSeams", () => {
  it("resolveModel delegates to the transport with the spec model; runStage delegates to the transport", async () => {
    let resolvedSetting: string | null = "unset";
    const t: JudgeTransport = {
      resolveModel: async (_ctx, setting) => {
        resolvedSetting = setting;
        return OK_MODEL;
      },
      runStage: async () => stageResult("s"),
      ctx: FAKE_CTX,
      maxTokens: 4096,
      signal: new AbortController().signal,
    };
    const seams: JsonToolStageSeams = buildStageSeams({ model: "p/xyz", reasoning: "high" }, t);
    const resolved = await seams.resolveModel();
    expect(resolved).toBe(OK_MODEL);
    expect(resolvedSetting).toBe("p/xyz");
    // runStage is the transport's runStage (identity passthrough)
    expect(seams.runStage).toBe(t.runStage);
  });
});

describe("buildJudgeEnsemble", () => {
  it("K=1 builds one callJudge + one stageSeams", () => {
    const t = transport(OK_MODEL, stageResult("a"), null);
    const ens = buildJudgeEnsemble(config(1), t);
    expect(ens.callJudges).toHaveLength(1);
    expect(ens.stageSeams).toHaveLength(1);
  });

  it("K=3 builds three callJudges + three stageSeams (judge1/2/3)", async () => {
    const captured: StageRunInput[] = [];
    const t = transport(OK_MODEL, stageResult("a"), captured);
    const ens = buildJudgeEnsemble(config(3), t);
    expect(ens.callJudges).toHaveLength(3);
    expect(ens.stageSeams).toHaveLength(3);
    // each judge's resolveModel is per-spec (judge1/2/3 models); verify judge2 resolves its model
    const judge2Seams = ens.stageSeams[1];
    expect(judge2Seams).toBeDefined();
    if (judge2Seams === undefined) return;
    const resolved = await judge2Seams.resolveModel();
    expect(resolved).toBe(OK_MODEL); // the fake ignores the setting, but the call must not throw
    // exercise all three callJudges
    const out = await Promise.all(ens.callJudges.map((c) => c("s", "u")));
    expect(out).toEqual(["a", "a", "a"]);
    expect(captured).toHaveLength(3); // three independent runs
  });
});

describe("defaultJudgeTransport", () => {
  it("uses the real resolveBenchModel + runBenchStage + threads ctx/maxTokens/signal", () => {
    const t = defaultJudgeTransport(FAKE_CTX, {
      maxTokens: 8192,
      signal: new AbortController().signal,
      rateLimitOptions: null,
    });
    expect(t.ctx).toBe(FAKE_CTX);
    expect(t.maxTokens).toBe(8192);
    expect(t.rateLimitOptions).toBeNull();
    // resolveModel + runStage are the real functions (function identities)
    expect(typeof t.resolveModel).toBe("function");
    expect(typeof t.runStage).toBe("function");
  });
});
