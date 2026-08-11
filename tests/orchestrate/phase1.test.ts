// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Usage shape (from @earendil-works/pi-ai) — typed via CompactionEntry.usage to avoid a fragile cross-package import. */
type Usage = NonNullable<CompactionEntry["usage"]>;

import { ARM_DEFS } from "../../src/arms/definitions.js";
import type { VersionResolver } from "../../src/arms/version.js";
import type { BenchConfig } from "../../src/config/types.js";
import {
  advancePhase1,
  type ArmBase,
  buildRunConfig,
  clearPhase1Cursor,
  compactOneArm,
  type Phase1Cursor,
  type Phase1Ops,
  type Phase1RunDeps,
  Phase1StoppedError,
  registerPhase1Driver,
  setPhase1Cursor,
} from "../../src/orchestrate/phase1.js";
import { clearRunState, setRunState } from "../../src/orchestrate/run-state.js";
import { CompactionCancelledError } from "../../src/session/compact.js";
import { ANTI_PEEK_PROMPT } from "../../src/storage/anti-peek.js";
import { buildArmBaseBranch } from "../../src/storage/branches.js";

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

interface FakeOps {
  switchArm: ReturnType<typeof vi.fn>;
  trigger: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
}

function makeFakeOps(): FakeOps {
  return {
    switchArm: vi.fn(async () => {}),
    trigger: vi.fn(async () => ({ compactionEntry: makeCompactionEntry({}), wallMs: 4200 })),
    loadSession: vi.fn(async (_ctx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({})),
    fork: vi.fn(),
    checkout: vi.fn(),
    commit: vi.fn(),
  };
}

function makeConfig(armsEnabled: BenchConfig["armsEnabled"]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    N: 3,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    armsEnabled,
  } as BenchConfig;
}

function makeRunDeps(opts: { ops: FakeOps; scenarioRepo?: string; onDone?: (b: ArmBase[]) => void }): Phase1RunDeps {
  const ops = opts.ops as unknown as Phase1Ops;
  return {
    scenarioRepo: opts.scenarioRepo ?? "/repo/scenario-x",
    date: "2026-08-11",
    id: 1,
    cfgId: "cfg-test1",
    toolVersions: { A2: { source: "git", commit: "gabc123", full: "abcdef1234567890" } },
    omFullReflectionThresholdTokens: 4000,
    ops,
    onDone: opts.onDone,
  };
}

/** Install a cursor for `arms` with the given ops; returns it for mutation/assertion. */
function installCursor(arms: BenchConfig["armsEnabled"], deps: Phase1RunDeps): Phase1Cursor {
  const cursor: Phase1Cursor = { arms: [...arms], nextArmIndex: 0, bases: [], deps };
  setPhase1Cursor(cursor);
  return cursor;
}

const fakePi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

afterEach(() => {
  clearPhase1Cursor();
  clearRunState();
});

// --- compactOneArm (single arm) --------------------------------------------

describe("compactOneArm", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("per arm: fork main→arm-base → checkout → load+inject+compact → commit", async () => {
    const ops = makeFakeOps();
    const deps = makeRunDeps({ ops, scenarioRepo: repo });
    const ctx = {} as ExtensionCommandContext;

    const base = (await compactOneArm(ctx, fakePi, "A1", deps)) as ArmBase;

    expect(base.arm).toBe("A1");
    expect(base.tool).toBe("bare-pi");
    expect(base.ver).toBeUndefined(); // bare-pi omits {ver}
    expect(base.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: "cfg-test1", tool: "bare-pi", ver: undefined }),
    );
    expect(ops.fork).toHaveBeenCalledWith(repo, "main", base.branch);
    expect(ops.checkout).toHaveBeenCalledWith(repo, base.branch);
    expect(ops.loadSession).toHaveBeenCalledWith(ctx, `${repo}/session.jsonl`, expect.any(Function));
    expect(ops.commit).toHaveBeenCalledWith(repo, expect.stringContaining("phase-1"));
  });

  it("injects the anti-peek prompt (followUp) before compaction inside the loaded session", async () => {
    const ops = makeFakeOps();
    const deps = makeRunDeps({ ops });
    await compactOneArm({} as ExtensionCommandContext, fakePi, "A1", deps);
    expect(fakePi.sendUserMessage).toHaveBeenCalledWith(ANTI_PEEK_PROMPT, { deliverAs: "followUp" });
    expect(ops.trigger).toHaveBeenCalled();
  });

  it("carries wallMs + usage from the compaction into the base", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ usage: makeUsage(2000, 800) }),
      wallMs: 9999,
    });
    const deps = makeRunDeps({ ops });
    const base = (await compactOneArm({} as ExtensionCommandContext, fakePi, "A2", deps)) as ArmBase;
    expect(base.wallMs).toBe(9999);
    expect(base.usage).toEqual(makeUsage(2000, 800));
    expect(base.ver).toBe("gabc123"); // non-bare-pi carries the tool version
  });

  it("throws Phase1StoppedError(reason=cancelled) on arm-cancel + does NOT commit", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("hook cancelled")));
    const deps = makeRunDeps({ ops, scenarioRepo: repo });
    await expect(compactOneArm({} as ExtensionCommandContext, fakePi, "A1", deps)).rejects.toMatchObject({
      arm: "A1",
      reason: "cancelled",
    });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("throws Phase1StoppedError(reason=empty-summary) on a degenerate empty summary", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ summary: "   \n\t " }),
      wallMs: 100,
    });
    const deps = makeRunDeps({ ops });
    await expect(compactOneArm({} as ExtensionCommandContext, fakePi, "A3", deps)).rejects.toMatchObject({
      arm: "A3",
      reason: "empty-summary",
    });
  });
});

