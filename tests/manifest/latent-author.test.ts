// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { JsonToolStageSeams } from "../../src/judge/stage-runner.js";
import type { AuthorLatentProbe } from "../../src/manifest/latent.js";
import {
  buildLatentSystemPrompt,
  buildLatentTaskMessage,
  buildLatentTools,
  LATENT_CAP_PER_CLASS,
  LATENT_MIN_PER_CLASS,
  runLatentAuthoringAgent,
  type SpanCitations,
  spanContentEntryIds,
} from "../../src/manifest/latent-author.js";
import { LATENT_PER_ARM_SYSTEM_PROMPT, LATENT_SHARED_SYSTEM_PROMPT } from "../../src/manifest/latent-prompt.js";
import type { AskUi } from "../../src/ui/ask.js";

const here = dirname(fileURLToPath(import.meta.url));
const perArmFixture = readFileSync(joinPath(here, "fixtures/latent-per-arm-prompt.txt"), "utf8").trimEnd();
const sharedFixture = readFileSync(joinPath(here, "fixtures/latent-shared-prompt.txt"), "utf8").trimEnd();

function item(probeClass: "cued" | "uncued", question: string): AuthorLatentProbe {
  return {
    question,
    accept: ["an answer"],
    entryIds: ["e1"],
    probeClass,
    note: "matters for the work",
  };
}

/** A fake dialog surface returning a queued choice per call. */
function fakeUi(choices: (string | undefined)[]): AskUi & { calls: number } {
  // pi's ui.select takes an optional opts bag; the lint forbids optional params, so
  // the implementation takes only the two required args and is cast to the interface.
  const state = { calls: 0 };
  const select = async (_title: string, _options: string[]): Promise<string | undefined> => {
    const c = choices[Math.min(state.calls, choices.length - 1)];
    state.calls += 1;
    return c;
  };
  return {
    select: select as unknown as AskUi["select"],
    get calls() {
      return state.calls;
    },
  };
}

describe("system prompts (byte-compare against frozen fixtures)", () => {
  it("per-arm matches the approved text verbatim", () => {
    expect(LATENT_PER_ARM_SYSTEM_PROMPT).toBe(perArmFixture);
  });
  it("shared matches the approved text verbatim", () => {
    expect(LATENT_SHARED_SYSTEM_PROMPT).toBe(sharedFixture);
  });
});

describe("buildLatentSystemPrompt / buildLatentTaskMessage", () => {
  it("substitutes <PATH> and <TAIL_START> (with $-bearing paths intact)", () => {
    const p = buildLatentSystemPrompt({
      mode: "per-arm",
      sessionPaths: ["/tmp/$HOME/arm.jsonl"],
      tailStartsAtEntryId: "cut-1",
    });
    expect(p).toContain("/tmp/$HOME/arm.jsonl");
    expect(p).toContain("id cut-1");
    expect(p).not.toContain("<PATH>");
    expect(p).not.toContain("<TAIL_START>");
  });

  it("shared: joins <PATHS> and both messages name the anchor", () => {
    const deps = { mode: "shared" as const, sessionPaths: ["/a.jsonl", "/b.jsonl"], tailStartsAtEntryId: "cut-9" };
    expect(buildLatentSystemPrompt(deps)).toContain("/a.jsonl\n/b.jsonl");
    const msg = buildLatentTaskMessage(deps);
    expect(msg).toContain("/a.jsonl");
    expect(msg).toContain("identical in every file");
    expect(msg).toContain("cut-9");
    const perArm = buildLatentTaskMessage({
      mode: "per-arm",
      sessionPaths: ["/a.jsonl"],
      tailStartsAtEntryId: "cut-9",
    });
    expect(perArm).toContain("The KEPT TAIL starts at the entry with id cut-9.");
    expect(perArm).toContain("then call finalize_latent when done.");
  });
});

/** A citations fixture: the given ids resolvable in-span, no position index. */
function citationsOf(...ids: string[]): SpanCitations {
  return { spanEntryIds: new Set(ids), positionToSpanId: new Map() };
}

