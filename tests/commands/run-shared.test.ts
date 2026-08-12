// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeRun, loadManifestFile, resolveScenarioLayout } from "../../src/commands/run-shared.js";
import type { BenchConfig } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { getActiveWidget, setActiveWidget } from "../../src/widget/active-widget.js";

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
});

describe("loadManifestFile", () => {
  it("parses valid manifest JSON", () => {
    const read = (): string => JSON.stringify(MANIFEST);
    const manifest = loadManifestFile("/p/manifest.json", read);
    expect(manifest.id).toBe("scen-1");
  });

  it("throws on invalid JSON", () => {
    const read = (): string => "{not json";
    expect(() => loadManifestFile("/p/manifest.json", read)).toThrow(SyntaxError);
  });
});

/** A fake command ctx (mode/hasUI/ui + switchSession) capturing notifies + widget sets. */
function fakeCtx(opts: { mode?: string; hasUI?: boolean } = {}): {
  ctx: {
    mode: string;
    hasUI: boolean;
    ui: {
      notify: (m: string, l: string) => void;
      setWidget: (k: string, c: unknown, o: { placement: string }) => void;
    };
    switchSession: (p: string, o?: { withSession?: (c: unknown) => Promise<void> }) => Promise<{ cancelled: boolean }>;
  };
  notifies: string[];
} {
  const notifies: string[] = [];
  return {
    notifies,
    ctx: {
      mode: opts.mode ?? "tui",
      hasUI: opts.hasUI ?? true,
      ui: {
        notify: (m: string): void => {
          notifies.push(m);
        },
        setWidget: (): void => {},
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    },
  };
}

describe("executeRun", () => {
  it("on done → notifies the results path + returns the run result", async () => {
    setActiveWidget(null);
    const { ctx, notifies } = fakeCtx();
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
    expect(notifies.some((m) => m.includes("done") && m.includes("/runs/r1/results.json"))).toBe(true);
    const deps = captured[0] as { cmdCtx: unknown; config: unknown; scenarioRepo: string; manifest: ScenarioManifest };
    expect(deps.scenarioRepo).toBe("/repo");
    expect(deps.manifest.id).toBe("scen-1");
    expect(deps.cmdCtx).toBe(ctx);
  });

  it("on stopped → notifies the reason + the resume hint", async () => {
    const { ctx, notifies } = fakeCtx();
    const result = await executeRun({
      ctx,
      config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async () => ({
        kind: "stopped",
        arm: null,
        attempt: null,
        phase: "phase-1",
        reason: "cancelled",
        message: "arm A3 compaction cancelled",
        runId: "2026-01-01-1",
      }),
    });
    expect(result.kind).toBe("stopped");
    expect(notifies.some((m) => m.includes("stopped") && m.includes("/bench-compact:resume"))).toBe(true);
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
    const { ctx } = fakeCtx({ mode: "json", hasUI: false });
    const result = await executeRun({
      ctx,
      config: { armsEnabled: ["A1"] } as unknown as BenchConfig,
      scenarioRepo: "/repo",
      manifest: MANIFEST,
      startRun: async () => ({ kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" }),
    });
    expect(result.kind).toBe("done");
  });
});
