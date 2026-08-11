// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  type AuthoringSeams,
  buildAuthoringSystemPrompt,
  buildAuthoringTools,
  postProcessManifest,
  runAuthoringAgent,
  type ScenarioContext,
} from "../../src/manifest/author.js";
import { AUTHORING_SYSTEM_PROMPT } from "../../src/manifest/prompt.js";
import type { AuthorOutput } from "../../src/manifest/schema.js";

const cannedAuthor: AuthorOutput = {
  recallFacts: [{ fact: "scores in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
  doneOps: [{ description: "built loop", artifact: "src/loop.ts", reworkable: false, entryIds: ["e2"] }],
  supersessions: [{ subject: "keys", oldValue: "WASD", latestValue: "arrows", entryIds: ["e3", "e4"] }],
  abstentions: [{ question: "renderer?", correctRefusal: true, entryIds: ["e5"] }],
  probes: [
    { question: "scores?", accept: ["~/.scores.json"], targets: ["e1"] }, // targets recallFact e1
    { question: "renderer?", correctRefusal: true, targets: ["e5"] }, // targets abstention e5
  ],
};

const scenarioCtx: ScenarioContext = {
  id: "tycoon-1",
  description: "AI tycoon",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build to target" },
  taskObjective: { description: "build the game", testSpec: "npm test", lane: "embedded-test" },
};

describe("postProcessManifest (pure)", () => {
  it("assigns sequential ids per condition type + merges scenario context", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    expect(m.id).toBe("tycoon-1");
    expect(m.description).toBe("AI tycoon");
    expect(m.compactionBoundary).toEqual({ phaseATokenBudget: 140000, plan: "build to target" });
    expect(m.taskObjective).toEqual({ description: "build the game", testSpec: "npm test", lane: "embedded-test" });
    expect(m.recallFacts[0].id).toBe("rf1");
    expect(m.doneOps[0].id).toBe("do1");
    expect(m.supersessions[0].id).toBe("ss1");
    expect(m.abstentions[0].id).toBe("ab1");
  });

  it("sets domain:technical on recallFacts (the only condition carrying the field per §4.5)", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    expect(m.recallFacts[0].domain).toBe("technical");
  });

  it("derives embedded lane (testSpec present) + direct-probe lane (probed) on targeted conditions", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    // recallFact e1 is targeted by a probe + scenario has embedded test → both lanes
    expect(m.recallFacts[0].lanes).toEqual(["embedded", "direct-probe"]);
    // abstention e5 is targeted by a probe → direct-probe (+ embedded, testSpec present)
    expect(m.abstentions[0].lanes).toEqual(["embedded", "direct-probe"]);
  });

  it("conditions NOT targeted by any probe get embedded-only (when testSpec present)", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    // doneOp e2 + supersession e3/e4 are NOT in any probe.targets → embedded only
    expect(m.doneOps[0].lanes).toEqual(["embedded"]);
    expect(m.supersessions[0].lanes).toEqual(["embedded"]);
  });

  it("omits embedded lane when scenario has no embedded testSpec", () => {
    const noEmbedded: ScenarioContext = {
      ...scenarioCtx,
      taskObjective: { ...scenarioCtx.taskObjective, testSpec: "" },
    };
    const m = postProcessManifest(cannedAuthor, noEmbedded);
    // recallFact e1 is targeted → direct-probe only (no embedded)
    expect(m.recallFacts[0].lanes).toEqual(["direct-probe"]);
    // doneOp e2 not targeted, no embedded → no lanes
    expect(m.doneOps[0].lanes).toEqual([]);
  });

  it("probes always get lanes=['direct-probe']", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    expect(m.probes[0].lanes).toEqual(["direct-probe"]);
    expect(m.probes[1].lanes).toEqual(["direct-probe"]);
  });

  it("numbered ids increment across multiple conditions of the same type", () => {
    const multi: AuthorOutput = {
      recallFacts: [
        { fact: "a", accept: ["a"], entryIds: ["e1"] },
        { fact: "b", accept: ["b"], entryIds: ["e2"] },
      ],
      doneOps: [],
      supersessions: [],
      abstentions: [],
      probes: [],
    };
    const m = postProcessManifest(multi, scenarioCtx);
    expect(m.recallFacts.map((r) => r.id)).toEqual(["rf1", "rf2"]);
  });
});

