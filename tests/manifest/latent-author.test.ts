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
import type { AuthorLatentProbe, LatentProbe } from "../../src/manifest/latent.js";
import type { LatentFinalizeTool } from "../../src/manifest/latent-author.js";
import {
  buildLatentRetryTaskMessage,
  buildLatentSystemPrompt,
  buildLatentTaskMessage,
  buildLatentTools,
  LATENT_CAP_PER_CLASS,
  LATENT_MAX_PASSES,
  LATENT_MIN_PER_CLASS,
  LATENT_REASON_CONTEXT,
  LATENT_REASON_RESUMED,
  LATENT_REASON_TIMED_OUT,
  runLatentAuthoringAgent,
  type SpanCitations,
  spanCitationIndex,
  spanContentEntryIds,
} from "../../src/manifest/latent-author.js";
import { LATENT_PER_ARM_SYSTEM_PROMPT, LATENT_SHARED_SYSTEM_PROMPT } from "../../src/manifest/latent-prompt.js";
import { StageRunError } from "../../src/runtime/agent-loop.js";
import type { AskUi } from "../../src/ui/ask.js";

const here = dirname(fileURLToPath(import.meta.url));
const perArmFixture = readFileSync(joinPath(here, "fixtures/latent-per-arm-prompt.txt"), "utf8").trimEnd();
const sharedFixture = readFileSync(joinPath(here, "fixtures/latent-shared-prompt.txt"), "utf8").trimEnd();

/** Real-grade question for a stub — the add-time content floors require a
 *  specific question (>= 12 chars; see the A3 junk-probe regression), so short
 *  test stubs are padded into a plausible probe question. */
function q(stub: string): string {
  return stub.length >= 12 ? stub : `${stub}: which exact value did the span record for it?`;
}

