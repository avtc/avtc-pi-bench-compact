// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { RateLimitOptions } from "../../src/judge/rate-limit.js";
import {
  type AuthoringSeams,
  buildAuthoringTools,
  dropConflictedFindings,
  postProcessManifest,
  runAuthoringAgent,
  type ScenarioContext,
  sanitizeCitations,
} from "../../src/manifest/author.js";
import type { AuthorOutput, ScenarioManifest } from "../../src/manifest/schema.js";
import type { StageRunInput } from "../../src/runtime/agent-loop.js";

/** Minimal stand-in for a resolved bench model (only `id` is read by the seams). */
const FAKE_MODEL: Model<Api> = { id: "fake" } as unknown as Model<Api>;

const cannedAuthor: AuthorOutput = {
  recallFacts: [{ fact: "scores in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
  doneOps: [{ description: "built loop", artifact: "src/loop.ts", reworkable: false, entryIds: ["e2"] }],
  supersessions: [{ subject: "keys", oldValue: "WASD", latestValue: "arrows", entryIds: ["e3", "e4"] }],
  abstentions: [{ question: "renderer?", correctRefusal: true, entryIds: ["e5"] }],
  probes: [
    { question: "scores?", accept: ["~/.scores.json"], targets: ["e1"] }, // targets recallFact e1
    { question: "renderer?", correctRefusal: true, face: "refuse", targets: ["e5"] }, // targets abstention e5
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
  it("composes read-only core tools + bash + five per-item tools + finalize_manifest", () => {
    const { tools, finalizeManifest } = buildAuthoringTools(process.cwd(), () => {}, null);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("bash");
    expect(names).toContain("add_recall_fact");
    expect(names).toContain("add_done_op");
    expect(names).toContain("add_supersession");
    expect(names).toContain("add_abstention");
    expect(names).toContain("add_probe");
    expect(names).toContain("finalize_manifest");
    expect(finalizeManifest.name).toBe("finalize_manifest");
  });

  it("per-item tools accumulate validated items; onAdd fires with live counts per accepted item", async () => {
    const counts: { recallFacts: number; doneOps: number; supersessions: number; abstentions: number }[] = [];
    const { tools } = buildAuthoringTools(process.cwd(), (c) => counts.push({ ...c }), null);
    const add = (name: string) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`no ${name}`);
      return t;
    };
    const r1 = await add("add_recall_fact").execute("c1", {
      fact: "scores in ~/.scores.json",
      accept: ["~/.scores.json"],
      entryIds: ["e1"],
    });
    expect(JSON.stringify(r1?.content)).toContain("recorded"); // accepted
    await add("add_probe").execute("c2", {
      question: "scores?",
      accept: ["~/.scores.json"],
      targets: ["e1"],
    });
    // malformed item rejected, not accumulated, counts unchanged
    const r3 = await add("add_recall_fact").execute("c3", { fact: "x", accept: "not-array", entryIds: ["e1"] });
    expect(JSON.stringify(r3?.content)).toContain("rejected");
    expect(counts).toEqual([
      { recallFacts: 1, doneOps: 0, supersessions: 0, abstentions: 0 },
      { recallFacts: 1, doneOps: 0, supersessions: 0, abstentions: 0 }, // probe add → same condition counts
    ]);
  });
});