describe("buildAuthoringSystemPrompt", () => {
  it("substitutes the <PATH> placeholder with the JSONL path", () => {
    const p = buildAuthoringSystemPrompt({ preSlicedJsonlPath: "/tmp/sliced.jsonl" });
    expect(p).toContain("/tmp/sliced.jsonl");
    expect(p).not.toContain("<PATH>");
  });

  it("appends the knownConditions list when provided (build-mode anchors)", () => {
    const p = buildAuthoringSystemPrompt({
      preSlicedJsonlPath: "/tmp/x.jsonl",
      knownConditions: [{ name: "key-decision", entryId: "e1" }],
    });
    expect(p).toMatch(/KNOWN CONDITIONS/i);
    expect(p).toContain("e1");
    expect(p).toContain("key-decision");
  });

  it("does not append knownConditions section data when absent (extract mode)", () => {
    const p = buildAuthoringSystemPrompt({ preSlicedJsonlPath: "/tmp/x.jsonl" });
    // the prompt's guidance section "KNOWN CONDITIONS (if provided)" stays, but no data list
    expect(p.startsWith(AUTHORING_SYSTEM_PROMPT.slice(0, 50))).toBe(true);
  });
});

describe("buildAuthoringTools", () => {
  it("composes benchReadOnlyTools (read/grep/find/ls) + a write_manifest tool", () => {
    const { tools, writeManifest } = buildAuthoringTools(process.cwd());
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("write_manifest");
    expect(writeManifest.name).toBe("write_manifest");
  });

  it("write_manifest captures validated payloads on _captured", async () => {
    const { writeManifest } = buildAuthoringTools(process.cwd());
    const res = await writeManifest.execute("call1", {
      recallFacts: [{ fact: "x", accept: ["x"], entryIds: ["e1"] }],
      doneOps: [],
      supersessions: [],
      abstentions: [],
      probes: [],
    });
    expect(writeManifest._captured).toHaveLength(1);
    expect(res.terminate).toBe(true); // signals the agent to stop
  });

  it("write_manifest rejects malformed payloads (nothing captured)", async () => {
    const { writeManifest } = buildAuthoringTools(process.cwd());
    await writeManifest.execute("call1", { recallFacts: [{ fact: "x", accept: "x", entryIds: ["e1"] }] }); // accept not array
    expect(writeManifest._captured).toHaveLength(0);
  });
});

describe("runAuthoringAgent", () => {
  it("composes tools, runs the stage, reads _captured, post-processes into ScenarioManifest", async () => {
    // fake seam: runStage finds the write_manifest tool in input.tools + simulates the
    // agent calling it with the canned AuthorOutput, then returns a canned result.
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: { id: "fake" } as never, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "write_manifest");
        if (!wm) throw new Error("write_manifest tool not composed into stage");
        // simulate the agent calling write_manifest with canned data
        await wm.execute("call1", {
          recallFacts: [{ fact: "scores in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [{ question: "scores?", accept: ["~/.scores.json"], targets: ["e1"] }],
        });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 5,
          aborted: false,
          timedOut: false,
        };
      },
    };

    const manifest = await runAuthoringAgent({
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/sliced.jsonl",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
    });

    expect(manifest.recallFacts[0].fact).toBe("scores in ~/.scores.json");
    expect(manifest.recallFacts[0].id).toBe("rf1");
    expect(manifest.recallFacts[0].lanes).toEqual(["embedded", "direct-probe"]); // targeted + embedded
    expect(manifest.id).toBe("tycoon-1");
  });

  it("throws when the agent never called write_manifest (no capture)", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: { id: "fake" } as never, apiKey: "k" }),
      runStage: async () => ({
        messages: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
        outputTokens: 5,
        aborted: false,
        timedOut: false,
      }),
    };
    await expect(
      runAuthoringAgent({
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
      }),
    ).rejects.toThrow(/write_manifest/i);
  });

  it("rejects when the model cannot be resolved", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: false, error: "no model configured" }),
      runStage: async () => ({
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs: 0 },
        outputTokens: 0,
        aborted: false,
        timedOut: false,
      }),
    };
    await expect(
      runAuthoringAgent({
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
      }),
    ).rejects.toThrow(/model/i);
  });
});
