// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrepareArgs } from "../../src/commands/parse.js";
import { computeScenarioId } from "../../src/commands/prepare-scenario.js";
import type { RunHandlerContext } from "../../src/commands/run-shared.js";
import {
  executeRun,
  guardPreflight,
  invokeShorthand,
  loadManifestFile,
  resolveScenarioLayout,
} from "../../src/commands/run-shared.js";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { SurfaceConditionsError } from "../../src/production/build.js";
import type { PrepareDeps } from "../../src/production/prepare.js";
import { getActiveWidget, setActiveWidget } from "../../src/widget/active-widget.js";
import { fakeCommandCtx, fakeGuardedCtx } from "./helpers.js";

const S1 = join("root", "scenarios", "s1");
const S1_REPO = join(S1, "repo");
const S1_MANIFEST = join(S1, "manifest.json");

const MANIFEST: ScenarioManifest = {
  id: "scen-1",
  description: "test scenario",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "the task", testSpec: "npm test" },
  probes: [],
} as unknown as ScenarioManifest;

describe("resolveScenarioLayout", () => {
  it("resolves when the folder is the scenario dir (has manifest.json + repo/)", () => {
    const exists = (p: string): boolean => p === S1_MANIFEST || p === S1_REPO;
    const layout = resolveScenarioLayout(S1, exists);
    expect(layout).toEqual({ ok: true, repoPath: S1_REPO, manifestPath: S1_MANIFEST });
  });

  it("resolves when the folder is the repo (manifest.json in the parent)", () => {
    const exists = (p: string): boolean => p === S1_MANIFEST;
    const layout = resolveScenarioLayout(S1_REPO, exists);
    expect(layout).toEqual({ ok: true, repoPath: S1_REPO, manifestPath: S1_MANIFEST });
  });

  it("errors when no manifest.json is found at either candidate location", () => {
    const layout = resolveScenarioLayout(S1_REPO, (): boolean => false);
    expect(layout.ok).toBe(false);
    if (!layout.ok) {
      expect(layout.reason).toMatch(/manifest\.json/);
      expect(layout.reason).toContain(S1_REPO);
    }
  });

  it("prefers the scenario-dir interpretation when both manifest.json candidates exist", () => {
    const layout = resolveScenarioLayout(S1, (): boolean => true);
    expect(layout).toEqual({ ok: true, repoPath: S1_REPO, manifestPath: S1_MANIFEST });
  });

  it("scenario dir with manifest.json but no repo/ subdirectory → error", () => {
    const exists = (p: string): boolean => p === S1_MANIFEST; // manifest present, repo/ absent
    const layout = resolveScenarioLayout(S1, exists);
    expect(layout.ok).toBe(false);
    if (!layout.ok) {
      expect(layout.reason).toContain("no repo/");
      expect(layout.reason).toContain(S1);
    }
  });
});

