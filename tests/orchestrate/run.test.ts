// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchConfig } from "../../src/config/types.js";
import { type ArmBase, type Phase1Deps, type Phase1Ops, Phase1StoppedError } from "../../src/orchestrate/phase1.js";
import { type StartRunDeps, startRun } from "../../src/orchestrate/run.js";
import { clearRunState, getRunState } from "../../src/orchestrate/run-state.js";

function makeConfig(arms: BenchConfig["armsEnabled"]): BenchConfig {
  return {
    evaluatedModel: "test/model",
    evaluatedThinkingLevel: "high",
    judgeModel: "test/judge",
    judgeThinkingLevel: "high",
    N: 3,
    compactionBoundary: 140000,
    backupMode: "build",
    omFullReflectionThresholdTokens: 4000,
    outputDir: null,
    armsEnabled: arms,
  } as BenchConfig;
}

function makeProxies() {
  return {
    om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
    mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({ enabled: true })) },
  };
}

function makeDeps(opts: {
  arms: BenchConfig["armsEnabled"];
  root: string;
  scenarioRepo?: string;
  phase1?: ReturnType<typeof vi.fn<(deps: Phase1Deps) => Promise<ArmBase[]>>>;
  now?: () => Date;
  notify?: (m: string) => void;
}): StartRunDeps {
  const proxies = makeProxies();
  return {
    pi: { sendUserMessage: vi.fn(), setActiveTools: vi.fn() },
    cmdCtx: {},
    omProxy: proxies.om,
    mkProxy: proxies.mk,
    config: makeConfig(opts.arms),
    scenarioRepo: opts.scenarioRepo ?? "/repo/scenario-x",
    root: opts.root,
    now: opts.now ?? (() => new Date("2026-08-11T10:00:00Z")),
    notify: opts.notify,
    phase1: opts.phase1,
    versionResolver: {
      resolveRoot: () => "/fake",
      gitHead: () => "abcdef1234567890",
      npmVersion: () => null,
    },
  } as unknown as StartRunDeps;
}

function fakeBases(arms: BenchConfig["armsEnabled"]): ArmBase[] {
  return arms.map((arm, i) => ({
    arm,
    tool: `tool-${arm}`,
    ver: i === 0 ? undefined : "gabc123",
    cfgId: "cfg-x",
    branch: `branch-${arm}`,
    wallMs: 1000 + i,
    usage: undefined,
  }));
}

/** A typed Phase-1 mock so `mock.calls[0][0]` is the Phase1Deps arg (not an empty tuple). */
function phase1Mock(
  impl: (deps: Phase1Deps) => Promise<ArmBase[]>,
): ReturnType<typeof vi.fn<(deps: Phase1Deps) => Promise<ArmBase[]>>> {
  return vi.fn(impl);
}

afterEach(() => {
  clearRunState();
});

describe("startRun — identity + state + Phase-1 dispatch (inline, no driver)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes runId = <utc-date>-<id>, sets run-state phase-1, dispatches Phase-1, returns phase1-done + advances to phase-2", async () => {
    const bases = fakeBases(["A1", "A3"]);
    const phase1 = phase1Mock(async () => bases);
    const deps = makeDeps({ arms: ["A1", "A3"], root, phase1 });

    const result = await startRun(deps);

    expect(result.kind).toBe("phase1-done");
    if (result.kind !== "phase1-done") return;
    expect(result.runId).toBe("2026-08-11-1");
    expect(result.cfgId).toMatch(/^cfg-/);
    expect(result.bases).toBe(bases);

    // run-state set eagerly to phase-1, then advanced to phase-2 on success.
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
    expect(s?.phase).toBe("phase-2");
    expect(s?.cfgId).toBe(result.cfgId);

    // Phase-1 received the resolved identity + proxies + config-derived knobs.
    expect(phase1).toHaveBeenCalledTimes(1);
    const phase1Arg = phase1.mock.calls[0]?.[0];
    expect(phase1Arg?.date).toBe("2026-08-11");
    expect(phase1Arg?.id).toBe(1);
    expect(phase1Arg?.cfgId).toBe(result.cfgId);
    expect(phase1Arg?.armsEnabled).toEqual(["A1", "A3"]);
    expect(phase1Arg?.omFullReflectionThresholdTokens).toBe(4000);
    expect(phase1Arg?.scenarioRepo).toBe(deps.scenarioRepo);
  });

  it("writes the run-config snapshot (cfgId + toolVersions) once + reserves the run dir", async () => {
    const deps = makeDeps({ arms: ["A1"], root, phase1: phase1Mock(async () => fakeBases(["A1"])) });
    await startRun(deps);
    const s = getRunState();
    expect(existsSync(join(root, "configs", `${s?.cfgId}.json`))).toBe(true);
    expect(existsSync(join(root, "runs", "2026-08-11-1"))).toBe(true);
  });

  it("same-day re-run increments the id (no collision with the reserved run dir)", async () => {
    await startRun(makeDeps({ arms: ["A1"], root, phase1: phase1Mock(async () => fakeBases(["A1"])) }));
    await startRun(makeDeps({ arms: ["A1"], root, phase1: phase1Mock(async () => fakeBases(["A1"])) }));
    expect(getRunState()?.runId).toBe("2026-08-11-2");
  });
});

describe("startRun — Phase-1 stop-and-surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-stop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a Phase1StoppedError from runPhase1 → stopped result + notify + run-state lastStopReason", async () => {
    const notify = vi.fn();
    const phase1 = phase1Mock(async () => {
      throw new Phase1StoppedError("A3", "cancelled", "arm A3 compaction cancelled");
    });
    const deps = makeDeps({ arms: ["A3"], root, notify, phase1 });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.arm).toBe("A3");
    expect(result.reason).toBe("cancelled");
    expect(result.message).toContain("cancelled");
    expect(result.runId).toBe("2026-08-11-1");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/stopped.*A3/i));
    expect(getRunState()?.lastStopReason).toContain("cancelled");
  });

  it("does NOT swallow non-Phase1StoppedError errors (unexpected failures re-throw)", async () => {
    const phase1 = phase1Mock(async () => {
      throw new Error("unexpected boom");
    });
    const deps = makeDeps({ arms: ["A1"], root, phase1 });
    await expect(startRun(deps)).rejects.toThrow("unexpected boom");
  });
});

// Phase1Ops stays referenced so tsc does not flag a dangling import when the suite evolves.
void (undefined as unknown as Phase1Ops);