// --- advancePhase1 (the reload check — CR-R1-1) ----------------------------

describe("advancePhase1 — cross-reload auto-drive", () => {
  beforeEach(() => {
    setRunState({
      runId: "2026-08-11-1",
      date: "2026-08-11",
      id: 1,
      cfgId: "cfg-test1",
      scenarioRepo: "/repo",
      phase: "phase-1",
      currentArm: null,
      currentAttempt: null,
      lastStopReason: null,
    });
  });

  it("compacts the next arm with the FRESH ctx from the reload (the CR-R1-1 fix)", async () => {
    const ops = makeFakeOps();
    const deps = makeRunDeps({ ops });
    const cursor = installCursor(["A1", "A3"], deps);
    const ctx0 = { id: "ctx-after-reload-0" } as unknown as ExtensionCommandContext;
    const ctx1 = { id: "ctx-after-reload-1" } as unknown as ExtensionCommandContext;

    // Reload 1 → arm[0] (A1) compacted with ctx0; then switchArm(A3) triggers the next reload.
    await advancePhase1(fakePi, ctx0);
    expect(ops.loadSession).toHaveBeenCalledWith(ctx0, expect.any(String), expect.any(Function));
    expect(cursor.nextArmIndex).toBe(1);
    expect(ops.switchArm).toHaveBeenCalledWith(ctx0, "A3", deps.scenarioRepo, {
      omFullReflectionThresholdTokens: 4000,
    });

    // Reload 2 → arm[1] (A3) compacted with ctx1 (NOT the stale ctx0).
    ops.loadSession.mockClear();
    ops.switchArm.mockClear();
    await advancePhase1(fakePi, ctx1);
    expect(ops.loadSession).toHaveBeenCalledWith(ctx1, expect.any(String), expect.any(Function)); // fresh ctx
    expect(ops.switchArm).not.toHaveBeenCalled(); // last arm → no next-isolation trigger
    expect(cursor.bases.map((b) => b.arm)).toEqual(["A1", "A3"]);
  });

  it("completes phase-1 after the last arm: clears cursor, advances run-state, fires onDone", async () => {
    const onDone = vi.fn();
    const ops = makeFakeOps();
    const deps = makeRunDeps({ ops, onDone });
    const cursor = installCursor(["A1"], deps); // single arm

    await advancePhase1(fakePi, {} as ExtensionCommandContext);

    expect(cursor.bases).toHaveLength(1);
    expect(getCursorOrNull()).toBeNull(); // cursor cleared
    // run-state advanced to phase-2
    const { getRunState } = await import("../../src/orchestrate/run-state.js");
    expect(getRunState()?.phase).toBe("phase-2");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect((onDone.mock.calls[0] as [ArmBase[]])[0]).toHaveLength(1);
  });

  it("no-ops when no phase-1 cursor is active (listener is always registered — must be idle-safe)", async () => {
    clearPhase1Cursor();
    const ops = makeFakeOps();
    await advancePhase1(fakePi, {} as ExtensionCommandContext);
    expect(ops.loadSession).not.toHaveBeenCalled();
  });

  it("no-ops when the cursor is past the last arm (defensive)", async () => {
    const ops = makeFakeOps();
    const deps = makeRunDeps({ ops });
    const cursor = installCursor(["A1"], deps);
    cursor.nextArmIndex = 1; // already past
    await advancePhase1(fakePi, {} as ExtensionCommandContext);
    expect(ops.loadSession).not.toHaveBeenCalled();
  });

  it("stop-and-surfaces on arm-cancel: clears cursor, records lastStopReason, notifies", async () => {
    const notify = vi.fn();
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("boom")));
    const deps = makeRunDeps({ ops });
    (deps as Phase1RunDeps & { notify?: (m: string) => void }).notify = notify;
    const cursor = installCursor(["A3"], deps);

    await advancePhase1(fakePi, {} as ExtensionCommandContext);

    expect(getCursorOrNull()).toBeNull();
    const { getRunState } = await import("../../src/orchestrate/run-state.js");
    expect(getRunState()?.lastStopReason).toMatch(/A3.*cancelled/i);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*A3/i));
  });
});

// --- registerPhase1Driver --------------------------------------------------

describe("registerPhase1Driver", () => {
  it("registers a session_start listener that advances phase-1 ONLY on reason 'reload'", async () => {
    const handlers: Record<string, ((...args: unknown[]) => Promise<void>) | undefined> = {};
    const pi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => {
        handlers[event] = handler;
      }),
    } as unknown as ExtensionAPI;

    registerPhase1Driver(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    const listener = handlers["session_start"];
    expect(listener).toBeDefined();

    // Install a cursor so advancePhase1 would act if called.
    const ops = makeFakeOps();
    installCursor(["A1"], makeRunDeps({ ops }));

    // Non-reload reasons are ignored (startup/resume/new/fork do not drive phase-1).
    await listener?.({ type: "session_start", reason: "startup" }, {});
    await listener?.({ type: "session_start", reason: "resume" }, {});
    expect(ops.loadSession).not.toHaveBeenCalled();

    // reload drives the next arm.
    await listener?.({ type: "session_start", reason: "reload" }, {});
    expect(ops.loadSession).toHaveBeenCalled();
  });
});

// --- buildRunConfig --------------------------------------------------------

describe("buildRunConfig", () => {
  it("resolves every enabled arm's tool version (A1 → absent) via the injectable resolver", () => {
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

// read the live cursor without importing the setter (avoids stale module state)
function getCursorOrNull(): Phase1Cursor | null {
  return ((globalThis as Record<string, unknown>).__benchCompactPhase1Cursor as Phase1Cursor | null) ?? null;
}