describe("loadManifestFile", () => {
  const VALID = {
    id: "scen-1",
    description: "a test scenario",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
    recallFacts: [{ id: "rf-1", fact: "scores live in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
    doneOps: [
      { id: "op-1", description: "built the shop", artifact: "src/shop.ts", reworkable: false, entryIds: ["e2"] },
    ],
    supersessions: [],
    abstentions: [],
    probes: [{ question: "where are scores stored?", accept: ["~/.scores.json"], targets: ["e1"] }],
    taskObjective: { description: "the task", testSpec: "npm test" },
  };

  it("parses a structurally valid manifest", () => {
    const read = (): string => JSON.stringify(VALID);
    const manifest = loadManifestFile("/p/manifest.json", read);
    expect(manifest.id).toBe("scen-1");
  });

  it("throws on invalid JSON", () => {
    const read = (): string => "{not json";
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(SyntaxError);
  });

  it("refuses a manifest without taskObjective", () => {
    const read = (): string => JSON.stringify({ ...VALID, taskObjective: undefined });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/taskObjective/);
  });

  it("refuses a manifest with an empty recallFacts list", () => {
    const read = (): string => JSON.stringify({ ...VALID, recallFacts: [] });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/recallFacts.*empty/);
  });

  it("refuses a probe carrying both accept and correctRefusal", () => {
    const read = (): string =>
      JSON.stringify({
        ...VALID,
        probes: [{ question: "q?", accept: ["a"], correctRefusal: true, targets: ["e1"] }],
      });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/exactly one of accept or correctRefusal/);
  });

  it("refuses a manifest whose taskObjective lacks testSpec (the done-snapshot judge reads .length)", () => {
    const read = (): string => JSON.stringify({ ...VALID, taskObjective: { description: "the task" } });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/testSpec/);
  });

  it("refuses a manifest whose supersessions key is missing (scoring flatMaps it)", () => {
    const { supersessions, ...noSup } = { ...VALID, supersessions: [] };
    expect(supersessions).toEqual([]);
    const read = (): string => JSON.stringify(noSup);
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/supersessions/);
  });

  it("refuses a manifest without compactionBoundary.plan (judge prompts read it)", () => {
    const read = (): string => JSON.stringify({ ...VALID, compactionBoundary: {} });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/compactionBoundary/);
  });

  it("refuses a recallFacts item missing accept (the C2 judge joins it)", () => {
    const read = (): string => JSON.stringify({ ...VALID, recallFacts: [{ id: "rf-1", fact: "f", entryIds: ["e1"] }] });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/recallFacts item/);
  });

  it("refuses a doneOps item missing artifact", () => {
    const read = (): string =>
      JSON.stringify({ ...VALID, doneOps: [{ id: "op-1", description: "d", entryIds: ["e2"] }] });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/doneOps item/);
  });

  it("refuses non-string probe targets (silently mis-routes the E5/E8 axis)", () => {
    const read = (): string => JSON.stringify({ ...VALID, probes: [{ question: "q?", accept: ["a"], targets: [42] }] });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/targets/);
  });

  it("refuses a probe with empty targets", () => {
    const read = (): string => JSON.stringify({ ...VALID, probes: [{ question: "q?", accept: ["a"], targets: [] }] });
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(/targets/);
  });
});

