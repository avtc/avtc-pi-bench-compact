// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WidgetPort } from "../../src/widget/active-widget.js";

/** A capturing WidgetPort: records setArm calls. */
function capturingWidget(): WidgetPort & { arms: string[] } {
  const arms: string[] = [];
  return {
    arms,
    show: () => {},
    startPhase: () => {},
    setStatus: () => {},
    setArm: (index, total, tool) => {
      arms.push(`${index}/${total}:${tool}`);
    },
    setDetail: () => {},
    setCtxWindow: () => {},
    onEvent: () => {},
    hide: () => {},
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Usage shape (from @earendil-works/pi-ai) — typed via CompactionEntry.usage to avoid a fragile cross-package import. */
type Usage = NonNullable<CompactionEntry["usage"]>;

import { ARM_DEFS } from "../../src/arms/definitions.js";
import { clearMemoryProxies, type MemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";
import { BUILTIN_TOOLS, SUITE_TOOLS } from "../../src/arms/switch.js";
import type { VersionResolver } from "../../src/arms/version.js";
import type { BenchConfig } from "../../src/config/types.js";
import { clearBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";
import {
  type ArmBase,
  buildRunConfig,
  type Phase1Deps,
  type Phase1Ops,
  Phase1StoppedError,
  runPhase1,
} from "../../src/orchestrate/phase1.js";
import { clearRunState } from "../../src/orchestrate/run-state.js";
import { CompactionCancelledError } from "../../src/session/compact.js";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { buildArmBaseBranch } from "../../src/storage/branches.js";
import { branchSessionFile } from "../../src/storage/paths.js";

// --- fake builders ----------------------------------------------------------

function makeUsage(input: number, output: number): Usage {
  const cost = (input + output) * 0.000001;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: input * 0.000001, output: output * 0.000001, cacheRead: 0, cacheWrite: 0, total: cost },
    totalTokens: input + output,
  };
}

function makeCompactionEntry(overrides: Partial<CompactionEntry>): CompactionEntry {
  return {
    type: "compaction",
    id: "c1",
    parentId: "p1",
    timestamp: "2026-08-11T00:00:00.000Z",
    summary: "compacted summary of earlier work",
    firstKeptEntryId: "k1",
    tokensBefore: 150000,
    usage: makeUsage(1000, 500),
    fromHook: false,
    ...overrides,
  } as CompactionEntry;
}

interface FakePi {
  pi: ExtensionAPI;
  sendUserMessage: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
}

/** A fake pi satisfying the inject seam (sendUserMessage) + the tool-allowlist seam (setActiveTools). */
function makeFakePi(): FakePi {
  const sendUserMessage = vi.fn();
  const setActiveTools = vi.fn();
  return { pi: { sendUserMessage, setActiveTools } as unknown as ExtensionAPI, sendUserMessage, setActiveTools };
}

interface FakeProxies {
  om: { reloadConfig: ReturnType<typeof vi.fn>; getConfig: ReturnType<typeof vi.fn> };
  mk: { reloadConfig: ReturnType<typeof vi.fn>; getConfig: ReturnType<typeof vi.fn> };
}

function makeProxies(): FakeProxies {
  return {
    om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
    mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
  };
}

interface FakeOps {
  trigger: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  copySeed: ReturnType<typeof vi.fn>;
  appendAntiPeek: ReturnType<typeof vi.fn>;
  commitCountAhead: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  newestBranches: ReturnType<typeof vi.fn>;
  /** The fresh pi stashed per loadSession call (one per arm) — for assertions. */
  freshPis: FakePi[];
  /** The fresh proxies stashed per loadSession call (one per arm) — for assertions. */
  freshProxies: FakeProxies[];
  /** The fresh ctx passed to each withSession callback — for assertions. */
  freshCtxs: ExtensionCommandContext[];
}

/**
 * Builds fake ops whose `loadSession` MODELS switchSession's re-activation: each call
 * generates a DISTINCT fresh pi + fresh proxies + fresh ctx, stashes the fresh pi +
 * proxies on globalThis (as activate would on re-activation), then invokes the
 * withSession callback with the fresh ctx. This reproduces the real lifecycle where
 * the command-handler pi/ctx go STALE after switchSession and runPhase1 MUST read the
 * fresh handles from globalThis — so tests asserting "fresh pi used, stale pi not
 * used" are non-tautological.
 */
function makeFakeOps(): FakeOps {
  const freshPis: FakePi[] = [];
  const freshProxies: FakeProxies[] = [];
  const freshCtxs: ExtensionCommandContext[] = [];
  return {
    trigger: vi.fn(async () => ({ compactionEntry: makeCompactionEntry({}), wallMs: 4200 })),
    loadSession: vi.fn(async (_ctx: unknown, _path: string, cb: (ctx: ExtensionCommandContext) => Promise<unknown>) => {
      const pi = makeFakePi();
      const proxies = makeProxies();
      const ctx = { id: `fresh-ctx-${freshCtxs.length + 1}` } as unknown as ExtensionCommandContext;
      freshPis.push(pi);
      freshProxies.push(proxies);
      freshCtxs.push(ctx);
      // Re-activation: activate(freshPi) stashes the fresh pi + proxies BEFORE withSession runs.
      setBenchPi(pi.pi);
      setMemoryProxies(proxies as unknown as MemoryProxies);
      return cb(ctx);
    }),
    fork: vi.fn(),
    checkout: vi.fn(),
    commit: vi.fn(),
    branchExists: vi.fn(() => false),
    copySeed: vi.fn(),
    appendAntiPeek: vi.fn(),
    commitCountAhead: vi.fn(() => 0),
    deleteBranch: vi.fn(),
    exists: vi.fn(() => false),
    newestBranches: vi.fn(() => []),
    freshPis,
    freshProxies,
    freshCtxs,
  };
}

function makeDeps(opts: {
  ops: FakeOps;
  scenarioRepo: string;
  sessionsDir: string;
  armsEnabled: BenchConfig["armsEnabled"];
  cmdCtx?: ExtensionCommandContext;
  widget?: WidgetPort | null;
  resume?: boolean;
  reuseBases?: boolean;
}): Phase1Deps {
  return {
    cmdCtx: opts.cmdCtx ?? ({ id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext),
    scenarioRepo: opts.scenarioRepo,
    sessionsDir: opts.sessionsDir,
    date: "2026-08-11",
    id: 1,
    cfgId: "cfg-test1",
    toolVersions: { A2: { source: "git", commit: "gabc123", full: "abcdef1234567890" } },
    omFullReflectionThresholdTokens: 4000,
    armsEnabled: opts.armsEnabled,
    widget: opts.widget,
    resume: opts.resume ?? false,
    reuseBases: opts.reuseBases ?? false,
    ops: opts.ops as unknown as Phase1Ops,
  };
}

afterEach(() => {
  clearRunState();
  clearBenchPi();
  clearMemoryProxies();
});

// --- runPhase1 (inline for-loop over arms — fresh pi/ctx per arm via re-activation) ---

describe("runPhase1 — per-arm configure + fork + compact + commit (NO ctx.reload)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("per arm: fork main→arm-base → checkout → seed session → load+configure+inject+compact → commit", async () => {
    const ops = makeFakeOps();
    const sessionsDir = join(repo, "sessions");
    const deps = makeDeps({ ops, scenarioRepo: repo, sessionsDir, armsEnabled: ["A1", "A3"] });

    const { bases } = await runPhase1(deps);

    expect(bases).toHaveLength(2);
    // arm 1 (bare-pi)
    const b1 = bases[0] as ArmBase;
    expect(b1.arm).toBe("A1");
    expect(b1.tool).toBe("bare-pi");
    expect(b1.ver).toBeUndefined(); // bare-pi omits {ver}
    expect(b1.cfgId).toBe("cfg-test1");
    expect(b1.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: "cfg-test1", tool: "bare-pi", ver: undefined }),
    );
    expect(b1.wallMs).toBe(4200);
    expect(b1.usage).toEqual(makeUsage(1000, 500));
    expect(ops.fork).toHaveBeenCalledWith(repo, "main", b1.branch);
    expect(ops.checkout).toHaveBeenCalledWith(repo, b1.branch);
    // the arm's session file is seeded from main's + loadSession receives the arm's file (NOT ${repo}/session.jsonl)
    expect(ops.copySeed).toHaveBeenCalledWith(
      branchSessionFile(sessionsDir, "main"),
      branchSessionFile(sessionsDir, b1.branch),
    );
    expect(ops.loadSession).toHaveBeenCalledWith(
      expect.anything(),
      branchSessionFile(sessionsDir, b1.branch),
      expect.any(Function),
    );
    expect(ops.commit).toHaveBeenCalledWith(repo, expect.stringContaining("phase-1"));
    // arm 2 (memkeeper-builder) carries the resolved tool version
    const b2 = bases[1] as ArmBase;
    expect(b2.arm).toBe("A3");
    expect(b2.tool).toBe("memkeeper-builder");
    expect(b2.ver).toBeUndefined(); // A3 has no toolVersions entry in the fake deps
  });

  it("calls widget.setArm per arm (index/total/tool)", async () => {
    const ops = makeFakeOps();
    const widget = capturingWidget();
    await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1", "A3"], widget }),
    );
    expect(widget.arms).toEqual(["1/2:bare-pi", "2/2:memkeeper-builder"]);
  });

  it("reads the FRESH pi from globalThis inside each withSession (not the stale command-handler pi)", async () => {
    // regression guard: switchSession invalidates the command-handler pi, so
    // runPhase1 MUST use the fresh pi stashed by re-activation. This test fails
    // (setActiveTools never called on the fresh pi) if runPhase1 used a stale pi.
    const ops = makeFakeOps();
    await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A2", "A3"] }),
    );

    expect(ops.freshPis).toHaveLength(2);
    // arm 1's fresh pi received A2's allowlist (recall); arm 2's fresh pi received A3's (mk_recall).
    expect(ops.freshPis[0]?.setActiveTools).toHaveBeenCalledWith([...BUILTIN_TOOLS, ...SUITE_TOOLS, "recall"]);
    expect(ops.freshPis[1]?.setActiveTools).toHaveBeenCalledWith([...BUILTIN_TOOLS, ...SUITE_TOOLS, "mk_recall"]);
    // the anti-peek entry is APPENDED to the arm session file (no agent turn fires —
    // sendUserMessage would start one) + the trigger ran against the FRESH pi (arm 1)
    expect(ops.appendAntiPeek).toHaveBeenCalledWith(expect.stringContaining("arm-om-default"), ANTI_PEEK_PROMPT);
    expect(ops.appendAntiPeek).toHaveBeenCalledTimes(2); // once per arm session file
    expect(ops.freshPis[0]?.sendUserMessage).not.toHaveBeenCalled();
    expect(ops.trigger.mock.calls[0]?.[0]).toBe(ops.freshPis[0]?.pi); // trigger got the fresh pi
    expect(ops.trigger.mock.calls[1]?.[0]).toBe(ops.freshPis[1]?.pi);
  });

  it("reads the FRESH proxies from globalThis inside each withSession (both reloadConfig fire per arm)", async () => {
    const ops = makeFakeOps();
    await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A2", "A3"] }),
    );

    expect(ops.freshProxies).toHaveLength(2);
    // each arm's fresh proxies were reloaded (configureArm calls reloadConfig on the fresh proxies)
    expect(ops.freshProxies[0]?.om.reloadConfig).toHaveBeenCalledTimes(1);
    expect(ops.freshProxies[0]?.mk.reloadConfig).toHaveBeenCalledTimes(1);
    expect(ops.freshProxies[1]?.om.reloadConfig).toHaveBeenCalledTimes(1);
    expect(ops.freshProxies[1]?.mk.reloadConfig).toHaveBeenCalledTimes(1);
  });

  it("threads the fresh ctx from each withSession into the next arm's switchSession (NOT the stale command-handler ctx)", async () => {
    // regression guard: switchSession invalidates the ctx it's called on, so
    // arm 2+ MUST use the fresh ctx threaded from the previous arm's withSession.
    const ops = makeFakeOps();
    const cmdCtx = { id: "cmd-handler-ctx" } as unknown as ExtensionCommandContext;
    await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1", "A3"], cmdCtx }),
    );

    expect(ops.loadSession).toHaveBeenCalledTimes(2);
    // arm 1's switchSession got the command-handler ctx (the loop's starting point)...
    expect(ops.loadSession.mock.calls[0]?.[0]).toBe(cmdCtx);
    // ...arm 2's switchSession got arm 1's FRESH withSession ctx (threaded), NOT the stale cmdCtx.
    expect(ops.loadSession.mock.calls[1]?.[0]).toBe(ops.freshCtxs[0]);
    expect(ops.loadSession.mock.calls[1]?.[0]).not.toBe(cmdCtx);
  });

  it("appends the anti-peek entry to the session FILE (pre-load, last message — no agent turn)", async () => {
    const ops = makeFakeOps();
    await runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"] }));
    expect(ops.appendAntiPeek).toHaveBeenCalledWith(expect.any(String), ANTI_PEEK_PROMPT);
    expect(ops.freshPis[0]?.sendUserMessage).not.toHaveBeenCalled(); // never sent — no turn fires
    expect(ops.trigger).toHaveBeenCalled();
  });

  it("carries wallMs + usage from the compaction into each base", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ usage: makeUsage(2000, 800) }),
      wallMs: 9999,
    });
    const { bases } = await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A2"] }),
    );
    expect((bases[0] as ArmBase).wallMs).toBe(9999);
    expect((bases[0] as ArmBase).usage).toEqual(makeUsage(2000, 800));
    expect((bases[0] as ArmBase).ver).toBe("gabc123"); // A2 has a toolVersions entry
  });

  it("a pre-existing arm-base branch is a CONFLICT — Phase1StoppedError(branch-conflict), no re-seed/commit", async () => {
    // Branch names embed the runId; a fresh run never reuses one within an output
    // root. An existing branch means a PRIOR run derived the same id against this
    // shared scenario repo (e.g. an outputDir change reset the same-day counter) —
    // silently re-seeding + stacking commits would corrupt both runs' traces, so
    // the bench stops + surfaces instead.
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"] })),
    ).rejects.toMatchObject({ name: "Phase1StoppedError", arm: "A1", reason: "branch-conflict" });
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.copySeed).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("forks the arm-base branch exactly once when it does not yet exist (no conflict)", async () => {
    const ops = makeFakeOps();
    await runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"] }));
    expect(ops.fork).toHaveBeenCalledTimes(1);
  });

  it("leaves the per-arm env set on completion (persists for Phase-2/probes; startRun clears at run end)", async () => {
    // writeArmConfig sets process.env keys; Phase-1 deliberately does NOT clear them (they
    // persist so Phase-2/probes keep each arm's isolation). startRun's finally clears them.
    process.env.PI_OBSERVATIONAL_MEMORY_ENABLED = "stale-from-run";
    await runPhase1(
      makeDeps({ ops: makeFakeOps(), scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"] }),
    );
    // A1 (OM disabled) sets the env to "0"; Phase-1 did not clear it.
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("0");
  });
});