describe("buildLatentTools", () => {
  it("add_latent_probe accepts valid items and fires onAdd with per-class counts", async () => {
    const seen: string[] = [];
    const { tools } = buildLatentTools(".", null, (c) => seen.push(`${c.cued}/${c.uncued}`), citationsOf("e1"));
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const r = await add.execute("c1", { ...item("cued", "q1"), probeClass: "cued" });
    expect(r.details).toEqual({ accepted: 1, rejected: 0 });
    expect(seen).toEqual(["1/0"]);
  });

  it("add_latent_probe rejects schema mismatches with the shared rejection shape", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"));
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const r = await add.execute("c1", { question: "q", accept: [], entryIds: [], probeClass: "cued", note: "" });
    expect(r.details?.rejected).toBe(1);
    expect((r.content as [{ type: string; text: string }])[0].text).toContain(
      "rejected: arguments did not match the add_latent_probe schema",
    );
  });

  it("add_latent_probe enforces the per-class cap with the approved rejection", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"));
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    for (let i = 0; i < LATENT_CAP_PER_CLASS; i++) {
      await add.execute(`c${i}`, { ...item("cued", "q"), question: `q${i}` });
    }
    const r = await add.execute("c11", item("cued", "over"));
    expect(r.details?.rejected).toBe(1);
    expect((r.content as [{ type: string; text: string }])[0].text).toBe(
      `rejected: cued cap reached (${LATENT_CAP_PER_CLASS} recorded) — record uncued probes, or finalize_latent`,
    );
    // the other class is unaffected
    const ok = await add.execute("c12", item("uncued", "fine"));
    expect(ok.details?.accepted).toBe(1);
  });

  it("finalize_latent: min met → captures done and terminates", async () => {
    const { tools, finalizeLatent } = buildLatentTools(".", null, () => {}, citationsOf("e1"));
    const add = tools.find((t) => t.name === "add_latent_probe");
    const fin = tools.find((t) => t.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    for (let i = 0; i < LATENT_MIN_PER_CLASS; i++) {
      await add.execute(`a${i}`, { ...item("cued", "q"), question: `c${i}` });
      await add.execute(`b${i}`, { ...item("uncued", "q"), question: `u${i}` });
    }
    const r = await fin.execute("f1", {});
    expect(r.terminate).toBe(true);
    expect(finalizeLatent._captured).toEqual(["done"]);
  });

  it("finalize_latent: below min with progress → produce-more rejection, no terminate", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"));
    const add = tools.find((t) => t.name === "add_latent_probe");
    const fin = tools.find((t) => t.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    await add.execute("a0", item("cued", "q"));
    const r = await fin.execute("f1", {});
    expect(r.terminate).toBeUndefined();
    expect((r.content as [{ type: string; text: string }])[0].text).toContain("rejected: below minimum — cued 1/3");
    expect((r.content as [{ type: string; text: string }])[0].text).toContain("call finalize_latent again unchanged");
  });

  it("finalize_latent: no progress → operator dialog (accept / retry / stop), null ui → stop", async () => {
    // seed below-min + one prior rejection
    const seed = async (t: ReturnType<typeof buildLatentTools>) => {
      const add = t.tools.find((x) => x.name === "add_latent_probe");
      const fin = t.tools.find((x) => x.name === "finalize_latent");
      if (add === undefined || fin === undefined) throw new Error("missing tool");
      await add.execute("a0", item("cued", "q"));
      await fin.execute("f0", {});
      return fin;
    };

    const accept = buildLatentTools(".", fakeUi(["accept fewer probes and continue"]), () => {}, citationsOf("e1"));
    const finA = await seed(accept);
    const ra = await finA.execute("f1", {});
    expect(ra.terminate).toBe(true);
    expect(accept.finalizeLatent._captured).toEqual(["accept"]);

    const retry = buildLatentTools(".", fakeUi(["ask the authoring agent to try again"]), () => {}, citationsOf("e1"));
    const finR = await seed(retry);
    const rr = await finR.execute("f1", {});
    expect(rr.terminate).toBeUndefined();
    expect((rr.content as [{ type: string; text: string }])[0].text).toContain(
      "the operator asked for another attempt",
    );
    // still no progress → dialog fires again
    const rr2 = await finR.execute("f2", {});
    expect(rr2.terminate).toBeUndefined();
    expect(retry.finalizeLatent._captured).toEqual([]);

    const stop = buildLatentTools(".", fakeUi(["stop the run"]), () => {}, citationsOf("e1"));
    const finS = await seed(stop);
    const rs = await finS.execute("f1", {});
    expect(rs.terminate).toBe(true);
    expect(stop.finalizeLatent._captured).toEqual(["stop"]);

    const dismissed = buildLatentTools(".", fakeUi([undefined]), () => {}, citationsOf("e1"));
    const finD = await seed(dismissed);
    const rd = await finD.execute("f1", {});
    expect(rd.terminate).toBe(true);
    expect(dismissed.finalizeLatent._captured).toEqual(["stop"]);

    const noUi = buildLatentTools(".", null, () => {}, citationsOf("e1"));
    const finN = await seed(noUi);
    const rn = await finN.execute("f1", {});
    expect(rn.terminate).toBe(true);
    expect(noUi.finalizeLatent._captured).toEqual(["stop"]);
  });
});