describe("executeRun", () => {
  it("on done → notifies the results path + returns the run result", async () => {
    setActiveWidget(null);
    const { ctx, notifies } = fakeCommandCtx();
    const config = { armsEnabled: ["A1"] } as unknown as BenchConfig;
    const captured: unknown[] = [];
    const result = await executeRun({
      ctx,
      config,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async (deps) => {
        captured.push(deps);
        return {
          kind: "done",
          runId: "2026-01-01-1",
          cfgId: "cfg-x",
          resultsPath: "/runs/r1/results.json",
          reportPath: "/runs/r1/report.md",
        };
      },
    });
    expect(result.kind).toBe("done");
    expect(notifies.some((n) => n.msg.includes("done") && n.msg.includes("/runs/r1/results.json"))).toBe(true);
    const deps = captured[0] as { cmdCtx: unknown; config: unknown; scenarioRepo: string; manifest: ScenarioManifest };
    expect(deps.scenarioRepo).toBe("/repo");
    expect(deps.manifest.id).toBe("scen-1");
    expect(deps.cmdCtx).toBe(ctx);
  });

  it("on stopped → surfaces startRun's detailed stop notify (no double-notify)", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const stopMessage = "bench-compact stopped (arm A3): compaction cancelled";
    const result = await executeRun({
      ctx,
      config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async (deps) => {
        // realistic: startRun notifies the detailed stop via deps.notify
        deps.notify?.(stopMessage);
        return {
          kind: "stopped",
          arm: "A3",
          attempt: null,
          phase: "phase-1",
          reason: "cancelled",
          message: "compaction cancelled",
          runId: "2026-01-01-1",
        };
      },
    });
    expect(result.kind).toBe("stopped");
    expect(notifies.some((n) => n.msg === stopMessage)).toBe(true);
    // executeRun must NOT add its own redundant stop notify
    expect(notifies.filter((n) => n.msg.includes("/bench-compact:resume"))).toHaveLength(0);
  });

  it("the shorthand's prepare phase drives a FRESH prepare widget (visible during the build drive)", async () => {
    // /bench-compact:run <idea> previously ran its entire prepare widget-less (hours
    // of build drive with no progress line); it must instead set a fresh prepare
    // widget that the build/extract seams read for ctx/tok — and NOT re-animate a
    // stale terminal widget from a prior command (the stale-leak hazard that once
    // motivated clearing the widget entirely).
    const stale: { status: string[] } = { status: [] };
    setActiveWidget({ setStatus: (s: string) => stale.status.push(s) } as unknown as Parameters<
      typeof setActiveWidget
    >[0]);
    const duringPrepare: unknown[] = [];
    const { ctx } = fakeCommandCtx();
    await invokeShorthand(
      ctx,
      {
        idea: "build an ai-company tycoon game",
        force: false,
        fromSession: undefined,
        plantFrom: undefined,
        skipFrom: undefined,
        skipTopics: undefined,
        error: undefined,
      },
      {
        buildDeps: (() => ({})) as unknown as Parameters<typeof invokeShorthand>[2]["buildDeps"],
        prepareScenario: (async () => {
          duringPrepare.push(getActiveWidget());
          return { repoPath: "/scen/repo", manifestPath: "/scen/manifest.json", liveCtx: { current: ctx } };
        }) as unknown as Parameters<typeof invokeShorthand>[2]["prepareScenario"],
        readManifest: () => JSON.stringify(MANIFEST),
        executeRun: async () => undefined,
      },
    );
    expect(duringPrepare).toHaveLength(1);
    expect(duringPrepare[0]).not.toBeNull(); // fresh widget active DURING prepare
    expect(stale.status).toHaveLength(0); // the stale prior widget was NOT re-animated
  });

  it("sets the widget active (so /abort can reach it)", async () => {
    setActiveWidget(null);
    let widgetPresent = 0;
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: { notify: (): void => {}, setWidget: (): void => {} },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    };
    await executeRun({
      ctx,
      config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async (deps) => {
        widgetPresent = deps.widget ? 1 : 0;
        return { kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" };
      },
    });
    expect(widgetPresent).toBe(1);
    expect(getActiveWidget()).not.toBeNull();
  });

  it("non-TUI ctx → widget is inert (null deps) but run still proceeds", async () => {
    const { ctx } = fakeCommandCtx({ mode: "json", hasUI: false });
    const result = await executeRun({
      ctx,
      config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async () => ({ kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" }),
    });
    expect(result.kind).toBe("done");
  });

  it("unexpected startRun error → notify 'run failed' + rethrow (stop-and-surface)", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    await expect(
      executeRun({
        ctx,
        config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
        scenarioRepo: "/repo",
        manifest: MANIFEST,
        startRun: async () => {
          throw new Error("config resolution blew up");
        },
      }),
    ).rejects.toThrow("config resolution blew up");
    expect(notifies.some((n) => n.msg.includes("run failed") && n.msg.includes("config resolution blew up"))).toBe(
      true,
    );
  });
});

describe("executeRun — stale-ctx safety (guarded getters)", () => {
  it("captures ui EAGERLY: notifies still work after the run's switchSessions invalidate the command ctx", async () => {
    // Models pi: switchSession → runner.invalidate → the old ctx's guarded getters
    // (ui/mode/hasUI) throw "stale". The run always switchSessions (Phase-1 loads each
    // arm), so every post-run notify MUST go through the eagerly-captured ui object.
    const { ctx, invalidate, notifies } = fakeGuardedCtx();
    const config = { armsEnabled: ["A1"] } as unknown as BenchConfig;
    const result = await executeRun({
      ctx,
      config,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async (deps) => {
        invalidate(); // the first switchSession happens inside the run
        deps.notify?.("stopped mid-run (arm A3): judge model unavailable"); // stop-path notify
        return {
          kind: "done",
          runId: "2026-01-01-1",
          cfgId: "cfg-x",
          resultsPath: "/runs/r1/results.json",
          reportPath: "/runs/r1/report.md",
        };
      },
    });
    expect(result.kind).toBe("done");
    expect(notifies.some((n) => n.msg.includes("judge model unavailable") && n.level === "warning")).toBe(true);
    expect(notifies.some((n) => n.msg.includes("done") && n.level === "info")).toBe(true);
  });

  it("the unexpected-error catch notifies via the eagerly-captured ui (not the stale ctx)", async () => {
    const { ctx, invalidate, notifies } = fakeGuardedCtx();
    const config = { armsEnabled: ["A1"] } as unknown as BenchConfig;
    await expect(
      executeRun({
        ctx,
        config,
        scenarioRepo: "/repo",
        manifest: MANIFEST,
        startRun: async () => {
          invalidate();
          throw new Error("git fault mid-run");
        },
      }),
    ).rejects.toThrow(/git fault/);
    expect(notifies.some((n) => n.msg.includes("run failed") && n.msg.includes("git fault"))).toBe(true);
  });
});

