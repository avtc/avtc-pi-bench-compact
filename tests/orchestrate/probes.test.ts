// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryProxies, type MemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";
import type { Probe, ScenarioManifest } from "../../src/manifest/schema.js";
import { clearBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";
import type { ArmBase } from "../../src/orchestrate/phase1.js";
import { extractProbeAnswer, type ProbeOps, ProbeStoppedError, runProbes } from "../../src/orchestrate/probes.js";
import { AgentSettledAbortedError } from "../../src/session/done.js";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { appendProbeAttempt } from "../../src/storage/branches.js";
import { branchSessionFile } from "../../src/storage/paths.js";

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

/** A fake fresh pi: sendUserMessage (the inject seam target) over the agent-event
 * handler surface (`pi.on`; emit is unused in these tests — the probes drive path
 * registers no listeners the tests fire). */
interface FreshPi {
  pi: ExtensionAPI;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFreshPi(): FreshPi {
  const sendUserMessage = vi.fn();
  const pi = { sendUserMessage, setActiveTools: vi.fn(), on: () => {} } as unknown as ExtensionAPI;
  return { pi, sendUserMessage };
}

interface FakeProbeOps {
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  sessionExists: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  commitCountAhead: ReturnType<typeof vi.fn>;
  copySeed: ReturnType<typeof vi.fn>;
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
        setMemoryProxies({
          om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
          mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
        } as unknown as MemoryProxies);
        return cb(freshCtx);
      },
    ),
    fork: vi.fn(),
    checkout: vi.fn(),
    branchExists: vi.fn(() => false),
    sessionExists: vi.fn(() => false),
    commit: vi.fn(),
    commitCountAhead: vi.fn(() => 0),
    copySeed: vi.fn(),
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
    clearMemoryProxies();
  });

  it("forks arm-base → probe branches (one per probe), commits each, returns a trace per probe", async () => {
    const ops = makeFakeProbeOps({ answer: "canvas was chosen" });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });

    expect(traces).toHaveLength(2);
    // one fork per probe, from the arm base, into the 1-based probe branch
    expect(ops.fork).toHaveBeenCalledTimes(2);
    expect(ops.fork.mock.calls[0]).toEqual([repo, base.branch, appendProbeAttempt(base.branch, "1", 1)]);
    expect(ops.fork.mock.calls[1]).toEqual([repo, base.branch, appendProbeAttempt(base.branch, "2", 1)]);
    // one checkout + one commit per probe
    expect(ops.checkout).toHaveBeenCalledTimes(2);
    expect(ops.checkout.mock.calls[0]).toEqual([repo, appendProbeAttempt(base.branch, "1", 1)]);
    expect(ops.commit).toHaveBeenCalledTimes(2);
    // each probe's session file is seeded from its arm base's + readAnswer receives the probe file (NOT the repo)
    expect(ops.copySeed.mock.calls[0]).toEqual([
      branchSessionFile(join(repo, "sessions"), base.branch),
      branchSessionFile(join(repo, "sessions"), appendProbeAttempt(base.branch, "1", 1)),
    ]);
    expect(ops.readAnswer.mock.calls[0]?.[0]).toBe(
      branchSessionFile(join(repo, "sessions"), appendProbeAttempt(base.branch, "1", 1)),
    );
    expect(traces[0]?.answer).toBe("canvas was chosen");
    expect(traces[0]?.probeId).toBe("1");
    expect(traces[0]?.branch).toBe(appendProbeAttempt(base.branch, "1", 1));
    expect(traces[0]?.arm).toBe("A1");
  });

  it("forks probes N× per arm (one set per attempt) → N×probes traces, branch names carry the attempt suffix, each tagged with attempt", async () => {
    const ops = makeFakeProbeOps({ answer: "canvas was chosen" });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 3,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });

    // N×probes = 3×2 = 6 independent forks (one probe-set per attempt)
    expect(traces).toHaveLength(6);
    expect(ops.fork).toHaveBeenCalledTimes(6);
    // each (probe, attempt) gets its own branch with the attempt suffix (no collision)
    const forkedBranches = ops.fork.mock.calls.map((c) => c[2] as string);
    expect(new Set(forkedBranches).size).toBe(6); // all distinct
    expect(forkedBranches).toContain(appendProbeAttempt(base.branch, "1", 1));
    expect(forkedBranches).toContain(appendProbeAttempt(base.branch, "2", 3));
    // every attempt is sampled for every probe (attempt tag present + spans 1..3)
    const attempts = new Set(traces.map((t) => t.attempt));
    expect(attempts).toEqual(new Set([1, 2, 3]));
    // each attempt contributes one trace per probe (probeIds 1 + 2)
    for (const attempt of [1, 2, 3]) {
      const attemptTraces = traces.filter((t) => t.attempt === attempt);
      expect(attemptTraces).toHaveLength(2);
      expect(attemptTraces.map((t) => t.probeId).sort()).toEqual(["1", "2"]);
      expect(attemptTraces.every((t) => t.branch.endsWith(`-${attempt}`))).toBe(true);
    }
  });

  it("repaints the widget after each probe's session switch (pi clears all extension widgets on switchSession)", async () => {
    const ops = makeFakeProbeOps();
    const widget = {
      show: vi.fn(),
      startPhase: vi.fn(),
      setStatus: vi.fn(),
      setArm: vi.fn(),
      setDetail: vi.fn(),
      setCtxWindow: vi.fn(),
      onEvent: vi.fn(),
      hide: vi.fn(),
    };
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      widget,
      ops: ops as unknown as ProbeOps,
    });

    // one repaint per probe, INSIDE the withSession callback (post-switchSession —
    // pi's teardownCurrent → clearExtensionWidgets wiped it at the fork)
    expect(widget.show).toHaveBeenCalledTimes(PROBES.length);
  });

  it("injects ANTI_PEEK_PROMPT + the probe question as a followUp on the FRESH pi", async () => {
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
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
    // regression guard (mirrors phase1/phase2): switchSession invalidates the
    // ctx it's called on, so probe 2+ MUST use the fresh ctx threaded from the prior
    // probe's withSession, NOT the stale command-handler ctx.
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
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
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.freshPis).toHaveLength(2);
    expect(ops.freshPis[0]?.pi).not.toBe(ops.freshPis[1]?.pi);
    expect(ops.freshPis[0]?.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ops.freshPis[1]?.sendUserMessage).toHaveBeenCalledTimes(1);
    // arm re-isolation: configureArm fires per probe fork (setActiveTools on each fresh pi),
    // so the probe phase keeps each arm's tool allowlist.
    for (const fresh of ops.freshPis) {
      expect((fresh.pi as unknown as { setActiveTools: ReturnType<typeof vi.fn> }).setActiveTools).toHaveBeenCalled();
    }
  });

  it("a Q&A-only probe branch (isQaOnly=true) is DELETED + reported kept=false", async () => {
    const ops = makeFakeProbeOps({ qaOnly: true });
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.deleteBranch).toHaveBeenCalledTimes(2);
    expect(ops.deleteBranch.mock.calls[0]).toEqual([repo, appendProbeAttempt(base.branch, "1", 1)]);
    expect(traces.every((t) => t.kept === false)).toBe(true);
  });

  it("a non-Q&A-only probe branch (isQaOnly=false) is KEPT (not deleted) + reported kept=true", async () => {
    const ops = makeFakeProbeOps({ qaOnly: false });
    const { traces } = await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.deleteBranch).not.toHaveBeenCalled();
    expect(traces.every((t) => t.kept === true)).toBe(true);
  });

  it("a pre-existing probe branch is a CONFLICT — ProbeStoppedError(branch-conflict), no re-seed/commit", async () => {
    // Branch names embed the runId; a fresh run never reuses one within an output
    // root. An existing probe branch means a prior run derived the same id against
    // this shared scenario repo — stop + surface instead of corrupting both runs.
    const ops = makeFakeProbeOps();
    ops.branchExists = vi.fn(() => true);
    await expect(
      runProbes({
        cmdCtx,
        armBase: makeArmBase("A1", "bare-pi", undefined),
        N: 1,
        manifest: makeManifest(PROBES),
        repo,
        sessionsDir: join(repo, "sessions"),
        omFullReflectionThresholdTokens: 4000,
        ops: ops as unknown as ProbeOps,
      }),
    ).rejects.toMatchObject({ name: "ProbeStoppedError", arm: "A1", probeId: "1", reason: "branch-conflict" });
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.copySeed).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
  });

  it("returns no traces (and does no git work) when the manifest has no probes", async () => {
    const ops = makeFakeProbeOps();
    const { traces } = await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest([]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
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
    clearMemoryProxies();
  });

  it("an awaitAgentSettled abort → rejects ProbeStoppedError(probe-hung) + does NOT commit", async () => {
    const ops = makeFakeProbeOps({ reject: new AgentSettledAbortedError(new Error("signal aborted")) });
    await expect(
      runProbes({
        cmdCtx,
        armBase: makeArmBase("A1", "bare-pi", undefined),
        N: 1,
        manifest: makeManifest([PROBES[0]]),
        repo,
        sessionsDir: join(repo, "sessions"),
        omFullReflectionThresholdTokens: 4000,
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
        N: 1,
        manifest: makeManifest([PROBES[0]]),
        repo,
        sessionsDir: join(repo, "sessions"),
        omFullReflectionThresholdTokens: 4000,
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

describe("runProbes — crash resume (skip committed probes)", () => {
  let repo: string;
  let cmdCtx: ExtensionCommandContext;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-probes-resume-"));
    cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    clearBenchPi();
    clearMemoryProxies();
  });

  it("skips a committed probe branch: answer re-read off the session file, lifecycle re-checked, NO fork/load/commit", async () => {
    const ops = makeFakeProbeOps({ answer: "the remembered answer" });
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.isQaOnly = vi.fn(() => false); // the existing branch was KEPT at completion
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces, finalCtx } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest(PROBES),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });

    expect(traces).toHaveLength(2);
    for (const trace of traces) {
      expect(trace).toMatchObject({ arm: "A1", attempt: 1, answer: "the remembered answer", kept: true });
      // the answer is re-read off the probe's EXISTING session file
      expect(ops.readAnswer).toHaveBeenCalledWith(branchSessionFile(join(repo, "sessions"), trace.branch));
      // the lifecycle is re-checked against the base (so a crash between commit + Q&A delete still deletes)
      expect(ops.isQaOnly).toHaveBeenCalled();
    }
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(finalCtx).toEqual({ id: "cmd-handler-ctx" }); // no switchSession ran
  });

  it("a resumed probe that turns out Q&A-only is deleted on resume (kept=false, lifecycle faithful)", async () => {
    const ops = makeFakeProbeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.isQaOnly = vi.fn(() => true); // crash landed between the commit + the Q&A delete
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });
    expect(traces[0]?.kept).toBe(false);
    expect(ops.deleteBranch).toHaveBeenCalledWith(repo, appendProbeAttempt(base.branch, "1", 1));
  });

  it("deletes + re-runs a probe branch that exists but is NOT committed (crash mid-probe)", async () => {
    const ops = makeFakeProbeOps({ answer: "fresh answer" });
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 0);
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.deleteBranch).toHaveBeenCalledWith(repo, appendProbeAttempt(base.branch, "1", 1));
    expect(ops.deleteBranch.mock.invocationCallOrder[0]).toBeLessThan(ops.fork.mock.invocationCallOrder[0]);
    expect(ops.fork).toHaveBeenCalledTimes(1);
    expect(ops.loadSession).toHaveBeenCalledTimes(1);
    expect(ops.commit).toHaveBeenCalledTimes(1);
    expect(traces[0]?.answer).toBe("fresh answer");
  });

  it("re-reads a PRUNED probe's answer off its session file (branch gone, answer complete) — no re-probe", async () => {
    const ops = makeFakeProbeOps({ answer: "prior answer" });
    ops.sessionExists = vi.fn(() => true); // the session file survived the branch prune
    const base = makeArmBase("A1", "bare-pi", undefined);
    const { traces, finalCtx } = await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });

    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(ops.isQaOnly).not.toHaveBeenCalled(); // no branch to diff — pruned ⟹ Q&A-only
    expect(ops.readAnswer).toHaveBeenCalledWith(branchSessionFile(join(repo, "sessions"), traces[0]?.branch ?? ""));
    expect(traces[0]).toMatchObject({ arm: "A1", attempt: 1, probeId: "1", answer: "prior answer", kept: false });
    expect(finalCtx).toEqual({ id: "cmd-handler-ctx" }); // no switchSession ran
  });

  it("re-runs a pruned probe whose session file is MISSING (never ran on this manifest)", async () => {
    const ops = makeFakeProbeOps({ answer: "fresh answer" });
    ops.sessionExists = vi.fn(() => false);
    const base = makeArmBase("A1", "bare-pi", undefined);
    await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });
    expect(ops.fork).toHaveBeenCalledTimes(1);
  });

  it("re-runs a pruned probe whose session has NO answer yet (crashed mid-turn)", async () => {
    const ops = makeFakeProbeOps({ answer: "" }); // partial session: question in, no assistant text
    ops.sessionExists = vi.fn(() => true);
    const base = makeArmBase("A1", "bare-pi", undefined);
    await runProbes({
      cmdCtx,
      armBase: base,
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      resume: true,
      ops: ops as unknown as ProbeOps,
    });
    expect(ops.fork).toHaveBeenCalledTimes(1); // fell through to the fresh-probe path
  });

  it("a pre-existing probe branch on the NON-resume path is still a hard conflict", async () => {
    const ops = makeFakeProbeOps();
    ops.branchExists = vi.fn(() => true);
    await expect(
      runProbes({
        cmdCtx,
        armBase: makeArmBase("A1", "bare-pi", undefined),
        N: 1,
        manifest: makeManifest([PROBES[0]]),
        repo,
        sessionsDir: join(repo, "sessions"),
        omFullReflectionThresholdTokens: 4000,
        ops: ops as unknown as ProbeOps,
      }),
    ).rejects.toMatchObject({ arm: "A1", probeId: "1", reason: "branch-conflict" });
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

  it("bounds to after the inject — does NOT scan into the compacted-base history (contamination regression)", () => {
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

describe("runProbes — fast eval (probes-only) pause preamble", () => {
  let repo: string;
  let cmdCtx: ExtensionCommandContext;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-probes-fast-"));
    cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("prefixes the pause-goal preamble between ANTI_PEEK and the question", async () => {
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      probesOnly: true,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });
    const body = ops.freshPis[0]?.sendUserMessage.mock.calls[0]?.[0] as string;
    expect(body.startsWith(ANTI_PEEK_PROMPT)).toBe(true);
    expect(body).toContain("Pause your work on the goal for now");
    const preamble = body.slice(body.indexOf("Pause your work"));
    expect(preamble).not.toContain("do not"); // no tool/work prohibition — retrieval stays allowed
    expect(preamble).not.toContain("run tools");
    expect(body).toContain(PROBES[0]?.question as string);
    expect(body.indexOf("Pause your work")).toBeGreaterThan(body.indexOf(ANTI_PEEK_PROMPT)); // after anti-peek
  });

  it("without the flag the body stays ANTI_PEEK + question (no pause preamble)", async () => {
    const ops = makeFakeProbeOps();
    await runProbes({
      cmdCtx,
      armBase: makeArmBase("A1", "bare-pi", undefined),
      N: 1,
      manifest: makeManifest([PROBES[0]]),
      repo,
      sessionsDir: join(repo, "sessions"),
      omFullReflectionThresholdTokens: 4000,
      ops: ops as unknown as ProbeOps,
    });
    const body = ops.freshPis[0]?.sendUserMessage.mock.calls[0]?.[0] as string;
    expect(body).not.toContain("Pause your work on the goal");
  });
});
