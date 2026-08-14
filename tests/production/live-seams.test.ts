// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { describe, expect, it } from "vitest";
import type { MemoryProxies } from "../../src/arms/proxies.js";
import { defaultBuildPrepareDeps } from "../../src/commands/prepare-scenario.js";
import { LANDING_FILE, type LandingState, writeLandingState } from "../../src/production/landing-state.js";
import type { WidgetPort } from "../../src/widget/active-widget.js";

/** A capturing WidgetPort: records startPhase calls. */
function capturingWidget(): WidgetPort & { phases: string[] } {
  const phases: string[] = [];
  return {
    phases,
    show: () => {},
    startPhase: (phase) => {
      phases.push(phase);
    },
    setStatus: () => {},
    setArm: () => {},
    setDetail: () => {},
    setCtxWindow: () => {},
    onEvent: () => {},
    hide: () => {},
  };
}

import { _setHandleForTest } from "../../src/config/accessor.js";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import {
  type BuildDriver,
  buildAuthorSeam,
  buildDriveAndCaptureSeam,
  buildLiveSeams,
  buildSessionHeader,
  buildTailCheckSeam,
  buildTrialCompactSeam,
  type ConfigureArmOp,
  type CtxHolder,
  type DriveAndCaptureSeamDeps,
  type ResolveModel,
  type RunAuthor,
  type RunStage,
  readBackupEntries,
  readRawBackupEntries,
  serializeSessionFile,
  sliceKeptTail,
  type TriggerCompactOp,
} from "../../src/production/live-seams.js";
import type { SimulatorHooks } from "../../src/simulator/loop.js";

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

  it("advances the widget to the 'extract' cell before running the authoring agent", async () => {
    const widget = capturingWidget();
    const author = buildAuthorSeam({
      ctxGetter: () => fakeCtx,
      evaluatedModel: null,
      scenarioCtx: { id: "sc1", description: "d", compactionBoundary: { phaseATokenBudget: 140000, plan: "build" } },
      signal: new AbortController().signal,
      maxTokens: 4096,
      runAuthor: async () => ({ id: "sc1" }) as unknown as ScenarioManifest,
      widget,
    });
    await author("/tmp/sliced-0.jsonl");
    expect(widget.phases).toContain("extract");
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
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: (p) => existsPaths.has(p),
      writeHeader: (p, header) => {
        written.push({ path: p, cwd: header.cwd });
      },
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (_args) => fakeDriver(2, _args.onStop),
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n{"type":"message","id":"m1"}\n`,
    });

    const result = await driveAndCapture(0);
    expect(written).toEqual([{ path: "/tmp/build.jsonl", cwd: "/repo" }]);
    expect(result.backupPath).toBe("/tmp/build.jsonl");
    expect(result.backupEntries).toEqual([{ id: "m1" }]);
    expect(holder.current).toBe(freshCtx);
  });

  it("paces against ACTUAL session usage: a >continueStep overshoot still leaves headroom (plant retry)", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    // A big overshoot: usage 180K already exceeds the resumed formula target
    // (140K + 1×20K = 160K), so the pacing target must grow to usage+step.
    const grownCtx = {
      getContextUsage: () => ({ tokens: 180000, contextWindow: 200000 }),
    } as unknown as ExtensionCommandContext;
    const loadedLoad: typeof fakeLoadSession = async (_ctx, _path, withSession) => withSession(grownCtx);
    let seenTarget = 0;
    let seeded = 0;
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => true,
      writeHeader: () => {},
      loadSession: loadedLoad,
      awaitSettled: async () => {},
      makeSimulator: (args) => {
        seenTarget = args.targetContext;
        return {
          trackContext: (t) => {
            seeded = t;
          },
          onAgentSettled: async () => args.onStop({ contextTokens: 0, reason: "boundary" }),
        };
      },
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}
`,
    });
    await driveAndCapture(1); // formula target = 140K + 1*20K = 160K < usage 180K
    expect(seenTarget).toBe(180000 + 20000); // max(160K, usage+step) — headroom restored
    expect(seeded).toBe(180000);
  });

  it("advances the widget to the 'build' cell before driving", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const widget = capturingWidget();
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => false,
      writeHeader: () => {},
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (args) => ({
        trackContext: () => {},
        onAgentSettled: async () => args.onStop({ contextTokens: 0, reason: "boundary" }),
      }),
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      widget,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });
    await driveAndCapture(0);
    expect(widget.phases).toContain("build");
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
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: (p) => p === "/tmp/build.jsonl",
      writeHeader: (p) => {
        written.push(p);
      },
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (args) => fakeDriver(1, args.onStop),
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });

    await driveAndCapture(1);
    expect(written).toEqual([]);
  });

  it("disables memory (configures the bare-pi arm A1) before driving when proxies are live", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const configured = { arm: "", repoCwd: "" };
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => false,
      writeHeader: () => {},
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (args) => fakeDriver(1, args.onStop),
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      getProxies: () => ({ om: {}, mk: {} }) as unknown as MemoryProxies,
      configureArm: ((_pi: unknown, _om: unknown, _mk: unknown, arm: string, repoCwd: string) => {
        configured.arm = arm;
        configured.repoCwd = repoCwd;
      }) as unknown as ConfigureArmOp,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });

    await driveAndCapture(0);
    expect(configured.arm).toBe("A1");
    expect(configured.repoCwd).toBe("/repo");
  });

  it("throws when the simulator signals an error-stop", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    let fired = false;
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "x",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => false,
      writeHeader: () => {},
      loadSession: fakeLoadSession,
      awaitSettled: async () => {},
      makeSimulator: (args) => {
        return {
          trackContext: () => {},
          onAgentSettled: async () => {
            if (!fired) {
              fired = true;
              args.onStop({ contextTokens: 0, reason: "error", error: "boom" });
            }
          },
        };
      },
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });
    await expect(driveAndCapture(0)).rejects.toThrow(/simulator stopped with an error/);
  });

  it("throws when the agent fails to settle (aborted)", async () => {
    const holder: CtxHolder = { current: {} as ExtensionCommandContext };
    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "x",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => false,
      writeHeader: () => {},
      loadSession: fakeLoadSession,
      awaitSettled: async () => {
        throw new Error("agent did not settle (run signal aborted)");
      },
      makeSimulator: (args) => fakeDriver(99, args.onStop), // never boundary-stops
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n`,
    });
    await expect(driveAndCapture(0)).rejects.toThrow(/agent did not settle/);
  });
});

describe("live-seams integration (cross-seam ctx-threading)", () => {
  it("threads the fresh ctx across driveAndCapture → trialCompact → author via the shared holder", async () => {
    const holder: CtxHolder = { current: { id: "initial" } as unknown as ExtensionCommandContext };
    // A recording loadSession: threads holder.current to a distinct fresh ctx per call +
    // records the "from" ctx each seam passed in (proves the holder threads).
    const fromCtxs: string[] = [];
    let call = 0;
    const recordingLoad = (async (
      fromCtx: ExtensionCommandContext,
      _path: string,
      withSession: (ctx: ExtensionCommandContext) => Promise<unknown>,
    ) => {
      fromCtxs.push((fromCtx as { id?: string }).id ?? "?");
      call += 1;
      const fresh = { id: `fresh-${call}`, getContextUsage: () => undefined } as unknown as ExtensionCommandContext;
      holder.current = fresh;
      return withSession(fresh);
    }) as unknown as typeof import("../../src/session/switch.js").loadSession;

    const driveAndCapture = buildDriveAndCaptureSeam({
      holder,
      repoPath: "/repo",
      buildSessionPath: "/tmp/build.jsonl",
      compactionBoundary: 140000,
      scenarioDescription: "build a game",
      evaluatedModel: null,
      omFullReflectionThresholdTokens: 4000,
      signal: new AbortController().signal,
      maxTokens: 1024,
      exists: () => false,
      writeHeader: () => {},
      loadSession: recordingLoad,
      awaitSettled: async () => {},
      makeSimulator: (args) => ({
        trackContext: () => {},
        onAgentSettled: async () => args.onStop({ contextTokens: 0, reason: "boundary" }),
      }),
      getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
      read: () => `{"type":"session","id":"h","cwd":"/repo"}\n{"type":"message","id":"m1"}\n`,
    });
    const trialCompact = buildTrialCompactSeam({
      holder,
      repoCwd: "/repo",
      omFullReflectionThresholdTokens: 4000,
      trialCopyPath: "/tmp/trial.jsonl",
      copyFile: () => {},
      loadSession: recordingLoad,
      triggerCompact: (async () => ({
        compactionEntry: { firstKeptEntryId: "m1", summary: "s" },
        wallMs: 1,
      })) as unknown as TriggerCompactOp,
      getPi: () => ({}) as unknown as ExtensionAPI,
      getProxies: () => null,
    });
    let authorResolveCtx: unknown = null;
    const author = buildAuthorSeam({
      ctxGetter: () => holder.current,
      evaluatedModel: null,
      scenarioCtx: { id: "sc1", description: "d", compactionBoundary: { phaseATokenBudget: 140000, plan: "build" } },
      signal: new AbortController().signal,
      maxTokens: 4096,
      resolveModel: (async (ctx: ExtensionContext) => {
        authorResolveCtx = ctx;
        return { ok: true, model: {}, apiKey: "k" };
      }) as unknown as ResolveModel,
      runStage: (async () => ({ aborted: false, timedOut: false, messages: [] })) as unknown as RunStage,
      runAuthor: (async (deps: { seams: { resolveModel(): Promise<unknown> } }) => {
        await deps.seams.resolveModel(); // exercise the ctxGetter-bound resolveModel
        return { id: "sc1" } as unknown as ScenarioManifest;
      }) as unknown as RunAuthor,
    });

    // Drive the buildBackup order: driveAndCapture(0) → trialCompact → author.
    await driveAndCapture(0);
    await trialCompact("/tmp/build.jsonl");
    await author("/tmp/slice/sliced-0.jsonl");

    // driveAndCapture got the initial ctx; trialCompact got drive's fresh-1 (the holder threads).
    expect(fromCtxs).toEqual(["initial", "fresh-1"]);
    // author's resolveModel received trial's fresh-2 (the holder threaded through author's ctxGetter).
    expect((authorResolveCtx as { id?: string })?.id).toBe("fresh-2");
    expect((holder.current as { id?: string }).id).toBe("fresh-2");
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
        {
          idea: "build a game",
          fromSession: undefined,
          plantFrom: undefined,
          skipFrom: undefined,
          skipTopics: undefined,
          force: false,
          error: undefined,
        },
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

  it("--plant resume derives from landing.json and restarts ONE PAST the surfaced attempt", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "bench-plant-"));
    const scenarioFolder = join(tmpRoot, "scenarios", "surfaced");
    mkdirSync(scenarioFolder, { recursive: true });
    writeLandingState(join(scenarioFolder, LANDING_FILE), {
      missingTopics: [
        { id: "change-mind", label: "Changed mind", tag: "safeToSkip" },
        { id: "key-decision", label: "Key decision", tag: "essential" },
      ],
      skipOffered: false,
      buildSessionPath: join(scenarioFolder, "pre-slice", "build.jsonl"),
      firstKeptEntryId: "e42",
      attempt: 2,
      scenario: "build a tycoon game",
      manifest: {} as unknown as LandingState["manifest"],
    });
    _setHandleForTest({
      getSettings: () => ({ outputDir: tmpRoot, compactionBoundary: 50000 }),
    } as unknown as SettingsHandle);
    try {
      const deps = defaultBuildPrepareDeps(
        fakeCmdCtx,
        {
          idea: undefined,
          fromSession: undefined,
          plantFrom: scenarioFolder,
          skipFrom: undefined,
          skipTopics: undefined,
          force: false,
          error: undefined,
        },
        "surfaced",
      );
      // the +1 is the fix: restarting AT attempt 2 would pace-stop immediately
      // (usage already crossed attempt 2's target); 3 grows the target one step.
      expect(deps.resume?.attempt).toBe(3);
      expect(deps.resume?.plantInstruction).toContain("Changed mind");
      expect(deps.resume?.plantInstruction).toContain("Key decision");
      expect(deps.scenario).toBe("build a tycoon game");
    } finally {
      _setHandleForTest(null);
      rmSync(tmpRoot, { recursive: true, force: true });
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
        {
          idea: undefined,
          fromSession: "/real/session.jsonl",
          plantFrom: undefined,
          skipFrom: undefined,
          skipTopics: undefined,
          force: false,
          error: undefined,
        },
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

describe("tail-check seam (findTailContent wiring)", () => {
  const SESSION = [
    JSON.stringify({ type: "session", id: "s1", cwd: "/repo" }),
    JSON.stringify({
      type: "message",
      id: "e1",
      message: { role: "user", content: [{ type: "text", text: "Early decision: fixed tick." }] },
    }),
    JSON.stringify({
      type: "message",
      id: "e2",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "e3",
      message: { role: "user", content: [{ type: "text", text: "Actually use variable tick instead." }] },
    }),
    JSON.stringify({
      type: "message",
      id: "e4",
      message: { role: "user", content: [{ type: "text", text: "What about the save format? Let's decide later." }] },
    }),
  ].join("\n");

  it("readRawBackupEntries skips the header; sliceKeptTail keeps entries at/after the cut", () => {
    const raw = readRawBackupEntries("/b.jsonl", { read: () => SESSION });
    expect(raw).toHaveLength(4);
    const tail = sliceKeptTail(raw, "e3");
    expect((tail[0] as { id?: string }).id).toBe("e3"); // at the cut (kept tail)
    expect(tail).toHaveLength(2);
  });

  it("unknown cut id → empty tail (nothing provably in-tail)", () => {
    expect(sliceKeptTail(readRawBackupEntries("/b.jsonl", { read: () => SESSION }), "nope")).toHaveLength(0);
  });

  it("seam renders the kept tail as user content + parses the JSON reply into topic ids", async () => {
    const captured: { systemPrompt: string; userContent: string } = { systemPrompt: "", userContent: "" };
    const seam = buildTailCheckSeam({
      ctxGetter: () => fakeCtx,
      evaluatedModel: null,
      signal: new AbortController().signal,
      resolveModel: (async () => ({ ok: true, model: { id: "m" }, apiKey: "k" })) as unknown as ResolveModel,
      read: () => SESSION,
      runStage: (async (input: { systemPrompt: string; messages: { content: string }[] }) => {
        captured.systemPrompt = input.systemPrompt;
        captured.userContent = input.messages[0].content;
        return {
          aborted: false,
          timedOut: false,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `{"key-decision": true, "completed-work": false, "reversal": true, "open-question": true}`,
                },
              ],
            },
          ],
        };
      }) as unknown as RunStage,
    });
    const ids = await seam("/b.jsonl", "e3");
    expect(captured.systemPrompt).toContain("KEPT TAIL");
    expect(captured.userContent).toContain("variable tick");
    expect(captured.userContent).not.toContain("fixed tick"); // pre-cut entry excluded
    expect([...ids].sort()).toEqual(["change-mind", "key-decision", "open-question"]);
  });

  it("malformed LLM reply → conservative empty set (missing → surface, never infinite-continue)", async () => {
    const seam = buildTailCheckSeam({
      ctxGetter: () => fakeCtx,
      evaluatedModel: null,
      signal: new AbortController().signal,
      resolveModel: (async () => ({ ok: true, model: { id: "m" }, apiKey: "k" })) as unknown as ResolveModel,
      read: () => SESSION,
      runStage: (async () => ({
        aborted: false,
        timedOut: false,
        messages: [{ role: "assistant", content: [{ type: "text", text: "cannot answer" }] }],
      })) as unknown as RunStage,
    });
    expect((await seam("/b.jsonl", "e3")).size).toBe(0);
  });

  it("model unavailable → throws (stop-and-surface, not silent)", async () => {
    const seam = buildTailCheckSeam({
      ctxGetter: () => fakeCtx,
      evaluatedModel: null,
      signal: new AbortController().signal,
      resolveModel: (async () => ({ ok: false, error: "no such model" })) as unknown as ResolveModel,
      read: () => SESSION,
      runStage: (async () => ({ aborted: false, timedOut: false, messages: [] })) as unknown as RunStage,
    });
    await expect(seam("/b.jsonl", "e3")).rejects.toThrow(/not available/);
  });
});

describe("driveAndCapture — plant threading (plant-and-continue resume)", () => {
  const baseDeps = (makeSimulator: DriveAndCaptureSeamDeps["makeSimulator"]): DriveAndCaptureSeamDeps => ({
    holder: { current: {} as ExtensionCommandContext },
    repoPath: "/repo",
    buildSessionPath: "/tmp/build.jsonl",
    compactionBoundary: 140000,
    scenarioDescription: "build a game",
    evaluatedModel: null,
    omFullReflectionThresholdTokens: 4000,
    signal: new AbortController().signal,
    maxTokens: 1024,
    exists: () => true,
    writeHeader: () => {},
    loadSession: (async (_ctx: unknown, _path: string, withSession: (ctx: unknown) => Promise<void>) => {
      await withSession({ getContextUsage: () => null });
    }) as unknown as DriveAndCaptureSeamDeps["loadSession"],
    awaitSettled: async () => {},
    makeSimulator,
    getPi: () => ({ on: () => {} }) as unknown as ExtensionAPI,
    read: () => `{"type":"session","id":"h","cwd":"/repo"}\n{"type":"message","id":"m1"}\n`,
  });

  it("passes firstInstruction ONLY at the plant attempt (other attempts get undefined)", async () => {
    const seen: (string | undefined)[] = [];
    // Stops on its FIRST cycle (boundary) — the drive loop exits immediately.
    const fakeDriver = (onStop: NonNullable<SimulatorHooks["onStop"]>): BuildDriver => ({
      onAgentSettled: async (): Promise<void> => {
        onStop({ contextTokens: 0, reason: "boundary" });
      },
      trackContext: () => {},
    });
    const driveAndCapture = buildDriveAndCaptureSeam({
      ...baseDeps((args) => {
        seen.push(args.firstInstruction);
        return fakeDriver(args.onStop);
      }),
      plant: { attempt: 2, instruction: "Bring up the changed-mind topic now." },
    });
    await driveAndCapture(0);
    await driveAndCapture(2);
    expect(seen[0]).toBeUndefined(); // pre-plant attempt
    expect(seen[1]).toBe("Bring up the changed-mind topic now."); // the resumed plant drive
  });

  it("no plant configured → firstInstruction always undefined", async () => {
    const seen: (string | undefined)[] = [];
    const fakeDriver = (onStop: NonNullable<SimulatorHooks["onStop"]>): BuildDriver => ({
      onAgentSettled: async (): Promise<void> => {
        onStop({ contextTokens: 0, reason: "boundary" });
      },
      trackContext: () => {},
    });
    const driveAndCapture = buildDriveAndCaptureSeam({
      ...baseDeps((args) => {
        seen.push(args.firstInstruction);
        return fakeDriver(args.onStop);
      }),
    });
    await driveAndCapture(0);
    expect(seen[0]).toBeUndefined();
  });
});