describe("runPhase1 — stop-and-surface", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-stop-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("arm-cancel (CompactionCancelledError) → rejects with Phase1StoppedError(reason=cancelled) + does NOT commit", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("hook cancelled")));
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A3"] })),
    ).rejects.toMatchObject({
      arm: "A3",
      reason: "cancelled",
    });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("degenerate empty summary → rejects with Phase1StoppedError(reason=empty-summary)", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({ compactionEntry: makeCompactionEntry({ summary: "   \n\t " }), wallMs: 100 });
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A3"] })),
    ).rejects.toMatchObject({
      arm: "A3",
      reason: "empty-summary",
    });
  });

  it("config-failure (ArmIsolationError — enabled arm's proxy not live) → Phase1StoppedError(reason=config-failed)", async () => {
    const ops = makeFakeOps();
    // Override the re-activation's fresh proxies: OM enabled (A2) but getConfig returns null.
    ops.loadSession.mockImplementation(
      async (_ctx: unknown, _path: string, cb: (ctx: ExtensionCommandContext) => Promise<unknown>) => {
        const pi = makeFakePi();
        const proxies = makeProxies();
        proxies.om.getConfig = vi.fn(() => null); // OM not live
        setBenchPi(pi.pi);
        setMemoryProxies(proxies as unknown as MemoryProxies);
        return cb({} as ExtensionCommandContext);
      },
    );
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A2"] })),
    ).rejects.toMatchObject({
      arm: "A2",
      reason: "config-failed",
    });
  });

  it("leaves the per-arm env set EVEN on a stop (startRun's finally clears it at run end)", async () => {
    process.env.PI_OBSERVATIONAL_MEMORY_ENABLED = "stale-from-run";
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("cancel")));
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A3"] })),
    ).rejects.toBeDefined();
    // configureArm(A3) set the env before the cancel; Phase-1's (now-removed) finally did not clear it.
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("0");
  });
});