function item(probeClass: "cued" | "uncued", question: string): AuthorLatentProbe {
  return {
    question: q(question),
    accept: ["an acceptable answer"],
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

/** A dialog ui that records the opts bag each select call received. */
function optsRecordingUi(answer: string | undefined): AskUi & { opts: ({ signal?: AbortSignal } | undefined)[] } {
  const opts: ({ signal?: AbortSignal } | undefined)[] = [];
  return {
    select: async (_title: string, _options: string[], o) => {
      opts.push(o);
      return answer;
    },
    get opts() {
      return opts;
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

  it("shared: joins <PATHS> and both messages name the anchor + tail-start line", () => {
    const deps = {
      mode: "shared" as const,
      sessionPaths: ["/a.jsonl", "/b.jsonl"],
      tailStartsAtEntryId: "cut-9",
      tailStartLine: 133,
    };
    expect(buildLatentSystemPrompt(deps)).toContain("/a.jsonl\n/b.jsonl");
    const msg = buildLatentTaskMessage(deps);
    expect(msg).toContain("/a.jsonl");
    expect(msg).toContain("identical in every file");
    expect(msg).toContain("cut-9");
    expect(msg).toContain("— line 133");
    const perArm = buildLatentTaskMessage({
      mode: "per-arm",
      sessionPaths: ["/a.jsonl"],
      tailStartsAtEntryId: "cut-9",
      tailStartLine: 42,
    });
    expect(perArm).toContain("The KEPT TAIL starts at the entry with id cut-9 — line 42.");
    expect(perArm).toContain("then call finalize_latent when done.");
  });
});

/** A citations fixture: the given ids resolvable in-span, no position index. */
function citationsOf(...ids: string[]): SpanCitations {
  return { spanEntryIds: new Set(ids), positionToSpanId: new Map(), tailStartLine: null };
}

describe("buildLatentTools", () => {
  it("add_latent_probe accepts valid items and fires onAdd with per-class counts", async () => {
    const seen: string[] = [];
    const { tools } = buildLatentTools(
      ".",
      null,
      (c) => seen.push(`${c.cued}/${c.uncued}`),
      citationsOf("e1"),
      null,
      null,
      null,
    );
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const r = await add.execute("c1", { ...item("cued", "q1"), probeClass: "cued" });
    expect(r.details).toEqual({ accepted: 1, rejected: 0 });
    expect(seen).toEqual(["1/0"]);
  });

  it("add_latent_probe rejects schema mismatches with the shared rejection shape", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const r = await add.execute("c1", { question: "q", accept: [], entryIds: [], probeClass: "cued", note: "" });
    expect(r.details?.rejected).toBe(1);
    expect((r.content as [{ type: string; text: string }])[0].text).toContain(
      "rejected: arguments did not match the add_latent_probe schema",
    );
  });

  it("add_latent_probe rejects placeholder-grade questions with the specific rejection (junk never enters the pool)", async () => {
    const seen: string[] = [];
    const { tools } = buildLatentTools(
      ".",
      null,
      (c) => seen.push(`${c.cued}/${c.uncued}`),
      citationsOf("e1"),
      null,
      null,
      null,
    );
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const r = await add.execute("c1", { ...item("cued", "placeholder"), question: "Test4" });
    expect(r.details).toEqual({ accepted: 0, rejected: 1 });
    expect((r.content as [{ type: string; text: string }])[0].text).toBe(
      "rejected: question too short (under 12 chars) — a probe question is a specific, self-contained question about the lost detail; re-check the entry and re-record the real question",
    );
    expect(seen).toEqual([]); // nothing recorded, no onAdd
  });

  it('add_latent_probe rejects placeholder-grade notes and accept lists (the A3 junk: note "t", accept "a")', async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const note = await add.execute("c1", { ...item("cued", "fine question"), note: "t" });
    expect(note.details).toEqual({ accepted: 0, rejected: 1 });
    expect((note.content as [{ type: string; text: string }])[0].text).toContain(
      "rejected: note too short (under 8 chars)",
    );
    const accept = await add.execute("c2", { ...item("cued", "another fine question"), accept: ["a"] });
    expect(accept.details).toEqual({ accepted: 0, rejected: 1 });
    expect((accept.content as [{ type: string; text: string }])[0].text).toContain(
      "rejected: accept too short (under 10 chars)",
    );
  });

  it("add_latent_probe rejects near-duplicate questions (padding runs never enter the pool)", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    const first = await add.execute("c1", item("cued", "What is the exact LEGACY_DECAY value?"));
    expect(first.details?.accepted).toBe(1);
    const dup = await add.execute("c2", item("cued", "What is the exact LEGACY_DECAY value used?"));
    expect(dup.details).toEqual({ accepted: 0, rejected: 1 });
    expect((dup.content as [{ type: string; text: string }])[0].text).toBe(
      "rejected: question is a near-duplicate of probe #1 already recorded — each probe targets a distinct lost detail; verify and record a different one",
    );
    // distinct adjacent facts (A1's real ≈0.70 pairs) stay accepted
    const distinct = await add.execute("c3", item("cued", "Which module path hosts the decay override constant?"));
    expect(distinct.details?.accepted).toBe(1);
  });

  it("add_latent_probe enforces the per-class cap with the approved rejection", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (add === undefined) throw new Error("missing tool");
    for (let i = 0; i < LATENT_CAP_PER_CLASS; i++) {
      await add.execute(`c${i}`, item("cued", `capped cued detail number ${i}`));
    }
    // the cap check fires BEFORE the content floors: a short 11th question still
    // gets the cap rejection, not the question-floor one
    const r = await add.execute("c11", { ...item("cued", "over"), question: "x" });
    expect(r.details?.rejected).toBe(1);
    expect((r.content as [{ type: string; text: string }])[0].text).toBe(
      `rejected: cued cap reached (${LATENT_CAP_PER_CLASS} recorded) — record uncued probes, or finalize_latent`,
    );
    // the other class is unaffected
    const ok = await add.execute("c12", item("uncued", "fine"));
    expect(ok.details?.accepted).toBe(1);
  });

  it("finalize_latent: min met → captures done and terminates", async () => {
    const { tools, finalizeLatent } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    const fin = tools.find((t) => t.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    for (let i = 0; i < LATENT_MIN_PER_CLASS; i++) {
      await add.execute(`a${i}`, item("cued", `cued fact number ${i} of three`));
      await add.execute(`b${i}`, item("uncued", `uncued fact number ${i} of three`));
    }
    const r = await fin.execute("f1", {});
    expect(r.terminate).toBe(true);
    expect(finalizeLatent._captured).toEqual(["done"]);
  });

  it("finalize_latent: below min with progress → produce-more rejection, no terminate", async () => {
    const { tools } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    const fin = tools.find((t) => t.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    await add.execute("a0", item("cued", "q"));
    const r = await fin.execute("f1", {});
    expect(r.terminate).toBeUndefined();
    expect((r.content as [{ type: string; text: string }])[0].text).toContain("rejected: below minimum — cued 1/3");
    expect((r.content as [{ type: string; text: string }])[0].text).toContain("call finalize_latent again unchanged");
    expect((r.content as [{ type: string; text: string }])[0].text).toContain(
      "Never record placeholder, repetitive, or unverified probes",
    );
  });

  it("rejected junk adds are not progress — the deadlock dialog stays reachable (A3 regression)", async () => {
    // The A3 authoring agent padded the cued minimum with "Test4"-grade probes; every
    // junk add was accepted, so the below-min rejection re-fired forever and the
    // operator dialog was unreachable. Junk adds are now rejected at the gate — the
    // next unchanged finalize has NO progress and opens the dialog (accept fewer).
    const ui = fakeUi(["accept fewer probes and continue"]);
    const t = buildLatentTools(".", ui, () => {}, citationsOf("e1"), null, null, null);
    const add = t.tools.find((x) => x.name === "add_latent_probe");
    const fin = t.tools.find((x) => x.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    await add.execute("a0", item("cued", "the one real cued fact in the span"));
    await fin.execute("f0", {}); // below min WITH progress → produce-more rejection
    const junk = await add.execute("a1", { ...item("cued", "placeholder"), question: "Test4" });
    expect(junk.details).toEqual({ accepted: 0, rejected: 1 });
    const r = await fin.execute("f1", {}); // no progress → dialog, not another produce-more
    expect(r.terminate).toBe(true);
    expect(t.finalizeLatent._captured).toEqual(["accept"]);
    expect(ui.calls).toBe(1);
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

    const accept = buildLatentTools(
      ".",
      fakeUi(["accept fewer probes and continue"]),
      () => {},
      citationsOf("e1"),
      null,
      null,
      null,
    );
    const finA = await seed(accept);
    const ra = await finA.execute("f1", {});
    expect(ra.terminate).toBe(true);
    expect(accept.finalizeLatent._captured).toEqual(["accept"]);

    const retry = buildLatentTools(
      ".",
      fakeUi(["ask the authoring agent to try again"]),
      () => {},
      citationsOf("e1"),
      null,
      null,
      null,
    );
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

    const stop = buildLatentTools(".", fakeUi(["stop the run"]), () => {}, citationsOf("e1"), null, null, null);
    const finS = await seed(stop);
    const rs = await finS.execute("f1", {});
    expect(rs.terminate).toBe(true);
    expect(stop.finalizeLatent._captured).toEqual(["stop"]);

    const dismissed = buildLatentTools(".", fakeUi([undefined]), () => {}, citationsOf("e1"), null, null, null);
    const finD = await seed(dismissed);
    const rd = await finD.execute("f1", {});
    expect(rd.terminate).toBe(true);
    expect(dismissed.finalizeLatent._captured).toEqual(["stop"]);

    const noUi = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const finN = await seed(noUi);
    const rn = await finN.execute("f1", {});
    expect(rn.terminate).toBe(true);
    expect(noUi.finalizeLatent._captured).toEqual(["stop"]);
  });

  it("the deadlock dialog is abort-linked: the stage's signal reaches ui.select", async () => {
    // A run stopped while the dialog is open must close the dialog (dismissed →
    // stop) instead of leaving it dangling over a dead stage.
    const ac = new AbortController();
    const ui = optsRecordingUi("accept fewer probes and continue");
    const t = buildLatentTools(".", ui, () => {}, citationsOf("e1"), null, null, ac.signal);
    const add = t.tools.find((x) => x.name === "add_latent_probe");
    const fin = t.tools.find((x) => x.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    await add.execute("a0", item("cued", "q"));
    await fin.execute("f0", {}); // below min with progress → rejection
    const r = await fin.execute("f1", {}); // no progress → dialog
    expect(r.terminate).toBe(true);
    expect(ui.opts).toEqual([{ signal: ac.signal }]);
  });

  it("_resetCaptured empties the capture slate", async () => {
    const { tools, finalizeLatent } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    const fin = tools.find((t) => t.name === "finalize_latent");
    if (add === undefined || fin === undefined) throw new Error("missing tool");
    for (let i = 0; i < LATENT_MIN_PER_CLASS; i++) {
      await add.execute(`a${i}`, item("cued", `cued fact number ${i} of three`));
      await add.execute(`b${i}`, item("uncued", `uncued fact number ${i} of three`));
    }
    await fin.execute("f1", {});
    expect(finalizeLatent._captured).toEqual(["done"]);
    finalizeLatent._resetCaptured();
    expect(finalizeLatent._captured).toEqual([]);
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

describe("spanCitationIndex", () => {
  it("reports the tail-start line (1-based, first file that has it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-cite-"));
    const path = join(dir, "arm.jsonl");
    writeFileSync(
      path,
      [
        { id: "e1", type: "message" },
        { id: "cut-1", type: "message" },
        { id: "t1", type: "message" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const idx = spanCitationIndex([path], "cut-1");
    expect(idx.tailStartLine).toBe(2);
    expect([...idx.positionToSpanId.entries()]).toEqual([[1, "e1"]]); // tail position 3 never resolves
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
        await exec(add, item("cued", `cued fact number ${i} of the trio`));
        await exec(add, item("uncued", `uncued fact number ${i} of the trio`));
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
      thinking: null,
      timeoutMs: 120000,
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
        await exec(add, { ...item("cued", `cued citation fact number ${i}`), entryIds: ["2"] }); // position of e1
        await exec(add, { ...item("uncued", `uncued citation fact number ${i}`), entryIds: [i === 0 ? "e2" : "3"] }); // real id / position of e2
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
      thinking: null,
      timeoutMs: 120000,
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
        await exec(add, { ...item("cued", `cued tailguard fact number ${i}`), entryIds: ["e1"] });
        await exec(add, { ...item("uncued", `uncued tailguard fact number ${i}`), entryIds: ["e1"] });
      }
      badResult = await add.execute("c7", {
        ...item("cued", "a cued probe citing the tail position"),
        entryIds: ["3"],
      }); // tail position
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
      thinking: null,
      timeoutMs: 120000,
    });
    expect(badResult?.details?.rejected).toBe(1);
    expect((badResult?.content ?? [])[0]?.text).toContain(
      'rejected: entryId "3" is not an in-span message/custom_message/branch_summary entry',
    );
    expect((badResult?.content ?? [])[0]?.text).toContain("before line 2 (the tail start)");
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
        await exec(add, item("cued", `cued fact number ${i} of the trio`));
        await exec(add, item("uncued", `uncued fact number ${i} of the trio`));
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
      thinking: null,
      timeoutMs: 120000,
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
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r).toEqual({ kind: "stopped", counts: { cued: 1, uncued: 0 } });
  });

  it("completed results surface the operator's accept: acceptedFewer=true (min-met finalizes carry false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-run-accepted-"));
    const session = makeSession(dir, "arm.jsonl");
    const seams = fakeSeams(async (find) => {
      const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
      const fin = find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> };
      await exec(add, item("cued", "q"));
      await exec(fin, {}); // below min with progress → rejection
      // no progress + ui answers "accept fewer probes and continue" → accept
      await exec(fin, {});
    });
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [session],
      tailStartsAtEntryId: "cut-1",
      ui: fakeUi(["accept fewer probes and continue"]),
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.acceptedFewer).toBe(true);
    expect(r.pool).toHaveLength(1);
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
        await exec(add, item("cued", `cued tailid fact number ${i}`));
        await exec(add, item("uncued", `uncued tailid fact number ${i}`));
      }
      const bad = await add.execute("c9", {
        ...item("uncued", "an uncued probe citing the tail id directly"),
        entryIds: ["cut-1"],
      });
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
      thinking: null,
      timeoutMs: 120000,
    });
    expect(badText).toContain('rejected: entryId "cut-1" is not an in-span');
    expect(r.kind).toBe("completed"); // the 3+3 valid probes finalized; the bad one never entered the pool
    if (r.kind !== "completed") return;
    expect(r.pool.every((p) => p.entryIds.every((id) => id === "e1"))).toBe(true);
  });
});

