// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchConfig } from "../../src/config/types.js";
import { type ArmBase, Phase1StoppedError } from "../../src/orchestrate/phase1.js";
import { type StartRunDeps, startRun } from "../../src/orchestrate/run.js";
import { getRunState, statusString } from "../../src/orchestrate/run-state.js";

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

function makeDeps(opts: {
  arms: BenchConfig["armsEnabled"];
  root: string;
  scenarioRepo?: string;
  phase1?: StartRunDeps["phase1"];
  now?: () => Date;
  notify?: (m: string) => void;
  versionResolver?: StartRunDeps["versionResolver"];
}): StartRunDeps {
  return {
    pi: {} as ExtensionAPI,
    cmdCtx: {} as ExtensionCommandContext,
    switchCtx: { reload: vi.fn(async () => {}) },
    config: makeConfig(opts.arms),
    scenarioRepo: opts.scenarioRepo ?? "/repo/scenario-x",
    root: opts.root,
    now: opts.now ?? (() => new Date("2026-08-11T10:00:00Z")),
    notify: opts.notify,
    phase1: opts.phase1,
    versionResolver: opts.versionResolver,
  } as StartRunDeps;
}

describe("startRun — identity + state", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes runId = <utc-date>-<id> + sets run-state phase-1 before phase1 runs", async () => {
    const fakeBases: ArmBase[] = [
      { arm: "A1", tool: "bare-pi", ver: undefined, cfgId: "cfg-x", branch: "b1", wallMs: 1, usage: undefined },
    ];
    let phase1Called = false;
    const deps = makeDeps({
      arms: ["A1"],
      root,
      phase1: async () => {
        phase1Called = true;
        return fakeBases;
      },
    });

    await startRun(deps);

    // run-state was set BEFORE phase1 ran (eager, so the widget can show it).
    expect(phase1Called).toBe(true);
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
    expect(s?.date).toBe("2026-08-11");
    expect(s?.id).toBe(1);
    expect(s?.cfgId).toMatch(/^cfg-/);
    expect(s?.phase).toBe("phase-2"); // advanced after phase1 success
  });

  it("writes the run-config snapshot (cfgId + toolVersions) once", async () => {
    const deps = makeDeps({
      arms: ["A1"],
      root,
      phase1: async () => [],
    });
    const result = await startRun(deps);
    expect(result.kind).toBe("phase1-done");
    // config file exists at root/configs/<cfgId>.json
    const s = getRunState();
    expect(existsSync(join(root, "configs", `${s?.cfgId}.json`))).toBe(true);
  });

  it("increments id when a run dir for that date already exists", async () => {
    // pre-create a prior run dir for the same date
    mkdirSync(join(root, "runs", "2026-08-11-1"), { recursive: true });
    const deps = makeDeps({
      arms: ["A1"],
      root,
      phase1: async () => [],
    });
    await startRun(deps);
    expect(getRunState()?.id).toBe(2);
    expect(getRunState()?.runId).toBe("2026-08-11-2");
  });
});

describe("startRun — stop-and-surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-stop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("catches Phase1StoppedError → records lastStopReason + notifies + returns stopped", async () => {
    const notify = vi.fn();
    const stopErr = new Phase1StoppedError("A2", "cancelled", "arm A2 compaction cancelled — no memory");
    const deps = makeDeps({
      arms: ["A1", "A2"],
      root,
      notify,
      phase1: vi.fn(async () => {
        throw stopErr;
      }),
      versionResolver: {
        resolveRoot: () => "/fake",
        gitHead: () => "abcdef1234567890",
        npmVersion: () => null,
      },
    });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") {
      expect(result.arm).toBe("A2");
      expect(result.reason).toBe("cancelled");
      expect(result.runId).toBe("2026-08-11-1");
    }
    // run-state records the stop reason (visible in /status)
    expect(getRunState()?.lastStopReason).toContain("cancelled");
    expect(statusString()).toContain("stopped");
    // operator was notified
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("A2");
  });

  it("does NOT swallow non-stop errors (unexpected failures re-throw)", async () => {
    const deps = makeDeps({
      arms: ["A1"],
      root,
      phase1: vi.fn(async () => {
        throw new Error("unexpected boom");
      }),
    });
    await expect(startRun(deps)).rejects.toThrow("unexpected boom");
  });
});