describe("spanContentEntryIds", () => {
  it("keeps only content types before the tail anchor, intersected across files", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-span-"));
    const span = [
      { id: "s1", type: "message", content: "user says" },
      { id: "s2", type: "model_change", content: "meta" },
      { id: "s3", type: "custom", content: "persistence" },
      { id: "s4", type: "custom_message", content: "custom content" },
      { id: "s5", type: "branch_summary", content: "branch" },
    ];
    const tail = [
      { id: "cut-1", type: "message", content: "tail start" },
      { id: "t2", type: "message", content: "tail" },
    ];
    const compaction = { id: "c9", type: "compaction", summary: "s", firstKeptEntryId: "cut-1" };
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, [...span, ...tail, compaction].map((e) => JSON.stringify(e)).join("\n"));
    // file b keeps s5 raw (it sits in b's tail region, after the cut) → intersection drops it
    writeFileSync(
      b,
      [
        ...span.slice(0, 4),
        { id: "cut-1", type: "message", content: "tail start" },
        { id: "s5", type: "message", content: "kept raw in b" },
        { id: "t2", type: "message", content: "tail" },
        compaction,
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const ids = spanContentEntryIds([a], "cut-1");
    expect([...ids].sort()).toEqual(["s1", "s4", "s5"]);
    const both = spanContentEntryIds([a, b], "cut-1");
    expect([...both].sort()).toEqual(["s1", "s4"]);
  });
});

