// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Probe, ScenarioManifest } from "../../src/manifest/schema.js";
import { clearBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";
import type { ArmBase } from "../../src/orchestrate/phase1.js";
import { extractProbeAnswer, type ProbeOps, ProbeStoppedError, runProbes } from "../../src/orchestrate/probes.js";
import { AgentSettledAbortedError } from "../../src/session/done.js";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { appendProbe } from "../../src/storage/branches.js";

// --- fixtures ----------------------------------------------------------------

const PROBES: readonly Probe[] = [
  {
    question: "Which rendering library did we settle on?",
    accept: ["canvas"],
    targets: ["e1"],
    lanes: ["direct-probe"],
  },
  { question: "What database did we abandon earlier?", accept: ["sqlite"], targets: ["e2"], lanes: ["direct-probe"] },
];

function makeManifest(probes: readonly Probe[]): ScenarioManifest {
  return {
    id: "scen-1",
    description: "an incremental economic tycoon",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "build to the boundary" },
    recallFacts: [],
    doneOps: [],
    supersessions: [],
    abstentions: [],
    taskObjective: { description: "the game", testSpec: "npm test" },
    probes,
  } as unknown as ScenarioManifest;
}

function makeArmBase(arm: string, tool: string, ver: string | undefined): ArmBase {
  return {
    arm: arm as ArmBase["arm"],
    tool,
    ver,
    cfgId: "cfg-test1",
    branch: `bench-compact/run-2026-08-11-1/cfg-test1/arm-${tool}${ver === undefined ? "" : `-${ver}`}`,
    wallMs: 1000,
    usage: undefined,
  };
}

// --- fake fresh pi + ops -----------------------------------------------------

/** A fake fresh pi: sendUserMessage (the inject seam target) over a tiny event bus. */
interface FreshPi {
  pi: ExtensionAPI;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFreshPi(): FreshPi {
  const on = (): (() => void) => () => {};
  const sendUserMessage = vi.fn();
  const pi = { sendUserMessage, events: { on, emit: () => {} } } as unknown as ExtensionAPI;
  return { pi, sendUserMessage };
}

interface FakeProbeOps {
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  awaitSettled: ReturnType<typeof vi.fn>;
  isQaOnly: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  readAnswer: ReturnType<typeof vi.fn>;
  freshPis: FreshPi[];
  freshCtxs: ExtensionCommandContext[];
}

function makeFakeProbeOps(opts: { qaOnly?: boolean; answer?: string; reject?: Error } = {}): FakeProbeOps {
  const qaOnly = opts.qaOnly ?? true;
  const answer = opts.answer ?? "the agent's answer";
  const reject = opts.reject;
  const freshPis: FreshPi[] = [];
  const freshCtxs: ExtensionCommandContext[] = [];
  return {
    loadSession: vi.fn(
      async (
        _ctx: ExtensionCommandContext,
        _path: string,
        cb: (c: ExtensionCommandContext) => Promise<unknown>,
      ): Promise<unknown> => {
        const fresh = makeFreshPi();
        const freshCtx = { id: `fresh-ctx-${freshCtxs.length + 1}` } as unknown as ExtensionCommandContext;
        freshPis.push(fresh);
        freshCtxs.push(freshCtx);
        setBenchPi(fresh.pi); // re-activation stashes the fresh pi BEFORE withSession runs
        return cb(freshCtx);
      },
    ),
    fork: vi.fn(),
    checkout: vi.fn(),
    branchExists: vi.fn(() => false),
    commit: vi.fn(),
    awaitSettled: vi.fn(async (): Promise<void> => {
      if (reject !== undefined) throw reject;
    }),
    isQaOnly: vi.fn(() => qaOnly),
    deleteBranch: vi.fn(),
    readAnswer: vi.fn((): string => answer),
    freshPis,
    freshCtxs,
  };
}

describe("runProbes — direct probes per arm (fork → load → inject → settle → answer → lifecycle)", () => {
  let repo: string;
  let cmdCtx: ExtensionCommandContext;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-probes-"));
    cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    clearBenchPi();
  });