// --- crash resume ----------------------------------------------------------

describe("runPhase1 — crash resume (skip committed arm bases)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-resume-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("skips an arm whose branch is committed + session file exists: base reconstructed, NO fork/seed/compact/commit", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.exists = vi.fn(() => true);
    const sessionsDir = join(repo, "sessions");
    const { bases, finalCtx } = await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir, armsEnabled: ["A1", "A2"], resume: true }),
    );

    expect(bases).toHaveLength(2);
    for (const base of bases) {
      expect(base.branch).toBe(
        buildArmBaseBranch({
          date: "2026-08-11",
          id: 1,
          cfgId: "cfg-test1",
          tool: base.tool,
          ver: base.ver,
        }),
      );
      expect(base.wallMs).toBe(0);
      expect(base.usage).toBeUndefined();
      expect(base.cfgId).toBe("cfg-test1");
    }
    // none of the compact-path ops fire
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.copySeed).not.toHaveBeenCalled();
    expect(ops.appendAntiPeek).not.toHaveBeenCalled();
    expect(ops.loadSession).not.toHaveBeenCalled();
    expect(ops.trigger).not.toHaveBeenCalled();
    expect(ops.commit).not.toHaveBeenCalled();
    expect(ops.deleteBranch).not.toHaveBeenCalled();
    // no switchSession ran — the original command ctx stays threaded
    expect(finalCtx).toEqual({ id: "cmd-handler-ctx" });
  });

  it("deletes + re-compacts an arm whose branch exists but is NOT committed (crash mid-arm)", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 0);
    const sessionsDir = join(repo, "sessions");
    const { bases } = await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir, armsEnabled: ["A1"], resume: true }),
    );

    const branch = buildArmBaseBranch({
      date: "2026-08-11",
      id: 1,
      cfgId: "cfg-test1",
      tool: "bare-pi",
      ver: undefined,
    });
    expect(ops.deleteBranch).toHaveBeenCalledWith(repo, branch);
    // the stale branch was deleted BEFORE the re-fork
    expect(ops.deleteBranch.mock.invocationCallOrder[0]).toBeLessThan(ops.fork.mock.invocationCallOrder[0]);
    expect(ops.fork).toHaveBeenCalledWith(repo, "main", branch);
    expect(ops.trigger).toHaveBeenCalledTimes(1);
    expect(ops.commit).toHaveBeenCalledTimes(1);
    expect(bases[0]?.wallMs).toBe(4200); // the fresh compaction's timing is carried
  });

  it("deletes + re-compacts an arm whose committed branch lost its session file (incomplete artifact)", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.exists = vi.fn(() => false); // session file missing
    await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"], resume: true }),
    );
    expect(ops.deleteBranch).toHaveBeenCalledTimes(1);
    expect(ops.trigger).toHaveBeenCalledTimes(1);
  });

  it("mixed: a committed arm is skipped, an unstarted arm compacts normally (no branch)", async () => {
    const ops = makeFakeOps();
    const sessionsDir = join(repo, "sessions");
    ops.branchExists = vi.fn((_repo: string, branch: string) => branch.includes("arm-bare-pi"));
    ops.commitCountAhead = vi.fn(() => 1);
    ops.exists = vi.fn(() => true);
    const { bases } = await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir, armsEnabled: ["A1", "A3"], resume: true }),
    );
    expect(bases).toHaveLength(2);
    // A1 skipped (no compact ops), A3 compacted fresh
    expect(ops.trigger).toHaveBeenCalledTimes(1);
    expect(ops.loadSession).toHaveBeenCalledTimes(1);
    expect(ops.loadSession.mock.calls[0]?.[1]).toBe(
      branchSessionFile(
        sessionsDir,
        buildArmBaseBranch({
          date: "2026-08-11",
          id: 1,
          cfgId: "cfg-test1",
          tool: "memkeeper-builder",
          ver: undefined,
        }),
      ),
    );
    expect(ops.deleteBranch).not.toHaveBeenCalled();
  });

  it("a pre-existing branch on the NON-resume path is still a hard conflict", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => true);
    await expect(
      runPhase1(makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A1"] })),
    ).rejects.toMatchObject({ name: "Phase1StoppedError", reason: "branch-conflict" });
  });
});