describe("runLatentAuthoringAgent", () => {
  const FAKE_MODEL: Model<Api> = { id: "fake" } as unknown as Model<Api>;

  function makeSession(dir: string, name: string): string {
    const path = join(dir, name);
    const entries = [
      { id: "e1", type: "message", content: "reasoning about write-through" },
      { id: "e2", type: "message", content: "more rationale" },
      { id: "cut-1", type: "message", content: "tail" },
      { id: "c9", type: "compaction", summary: "the summary", firstKeptEntryId: "cut-1" },
    ];
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
    return path;
  }

  /** Fake seams: runStage drives the tools like the agent would. */
  function fakeSeams(script: (find: (n: string) => AgentTool) => Promise<void>): JsonToolStageSeams {
    return {
      resolveModel: async () => ({ ok: true as const, model: FAKE_MODEL, apiKey: "k" }),
      runStage: async (input) => {
        const tools = (input as { tools: AgentTool[] }).tools;
        const find = (n: string): AgentTool => {
          const tool = tools.find((t) => t.name === n);
          if (tool === undefined) throw new Error(`tool ${n} missing`);
          return tool;
        };
        await script(find);
        return { timedOut: false, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
      },
      onEvent: (_e: AgentEvent) => {},
    };
  }

  const exec = async (tool: { execute: (id: string, args: unknown) => Promise<unknown> }, args: unknown) =>
    tool.execute("call", args);

  it("per-arm: 3+3 probes → validated pool stamped with arm + absent verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    const session = makeSession(dir, "arm.jsonl");
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
      for (let i = 0; i < 3; i++) {
        await exec(add, { ...item("cued", "q"), question: `c${i}` });
        await exec(add, { ...item("uncued", "q"), question: `u${i}` });
      }
      await exec(find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A3",
      enabledArms: ["A1", "A3"],
      sessionPaths: [session],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool).toHaveLength(6);
    expect(r.pool[0]).toMatchObject({ id: "l1", arm: "A3", probeClass: "cued", verdicts: { A3: "absent" } });
  });

  it("numeric citations (line positions from the read view) resolve to the id at that line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    // lines: 1 header, 2 e1, 3 e2, 4 tail, 5 compaction — the agent cites "2"/"3" (positions)
    const path = join(dir, "arm.jsonl");
    const entries = [
      { id: "h0", type: "session" },
      { id: "e1", type: "message", content: "reasoning about write-through" },
      { id: "e2", type: "message", content: "more rationale" },
      { id: "cut-1", type: "message", content: "tail" },
      { id: "c9", type: "compaction", summary: "the summary", firstKeptEntryId: "cut-1" },
    ];
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
      for (let i = 0; i < 3; i++) {
        await exec(add, { ...item("cued", "q"), entryIds: ["2"] }); // position of e1
        await exec(add, { ...item("uncued", "q"), entryIds: [i === 0 ? "e2" : "3"] }); // real id / position of e2
      }
      await exec(find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [path],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool.map((p) => p.entryIds)).toEqual([["e1"], ["e2"], ["e1"], ["e2"], ["e1"], ["e2"]]);
  });

  it("a TAIL-position citation (line past firstKeptEntryId) is rejected AT ADD TIME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    const path = join(dir, "arm.jsonl");
    const entries = [
      { id: "e1", type: "message", content: "span" },
      { id: "cut-1", type: "message", content: "tail" },
      { id: "t2", type: "message", content: "tail content" }, // line 3 — the agent cites "3"
      { id: "c9", type: "compaction", summary: "s", firstKeptEntryId: "cut-1" },
    ];
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
    let badResult: { details?: { rejected?: number }; content?: { text: string }[] } | undefined;
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as unknown as {
        execute: (id: string, a: unknown) => Promise<{ details?: { rejected?: number }; content?: { text: string }[] }>;
      };
      for (let i = 0; i < 3; i++) {
        await exec(add, { ...item("cued", `c${i}`), entryIds: ["e1"] });
        await exec(add, { ...item("uncued", `u${i}`), entryIds: ["e1"] });
      }
      badResult = await add.execute("c7", { ...item("cued", "tail-citer"), entryIds: ["3"] }); // tail position
      await exec(find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [path],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(badResult?.details?.rejected).toBe(1);
    expect((badResult?.content ?? [])[0]?.text).toContain(
      'rejected: entryId "3" is not an in-span message/custom_message/branch_summary entry',
    );
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool).toHaveLength(6); // the tail-citer never entered the pool
    expect(r.pool.every((p) => p.entryIds.every((id) => id === "e1"))).toBe(true);
  });

  it("shared: verdicts stamped for every enabled arm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    const session = makeSession(dir, "arm.jsonl");
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
      for (let i = 0; i < 3; i++) {
        await exec(add, { ...item("cued", "q"), question: `c${i}` });
        await exec(add, { ...item("uncued", "q"), question: `u${i}` });
      }
      await exec(find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "shared",
      arm: "A1",
      enabledArms: ["A1", "A3", "A5"],
      sessionPaths: [session, session],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool[0].verdicts).toEqual({ A1: "absent", A3: "absent", A5: "absent" });
    expect(r.pool[0].arm).toBeUndefined();
  });

  it("operator stop (null ui, below min, no progress) → { kind: stopped }", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    const session = makeSession(dir, "arm.jsonl");
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
      const fin = find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> };
      await exec(add, item("cued", "q"));
      await exec(fin, {}); // rejected (progress)
      await exec(fin, {}); // no progress + null ui → stop
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [session],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(r).toEqual({ kind: "stopped", counts: { cued: 1, uncued: 0 } });
  });

  it("a tail-id citation is rejected AT ADD TIME (the finalize validation is the unreachable backstop)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-"));
    const session = makeSession(dir, "arm.jsonl");
    let badText = "";
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as unknown as {
        execute: (id: string, a: unknown) => Promise<{ content?: { text: string }[]; details?: { rejected?: number } }>;
      };
      for (let i = 0; i < 3; i++) {
        await exec(add, { ...item("cued", "q"), question: `c${i}`, entryIds: ["e1"] });
        await exec(add, { ...item("uncued", "q"), question: `u${i}` });
      }
      const bad = await add.execute("c9", { ...item("uncued", "bad"), entryIds: ["cut-1"], question: "tail-citer" });
      badText = (bad.content ?? [])[0]?.text ?? "";
      await exec(find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [session],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
    });
    expect(badText).toContain('rejected: entryId "cut-1" is not an in-span');
    expect(r.kind).toBe("completed"); // the 3+3 valid probes finalized; the bad one never entered the pool
    if (r.kind !== "completed") return;
    expect(r.pool.every((p) => p.entryIds.every((id) => id === "e1"))).toBe(true);
  });
});