  it("forks arm-base → probe branches (one per probe), commits each, returns a trace per probe", async () => {
    const ops = makeFakeProbeOps({ answer: "canvas was chosen" });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(traces).toHaveLength(2);
    // one fork per probe, from the arm base, into the 1-based probe branch
    expect(ops.fork).toHaveBeenCalledTimes(2);
    expect(ops.fork.mock.calls[0]).toEqual([repo, base.branch, appendProbe(base.branch, "1")]);
    expect(ops.fork.mock.calls[1]).toEqual([repo, base.branch, appendProbe(base.branch, "2")]);
    // one checkout + one commit per probe
    expect(ops.checkout).toHaveBeenCalledTimes(2);
    expect(ops.checkout.mock.calls[0]).toEqual([repo, appendProbe(base.branch, "1")]);
    expect(ops.commit).toHaveBeenCalledTimes(2);
    // the canned answer flows into the trace; readAnswer received the repo
    expect(ops.readAnswer.mock.calls[0]?.[0]).toBe(repo);
    expect(traces[0]?.answer).toBe("canvas was chosen");
    expect(traces[0]?.probeId).toBe("1");
    expect(traces[0]?.branch).toBe(appendProbe(base.branch, "1"));
    expect(traces[0]?.arm).toBe("A1");
  });

  it("injects ANTI_PEEK_PROMPT + the probe question as a followUp on the FRESH pi", async () => {
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest([PROBES[0]]),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.freshPis).toHaveLength(1);
    const calls = ops.freshPis[0]?.sendUserMessage.mock.calls ?? [];
    expect(calls).toHaveLength(1);
    const body = calls[0]?.[0] as string;
    expect(body.startsWith(ANTI_PEEK_PROMPT)).toBe(true);
    expect(body).toContain(PROBES[0]?.question as string);
    expect(calls[0]?.[1]).toEqual({ deliverAs: "followUp" });
  });

  it("threads the fresh ctx from each withSession into the next probe's switchSession", async () => {
    // CR-R1-1 regression guard (mirrors phase1/phase2): switchSession invalidates the
    // ctx it's called on, so probe 2+ MUST use the fresh ctx threaded from the prior
    // probe's withSession, NOT the stale command-handler ctx.
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.loadSession.mock.calls[0]?.[0]).toBe(cmdCtx); // probe 1 starts from cmdCtx
    expect(ops.loadSession.mock.calls[1]?.[0]).toBe(ops.freshCtxs[0]); // probe 2 threads probe-1 fresh ctx
    expect(ops.loadSession.mock.calls[1]?.[0]).not.toBe(cmdCtx);
  });

  it("each probe's inject lands on ITS OWN fresh pi (never the stale command-handler pi, never a sibling's)", async () => {
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.freshPis).toHaveLength(2);
    expect(ops.freshPis[0]?.pi).not.toBe(ops.freshPis[1]?.pi);
    expect(ops.freshPis[0]?.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ops.freshPis[1]?.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("a Q&A-only probe branch (isQaOnly=true) is DELETED + reported kept=false", async () => {
    const ops = makeFakeProbeOps({ qaOnly: true });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.deleteBranch).toHaveBeenCalledTimes(2);
    expect(ops.deleteBranch.mock.calls[0]).toEqual([repo, appendProbe(base.branch, "1")]);
    expect(traces.every((t) => t.kept === false)).toBe(true);
  });

  it("a non-Q&A-only probe branch (isQaOnly=false) is KEPT (not deleted) + reported kept=true", async () => {
    const ops = makeFakeProbeOps({ qaOnly: false });
    const { traces } = await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.deleteBranch).not.toHaveBeenCalled();
    expect(traces.every((t) => t.kept === true)).toBe(true);
  });

  it("is idempotent on re-run: skips fork when the probe branch already exists", async () => {
    const ops = makeFakeProbeOps();
    ops.branchExists = vi.fn(() => true);
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest(PROBES),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.checkout).toHaveBeenCalledTimes(2);
    expect(ops.loadSession).toHaveBeenCalledTimes(2);
  });

  it("returns no traces (and does no git work) when the manifest has no probes", async () => {
    const ops = makeFakeProbeOps();
    const { traces } = await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      manifest: makeManifest([]),
      repo,
      ops: ops as unknown as ProbeOps,
    });

    expect(traces).toEqual([]);
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
  });
});

