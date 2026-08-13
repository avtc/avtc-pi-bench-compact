// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { RateLimitOptions } from "../../src/judge/rate-limit.js";
import { gradeTrajectory, type TrajectoryGrade, type TrajectorySeams } from "../../src/judge/trajectory.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { MetricId } from "../../src/metrics/defs.js";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";
import { callTerminal, capturingSeams, cleanResult, OK_MODEL } from "./helpers.js";

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
  callTerminal(input, "record_grades", payload);
}

/** Build seams: resolveModel=ok; runStage=fake that captures the payload into record_grades. */
function seamsCapturing(payload: unknown): { seams: TrajectorySeams; inputs: StageRunInput[] } {
  return capturingSeams("record_grades", payload);
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
      tracePath: "/sessions/store.jsonl",
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
      tracePath: "/sessions/store.jsonl",
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
        tracePath: "/sessions/store.jsonl",
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
        tracePath: "/sessions/store.jsonl",
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
        tracePath: "/sessions/store.jsonl",
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
        tracePath: "/sessions/store.jsonl",
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
      tracePath: "/sessions/store.jsonl",
      axes: ["E4"] as readonly MetricId[],
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
      rateLimitOptions,
    });
    expect(calls).toBe(2); // retried once after the rate-limit
    expect(grades[0]?.pass).toBe(true);
  });

  // --- R2: axis-validation (STOP+surface on judge misbehavior) ---

  it("throws when the judge returns a grade for an axis that was not requested (hallucinated)", async () => {
    const { seams } = seamsCapturing({
      grades: [
        { axis: "E4", pass: true, evidence: "" },
        { axis: "E99", pass: true, evidence: "" }, // hallucinated
      ],
    });
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        tracePath: "/sessions/store.jsonl",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unknown.*E99|E99.*unknown|unexpected.*axis/i);
  });

  it("throws when a requested axis is missing from the judge response", async () => {
    const { seams } = seamsCapturing({
      grades: [{ axis: "E4", pass: true, evidence: "" }], // E2 requested but omitted
    });
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        tracePath: "/sessions/store.jsonl",
        axes: ["E4", "E2"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/missing.*E2|E2.*missing|incomplete.*grade/i);
  });

  it("throws on duplicate axes in the judge response", async () => {
    const { seams } = seamsCapturing({
      grades: [
        { axis: "E4", pass: true, evidence: "" },
        { axis: "E4", pass: false, evidence: "" }, // duplicate
      ],
    });
    await expect(
      gradeTrajectory({
        seams,
        cwd: "/repo",
        tracePath: "/sessions/store.jsonl",
        axes: ["E4"] as readonly MetricId[],
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/duplicate.*E4|E4.*duplicate/i);
  });
});
