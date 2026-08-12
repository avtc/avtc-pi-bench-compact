// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type C2Boundary, type C2BoundarySeams, findFirstCorrectUse } from "../../src/judge/c2-boundary.js";
import type { RateLimitOptions } from "../../src/judge/rate-limit.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
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
    {
      id: "rf2",
      fact: "save path is ~/.game/save.json",
      accept: ["~/.game/save.json"],
      entryIds: ["e2"],
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

function simulateBoundaryCall(input: StageRunInput, payload: unknown): void {
  const tool = input.tools.find((t) => t.name === "report_boundary") as JsonOutputTool | undefined;
  if (tool === undefined) throw new Error("test fake: report_boundary tool not found");
  void tool.execute("call-1", payload as Record<string, unknown>);
}

function seamsCapturing(payload: unknown): { seams: C2BoundarySeams; inputs: StageRunInput[] } {
  const inputs: StageRunInput[] = [];
  const seams: C2BoundarySeams = {
    resolveModel: async () => OK_MODEL,
    runStage: async (input: StageRunInput) => {
      inputs.push(input);
      simulateBoundaryCall(input, payload);
      return cleanResult();
    },
  };
  return { seams, inputs };
}

describe("findFirstCorrectUse", () => {
  it("returns one boundary per recallFact, mapping the captured payload", async () => {
    const payload = {
      boundaries: [
        { factId: "rf1", entryId: "a12", evidence: "agent applied revenue = price * units" },
        { factId: "rf2", entryId: null, evidence: "agent never referenced the save path" },
      ],
    };
    const { seams, inputs } = seamsCapturing(payload);
    const boundaries = await findFirstCorrectUse({
      seams,
      cwd: "/repo",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(boundaries).toEqual<C2Boundary[]>([
      { factId: "rf1", firstCorrectUseEntryId: "a12" },
      { factId: "rf2", firstCorrectUseEntryId: null },
    ]);
    expect(inputs[0]?.systemPrompt).toContain("report_boundary");
  });

  it("includes each recallFact (id + fact + accept) in the system prompt", async () => {
    const { seams, inputs } = seamsCapturing({
      boundaries: [
        { factId: "rf1", entryId: "x", evidence: "" },
        { factId: "rf2", entryId: null, evidence: "" },
      ],
    });
    await findFirstCorrectUse({
      seams,
      cwd: "/repo",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(inputs[0]?.systemPrompt).toContain("rf1");
    expect(inputs[0]?.systemPrompt).toContain("revenue = price * units");
    expect(inputs[0]?.systemPrompt).toContain("rf2");
  });

  it("throws when the agent never called report_boundary (no capture)", async () => {
    const seams: C2BoundarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(),
    };
    await expect(
      findFirstCorrectUse({
        seams,
        cwd: "/repo",
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/report_boundary|no.*captured|did not call/i);
  });

  it("throws on a timed-out stage", async () => {
    const seams: C2BoundarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        simulateBoundaryCall(input, { boundaries: [{ factId: "rf1", entryId: "x", evidence: "" }] });
        return { ...cleanResult(), timedOut: true };
      },
    };
    await expect(
      findFirstCorrectUse({ seams, cwd: "/repo", manifest, maxTokens: 4096, signal: new AbortController().signal }),
    ).rejects.toThrow(/timed out/i);
  });

  it("throws on an aborted stage", async () => {
    const seams: C2BoundarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        simulateBoundaryCall(input, { boundaries: [{ factId: "rf1", entryId: "x", evidence: "" }] });
        return { ...cleanResult(), aborted: true };
      },
    };
    await expect(
      findFirstCorrectUse({ seams, cwd: "/repo", manifest, maxTokens: 4096, signal: new AbortController().signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("throws when the model is unavailable", async () => {
    const seams: C2BoundarySeams = {
      resolveModel: async () => ({ ok: false, error: "no judge model" }),
      runStage: async () => cleanResult(),
    };
    await expect(
      findFirstCorrectUse({ seams, cwd: "/repo", manifest, maxTokens: 4096, signal: new AbortController().signal }),
    ).rejects.toThrow(/judge model|not available/i);
  });

  it("retries the stage on a rate-limit error (rate-limit-wrapped)", async () => {
    let calls = 0;
    const rateErr = Object.assign(new Error("429"), { status: 429 });
    const seams: C2BoundarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input) => {
        calls += 1;
        if (calls === 1) throw rateErr;
        simulateBoundaryCall(input, { boundaries: [{ factId: "rf1", entryId: "x", evidence: "" }] });
        return cleanResult();
      },
    };
    const rateLimitOptions: RateLimitOptions = {
      isRateLimit: (e) => e === rateErr,
      waitMs: 0,
      maxAttempts: 3,
      sleep: async () => {},
    };
    const boundaries = await findFirstCorrectUse({
      seams,
      cwd: "/repo",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
      rateLimitOptions,
    });
    expect(calls).toBe(2);
    expect(boundaries[0]?.firstCorrectUseEntryId).toBe("x");
  });

  it("returns an empty array when the manifest has no recallFacts", async () => {
    const seams: C2BoundarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(),
    };
    const emptyManifest: ScenarioManifest = { ...manifest, recallFacts: [] };
    const boundaries = await findFirstCorrectUse({
      seams,
      cwd: "/repo",
      manifest: emptyManifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(boundaries).toEqual([]);
  });
});