describe("runProbes — stop-and-surface (probe failure / hang)", () => {
  let repo: string;
  let cmdCtx: ExtensionCommandContext;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-probes-stop-"));
    cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    clearBenchPi();
  });

  it("an awaitAgentSettled abort → rejects ProbeStoppedError(probe-hung) + does NOT commit", async () => {
    const ops = makeFakeProbeOps({ reject: new AgentSettledAbortedError(new Error("signal aborted")) });
    await expect(
      runProbes({
        cmdCtx,
        armBase: makeArmBase("A1", "bare-pi", undefined),
        manifest: makeManifest([PROBES[0]]),
        repo,
        ops: ops as unknown as ProbeOps,
      }),
    ).rejects.toMatchObject({ arm: "A1", probeId: "1", reason: "probe-hung" });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("a non-abort inject/settle error → rejects ProbeStoppedError(probe-failed)", async () => {
    const ops = makeFakeProbeOps({ reject: new Error("inject blew up") });
    await expect(
      runProbes({
        cmdCtx,
        armBase: makeArmBase("A2", "om-default", "g1a2b3c"),
        manifest: makeManifest([PROBES[0]]),
        repo,
        ops: ops as unknown as ProbeOps,
      }),
    ).rejects.toMatchObject({ arm: "A2", probeId: "1", reason: "probe-failed" });
  });

  it("ProbeStoppedError carries arm + probeId + reason + message", () => {
    const err = new ProbeStoppedError("A3", "2", "probe-hung", "agent never settled");
    expect(err.arm).toBe("A3");
    expect(err.probeId).toBe("2");
    expect(err.reason).toBe("probe-hung");
    expect(err.message).toBe("agent never settled");
    expect(err.name).toBe("ProbeStoppedError");
  });
});

describe("extractProbeAnswer — last assistant message text off parsed entries", () => {
  let seq: number;
  beforeEach(() => {
    seq = 0;
  });

  /** Build a minimal message entry cast to SessionEntry (only the fields the extractor reads). */
  function msgEntry(role: string, blocks: unknown[]): SessionEntry {
    return { type: "message", id: `e${seq++}`, message: { role, content: blocks } } as unknown as SessionEntry;
  }
  /** A non-message (custom/compaction) entry. */
  function otherEntry(type: string): SessionEntry {
    return { type, id: `e${seq++}` } as unknown as SessionEntry;
  }

  it("returns the assistant response text after the probe inject (most recent wins)", () => {
    const entries: SessionEntry[] = [
      msgEntry("assistant", [{ type: "text", text: "stale base answer" }]),
      msgEntry("user", [{ type: "text", text: "probe question" }]),
      msgEntry("assistant", [{ type: "text", text: "first answer" }]),
      msgEntry("assistant", [{ type: "text", text: "final answer" }]),
    ];
    expect(extractProbeAnswer(entries)).toBe("final answer");
  });

  it("joins multiple text blocks of the response", () => {
    const entries: SessionEntry[] = [
      msgEntry("user", [{ type: "text", text: "q" }]),
      msgEntry("assistant", [
        { type: "text", text: "part one. " },
        { type: "text", text: "part two." },
      ]),
    ];
    expect(extractProbeAnswer(entries)).toBe("part one. part two.");
  });

  it("ignores thinking blocks (only text blocks count as the answer)", () => {
    const entries: SessionEntry[] = [
      msgEntry("user", [{ type: "text", text: "q" }]),
      msgEntry("assistant", [
        { type: "thinking", text: "internal reasoning" },
        { type: "text", text: "the visible answer" },
      ]),
    ];
    expect(extractProbeAnswer(entries)).toBe("the visible answer");
  });

  it("bounds to after the inject — does NOT scan into the compacted-base history (R1-1 contamination regression)", () => {
    // The probe response is tool-call-only (no text); the base has a prior assistant text.
    // The extractor MUST return "" (no clean text answer), NOT the stale base text.
    const entries: SessionEntry[] = [
      msgEntry("user", [{ type: "text", text: "base user msg" }]),
      msgEntry("assistant", [{ type: "text", text: "STALE BASE ANSWER" }]),
      msgEntry("user", [{ type: "text", text: "probe question" }]),
      msgEntry("assistant", [{ type: "toolCall", name: "read_file", args: {} }]),
    ];
    expect(extractProbeAnswer(entries)).toBe("");
  });

  it("a tool-call-only response after the inject returns '' (no clean text answer)", () => {
    const entries: SessionEntry[] = [
      msgEntry("user", [{ type: "text", text: "q" }]),
      msgEntry("assistant", [{ type: "toolCall", name: "read_file", args: {} }]),
    ];
    expect(extractProbeAnswer(entries)).toBe("");
  });

  it("no assistant response after the inject returns '' (no scan into base)", () => {
    const entries: SessionEntry[] = [
      msgEntry("assistant", [{ type: "text", text: "stale base" }]),
      msgEntry("user", [{ type: "text", text: "probe question" }]),
      otherEntry("compaction"),
    ];
    expect(extractProbeAnswer(entries)).toBe("");
  });

  it("no user message (no inject) returns ''", () => {
    const entries: SessionEntry[] = [msgEntry("assistant", [{ type: "text", text: "orphan" }])];
    expect(extractProbeAnswer(entries)).toBe("");
  });

  it("returns '' for an empty entry list", () => {
    expect(extractProbeAnswer([])).toBe("");
  });
});