// --- buildRunConfig --------------------------------------------------------

describe("buildRunConfig", () => {
  it("resolves every enabled arm's tool version (bare-pi → absent) via the injectable resolver", () => {
    const resolver: VersionResolver = {
      resolveRoot: () => "/fake/root",
      gitHead: (dir: string) => (dir === "/fake/root" ? "abcdef1234567890" : null),
      npmVersion: () => null,
    };
    const rc = buildRunConfig(makeConfig(["A1", "A2"]), resolver);
    expect(rc.armsEnabled).toEqual(["A1", "A2"]);
    expect(rc.toolVersions.A1).toBeUndefined();
    expect(rc.toolVersions.A2).toEqual({ source: "git", commit: "gabcdef", full: "abcdef1234567890" });
  });
});

describe("phase-1 sanity", () => {
  it("ARM_DEFS tool names (used for branch naming) are intact", () => {
    expect(ARM_DEFS.A1.tool).toBe("bare-pi");
    expect(ARM_DEFS.A3.tool).toBe("memkeeper-builder");
    expect(ARM_DEFS.A4.tool).toBe("memkeeper-selector");
    expect(ARM_DEFS.A5.tool).toBe("om-full");
  });

  it("Phase1StoppedError carries arm + reason + message", () => {
    const err = new Phase1StoppedError("A2", "cancelled", "boom");
    expect(err.arm).toBe("A2");
    expect(err.reason).toBe("cancelled");
    expect(err.message).toBe("boom");
  });
});