// ── pass loop: auto-restart on mid-work deaths (timeout / context exhaustion) ──
describe("runLatentAuthoringAgent — retry passes", () => {
  const FAKE_MODEL_R: Model<Api> = { id: "fake" } as unknown as Model<Api>;
  const WINDOWED_MODEL_R: Model<Api> = { id: "fake", contextWindow: 262_144 } as unknown as Model<Api>;

  function sessionOf(dir: string): string {
    const path = join(dir, "arm.jsonl");
    writeFileSync(
      path,
      [
        { id: "e1", type: "message", content: "span" },
        { id: "cut-1", type: "message", content: "tail" },
        { id: "c9", type: "compaction", summary: "s", firstKeptEntryId: "cut-1" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    return path;
  }

  /** Fake seams with a scripted list of pass behaviors: each entry drives the tools
   *  for that pass (adding probes / finalizing). `failFirst` kills pass 1 the way
   *  the real pipeline surfaces a mid-work death — a timed-out stage result, or a
   *  context-exhausted request wrapped in StageRunError — before the script runs;
   *  `timeout-after-step` runs pass 1's script and THEN returns a timed-out result
   *  (the pass did real work, captured a finalize, and the stage still died). */
  function scriptedSeams(
    passes: Array<(find: (n: string) => AgentTool, input: { messages: [{ content: string }] }) => Promise<void>>,
    failFirst: "timeout" | "context" | "silent-context" | "timeout-after-step" | null,
  ): { seams: JsonToolStageSeams; kickoffs: string[] } {
    const kickoffs: string[] = [];
    let i = 0;
    return {
      kickoffs,
      seams: {
        resolveModel: async () =>
          ({
            ok: true as const,
            model: failFirst === "silent-context" ? WINDOWED_MODEL_R : FAKE_MODEL_R,
            apiKey: "k",
          }) as {
            ok: true;
            model: Model<Api>;
            apiKey: string;
          },
        runStage: async (input) => {
          const inp = input as unknown as { tools: AgentTool[]; messages: [{ content: string }] };
          kickoffs.push(inp.messages[0].content);
          if (i === 0 && failFirst === "timeout") {
            i += 1;
            return { timedOut: true, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
          }
          if (i === 0 && failFirst === "context") {
            i += 1;
            throw new StageRunError(
              new Error("model m request failed: maximum context length is 8192 tokens, however you requested 262999"),
            );
          }
          if (i === 0 && failFirst === "silent-context") {
            // the local-model death: the stage ENDS CLEANLY (no timeout, no error,
            // no terminal call) at >=95% of the window — a degraded tool-less reply
            i += 1;
            return {
              timedOut: false,
              aborted: false,
              finalContextTokens: 262_000,
            } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
          }
          const step = passes[Math.min(i, passes.length - 1)];
          i += 1;
          const find = (n: string): AgentTool => {
            const tool = inp.tools.find((t) => t.name === n);
            if (tool === undefined) throw new Error(`tool ${n} missing`);
            return tool;
          };
          await step(find, inp);
          if (failFirst === "timeout-after-step" && kickoffs.length === 1) {
            return { timedOut: true, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
          }
          return { timedOut: false, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
        },
        onEvent: (_e: AgentEvent) => {},
      },
    };
  }

  it("a timed-out pass auto-restarts: pass 2 completes over the kept probes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-retry-"));
    const { seams, kickoffs } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          for (let i = 0; i < 3; i++) {
            await add.execute("c", item("cued", `cued retry fact number ${i} of the trio`));
            await add.execute("c", item("uncued", `uncued retry fact number ${i} of the trio`));
          }
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      "timeout",
    );
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A3",
      enabledArms: ["A3"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool).toHaveLength(6);
    // pass 1 got the plain kickoff, pass 2 the retry kickoff with the timeout reason
    expect(kickoffs[0]).toContain("then call finalize_latent when done.");
    expect(kickoffs[1]).toContain(
      `The previous authoring pass ended before finalize_latent (${LATENT_REASON_TIMED_OUT}).`,
    );
    expect(kickoffs[1]).toContain("Still needed: cued 3 more, uncued 3 more.");
  });

  it("each pass starts with a clean capture slate — an earlier pass's capture never decides a later one", async () => {
    // Pass 1 does real work (adds 3+3, finalizes → captures "done") and the stage
    // still dies on a timeout; pass 2 finalizes over the kept probes. The stage's
    // ending action must be pass 2's capture ALONE — a leftover capture from pass 1
    // must not speak for (or smear into) the pass that actually ended the loop.
    const dir = mkdtempSync(join(tmpdir(), "latent-capture-reset-"));
    let finalizeTool: (LatentFinalizeTool & AgentTool) | null = null;
    // read through a fn so TS uses the DECLARED type (closure assignments don't narrow)
    const captured = (): readonly string[] => finalizeTool?._captured ?? [];
    const { seams } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          for (let i = 0; i < 3; i++) {
            await add.execute("c", item("cued", `cued slate fact number ${i} of the trio`));
            await add.execute("c", item("uncued", `uncued slate fact number ${i} of the trio`));
          }
          const fin = find("finalize_latent") as LatentFinalizeTool &
            AgentTool & {
              execute: (id: string, a: unknown) => Promise<unknown>;
            };
          finalizeTool = fin;
          await fin.execute("c", {});
        },
      ],
      "timeout-after-step",
    );
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool).toHaveLength(6);
    // pass 2's finalize ran through runJsonToolStage's capture read: the returned
    // action came from a slate holding ONLY pass 2's "done".
    expect(captured()).toEqual(["done"]);
  });

  it("a context-exhausted pass auto-restarts (StageRunError naming the context)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-retry-ooc-"));
    const { seams } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          for (let i = 0; i < 3; i++) {
            await add.execute("c", item("cued", `cued ooc fact number ${i} of the trio`));
            await add.execute("c", item("uncued", `uncued ooc fact number ${i} of the trio`));
          }
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      "context",
    );
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r.kind).toBe("completed");
  });

  it("a SILENT context death (clean no-finalize at >=95% of the window) auto-restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-retry-silent-"));
    const { seams, kickoffs } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          for (let i = 0; i < 3; i++) {
            await add.execute("c", item("cued", `cued silent fact number ${i} of the trio`));
            await add.execute("c", item("uncued", `uncued silent fact number ${i} of the trio`));
          }
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      "silent-context",
    );
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A1",
      enabledArms: ["A1"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(r.kind).toBe("completed");
    expect(kickoffs).toHaveLength(2);
    expect(kickoffs[1]).toContain(
      `The previous authoring pass ended before finalize_latent (${LATENT_REASON_CONTEXT}).`,
    );
  });

  it("a NON-retryable failure (lucid no-finalize) does NOT restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-noretry-"));
    let calls = 0;
    const seams: JsonToolStageSeams = {
      resolveModel: async () => ({ ok: true as const, model: FAKE_MODEL_R, apiKey: "k" }),
      runStage: async (input) => {
        calls += 1;
        void (input as { tools: AgentTool[] }).tools;
        return { timedOut: false, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
      },
      onEvent: (_e: AgentEvent) => {},
    };
    await expect(
      runLatentAuthoringAgent({
        seams,
        cwd: dir,
        mode: "per-arm",
        arm: "A1",
        enabledArms: ["A1"],
        sessionPaths: [sessionOf(dir)],
        tailStartsAtEntryId: "cut-1",
        ui: null,
        signal: new AbortController().signal,
        maxTokens: 1000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/did not call finalize_latent/);
    expect(calls).toBe(1);
  });

  it("retries stop at the pass cap (3 total), then the failure surfaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-cap-"));
    let calls = 0;
    const seams: JsonToolStageSeams = {
      resolveModel: async () => ({ ok: true as const, model: FAKE_MODEL_R, apiKey: "k" }),
      runStage: async (input) => {
        calls += 1;
        void (input as { tools: AgentTool[] }).tools;
        return { timedOut: true, aborted: false } as unknown as Awaited<ReturnType<JsonToolStageSeams["runStage"]>>;
      },
      onEvent: (_e: AgentEvent) => {},
    };
    await expect(
      runLatentAuthoringAgent({
        seams,
        cwd: dir,
        mode: "per-arm",
        arm: "A1",
        enabledArms: ["A1"],
        sessionPaths: [sessionOf(dir)],
        tailStartsAtEntryId: "cut-1",
        ui: null,
        signal: new AbortController().signal,
        maxTokens: 1000,
        thinking: null,
        timeoutMs: 120000,
      }),
    ).rejects.toThrow(/timed out before finalize_latent/);
    expect(calls).toBe(LATENT_MAX_PASSES);
  });

  it("seeds from a partial pool: counted, widget onAdd fired, retry kickoff with the resumed reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-seed-"));
    const seen: string[] = [];
    const { seams, kickoffs } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          await add.execute("c", item("uncued", "a fresh uncued fact mined from the span"));
          await add.execute("c", item("uncued", "another fresh uncued fact from the span"));
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      null,
    );
    const seed = (n: number, cls: "cued" | "uncued", q: string): LatentProbe =>
      ({ id: `l${n}`, ...item(cls, q), arm: "A3", verdicts: { A3: "absent" } }) as unknown as LatentProbe;
    const seeds: readonly LatentProbe[] = [
      seed(1, "cued", "the write-through threshold settled in the span"),
      seed(2, "cued", "the vendor name chosen mid-conversation"),
      seed(3, "cued", "the retry budget agreed on late"),
      seed(4, "uncued", "the undocumented flag mentioned in passing"),
    ];
    const r = await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A3",
      enabledArms: ["A3"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      seedProbes: seeds,
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
      onAdd: (c) => seen.push(`${c.cued}/${c.uncued}`),
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.pool).toHaveLength(6); // 4 seeds + 2 fresh
    expect(r.pool[0]).toMatchObject({ id: "l1", probeClass: "cued" });
    expect(r.pool[4]).toMatchObject({ id: "l5", probeClass: "uncued" });
    expect(seen[0]).toBe("3/1"); // seeded counts surface immediately
    expect(kickoffs[0]).toContain(
      `The previous authoring pass ended before finalize_latent (${LATENT_REASON_RESUMED}).`,
    );
    expect(kickoffs[0]).toContain("- [cued] the write-through threshold settled in the span");
    expect(kickoffs[0]).toContain("Still needed: cued 0 more, uncued 2 more.");
  });

  it("persistPartial fires after every accepted add with the full kept set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-persist-"));
    const persisted: number[] = [];
    const { seams } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as { execute: (id: string, a: unknown) => Promise<unknown> };
          for (let i = 0; i < 3; i++) {
            await add.execute("c", item("cued", `cued persist fact number ${i} of the trio`));
            await add.execute("c", item("uncued", `uncued persist fact number ${i} of the trio`));
          }
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      null,
    );
    await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A3",
      enabledArms: ["A3"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
      persistPartial: (probes) => persisted.push(probes.length),
    });
    expect(persisted).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("re-recording a SEEDED probe is rejected by the duplicate gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-seeddup-"));
    let rejection = "";
    const { seams } = scriptedSeams(
      [
        async (find) => {
          const add = find("add_latent_probe") as unknown as {
            execute: (id: string, a: unknown) => Promise<{ content: [{ text: string }] }>;
          };
          const r = await add.execute("c", item("cued", "the write-through threshold settled in the span"));
          rejection = r.content[0].text;
          await (find("finalize_latent") as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("c", {});
        },
      ],
      null,
    );
    const seed = (n: number, cls: "cued" | "uncued", q: string): LatentProbe =>
      ({ id: `l${n}`, ...item(cls, q), arm: "A3", verdicts: { A3: "absent" } }) as unknown as LatentProbe;
    const seeds: readonly LatentProbe[] = [
      seed(1, "cued", "the write-through threshold settled in the span"),
      seed(2, "cued", "the vendor name chosen mid-conversation"),
      seed(3, "cued", "the retry budget agreed on late"),
      seed(4, "uncued", "the undocumented flag mentioned in passing"),
      seed(5, "uncued", "an offhand deadline nobody wrote down"),
      seed(6, "uncued", "the side-channel discussed only verbally"),
    ];
    await runLatentAuthoringAgent({
      seams,
      cwd: dir,
      mode: "per-arm",
      arm: "A3",
      enabledArms: ["A3"],
      sessionPaths: [sessionOf(dir)],
      tailStartsAtEntryId: "cut-1",
      seedProbes: seeds,
      ui: null,
      signal: new AbortController().signal,
      maxTokens: 1000,
      thinking: null,
      timeoutMs: 120000,
    });
    expect(rejection).toContain("rejected");
  });

  it("kickoff with both minimums already met reads 'Still needed: nothing — call finalize_latent.'", () => {
    const kept = [
      item("cued", "cued fact one that is long enough"),
      item("cued", "cued fact two that is long enough"),
      item("cued", "cued fact three that is long enough"),
      item("uncued", "uncued fact one that is long enough"),
      item("uncued", "uncued fact two that is long enough"),
      item("uncued", "uncued fact three that is long enough"),
    ];
    const msg = buildLatentRetryTaskMessage({
      mode: "per-arm",
      sessionPaths: ["E:/repo/sessions/arm.jsonl"],
      tailStartsAtEntryId: "cut-1",
      tailStartLine: 4,
      reason: LATENT_REASON_TIMED_OUT,
      kept,
    });
    expect(msg).toContain("Still needed: nothing — call finalize_latent.");
    expect(msg).toContain("The KEPT TAIL starts at the entry with id cut-1 — line 4.");
    expect(msg).toContain("Read the session file at E:/repo/sessions/arm.jsonl");
  });
});

