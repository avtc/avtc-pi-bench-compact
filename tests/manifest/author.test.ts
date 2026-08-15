// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { RateLimitOptions } from "../../src/judge/rate-limit.js";
import {
  type AuthoringSeams,
  buildAuthoringTools,
  postProcessManifest,
  runAuthoringAgent,
  type ScenarioContext,
  sanitizeCitations,
} from "../../src/manifest/author.js";
import type { AuthorOutput } from "../../src/manifest/schema.js";

/** Minimal stand-in for a resolved bench model (only `id` is read by the seams). */
const FAKE_MODEL: Model<Api> = { id: "fake" } as unknown as Model<Api>;

const cannedAuthor: AuthorOutput = {
  recallFacts: [{ fact: "scores in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
  doneOps: [{ description: "built loop", artifact: "src/loop.ts", reworkable: false, entryIds: ["e2"] }],
  supersessions: [{ subject: "keys", oldValue: "WASD", latestValue: "arrows", entryIds: ["e3", "e4"] }],
  abstentions: [{ question: "renderer?", correctRefusal: true, entryIds: ["e5"] }],
  probes: [
    { question: "scores?", accept: ["~/.scores.json"], targets: ["e1"] }, // targets recallFact e1
    { question: "renderer?", correctRefusal: true, targets: ["e5"] }, // targets abstention e5
  ],
  taskObjective: { description: "build the game", testSpec: "npm test" },
};

const scenarioCtx: ScenarioContext = {
  id: "tycoon-1",
  description: "AI tycoon",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build to target" },
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

  it("sets domain:technical on recallFacts (the only condition carrying the field per)", () => {
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

  it("omits embedded lane when the authored taskObjective has no testSpec", () => {
    const noTestSpec: AuthorOutput = {
      ...cannedAuthor,
      taskObjective: { ...cannedAuthor.taskObjective, testSpec: "" },
    };
    const m = postProcessManifest(noTestSpec, scenarioCtx);
    // recallFact e1 is targeted → direct-probe only (no embedded)
    expect(m.recallFacts[0].lanes).toEqual(["direct-probe"]);
    // doneOp e2 not targeted, no embedded → no lanes
    expect(m.doneOps[0].lanes).toEqual([]);
    // taskObjective is discovered from the author output (description + testSpec), lane set by harness
    expect(m.taskObjective).toEqual({ description: "build the game", testSpec: "" }); // no testSpec → no lane
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
      taskObjective: { description: "x", testSpec: "npm test" },
    };
    const m = postProcessManifest(multi, scenarioCtx);
    expect(m.recallFacts.map((r) => r.id)).toEqual(["rf1", "rf2"]);
  });
});

describe("buildAuthoringTools", () => {
  it("composes read-only core tools (read/grep/find/ls) + bash + a write_manifest tool", () => {
    const { tools, writeManifest } = buildAuthoringTools(process.cwd());
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("bash"); // bash for JSONL parsing (jq)
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
      taskObjective: { description: "x", testSpec: "npm test" },
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
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
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
          taskObjective: { description: "build the game", testSpec: "npm test" },
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
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
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

  it("throws when the stage timed out (even if write_manifest left a capture)", async () => {
    // a timed-out stage that left a partial capture must NOT be silently post-processed
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "write_manifest");
        if (!wm) throw new Error("write_manifest not composed");
        await wm.execute("call1", {
          recallFacts: [{ fact: "partial", accept: ["partial"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [],
          taskObjective: { description: "x", testSpec: "npm test" },
        });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 5,
          aborted: false,
          timedOut: true, // per-turn timeout fired
        };
      },
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
    ).rejects.toThrow(/timed.?out|timeout/i);
  });

  it("throws when the stage was aborted (run signal) even with a capture", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "write_manifest");
        if (!wm) throw new Error("write_manifest not composed");
        await wm.execute("call1", {
          recallFacts: [{ fact: "partial", accept: ["partial"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [],
          taskObjective: { description: "x", testSpec: "npm test" },
        });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 5,
          aborted: true, // run-signal abort (not timeout)
          timedOut: false,
        };
      },
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
    ).rejects.toThrow(/abort/i);
  });

  it("takes the LAST capture when write_manifest was called multiple times", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "write_manifest");
        if (!wm) throw new Error("write_manifest not composed");
        // first (superseded) call
        await wm.execute("c1", {
          recallFacts: [{ fact: "first", accept: ["first"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [],
          taskObjective: { description: "x", testSpec: "npm test" },
        });
        // second (final) call — this is what the agent settled on
        await wm.execute("c2", {
          recallFacts: [{ fact: "second-final", accept: ["second-final"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [],
          taskObjective: { description: "x", testSpec: "npm test" },
        });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2, elapsedMs: 2 },
          outputTokens: 5,
          aborted: false,
          timedOut: false,
        };
      },
    };
    const manifest = await runAuthoringAgent({
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/x.jsonl",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
    });
    expect(manifest.recallFacts[0].fact).toBe("second-final");
  });

  // R3: the authoring stage is rate-limit-wrapped via runJsonToolStage; the
  // caller can tune/opt-out via RunAuthoringAgentDeps.rateLimitOptions (parity
  // with trajectory/c2). This is a DELIBERATE behavior addition (the refactor
  // routed authoring through the rate-limit-wrapped stage-runner), not a silent
  // change — surfaced + tunable here.
  it("threads rateLimitOptions so a rate-limited authoring stage retries (R3)", async () => {
    let calls = 0;
    const rateErr = Object.assign(new Error("429"), { status: 429 });
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        calls += 1;
        if (calls === 1) throw rateErr;
        const wm = input.tools.find((t) => t.name === "write_manifest");
        if (!wm) throw new Error("write_manifest not composed");
        await wm.execute("call1", {
          recallFacts: [{ fact: "f", accept: ["a"], entryIds: ["e1"] }],
          doneOps: [],
          supersessions: [],
          abstentions: [],
          probes: [],
          taskObjective: { description: "x", testSpec: "npm test" },
        });
        return {
          messages: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 1,
          aborted: false,
          timedOut: false,
        };
      },
    };
    const rateLimitOptions: RateLimitOptions = {
      isRateLimit: (e) => e === rateErr,
      waitMs: 0,
      maxAttempts: 3,
      sleep: async () => {},
    };
    const manifest = await runAuthoringAgent({
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/x.jsonl",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
      rateLimitOptions,
    });
    expect(calls).toBe(2); // retried once after the rate-limit
    expect(manifest.recallFacts[0]?.fact).toBe("f");
  });
});

