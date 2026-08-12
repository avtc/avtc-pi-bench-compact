// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { summarizeTrajectory, type TrajectorySummarySeams } from "../../src/judge/summarize-trajectory.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";
import type { JsonOutputTool } from "../../src/runtime/tools.js";
import { callTerminal, capturingSeams, cleanResult, OK_MODEL } from "./helpers.js";

const manifest: ScenarioManifest = {
  id: "scen-1",
  description: "incremental economic strategy game",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
  recallFacts: [],
  doneOps: [
    {
      id: "do1",
      description: "market-pricing loop (price adjusts to demand)",
      artifact: "src/economy/market.ts",
      reworkable: false,
      entryIds: ["e3"],
      lanes: [],
    },
    {
      id: "do2",
      description: "save-system prototype (later abandoned for snapshot approach)",
      artifact: "src/save/old.ts",
      reworkable: true,
      entryIds: ["e8"],
      lanes: [],
    },
  ],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "build a bounded incremental economic strategy game", testSpec: "" },
  probes: [],
};

describe("summarizeTrajectory", () => {
  it("reads the captured write_summary payload + returns the summary string", async () => {
    const { seams } = capturingSeams("write_summary", {
      summary:
        "The agent re-proposed the market-pricing loop (do1) at entry a22, then abandoned the snapshot save approach.",
    });
    const summary = await summarizeTrajectory({
      seams,
      cwd: "/repo",
      axis: "E3",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    expect(summary).toBe(
      "The agent re-proposed the market-pricing loop (do1) at entry a22, then abandoned the snapshot save approach.",
    );
  });

  it("names the terminal tool write_summary + bounds the summary to 2000 chars", async () => {
    const { seams, inputs } = capturingSeams("write_summary", { summary: "ok" });
    await summarizeTrajectory({
      seams,
      cwd: "/repo",
      axis: "E3",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    const tool = inputs[0]?.tools.find((t) => t.name === "write_summary") as JsonOutputTool | undefined;
    if (tool === undefined) throw new Error("test: write_summary tool missing");
    const summaryProp = (tool.parameters as { properties?: { summary?: { maxLength?: number } } }).properties?.summary;
    expect(summaryProp?.maxLength).toBe(2000);
  });

  it("rejects an overlong summary (>2000 chars) at the tool schema → no capture → STOP+surface", async () => {
    // The terminal tool's typebox schema rejects summary>2000 chars; the rejected
    // call does NOT accumulate, so runJsonToolStage sees no capture → no-capture error.
    const seams: TrajectorySummarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async (input: StageRunInput) => {
        callTerminal(input, "write_summary", { summary: "x".repeat(2001) });
        return cleanResult();
      },
    };
    await expect(
      summarizeTrajectory({
        seams,
        cwd: "/repo",
        axis: "E3",
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/did not call write_summary|nothing captured/);
  });

  it("E3 system prompt includes the E3 rubric + the manifest doneOps context", async () => {
    const { seams, inputs } = capturingSeams("write_summary", { summary: "summary" });
    await summarizeTrajectory({
      seams,
      cwd: "/repo",
      axis: "E3",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    const prompt = inputs[0]?.systemPrompt ?? "";
    expect(prompt).toContain("E3");
    expect(prompt).toContain("market-pricing loop");
    expect(prompt).toContain("do1");
  });

  it("E10 system prompt includes the E10 rubric + the scripted goal (taskObjective)", async () => {
    const { seams, inputs } = capturingSeams("write_summary", { summary: "summary" });
    await summarizeTrajectory({
      seams,
      cwd: "/repo",
      axis: "E10",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    const prompt = inputs[0]?.systemPrompt ?? "";
    expect(prompt).toContain("E10");
    expect(prompt).toContain("bounded incremental economic strategy game");
  });

  it("system prompt instructs the judge to inspect via read/grep/find/ls + the cwd", async () => {
    const { seams, inputs } = capturingSeams("write_summary", { summary: "summary" });
    await summarizeTrajectory({
      seams,
      cwd: "/attempt-repo",
      axis: "E10",
      manifest,
      maxTokens: 4096,
      signal: new AbortController().signal,
    });
    const prompt = inputs[0]?.systemPrompt ?? "";
    expect(prompt).toContain("/attempt-repo");
    expect(prompt).toMatch(/read|grep|find|ls/);
  });

  it("STOP+surfaces on model-unavailable", async () => {
    const seams: TrajectorySummarySeams = {
      resolveModel: async () => ({ ok: false, error: "no judge model configured" }),
      runStage: async () => cleanResult(),
    };
    await expect(
      summarizeTrajectory({
        seams,
        cwd: "/repo",
        axis: "E3",
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/model not available/);
  });

  it("STOP+surfaces when the agent never calls write_summary (no capture)", async () => {
    const seams: TrajectorySummarySeams = {
      resolveModel: async () => OK_MODEL,
      runStage: async () => cleanResult(),
    };
    await expect(
      summarizeTrajectory({
        seams,
        cwd: "/repo",
        axis: "E3",
        manifest,
        maxTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/did not call write_summary/);
  });
});
