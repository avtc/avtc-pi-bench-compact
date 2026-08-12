// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { describe, expect, it } from "vitest";
import type { MemoryProxies } from "../../src/arms/proxies.js";
import { defaultBuildPrepareDeps } from "../../src/commands/prepare-scenario.js";
import { _setHandleForTest } from "../../src/config/accessor.js";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import {
  type BuildDriver,
  buildAuthorSeam,
  buildDriveAndCaptureSeam,
  buildLiveSeams,
  buildSessionHeader,
  buildTrialCompactSeam,
  type ConfigureArmOp,
  type CtxHolder,
  type ResolveModel,
  type RunStage,
  readBackupEntries,
  serializeSessionFile,
  type TriggerCompactOp,
} from "../../src/production/live-seams.js";

const fakeCtx = {} as ExtensionContext;
const fakeCmdCtx = {} as ExtensionCommandContext;

describe("buildSessionHeader", () => {
  it("produces a minimal valid session header with cwd=repo", () => {
    const header = buildSessionHeader({ repoPath: "/repo", id: "abc", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(header).toEqual({ type: "session", id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" });
  });
});

describe("serializeSessionFile", () => {
  it("serializes the header as a single JSON line with a trailing newline", () => {
    const header = buildSessionHeader({ repoPath: "/r", id: "x", timestamp: "t" });
    expect(serializeSessionFile(header)).toBe(`{"type":"session","id":"x","timestamp":"t","cwd":"/r"}\n`);
  });
});

describe("readBackupEntries", () => {
  it("reads entries excluding the session header, mapped to {id}", () => {
    const jsonl =
      `{"type":"session","id":"h","timestamp":"t","cwd":"/r"}\n` +
      `{"type":"message","id":"m1"}\n` +
      `{"type":"message","id":"m2"}\n`;
    const entries = readBackupEntries("/path", { read: () => jsonl });
    expect(entries).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("returns an empty array for a header-only session", () => {
    const jsonl = `{"type":"session","id":"h","timestamp":"t","cwd":"/r"}\n`;
    expect(readBackupEntries("/path", { read: () => jsonl })).toEqual([]);
  });

  it("ignores blank trailing lines", () => {
    const jsonl = `{"type":"session","id":"h","timestamp":"t","cwd":"/r"}\n{"type":"message","id":"m1"}\n\n`;
    expect(readBackupEntries("/path", { read: () => jsonl })).toEqual([{ id: "m1" }]);
  });
});

describe("buildAuthorSeam", () => {
  it("wires runAuthoringAgent with resolveModel(ctx, evaluatedModel) + runStage + cwd=dirname(jsonl)", async () => {
    const scenarioCtx = {
      id: "sc1",
      description: "build a game",
      compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
    };
    const signal = new AbortController().signal;
    const captured = { cwd: "", preSlicedJsonlPath: "", resolveCtx: fakeCtx, modelSetting: "x" as string | null };
    const manifest = { id: "sc1" } as unknown as ScenarioManifest;
    const author = buildAuthorSeam({
      ctxGetter: () => fakeCtx,
      evaluatedModel: "provider/model-a",
      scenarioCtx,
      signal,
      maxTokens: 4096,
      resolveModel: (async (ctx: ExtensionContext, modelSetting: string | null) => {
        captured.resolveCtx = ctx;
        captured.modelSetting = modelSetting;
        return { ok: true, model: { id: "model-a" }, apiKey: "key" };
      }) as unknown as ResolveModel,
      runStage: (async () => ({ aborted: false, timedOut: false, messages: [] })) as unknown as RunStage,
      runAuthor: async (deps) => {
        captured.cwd = deps.cwd;
        captured.preSlicedJsonlPath = deps.preSlicedJsonlPath;
        await deps.seams.resolveModel();
        return manifest;
      },
    });

    const result = await author("/tmp/slice/sliced-0.jsonl");
    expect(result).toBe(manifest);
    expect(captured.cwd).toBe("/tmp/slice");
    expect(captured.preSlicedJsonlPath).toBe("/tmp/slice/sliced-0.jsonl");
    expect(captured.resolveCtx).toBe(fakeCtx);
    expect(captured.modelSetting).toBe("provider/model-a");
  });
});

describe("buildTrialCompactSeam", () => {
  const freshCtx = { fresh: true } as unknown as ExtensionCommandContext;
  // A fake loadSession that invokes withSession(freshCtx) — the seam updates holder.current.
  const fakeLoadSession: typeof import("../../src/session/switch.js").loadSession = async (_ctx, _path, withSession) =>
    withSession(freshCtx);

  it("copies the backup, compacts the copy, + returns the native cut (no memory proxies → no configureArm)", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const copies: { src: string; dest: string }[] = [];
    let triggered = false;
    let configuredArm: string | null = null;
    const trialCompact = buildTrialCompactSeam({
      holder,
      repoCwd: "/repo",
      omFullReflectionThresholdTokens: 4000,
      trialCopyPath: "/tmp/trial.jsonl",
      copyFile: (src, dest) => {
        copies.push({ src, dest });
      },
      loadSession: fakeLoadSession,
      triggerCompact: (async () => {
        triggered = true;
        return { compactionEntry: { firstKeptEntryId: "e5", summary: "cut here" }, wallMs: 100 };
      }) as unknown as TriggerCompactOp,
      configureArm: ((_pi: unknown, _om: unknown, _mk: unknown, arm: string) => {
        configuredArm = arm;
      }) as unknown as ConfigureArmOp,
      getPi: () => ({}) as unknown as ExtensionAPI,
      getProxies: () => null,
    });

    const cut = await trialCompact("/tmp/backup-0.jsonl");
    expect(cut).toEqual({ firstKeptEntryId: "e5", summary: "cut here" });
    expect(copies).toEqual([{ src: "/tmp/backup-0.jsonl", dest: "/tmp/trial.jsonl" }]);
    expect(triggered).toBe(true);
    expect(configuredArm).toBeNull(); // no proxies → skip configureArm (memory not loaded → native anyway)
    expect(holder.current).toBe(freshCtx); // ctx threaded
  });

  it("configures the bare-pi arm (A1) to disable memory hooks when proxies are live", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const configured: { arm: string; repoCwd: string; threshold: number } = { arm: "", repoCwd: "", threshold: 0 };
    const fakeProxies = { om: {}, mk: {} } as unknown as MemoryProxies;
    const trialCompact = buildTrialCompactSeam({
      holder,
      repoCwd: "/repo",
      omFullReflectionThresholdTokens: 4000,
      trialCopyPath: "/tmp/trial.jsonl",
      copyFile: () => {},
      loadSession: fakeLoadSession,
      triggerCompact: (async () => ({
        compactionEntry: { firstKeptEntryId: "e1", summary: "s" },
        wallMs: 1,
      })) as unknown as TriggerCompactOp,
      configureArm: ((
        _pi: unknown,
        _om: unknown,
        _mk: unknown,
        arm: string,
        repoCwd: string,
        opts: { omFullReflectionThresholdTokens: number },
      ) => {
        configured.arm = arm;
        configured.repoCwd = repoCwd;
        configured.threshold = opts.omFullReflectionThresholdTokens;
      }) as unknown as ConfigureArmOp,
      getPi: () => ({}) as unknown as ExtensionAPI,
      getProxies: () => fakeProxies,
    });

    await trialCompact("/tmp/backup-0.jsonl");
    expect(configured.arm).toBe("A1");
    expect(configured.repoCwd).toBe("/repo");
    expect(configured.threshold).toBe(4000);
  });
});

describe("buildDriveAndCaptureSeam", () => {
  const freshCtx = {
    fresh: true,
    getContextUsage: () => ({ tokens: 0, contextWindow: 200000 }),
  } as unknown as ExtensionCommandContext;
  const fakeLoadSession: typeof import("../../src/session/switch.js").loadSession = async (_ctx, _path, withSession) =>
    withSession(freshCtx);

  /** A fake driver that fires onStop({reason:'boundary'}) on the Nth cycle. */
  function fakeDriver(
    stopAfter: number,
    onStop: (info: { contextTokens: number; reason: "boundary" | "error"; error?: string }) => void,
  ): BuildDriver {
    let cycles = 0;
    return {
      trackContext: () => {},
      onAgentSettled: async () => {
        cycles += 1;
        if (cycles >= stopAfter) {
          onStop({ contextTokens: 0, reason: "boundary" });
        }
      },
    };
  }

  it("writes a build-session header (cwd=repo) when absent, drives, + captures entries", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const written: { path: string; cwd: string }[] = [];
    const existsPaths = new Set<string>();
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: "provider/m",
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: (p) => existsPaths.has(p),
      writeHeader: (p, header) => {
        written.push({ path: p, cwd: header.cwd });
      },
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (_args) => fakeDriver(2, _args.onStop),
      getPi: () => ({ events: { on: () => () => {} } }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n{"type":"message","id":"m1"}\n`,
    });

    const result = await driveAndCapture(0);
    expect(written).toEqual([{ path: "/tmp/build.jsonl", cwd: "/repo" }]);
    expect(result.backupPath).toBe("/tmp/build.jsonl");
    expect(result.backupEntries).toEqual([{ id: "m1" }]);
    expect(holder.current).toBe(freshCtx);
  });

  it("does NOT rewrite the header when the build session already exists", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const written: string[] = [];
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: null,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: (p) => p === "/tmp/build.jsonl",
      writeHeader: (p) => {
        written.push(p);
      },
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (args) => fakeDriver(1, args.onStop),
      getPi: () => ({ events: { on: () => () => {} } }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });

    await driveAndCapture(1);
    expect(written).toEqual([]);
  });
});

describe("buildLiveSeams", () => {
  it("assembles the three seams bound to a shared ctx holder", () => {
    const config = {
      compactionBoundary: 140000,
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
    } as unknown as BenchConfig;
    const seams = buildLiveSeams({
      cmdCtx: fakeCmdCtx,
      config,
      repoPath: "/repo",
      preSliceDir: "/tmp/slice",
      scenarioId: "sc1",
      scenarioDescription: "build a game",
      compactionPlan: "build",
      signal: new AbortController().signal,
    });
    expect(typeof seams.driveAndCapture).toBe("function");
    expect(typeof seams.trialCompact).toBe("function");
    expect(typeof seams.author).toBe("function");
  });
});

describe("defaultBuildPrepareDeps", () => {
  it("computes paths under the bench root + assembles live seams for build mode", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "bench-prep-"));
    _setHandleForTest({
      getSettings: () => ({ outputDir: tmpRoot, compactionBoundary: 50000 }),
    } as unknown as SettingsHandle);
    try {
      const deps = defaultBuildPrepareDeps(
        fakeCmdCtx,
        { idea: "build a game", fromSession: undefined, force: false, error: undefined },
        "sc1",
      );
      expect(deps.scenario).toBe("build a game");
      expect(deps.fromSessionPath).toBeUndefined();
      expect(deps.compactionBoundary).toBe(50000);
      expect(deps.repoPath).toBe(join(tmpRoot, "scenarios", "sc1", "repo"));
      expect(deps.preSliceDir).toBe(join(tmpRoot, "scenarios", "sc1", "pre-slice"));
      expect(deps.seams).toBeDefined();
      expect(deps.force).toBe(false);
    } finally {
      _setHandleForTest(null);
    }
  });

  it("wires extract-mode fields when --from-session is set", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "bench-ext-"));
    _setHandleForTest({
      getSettings: () => ({ outputDir: tmpRoot, compactionBoundary: 50000 }),
    } as unknown as SettingsHandle);
    try {
      const deps = defaultBuildPrepareDeps(
        fakeCmdCtx,
        { idea: undefined, fromSession: "/real/session.jsonl", force: false, error: undefined },
        "session-basename",
      );
      expect(deps.scenario).toBeUndefined();
      expect(deps.fromSessionPath).toBe("/real/session.jsonl");
      expect(deps.extractOutputPath).toBe(
        join(tmpRoot, "scenarios", "session-basename", "pre-slice", "extract-backup.jsonl"),
      );
      expect(deps.extractCwd).toBe(process.cwd());
    } finally {
      _setHandleForTest(null);
    }
  });
});
