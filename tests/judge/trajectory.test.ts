// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { RateLimitOptions } from "../../src/judge/rate-limit.js";
import { gradeTrajectory, type TrajectoryGrade, type TrajectorySeams } from "../../src/judge/trajectory.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { MetricId } from "../../src/metrics/defs.js";
import type { StageRunInput, StageRunResult } from "../../src/runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../../src/runtime/model.js";
import type { JsonOutputTool } from "../../src/runtime/tools.js";

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

const manifest: ScenarioManifest = {
  id: "scen-1",
  description: "tycoon",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
  recallFacts: [
    {
      id: "rf1",
      fact: "revenue = price * units",
      accept: ["price * units"],
      entryIds: ["e1"],
      domain: "technical",
      lanes: [],
    },
  ],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "build a tycoon", testSpec: "" },
  probes: [],
};

/** Find the record_grades tool in the stage input + call its execute with the payload. */
function simulateGradesCall(input: StageRunInput, payload: unknown): void {
  const tool = input.tools.find((t) => t.name === "record_grades") as JsonOutputTool | undefined;
  if (tool === undefined) throw new Error("test fake: record_grades tool not found");
  void tool.execute("call-1", payload as Record<string, unknown>);
}

/** Build seams: resolveModel=ok; runStage=fake that captures the payload into record_grades. */
function seamsCapturing(payload: unknown): { seams: TrajectorySeams; inputs: StageRunInput[] } {
  const inputs: StageRunInput[] = [];
  const seams: TrajectorySeams = {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      inputs.push(input);
      simulateGradesCall(input, payload);
      return cleanResult();
    },
  };
  return { seams, inputs };
}

describe("gradeTrajectory", () => {
  it("reads the captured record_grades payload + returns one TrajectoryGrade per axis", async () => {
    const payload = {
      grades: [
        { axis: "E4", pass: true, evidence: "used revenue formula unprompted at entry a12" },
        { axis: "E2", pass: false, evidence: "did not redo the economy loop" },
      ],
    };
    const { seams, inputs } = seamsCapturing(payload);
    const grades = await gradeTrajectory({
      seams,
      cwd: "/repo",
      axes: ["E4", "E2"] as readonly MetricId[],
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(grades).toEqual<TrajectoryGrade[]>([
      { axis: "E4", pass: true, evidence: "used revenue formula unprompted at entry a12" },
      { axis: "E2", pass: false, evidence: "did not redo the economy loop" },
    ]);
    expect(inputs[0]?.systemPrompt).toContain("record_grades");
  });

  it("includes each axis rubric in the system prompt", async () => {
    const { seams, inputs } = seamsCapturing({ grades: [{ axis: "E4", pass: true, evidence: "" }] });
    await gradeTrajectory({
      seams,
      cwd: "/repo",
      axes: ["E4"] as readonly MetricId[],
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(inputs[0]?.systemPrompt).toContain("proactive recall"); // E4 rubric content
  });

  it("throws when the agent never called record_grades (no capture)", async () => {
    const seams: TrajectorySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(), // never calls the tool
    };
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/record_grades|no.*captured|did not call/i);
  });

  it("throws on a timed-out stage (STOP+surface, no silent partial)", async () => {
    const seams: TrajectorySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        simulateGradesCall(input, { grades: [{ axis: "E4", pass: true, evidence: "" }] });
        return { ...cleanResult(), timedOut: true };
      },
    };
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("throws on an aborted stage", async () => {
    const seams: TrajectorySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        simulateGradesCall(input, { grades: [{ axis: "E4", pass: true, evidence: "" }] });
        return { ...cleanResult(), aborted: true };
      },
    };
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("throws when the model is unavailable", async () => {
    const seams: TrajectorySeams = {
      resolveModel: async () => ({ ok: false, error: "no judge model configured" }),
      runStage: async () => cleanResult(),
    };
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/judge model|not available/i);
  });

  it("retries the stage on a rate-limit error (rate-limit-wrapped, never discards)", async () => {
    let calls = 0;
    const rateErr = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    const seams: TrajectorySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        calls += 1;
        if (calls === 1) throw rateErr; // first call rate-limited
        simulateGradesCall(input, { grades: [{ axis: "E4", pass: true, evidence: "ok" }] });
        return cleanResult();
      },
    };
    const rateLimitOptions: RateLimitOptions = {
      isRateLimit: (e) => e === rateErr,
      waitMs: 0,
      maxAttempts: 3,
      sleep: async () => {},
    };
    const grades = await gradeTrajectory({
      seams,
      cwd: "/repo",
      axes: ["E4"] as readonly MetricId[],
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
      rateLimitOptions,
    });
    expect(calls).toBe(2); // retried once after the rate-limit
    expect(grades[0]?.pass).toBe(true);
  });
});
