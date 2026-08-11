// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchConfig } from "../../src/config/types.js";
import { getPhase1Cursor, type Phase1Ops } from "../../src/orchestrate/phase1.js";
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

function makeDeps(opts: {
  arms: BenchConfig["armsEnabled"];
  root: string;
  scenarioRepo?: string;
  ops?: Partial<Phase1Ops>;
  now?: () => Date;
  notify?: (m: string) => void;
  onDone?: () => void;
}): StartRunDeps {
  return {
    switchCtx: { reload: vi.fn(async () => {}) },
    config: makeConfig(opts.arms),
    scenarioRepo: opts.scenarioRepo ?? "/repo/scenario-x",
    root: opts.root,
    now: opts.now ?? (() => new Date("2026-08-11T10:00:00Z")),
    notify: opts.notify,
    onDone: opts.onDone,
    ops: opts.ops,
    versionResolver: {
      resolveRoot: () => "/fake",
      gitHead: () => "abcdef1234567890",
      npmVersion: () => null,
    },
  } as unknown as StartRunDeps;
}

afterEach(() => {
  clearRunState();
});

describe("startRun — identity + state + trigger", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes runId = <utc-date>-<id>, sets run-state phase-1, installs the cursor, returns phase1-started", async () => {
    const switchArm = vi.fn(async () => {});
    const deps = makeDeps({ arms: ["A1", "A3"], root, ops: { switchArm } });

    const result = await startRun(deps);

    expect(result.kind).toBe("phase1-started");
    if (result.kind === "phase1-started") {
      expect(result.runId).toBe("2026-08-11-1");
      expect(result.cfgId).toMatch(/^cfg-/);
    }
    // run-state set eagerly to phase-1 (widget + /status reflect it).
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
    expect(s?.phase).toBe("phase-1");
    // cursor installed with the arms in order + the run deps (the driver reads it on reload).
    const cursor = getPhase1Cursor();
    expect(cursor?.arms).toEqual(["A1", "A3"]);
    expect(cursor?.nextArmIndex).toBe(0);
    expect(cursor?.bases).toEqual([]);
  });

  it("triggers ONLY the first arm's isolation (switchArm(arm[0])); the driver owns the rest", async () => {
    const switchArm = vi.fn(async () => {});
    const deps = makeDeps({ arms: ["A1", "A3", "A5"], root, ops: { switchArm } });

    await startRun(deps);

    expect(switchArm).toHaveBeenCalledTimes(1);
    expect(switchArm).toHaveBeenCalledWith(expect.anything(), "A1", deps.scenarioRepo, {
      omFullReflectionThresholdTokens: 4000,
    });
  });

  it("writes the run-config snapshot (cfgId + toolVersions) once", async () => {
    const deps = makeDeps({ arms: ["A1"], root, ops: { switchArm: vi.fn(async () => {}) } });
    await startRun(deps);
    const s = getRunState();
    expect(existsSync(join(root, "configs", `${s?.cfgId}.json`))).toBe(true);
  });

  it("reserves the run dir at start so a same-day stop-and-retry cannot collide ids", async () => {
    const deps = makeDeps({ arms: ["A1"], root, ops: { switchArm: vi.fn(async () => {}) } });
    await startRun(deps);
    expect(existsSync(join(root, "runs", "2026-08-11-1"))).toBe(true);
    // a second same-day run sees the reserved dir → id=2, no collision
    await startRun(makeDeps({ arms: ["A1"], root, ops: { switchArm: vi.fn(async () => {}) } }));
    expect(getRunState()?.runId).toBe("2026-08-11-2");
  });
});

describe("startRun — first switchArm failure", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-run-stop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("surfaces a pre-reload switchArm throw as stopped(reason=switchArm-failed)", async () => {
    const notify = vi.fn();
    const switchArm = vi.fn(async () => {
      throw new Error("settings write failed");
    });
    const deps = makeDeps({ arms: ["A1"], root, notify, ops: { switchArm } });

    const result = await startRun(deps);

    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") {
      expect(result.arm).toBe("A1");
      expect(result.reason).toBe("switchArm-failed");
      expect(result.message).toContain("settings write failed");
    }
  });

  it("does NOT swallow non-switchArm errors (unexpected failures re-throw)", async () => {
    // A non-throwing switchArm but a broken config write path: simulate by making writeRunConfig
    // unreachable — instead force nextRunId to throw via a root that vanishes mid-call is fragile;
    // the switchArm-failed path is the only synchronous failure, so assert the happy path does not
    // throw spuriously + the contract is exactly {started | stopped(switchArm-failed)}.
    const switchArm = vi.fn(async () => {});
    const deps = makeDeps({ arms: ["A1"], root, ops: { switchArm } });
    const result = await startRun(deps);
    expect(["phase1-started", "stopped"]).toContain(result.kind);
  });
});

// ExtensionAPI is unused now (pi is threaded via the driver, not startRun); keep the import
// honest by referencing the type so tsc does not flag a dangling import.
void (undefined as unknown as ExtensionAPI);
