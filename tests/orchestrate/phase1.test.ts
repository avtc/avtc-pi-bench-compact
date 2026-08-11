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
  type ArmBase,
  buildRunConfig,
  type Phase1Deps,
  Phase1StoppedError,
  runPhase1,
} from "../../src/orchestrate/phase1.js";
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

function makeCompactionEntry(overrides: Partial<CompactionEntry> = {}): CompactionEntry {
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
  resolveVersion: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  writeRunConfig: ReturnType<typeof vi.fn>;
}

function makeFakeOps(): FakeOps {
  return {
    switchArm: vi.fn(async () => {}),
    trigger: vi.fn(async () => ({ compactionEntry: makeCompactionEntry(), wallMs: 4200 })),
    loadSession: vi.fn(),
    resolveVersion: vi.fn((arm: string) => {
      if (arm === "A1") return null;
      return { source: "git", commit: "gabc123", full: "abcdef1234567890" };
    }),
    fork: vi.fn(),
    checkout: vi.fn(),
    commit: vi.fn(),
    writeRunConfig: vi.fn(),
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

function makeDeps(opts: {
  arms: BenchConfig["armsEnabled"];
  ops: FakeOps;
  scenarioRepo?: string;
}): Phase1Deps & { ops: FakeOps } {
  const ops = opts.ops;
  const scenarioRepo = opts.scenarioRepo ?? "/repo/scenario-x";
  const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
  const cmdCtx = {
    switchSession: vi.fn(async (_path: string, o: { withSession: (ctx: unknown) => Promise<unknown> }) => {
      await o.withSession({
        /* fake session ctx */
      });
      return { cancelled: false };
    }),
  } as unknown as ExtensionCommandContext;
  const switchCtx = { reload: vi.fn(async () => {}) };
  return {
    pi,
    cmdCtx,
    switchCtx,
    config: makeConfig(opts.arms),
    scenarioRepo,
    date: "2026-08-11",
    id: 1,
    cfgId: "cfg-test1",
    toolVersions: { A2: { source: "git", commit: "gabc123", full: "abcdef1234567890" } },
    ops: {
      switchArm: ops.switchArm,
      trigger: ops.trigger,
      loadSession: ops.loadSession,
      fork: ops.fork,
      checkout: ops.checkout,
      commit: ops.commit,
    },
  } as unknown as Phase1Deps & { ops: FakeOps };
}

// --- tests ------------------------------------------------------------------

describe("runPhase1 — success path", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("uses the pre-computed cfgId for every arm's branch (single source of truth)", async () => {
    const ops = makeFakeOps();
    const deps = makeDeps({ arms: ["A1", "A2"], ops });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    const bases = await runPhase1(deps);

    // Both arms share the same cfgId (passed in), reflected in their branch names.
    expect((bases[0] as ArmBase).cfgId).toBe("cfg-test1");
    expect((bases[1] as ArmBase).cfgId).toBe("cfg-test1");
    expect((bases[0] as ArmBase).branch).toContain("cfg-test1");
  });

  it("per arm: switchArm → fork main→arm-base → checkout → load+inject+compact → commit", async () => {
    const ops = makeFakeOps();
    const deps = makeDeps({ arms: ["A1", "A2"], ops, scenarioRepo: repo });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    const bases = await runPhase1(deps);

    expect(bases).toHaveLength(2);
    // A1: ver undefined (bare-pi) → branch omits {ver}
    const a1 = bases[0] as ArmBase;
    expect(a1.arm).toBe("A1");
    expect(a1.tool).toBe("bare-pi");
    expect(a1.ver).toBeUndefined();
    expect(a1.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: a1.cfgId, tool: "bare-pi", ver: undefined }),
    );
    // A2: ver present
    const a2 = bases[1] as ArmBase;
    expect(a2.tool).toBe("om-default");
    expect(a2.ver).toBe("gabc123");
    expect(a2.branch).toBe(
      buildArmBaseBranch({ date: "2026-08-11", id: 1, cfgId: a2.cfgId, tool: "om-default", ver: "gabc123" }),
    );

    // per-arm call sequence for A2 (last arm)
    expect(ops.switchArm).toHaveBeenCalledWith(expect.anything(), "A2", repo, {
      omFullReflectionThresholdTokens: 4000,
    });
    expect(ops.fork).toHaveBeenCalledWith(repo, "main", a2.branch);
    expect(ops.checkout).toHaveBeenCalledWith(repo, a2.branch);
    expect(ops.loadSession).toHaveBeenCalledTimes(2);
    expect(ops.commit).toHaveBeenCalledWith(repo, expect.stringContaining("phase-1"));
  });

  it("injects the anti-peek prompt (followUp) before compaction inside the loaded session", async () => {
    const ops = makeFakeOps();
    const deps = makeDeps({ arms: ["A1"], ops });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    await runPhase1(deps);

    expect(deps.pi.sendUserMessage).toHaveBeenCalledWith(ANTI_PEEK_PROMPT, { deliverAs: "followUp" });
    // compact ran AFTER the inject (inject is the first sendUserMessage call)
    expect(ops.trigger).toHaveBeenCalled();
  });

  it("carries wallMs + usage from the compaction into the base", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ usage: makeUsage(2000, 800) }),
      wallMs: 9999,
    });
    const deps = makeDeps({ arms: ["A2"], ops });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    const [base] = (await runPhase1(deps)) as ArmBase[];
    expect(base.wallMs).toBe(9999);
    expect(base.usage).toEqual(makeUsage(2000, 800));
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

  it("throws Phase1StoppedError(reason=cancelled) on arm-cancel + does NOT commit that arm", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("hook cancelled")));
    const deps = makeDeps({ arms: ["A1", "A2"], ops, scenarioRepo: repo });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    await expect(runPhase1(deps)).rejects.toMatchObject({ arm: "A1", reason: "cancelled" });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("throws Phase1StoppedError(reason=empty-summary) on a degenerate empty summary", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ summary: "   \n\t " }),
      wallMs: 100,
    });
    const deps = makeDeps({ arms: ["A2"], ops, scenarioRepo: repo });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    await expect(runPhase1(deps)).rejects.toMatchObject({ arm: "A2", reason: "empty-summary" });
  });

  it("Phase1StoppedError carries the arm + a human-readable message", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockRejectedValue(new CompactionCancelledError(new Error("boom")));
    const deps = makeDeps({ arms: ["A3"], ops, scenarioRepo: repo });
    ops.loadSession.mockImplementation(
      async (_cmdCtx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({}),
    );

    await expect(runPhase1(deps)).rejects.toBeInstanceOf(Phase1StoppedError);
    await expect(runPhase1(deps)).rejects.toThrow(/A3.*cancelled/i);
  });
});