function makeConfig(armsEnabled: BenchConfig["armsEnabled"]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    judgesNumber: 1,
    judge2Model: null,
    judge2ThinkingLevel: "high",
    judge3Model: null,
    judge3ThinkingLevel: "high",
    N: 3,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    armsEnabled,
  } as BenchConfig;
}

// --- --reuse-bases (older-version base fallback) -----------------------------

describe("runPhase1 — --reuse-bases (older-version base fallback)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-p1-reuse-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reuses the newest committed older-version base when the current version's branch is absent", async () => {
    const ops = makeFakeOps();
    // current-version branch (arm-om-default-gabc123) does NOT exist → branchExists false
    ops.branchExists = vi.fn(() => false);
    // candidates include an attempt branch (later committer date) — must be shape-skipped
    const oldBase = "bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default-g999888";
    ops.newestBranches = vi.fn(() => [
      "bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default-g999888-attempt1", // wrong shape
      "bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default-g999888-probe-1-1", // wrong shape
      oldBase, // ← the reusable base
    ]);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.exists = vi.fn(() => true);
    const { bases } = await runPhase1(
      makeDeps({
        ops,
        scenarioRepo: repo,
        sessionsDir: join(repo, "sessions"),
        armsEnabled: ["A2"],
        resume: true,
        reuseBases: true,
      }),
    );
    expect(bases).toHaveLength(1);
    expect(bases[0]?.branch).toBe(oldBase);
    expect(bases[0]?.ver).toBe("g999888"); // records the version the base was BUILT under
    expect(ops.fork).not.toHaveBeenCalled();
    expect(ops.trigger).not.toHaveBeenCalled();
    expect(ops.newestBranches).toHaveBeenCalledWith(repo, "bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default*");
  });

  it("does NOT reuse without the flag (version change → re-compact)", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => false);
    ops.newestBranches = vi.fn(() => ["bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default-g999888"]);
    ops.commitCountAhead = vi.fn(() => 1);
    ops.exists = vi.fn(() => true);
    const { bases } = await runPhase1(
      makeDeps({ ops, scenarioRepo: repo, sessionsDir: join(repo, "sessions"), armsEnabled: ["A2"], resume: true }),
    );
    expect(bases[0]?.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: "cfg-test1", tool: "om-default", ver: "gabc123" }),
    );
    expect(ops.fork).toHaveBeenCalled(); // fresh compact under the CURRENT version
  });

  it("an uncommitted older-version base is not reusable → re-compact", async () => {
    const ops = makeFakeOps();
    ops.branchExists = vi.fn(() => false);
    ops.newestBranches = vi.fn(() => ["bench-compact/run-2026-08-11-1/cfg-test1/arm-om-default-g999888"]);
    ops.commitCountAhead = vi.fn(() => 0); // bare fork — crashed before its boundary commit
    ops.exists = vi.fn(() => true);
    const { bases } = await runPhase1(
      makeDeps({
        ops,
        scenarioRepo: repo,
        sessionsDir: join(repo, "sessions"),
        armsEnabled: ["A2"],
        resume: true,
        reuseBases: true,
      }),
    );
    expect(bases[0]?.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: "cfg-test1", tool: "om-default", ver: "gabc123" }),
    );
    expect(ops.fork).toHaveBeenCalled();
  });
});