describe("runAuthoringAgent", () => {
  it("composes tools, runs the stage, accumulates per-item tools + finalize capture into ScenarioManifest", async () => {
    // fake seam: runStage finds the tools in input.tools + simulates the agent
    // agent calling it with the canned AuthorOutput, then returns a canned result.
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const byName = (n: string) => {
          const t = input.tools.find((x) => x.name === n);
          if (!t) throw new Error(`${n} tool not composed into stage`);
          return t;
        };
        // simulate the agent recording its findings progressively, then finalizing
        await byName("add_recall_fact").execute("call1", {
          fact: "scores in ~/.scores.json",
          accept: ["~/.scores.json"],
          entryIds: ["e1"],
        });
        await byName("add_probe").execute("call2", {
          question: "scores?",
          accept: ["~/.scores.json"],
          targets: ["e1"],
        });
        await byName("finalize_manifest").execute("call3", {
          description: "build the game",
          testSpec: "npm test",
        });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 5,
          aborted: false,
          timedOut: false,
          finalContextTokens: 0,
        };
      },
    };

    const manifest = await runAuthoringAgent({
      onAdd: () => {},
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/sliced.jsonl",
      fullJsonlPath: "/tmp/backup.jsonl",
      tailStartsAtEntryId: "tail-start",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
      thinking: null,
      timeoutMs: 120000,
    });

    expect(manifest.recallFacts[0].fact).toBe("scores in ~/.scores.json");
    expect(manifest.recallFacts[0].id).toBe("rf1");
    expect(manifest.recallFacts[0].lanes).toEqual(["embedded", "direct-probe"]); // targeted + embedded
    expect(manifest.id).toBe("tycoon-1");
  });

  it("throws when the agent never called finalize_manifest (no capture)", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async () => ({
        messages: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
        outputTokens: 5,
        aborted: false,
        timedOut: false,
        finalContextTokens: 0,
      }),
    };
    await expect(
      runAuthoringAgent({
        onAdd: () => {},
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        fullJsonlPath: "/tmp/x-full.jsonl",
        tailStartsAtEntryId: "tail-start",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/finalize_manifest/i);
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
        finalContextTokens: 0,
      }),
    };
    await expect(
      runAuthoringAgent({
        onAdd: () => {},
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        fullJsonlPath: "/tmp/x-full.jsonl",
        tailStartsAtEntryId: "tail-start",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/model/i);
  });

  it("throws when the stage timed out (even if finalize_manifest left a capture)", async () => {
    // a timed-out stage that left a partial capture must NOT be silently post-processed
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "finalize_manifest");
        if (!wm) throw new Error("finalize_manifest not composed");
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
          timedOut: true,
          finalContextTokens: 0, // per-turn timeout fired
        };
      },
    };
    await expect(
      runAuthoringAgent({
        onAdd: () => {},
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        fullJsonlPath: "/tmp/x-full.jsonl",
        tailStartsAtEntryId: "tail-start",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/timed.?out|timeout/i);
  });

  it("throws when the stage was aborted (run signal) even with a capture", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "finalize_manifest");
        if (!wm) throw new Error("finalize_manifest not composed");
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
          finalContextTokens: 0,
        };
      },
    };
    await expect(
      runAuthoringAgent({
        onAdd: () => {},
        seams: fakeSeams,
        cwd: process.cwd(),
        preSlicedJsonlPath: "/tmp/x.jsonl",
        fullJsonlPath: "/tmp/x-full.jsonl",
        tailStartsAtEntryId: "tail-start",
        scenarioCtx,
        signal: new AbortController().signal,
        maxTokens: 2000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("takes the LAST capture when finalize_manifest was called multiple times", async () => {
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const wm = input.tools.find((t) => t.name === "finalize_manifest");
        if (!wm) throw new Error("finalize_manifest not composed");
        // per-item conditions accumulate once; finalize called twice — the LAST
        // task objective wins (items are not duplicated)
        const add = input.tools.find((t) => t.name === "add_recall_fact");
        if (!add) throw new Error("add_recall_fact not composed");
        await add.execute("c0", { fact: "second-final", accept: ["second-final"], entryIds: ["e1"] });
        await wm.execute("c1", { description: "first draft", testSpec: "npm test" });
        await wm.execute("c2", { description: "second-final", testSpec: "npm test" });
        return {
          messages: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2, elapsedMs: 2 },
          outputTokens: 5,
          aborted: false,
          timedOut: false,
          finalContextTokens: 0,
        };
      },
    };
    const manifest = await runAuthoringAgent({
      onAdd: () => {},
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/x.jsonl",
      fullJsonlPath: "/tmp/x-full.jsonl",
      tailStartsAtEntryId: "tail-start",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(manifest.recallFacts[0]?.fact).toBe("second-final"); // accumulated ONCE (not per finalize)
    expect(manifest.taskObjective.description).toBe("second-final"); // LAST finalize wins
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
        const wm = input.tools.find((t) => t.name === "finalize_manifest");
        if (!wm) throw new Error("finalize_manifest not composed");
        const add = input.tools.find((t) => t.name === "add_recall_fact");
        if (!add) throw new Error("add_recall_fact not composed");
        await add.execute("call0", { fact: "f", accept: ["a"], entryIds: ["e1"] });
        await wm.execute("call1", { description: "x", testSpec: "npm test" });
        return {
          messages: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 1,
          aborted: false,
          timedOut: false,
          finalContextTokens: 0,
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
      onAdd: () => {},
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/x.jsonl",
      fullJsonlPath: "/tmp/x-full.jsonl",
      tailStartsAtEntryId: "tail-start",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2000,
      thinking: null,
      timeoutMs: 120000,
      rateLimitOptions,
    });
    expect(calls).toBe(2); // retried once after the rate-limit
    expect(manifest.recallFacts[0]?.fact).toBe("f");
  });

  it("threads thinking (off → null), maxTokens + timeoutMs into the stage input", async () => {
    const capturedStage: { input: StageRunInput | null } = { input: null };
    const fakeSeams: AuthoringSeams = {
      resolveModel: async () => ({ ok: true, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        capturedStage.input = input;
        const finalize = input.tools.find((t) => t.name === "finalize_manifest");
        if (finalize) {
          await finalize.execute("call1", { description: "d", testSpec: "t" });
        }
        return {
          messages: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, elapsedMs: 1 },
          outputTokens: 1,
          aborted: false,
          timedOut: false,
          finalContextTokens: 0,
        };
      },
    };
    await runAuthoringAgent({
      onAdd: () => {},
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/sliced.jsonl",
      fullJsonlPath: "/tmp/backup.jsonl",
      tailStartsAtEntryId: "tail-start",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2048,
      thinking: "off",
      timeoutMs: 45678,
    });
    expect(capturedStage.input?.reasoning).toBeNull(); // "off" = no reasoning = null
    expect(capturedStage.input?.maxTokens).toBe(2048);
    expect(capturedStage.input?.timeoutMs).toBe(45678);

    // a real level passes through unchanged
    await runAuthoringAgent({
      onAdd: () => {},
      seams: fakeSeams,
      cwd: process.cwd(),
      preSlicedJsonlPath: "/tmp/sliced.jsonl",
      fullJsonlPath: "/tmp/backup.jsonl",
      tailStartsAtEntryId: "tail-start",
      scenarioCtx,
      signal: new AbortController().signal,
      maxTokens: 2048,
      thinking: "high",
      timeoutMs: 45678,
    });
    expect(capturedStage.input?.reasoning).toBe("high");
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

describe("tail conflicts (author-side tail validation)", () => {
  it("buildAuthoringTools includes add_tail_conflict (validated accumulation)", async () => {
    const { tools } = buildAuthoringTools(process.cwd(), () => {}, null);
    expect(tools.find((t) => t.name === "add_tail_conflict")).toBeDefined();
  });

  it("postProcessManifest carries authored tailConflicts into the manifest", () => {
    const manifest = postProcessManifest(
      {
        ...cannedAuthor,
        tailConflicts: [{ entryIds: ["e1"], kind: "answerable" }],
      },
      scenarioCtx,
    );
    expect(manifest.tailConflicts).toEqual([{ entryIds: ["e1"], kind: "answerable" }]);
  });

  it("postProcessManifest omits the field when none were authored", () => {
    const manifest = postProcessManifest(cannedAuthor, scenarioCtx);
    expect(manifest.tailConflicts).toBeUndefined();
  });

  it("sanitizeCitations keeps resolvable conflict ids, drops conflicts with none", () => {
    const base = postProcessManifest(
      { ...cannedAuthor, tailConflicts: [{ entryIds: ["e1", "ghost"], kind: "superseded" }] },
      scenarioCtx,
    );
    const cleaned = sanitizeCitations(base, new Set(["e1", "e2", "e3", "e4", "e5"]));
    expect(cleaned.tailConflicts).toEqual([{ entryIds: ["e1"], kind: "superseded" }]);
    const emptied = sanitizeCitations(base, new Set(["e2", "e3", "e4", "e5"])); // e1 unresolvable → conflict dropped (field absent)
    expect(emptied.tailConflicts).toBeUndefined();
  });
});

describe("dropConflictedFindings (tail-conflict filtering, not auto-continue)", () => {
  const withConflicts: ScenarioManifest = {
    ...postProcessManifest(
      {
        ...cannedAuthor,
        tailConflicts: [
          { entryIds: ["e1"], kind: "answerable" }, // recallFact rf1 — tail gives it away
          { entryIds: ["e3"], kind: "superseded" }, // supersession ss1 — tail changed the value
        ],
      },
      scenarioCtx,
    ),
  };

  it("drops conflicted conditions + every probe citing them, keeps unconflicted ones", () => {
    const m = dropConflictedFindings(withConflicts);
    expect(m.recallFacts).toHaveLength(0); // rf1 conflicted
    expect(m.supersessions).toHaveLength(0); // ss1 conflicted
    expect(m.doneOps).toHaveLength(1); // do1 clean
    expect(m.abstentions).toHaveLength(1); // ab1 clean
    // probes: "scores?" targets e1 (conflicted) → dropped; "renderer?" targets e5 → kept
    expect(m.probes).toHaveLength(1);
    expect(m.probes[0]?.question).toBe("renderer?");
    expect(m.tailConflicts).toBeUndefined(); // conflicts consumed
  });

  it("is a no-op (same reference) when no conflicts were reported", () => {
    const m = postProcessManifest(cannedAuthor, scenarioCtx);
    expect(dropConflictedFindings(m)).toBe(m);
  });
});

describe("buildAuthoringTools — supersessionId guards (add-time + finalize)", () => {
  const toolsOf = () => buildAuthoringTools(process.cwd(), () => {}, null);
  const byName = (ts: readonly { name: string }[], n: string) => {
    const t = ts.find((x) => x.name === n);
    if (!t) throw new Error(`${n} tool not composed`);
    return t as AgentTool;
  };
  const ssItem = (subject: string) => ({
    subject,
    oldValue: "WASD",
    latestValue: "arrows",
    entryIds: ["e3"],
  });
  const text = (r: unknown): string => JSON.stringify(r);

  it("add_supersession assigns + echoes sequential ids (ss1, ss2)", async () => {
    const { tools, acc } = toolsOf();
    const r1 = await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    expect(text(r1?.content)).toContain("recorded add_supersession as ss1");
    const r2 = await byName(tools, "add_supersession").execute("c2", ssItem("player capital"));
    expect(text(r2?.content)).toContain("recorded add_supersession as ss2");
    expect(acc.supersessions.map((s) => s.id)).toEqual(["ss1", "ss2"]);
  });

  it("add_probe accepts a supersessionId referencing a recorded reversal", async () => {
    const { tools, acc } = toolsOf();
    await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    const r = await byName(tools, "add_probe").execute("c2", {
      question: "which keys move the player?",
      accept: ["arrow keys"],
      supersessionId: "ss1",
      targets: ["e3"],
    });
    expect(text(r?.content)).toContain("recorded add_probe");
    expect(acc.probes).toHaveLength(1);
  });

  it("add_probe rejects a dangling supersessionId with record-first guidance", async () => {
    const { tools, acc } = toolsOf();
    const r = await byName(tools, "add_probe").execute("c1", {
      question: "which keys move the player?",
      accept: ["arrow keys"],
      supersessionId: "ss9",
      targets: ["e3"],
    });
    expect(text(r?.content)).toContain("matches no recorded reversal");
    expect(acc.probes).toHaveLength(0);
  });

  it("add_probe rejects supersessionId on a correctRefusal probe", async () => {
    const { tools, acc } = toolsOf();
    await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    const r = await byName(tools, "add_probe").execute("c2", {
      question: "we use WASD, right?",
      correctRefusal: true,
      face: "stale",
      supersessionId: "ss1",
      targets: ["e3"],
    });
    expect(text(r?.content)).toContain("belongs on a latest-value accept probe");
    expect(acc.probes).toHaveLength(0);
  });

  it("finalize_manifest rejects a reversal missing its linked latest-value probe", async () => {
    const { tools, finalizeManifest } = toolsOf();
    await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    await byName(tools, "add_probe").execute("c2", {
      question: "we use WASD, right?",
      correctRefusal: true,
      face: "stale",
      targets: ["e3"],
    });
    const r = await finalizeManifest.execute("c3", { description: "build", testSpec: "npm test" });
    expect(text(r?.content)).toContain(
      "reversal ss1 (movement keys) is missing a latest-value probe carrying its supersessionId link",
    );
    expect(finalizeManifest._captured).toHaveLength(0);
  });

  it("finalize_manifest rejects a reversal missing the stale-value probe", async () => {
    const { tools, finalizeManifest } = toolsOf();
    await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    await byName(tools, "add_probe").execute("c2", {
      question: "which keys move the player?",
      accept: ["arrow keys"],
      supersessionId: "ss1",
      targets: ["e3"],
    });
    const r = await finalizeManifest.execute("c3", { description: "build", testSpec: "npm test" });
    expect(text(r?.content)).toContain("reversal ss1 (movement keys) is missing a stale-value probe");
    expect(finalizeManifest._captured).toHaveLength(0);
  });

  it("finalize_manifest accepts when both faces are present (captures + terminates)", async () => {
    const { tools, finalizeManifest } = toolsOf();
    await byName(tools, "add_supersession").execute("c1", ssItem("movement keys"));
    await byName(tools, "add_probe").execute("c2", {
      question: "which keys move the player?",
      accept: ["arrow keys"],
      supersessionId: "ss1",
      targets: ["e3"],
    });
    await byName(tools, "add_probe").execute("c3", {
      question: "we use WASD, right?",
      correctRefusal: true,
      face: "stale",
      targets: ["e3"],
    });
    const r = await finalizeManifest.execute("c4", { description: "build", testSpec: "npm test" });
    expect(text(r?.content)).toContain("recorded finalize_manifest");
    expect(finalizeManifest._captured).toHaveLength(1);
  });
});

describe("postProcessManifest — supersession ids", () => {
  it("preserves tool-assigned ids; assigns sequentially for id-less items", () => {
    const author = {
      ...cannedAuthor,
      supersessions: [
        { id: "ss1", subject: "movement keys", oldValue: "WASD", latestValue: "arrows", entryIds: ["e3"] },
        { subject: "player capital", oldValue: "$12B", latestValue: "$15B", entryIds: ["e4"] },
      ],
    };
    const m = postProcessManifest(author, scenarioCtx);
    expect(m.supersessions.map((s) => s.id)).toEqual(["ss1", "ss2"]);
  });
});

describe("buildAuthoringTools — add-time manifest-probe validation", () => {
  const acceptProbe = {
    question: "What was TAKE_RATE before the recalibration?",
    accept: ["TAKE_RATE was 0.05"],
    targets: ["e3"],
  };

  it("a validator rejection rejects the add with the validator's evidence; nothing accumulates", async () => {
    const { tools, acc } = buildAuthoringTools(
      process.cwd(),
      () => {},
      async () => ({
        ok: false,
        problems: [{ check: "repo", what: "grep hits TAKE_RATE = 0.05 in config.js — answerable from files" }],
      }),
    );
    const add = tools.find((t) => t.name === "add_probe");
    if (!add) throw new Error("no add_probe");
    const r = await add.execute("c1", acceptProbe);
    expect(JSON.stringify(r?.content)).toContain("answerable from files");
    expect(JSON.stringify(r?.content)).toContain("call add_probe again");
    expect(acc.probes).toHaveLength(0);
  });

  it("a validator pass records the probe; correctRefusal probes bypass validation", async () => {
    let calls = 0;
    const { tools, acc } = buildAuthoringTools(
      process.cwd(),
      () => {},
      async () => {
        calls += 1;
        return { ok: true };
      },
    );
    const add = tools.find((t) => t.name === "add_probe");
    if (!add) throw new Error("no add_probe");
    await add.execute("c1", acceptProbe);
    const r2 = await add.execute("c2", {
      question: "we use WASD, right?",
      correctRefusal: true,
      face: "stale",
      targets: ["e3"],
    });
    expect(JSON.stringify(r2?.content)).toContain("recorded add_probe");
    expect(acc.probes).toHaveLength(2);
    expect(calls).toBe(1); // refusal probe never reached the validator
  });
});