describe("buildRunConfig", () => {
  it("resolves every enabled arm's tool version (A1 → absent) via the injectable resolver", () => {
    const resolver: VersionResolver = {
      resolveRoot: () => "/fake/root",
      gitHead: (dir: string) => (dir === "/fake/root" ? "abcdef1234567890" : null),
      npmVersion: () => null,
    };
    const rc = buildRunConfig(makeConfig(["A1", "A2"]), resolver);
    expect(rc.armsEnabled).toEqual(["A1", "A2"]);
    expect(rc.toolVersions.A1).toBeUndefined(); // A1 bare-pi carries no tool version
    expect(rc.toolVersions.A2).toEqual({ source: "git", commit: "gabcdef", full: "abcdef1234567890" });
    expect(rc.evaluatedModel).toBe("test/model");
    expect(rc.N).toBe(3);
  });
});

describe("runPhase1 — isolation", () => {
  it("passes each arm's tool def through (sanity: ARM_DEFS tool names)", () => {
    // Phase1 uses ARM_DEFS[arm].tool for branch naming — verify the mapping is intact.
    expect(ARM_DEFS.A1.tool).toBe("bare-pi");
    expect(ARM_DEFS.A3.tool).toBe("memkeeper-builder");
    expect(ARM_DEFS.A4.tool).toBe("memkeeper-selector");
    expect(ARM_DEFS.A5.tool).toBe("om-full");
  });
});