describe("guardPreflight — concurrent-run refusal", () => {
  it("refuses while a bench run is in-flight (one run drives the one main pi session)", async () => {
    const { setRunState } = await import("../../src/orchestrate/run-state.js");
    setRunState({
      runId: "2026-08-14-1",
      date: "2026-08-14",
      id: 1,
      cfgId: "cfg-x",
      scenarioRepo: "/repo/s",
      phase: "phase-2",
      currentArm: "A3",
      currentAttempt: 2,
      lastStopReason: null,
    });
    const { ctx, notifies } = fakeCommandCtx();
    const ok = guardPreflight(
      ctx as unknown as Parameters<typeof guardPreflight>[0],
      "run-scenario",
      { value: "/some/folder" },
      () => true,
    );
    expect(ok).toBe(false);
    expect(notifies.some((n) => n.msg.includes("already active") && n.msg.includes("/bench-compact:abort"))).toBe(true);
  });

  it("refuses while a bench PREPARE is in-flight (the run-state is not set yet during prepare)", async () => {
    const { setPrepareInFlight } = await import("../../src/orchestrate/run-state.js");
    setPrepareInFlight(true);
    try {
      const { ctx, notifies } = fakeCommandCtx();
      const ok = guardPreflight(
        ctx as unknown as Parameters<typeof guardPreflight>[0],
        "run-scenario",
        { value: "/some/folder" },
        () => true,
      );
      expect(ok).toBe(false);
      expect(notifies.some((n) => n.msg.includes("prepare is already active"))).toBe(true);
    } finally {
      setPrepareInFlight(false);
    }
  });

  it("allows a follow-up once the prior run recorded a stop (not in-flight)", async () => {
    const { setRunState, updateRunState } = await import("../../src/orchestrate/run-state.js");
    setRunState({
      runId: "2026-08-14-1",
      date: "2026-08-14",
      id: 1,
      cfgId: "cfg-x",
      scenarioRepo: "/repo/s",
      phase: "phase-2",
      currentArm: null,
      currentAttempt: null,
      lastStopReason: null,
    });
    updateRunState({ lastStopReason: "compaction cancelled" });
    const { ctx, notifies } = fakeCommandCtx();
    const ok = guardPreflight(
      ctx as unknown as Parameters<typeof guardPreflight>[0],
      "run-scenario",
      { value: "/some/folder" },
      () => true,
    );
    expect(ok).toBe(true);
    expect(notifies).toHaveLength(0);
  });
});