describe("sanitizeCitations", () => {
  const base = {
    id: "sc1",
    description: "d",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
    taskObjective: { description: "b", testSpec: "npm test", lane: "embedded-test" as const },
  };
  const span = new Set(["e1", "e2", "e3"]);

  it("drops hallucinated citation ids + conditions left with no anchors + orphaned probes", () => {
    const m = {
      ...base,
      recallFacts: [
        { id: "rf1", fact: "f1", accept: ["a"], entryIds: ["e1", "ghost9"], domain: "technical" as const, lanes: [] },
        {
          id: "rf2",
          fact: "f2",
          accept: ["b"],
          entryIds: ["ghost1", "ghost2"],
          domain: "technical" as const,
          lanes: [],
        },
      ],
      doneOps: [{ id: "do1", description: "d", artifact: "a", reworkable: false, entryIds: ["e2"], lanes: [] }],
      supersessions: [],
      abstentions: [],
      probes: [
        { question: "q1?", accept: ["a"], targets: ["e1"], lanes: ["direct-probe" as const] },
        { question: "q2?", accept: ["b"], targets: ["ghost1"], lanes: ["direct-probe" as const] },
      ],
    } as unknown as import("../../src/manifest/schema.js").ScenarioManifest;
    const clean = sanitizeCitations(m, span);
    expect(clean.recallFacts.map((r) => r.id)).toEqual(["rf1"]); // rf2 fully hallucinated → dropped
    expect(clean.recallFacts[0]?.entryIds).toEqual(["e1"]); // ghost id stripped
    expect(clean.probes.map((p2) => p2.question)).toEqual(["q1?"]); // orphaned probe dropped
    expect(clean.doneOps).toHaveLength(1);
  });

  it("keeps a fully-valid manifest untouched (no drops logged, same lists)", () => {
    const m = {
      ...base,
      recallFacts: [
        { id: "rf1", fact: "f", accept: ["a"], entryIds: ["e1", "e3"], domain: "technical" as const, lanes: [] },
      ],
      doneOps: [{ id: "do1", description: "d", artifact: "a", reworkable: false, entryIds: ["e2"], lanes: [] }],
      supersessions: [],
      abstentions: [],
      probes: [{ question: "q?", accept: ["a"], targets: ["e1"], lanes: ["direct-probe" as const] }],
    } as unknown as import("../../src/manifest/schema.js").ScenarioManifest;
    expect(sanitizeCitations(m, span)).toEqual(m);
  });
});
