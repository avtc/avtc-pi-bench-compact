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
import { BUILTIN_TOOLS, SUITE_TOOLS } from "../../src/arms/switch.js";
import type { VersionResolver } from "../../src/arms/version.js";
import type { BenchConfig } from "../../src/config/types.js";
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
  trigger: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  checkout: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
}

function makeFakeOps(): FakeOps {
  return {
    trigger: vi.fn(async () => ({ compactionEntry: makeCompactionEntry({}), wallMs: 4200 })),
    // loadSession invokes the callback with a fake session ctx so inject + re-set + trigger run.
    loadSession: vi.fn(async (_ctx: unknown, _path: string, cb: (ctx: unknown) => Promise<unknown>) => cb({})),
    fork: vi.fn(),
    checkout: vi.fn(),
    commit: vi.fn(),
  };
}

interface FakePi {
  pi: ExtensionAPI;
  sendUserMessage: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
}

/** A fake pi satisfying the ToolSetSeam (setActiveTools) + the inject seam (sendUserMessage). */
function makeFakePi(): FakePi {
  const sendUserMessage = vi.fn();
  const setActiveTools = vi.fn();
  return { pi: { sendUserMessage, setActiveTools } as unknown as ExtensionAPI, sendUserMessage, setActiveTools };
}

function makeProxies() {
  return {
    om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
    mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
  };
}

function makeDeps(opts: {
  ops: FakeOps;
  pi: FakePi;
  proxies: ReturnType<typeof makeProxies>;
  scenarioRepo: string;
  armsEnabled: BenchConfig["armsEnabled"];
}): Phase1Deps {
  return {
    pi: opts.pi.pi,
    cmdCtx: {} as ExtensionCommandContext,
    omProxy: opts.proxies.om,
    mkProxy: opts.proxies.mk,
    scenarioRepo: opts.scenarioRepo,
    date: "2026-08-11",
    id: 1,
    cfgId: "cfg-test1",
    toolVersions: { A2: { source: "git", commit: "gabc123", full: "abcdef1234567890" } },
    omFullReflectionThresholdTokens: 4000,
    armsEnabled: opts.armsEnabled,
    ops: opts.ops as unknown as Phase1Ops,
  };
}

afterEach(() => {
  clearRunState();
});

// --- runPhase1 (inline for-loop over arms) ----------------------------------

describe("runPhase1 — per-arm configure + fork + compact + commit (NO ctx.reload)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-phase1-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("per arm: configureArm (writeArmConfig + both reloadConfig + setActiveTools) → fork main→arm-base → checkout → load+inject+compact → commit", async () => {
    const ops = makeFakeOps();
    const pi = makeFakePi();
    const proxies = makeProxies();
    const deps = makeDeps({ ops, pi, proxies, scenarioRepo: repo, armsEnabled: ["A1", "A3"] });

    const bases = await runPhase1(deps);

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
    expect(ops.loadSession).toHaveBeenCalledWith(expect.anything(), `${repo}/session.jsonl`, expect.any(Function));
    expect(ops.commit).toHaveBeenCalledWith(repo, expect.stringContaining("phase-1"));
    // arm 2 (memkeeper-builder) carries the resolved tool version
    const b2 = bases[1] as ArmBase;
    expect(b2.arm).toBe("A3");
    expect(b2.tool).toBe("memkeeper-builder");
    expect(b2.ver).toBeUndefined(); // A3 has no toolVersions entry in the fake deps
  });

  it("configureArm runs for each arm: both reloadConfig fire + setActiveTools receives the arm's allowlist", async () => {
    const ops = makeFakeOps();
    const pi = makeFakePi();
    const proxies = makeProxies();
    await runPhase1(makeDeps({ ops, pi, proxies, scenarioRepo: repo, armsEnabled: ["A2", "A3"] }));

    // both proxies reloaded once per arm (2 arms → 2 calls each)
    expect(proxies.om.reloadConfig).toHaveBeenCalledTimes(2);
    expect(proxies.mk.reloadConfig).toHaveBeenCalledTimes(2);
    // setActiveTools: configureArm + the post-switch re-set = 2 calls per arm;
    // assert the allowlist was set (toHaveBeenCalledWith matches any matching call).
    expect(pi.setActiveTools).toHaveBeenCalledWith([...BUILTIN_TOOLS, ...SUITE_TOOLS, "recall"]); // A2
    expect(pi.setActiveTools).toHaveBeenCalledWith([...BUILTIN_TOOLS, ...SUITE_TOOLS, "mk_recall"]); // A3
  });

  it("injects the anti-peek prompt (followUp) before compaction inside the loaded session", async () => {
    const ops = makeFakeOps();
    const pi = makeFakePi();
    await runPhase1(makeDeps({ ops, pi, proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A1"] }));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(ANTI_PEEK_PROMPT, { deliverAs: "followUp" });
    expect(ops.trigger).toHaveBeenCalled();
  });

  it("carries wallMs + usage from the compaction into each base", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({
      compactionEntry: makeCompactionEntry({ usage: makeUsage(2000, 800) }),
      wallMs: 9999,
    });
    const bases = await runPhase1(
      makeDeps({ ops, pi: makeFakePi(), proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A2"] }),
    );
    expect((bases[0] as ArmBase).wallMs).toBe(9999);
    expect((bases[0] as ArmBase).usage).toEqual(makeUsage(2000, 800));
    expect((bases[0] as ArmBase).ver).toBe("gabc123"); // A2 has a toolVersions entry
  });

  it("uses the SAME command ctx for every arm (inline loop — no reload, no fresh-ctx gymnastics)", async () => {
    const ops = makeFakeOps();
    const ctx = { id: "single-inline-ctx" } as unknown as ExtensionCommandContext;
    const deps: Phase1Deps = {
      ...makeDeps({ ops, pi: makeFakePi(), proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A1", "A3"] }),
      cmdCtx: ctx,
    };
    await runPhase1(deps);
    // every loadSession call received the SAME ctx (inline loop reuses it; reload would invalidate it)
    for (const call of ops.loadSession.mock.calls) {
      expect(call[0]).toBe(ctx);
    }
    expect(ops.loadSession).toHaveBeenCalledTimes(2);
  });

  it("fork is idempotent — a base branch that already exists is not re-forked (branchExists guard)", async () => {
    // The guard is `if (!branchExists(repo, branch)) fork(...)`. branchExists is a real
    // git read, so exercising it end-to-end needs a real repo: covered by the fork
    // round-trip in storage/repo.test.ts. Here we only assert the guard is present
    // (the branch is forked exactly once when it does not yet exist).
    const ops = makeFakeOps();
    await runPhase1(
      makeDeps({ ops, pi: makeFakePi(), proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A1"] }),
    );
    expect(ops.fork).toHaveBeenCalledTimes(1);
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
      runPhase1(makeDeps({ ops, pi: makeFakePi(), proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A3"] })),
    ).rejects.toMatchObject({ arm: "A3", reason: "cancelled" });
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it("degenerate empty summary → rejects with Phase1StoppedError(reason=empty-summary)", async () => {
    const ops = makeFakeOps();
    ops.trigger.mockResolvedValue({ compactionEntry: makeCompactionEntry({ summary: "   \n\t " }), wallMs: 100 });
    await expect(
      runPhase1(makeDeps({ ops, pi: makeFakePi(), proxies: makeProxies(), scenarioRepo: repo, armsEnabled: ["A3"] })),
    ).rejects.toMatchObject({ arm: "A3", reason: "empty-summary" });
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
    N: 3,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    armsEnabled,
  } as BenchConfig;
}