describe("prepareThenRun — surfaced prepare asks the operator (modal dialog recovery)", () => {
  const manifestStub = {
    id: "sc1",
    description: "d",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
    recallFacts: [],
    doneOps: [],
    supersessions: [],
    abstentions: [],
    taskObjective: { description: "b", testSpec: "" },
    probes: [],
  };
  const surfaceErr = (): SurfaceConditionsError =>
    new SurfaceConditionsError(
      {
        kind: "surface",
        skipOffered: true,
        missing: [
          { id: "change-mind", label: "Changed mind", tag: "safeToSkip", hint: "", metricAxis: "supersession" },
          { id: "open-question", label: "Open question", tag: "safeToSkip", hint: "", metricAxis: "abstention" },
        ],
      },
      { firstKeptEntryId: "e50", attempt: 0, manifest: manifestStub as unknown as ScenarioManifest },
    );

  function tuiCtx(answer: string | undefined): { ctx: RunHandlerContext; notifies: { msg: string; level: string }[] } {
    const notifies: { msg: string; level: string }[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (m: string, l: string) => notifies.push({ msg: m, level: l }),
        setWidget: () => {},
        select: async () => answer,
      },
      switchSession: async () => {},
    };
    return { ctx: ctx as unknown as RunHandlerContext, notifies };
  }

  it("dialog choice 'plant + continue' re-runs prepare with --plant args, then proceeds to the run", async () => {
    let calls = 0;
    const parsedArgs: PrepareArgs[] = [];
    const { ctx, notifies } = tuiCtx("plant + continue");
    await invokeShorthand(
      ctx,
      {
        idea: "build a game",
        force: false,
        fromSession: undefined,
        plantFrom: undefined,
        skipFrom: undefined,
        skipTopics: undefined,
        error: undefined,
      },
      {
        buildDeps: ((_c: unknown, parsed: PrepareArgs, id: string) => {
          calls += 1;
          parsedArgs.push(parsed);
          expect(id).toBe(computeScenarioId({ idea: "build a game" }));
          return {} as unknown as PrepareDeps;
        }) as unknown as Parameters<typeof invokeShorthand>[2]["buildDeps"],
        prepareScenario: (async () => {
          if (calls === 1) throw surfaceErr();
          return {
            repoPath: "/scen/repo",
            manifestPath: "/scen/manifest.json",
            liveCtx: { current: ctx },
          };
        }) as unknown as Parameters<typeof invokeShorthand>[2]["prepareScenario"],
        readManifest: () => JSON.stringify(MANIFEST),
        executeRun: async () => undefined,
      },
    );
    expect(calls).toBe(2);
    expect(parsedArgs[1]?.plantFrom).toBeTruthy(); // recovery round targets the scenario folder
    expect(notifies.some((n) => n.msg.includes("prepare failed"))).toBe(false);
  });

  it("dialog choice 'skip safe-to-skip topics' re-runs with skipFrom + the missing safe ids", async () => {
    let calls = 0;
    let skipParsed: PrepareArgs | null = null;
    const { ctx } = tuiCtx("skip safe-to-skip topics");
    await invokeShorthand(
      ctx,
      {
        idea: "build a game",
        force: false,
        fromSession: undefined,
        plantFrom: undefined,
        skipFrom: undefined,
        skipTopics: undefined,
        error: undefined,
      },
      {
        buildDeps: ((_c: unknown, parsed: PrepareArgs) => {
          calls += 1;
          if (calls === 2) skipParsed = parsed;
          return {} as unknown as PrepareDeps;
        }) as unknown as Parameters<typeof invokeShorthand>[2]["buildDeps"],
        prepareScenario: (async () => {
          if (calls === 1) throw surfaceErr();
          return { repoPath: "/scen/repo", manifestPath: "/scen/manifest.json", liveCtx: { current: ctx } };
        }) as unknown as Parameters<typeof invokeShorthand>[2]["prepareScenario"],
        readManifest: () => JSON.stringify(MANIFEST),
        executeRun: async () => undefined,
      },
    );
    expect(calls).toBe(2);
    expect((skipParsed as PrepareArgs | null)?.skipTopics).toEqual(["change-mind", "open-question"]);
  });

  it("dialog 'start over' (or dismissal) stops with the guidance notify — no retry", async () => {
    for (const answer of ["start over", undefined]) {
      let calls = 0;
      const { ctx, notifies } = tuiCtx(answer);
      await invokeShorthand(
        ctx,
        {
          idea: "build a game",
          force: false,
          fromSession: undefined,
          plantFrom: undefined,
          skipFrom: undefined,
          skipTopics: undefined,
          error: undefined,
        },
        {
          buildDeps: (() => {
            calls += 1;
            return {} as unknown as PrepareDeps;
          }) as unknown as Parameters<typeof invokeShorthand>[2]["buildDeps"],
          prepareScenario: (async () => {
            throw surfaceErr();
          }) as unknown as Parameters<typeof invokeShorthand>[2]["prepareScenario"],
          readManifest: () => JSON.stringify(MANIFEST),
          executeRun: async () => undefined,
        },
      );
      expect(calls).toBe(1); // no recovery round
      expect(notifies.some((n) => n.msg.includes("--plant"))).toBe(true); // guidance carries the commands
    }
  });
});