describe("buildLatentTools — add-time probe validation", () => {
  const probeParams = {
    question: "What was MODEL_MAINT before the recalibration?",
    accept: ["MODEL_MAINT was 0.25"],
    entryIds: ["e1"],
    probeClass: "cued" as const,
    note: "the pre-recalibration economy matters for regressions",
  };

  it("a validator rejection rejects the add with the validator's evidence; the probe never enters the pool", async () => {
    const seen: unknown[] = [];
    const { tools, acc } = buildLatentTools(
      ".",
      null,
      () => {},
      citationsOf("e1"),
      null,
      async (probe) => {
        seen.push(probe);
        return {
          ok: false,
          problems: [{ check: "tail", what: "the kept tail's recalibration table lists 0.25" }],
        };
      },
      null,
    );
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (!add) throw new Error("no add_latent_probe");
    const r = await add.execute("c1", probeParams);
    expect(JSON.stringify(r?.content)).toContain("recalibration table lists 0.25");
    expect(JSON.stringify(r?.content)).toContain("call add_latent_probe again");
    expect(acc).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("a validator pass records the probe", async () => {
    const { tools, acc } = buildLatentTools(
      ".",
      null,
      () => {},
      citationsOf("e1"),
      null,
      async () => ({ ok: true }),
      null,
    );
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (!add) throw new Error("no add_latent_probe");
    const r = await add.execute("c1", probeParams);
    expect(JSON.stringify(r?.content)).toContain("recorded add_latent_probe");
    expect(acc).toHaveLength(1);
  });

  it("null validate = validation off (existing behavior)", async () => {
    const { tools, acc } = buildLatentTools(".", null, () => {}, citationsOf("e1"), null, null, null);
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (!add) throw new Error("no add_latent_probe");
    await add.execute("c1", probeParams);
    expect(acc).toHaveLength(1);
  });

  it("a validator stop error propagates out of the tool (halts the stage for the operator)", async () => {
    const { tools } = buildLatentTools(
      ".",
      null,
      () => {},
      citationsOf("e1"),
      null,
      async () => {
        throw new (await import("../../src/manifest/probe-validate.js")).ProbeValidationStoppedError(
          "stage ended without calling report_verdict",
        );
      },
      null,
    );
    const add = tools.find((t) => t.name === "add_latent_probe");
    if (!add) throw new Error("no add_latent_probe");
    await expect(add.execute("c1", probeParams)).rejects.toThrow(/report_verdict/);
  });
});
