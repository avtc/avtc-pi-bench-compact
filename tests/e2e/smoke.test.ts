// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The end-to-end smoke test: prove the FULL bench pipeline holds together from
// the run driver through to the on-disk result-JSON + headline report. The phase
// functions that need a LIVE session (Phase-1 compaction, Phase-2 continuation,
// direct probes) are mocked with realistic captured traces, but everything ELSE
// is real — the run driver (identity, config snapshot, phase sequencing, scoring
// hand-off), the REAL scoring orchestrator (exact metrics + canned judge grades
// + statistics + serialization), and the result-JSON + markdown writers. If any
// boundary between these drifts, this test fails.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunScenarioHandler } from "../../src/commands/run-scenario.js";
import { executeRun, type RunHandlerContext } from "../../src/commands/run-shared.js";
import { _setHandleForTest } from "../../src/config/accessor.js";
import type { ArmId } from "../../src/config/types.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { ArmBase, Phase1Deps, Phase1Result } from "../../src/orchestrate/phase1.js";
import type { Phase2Deps, Phase2Result } from "../../src/orchestrate/phase2.js";
import type { ProbeTrace } from "../../src/orchestrate/probes.js";
import { type StartRunDeps, startRun } from "../../src/orchestrate/run.js";
import { clearRunState } from "../../src/orchestrate/run-state.js";
import { scoreRun } from "../../src/orchestrate/score.js";
import type { TestSpecResult } from "../../src/orchestrate/testspec.js";
import type { BenchResultJson } from "../../src/report/result-json.js";
import { initScenarioRepo } from "../../src/storage/repo.js";
import { fakeCommandCtx } from "../commands/helpers.js";
import {
  buildRealisticTrace,
  makeBenchConfig,
  makeScoreDeps,
  makeSmokeManifest,
  makeVersionResolver,
} from "./helpers.js";

/** A sentinel for the threaded fresh ctx (so tests can assert it is forwarded, not the original cmdCtx). */
const FINAL_CTX = { __finalCtx: true } as unknown as ExtensionCommandContext;

/** Build the per-arm compacted bases the Phase-1 mock returns (one per enabled arm). */
function fakeBases(arms: readonly ArmId[]): ArmBase[] {
  const toolOf: Record<ArmId, string> = {
    A1: "bare-pi",
    A2: "om-default",
    A3: "memkeeper-builder",
    A4: "memkeeper-selector",
    A5: "om-full",
  };
  return arms.map((arm) => ({
    arm,
    tool: toolOf[arm],
    ver: arm === "A1" ? undefined : "gabcdef",
    cfgId: "cfg-x",
    branch: `arm-${arm}-base`,
    wallMs: 4200,
    usage: undefined,
  }));
}

/** Build the two direct-probe answers for one arm (matching the smoke manifest's probes by position). */
function buildProbeAnswers(arm: ArmId): ProbeTrace[] {
  return [
    { arm, probeId: "1", branch: `probe-${arm}-1`, answer: "the production formula", kept: true },
    { arm, probeId: "2", branch: `probe-${arm}-2`, answer: "I cannot decide without more information", kept: true },
  ];
}

/** Read + parse the run's results.json into the typed result-v1 shape. */
function readResultJson(resultsPath: string): BenchResultJson {
  return JSON.parse(readFileSync(resultsPath, "utf8")) as BenchResultJson;
}

afterEach(() => {
  clearRunState();
  _setHandleForTest(null);
});

// ---------------------------------------------------------------------------
// Test 1 — the capstone: drive the REAL run driver with mocked phase functions
// returning realistic traces, hand off to the REAL scoring orchestrator (canned
// judge/pricing deps), and assert the on-disk result-JSON holds the full
// bench-compact.result-v1 shape + the headline report renders.
// ---------------------------------------------------------------------------
describe("startRun end-to-end (mocked phases + real score) -> result-v1 + report", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-smoke-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a full result-v1 results.json + report.md for a 2-arm (A1 + A3) run", async () => {
    const arms: readonly ArmId[] = ["A1", "A3"];
    const traceA1 = buildRealisticTrace("A1", "arm-A1-1", null); // native single-stage compaction
    const traceA3 = buildRealisticTrace("A3", "arm-A3-1", ["observer", "builder", "selector"]); // memory arm stages
    const bases = fakeBases(arms);

    const phase1 = vi.fn(async (_deps: Phase1Deps): Promise<Phase1Result> => ({ bases, finalCtx: FINAL_CTX }));
    const continuations = vi.fn(
      async (_deps: Phase2Deps): Promise<Phase2Result> => ({
        traces: [traceA1, traceA3],
        finalCtx: FINAL_CTX,
      }),
    );
    const probes = vi.fn(
      async (d: { armBase: ArmBase }): Promise<{ traces: ProbeTrace[]; finalCtx: ExtensionCommandContext }> => ({
        traces: buildProbeAnswers(d.armBase.arm),
        finalCtx: FINAL_CTX,
      }),
    );
    const testSpec = vi.fn(
      (_deps: { repo: string; branch: string; manifest: ScenarioManifest }): TestSpecResult => ({
        kind: "skipped" as const,
      }),
    );

    const deps = {
      cmdCtx: {} as unknown as ExtensionCommandContext,
      config: makeBenchConfig(arms),
      scenarioRepo: join(root, "scenario-repo"),
      manifest: makeSmokeManifest(),
      root,
      now: () => new Date("2026-08-11T10:00:00Z"),
      widget: null,
      phase1,
      continuations,
      probes,
      testSpec,
      score: scoreRun, // REAL scoring orchestrator
      buildScoreDeps: makeScoreDeps, // REAL ScoreRunDeps with canned judge/pricing deps
      versionResolver: makeVersionResolver(),
    } as unknown as StartRunDeps;

    const result = await startRun(deps);

    // --- the run completed cleanly + wrote both artifacts ---
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(existsSync(result.resultsPath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);

    // --- every phase was driven exactly once + threaded the final ctx forward ---
    expect(phase1).toHaveBeenCalledTimes(1);
    expect(continuations).toHaveBeenCalledTimes(1);
    expect(probes).toHaveBeenCalledTimes(2); // once per arm

    // --- the result-JSON holds the full result-v1 shape ---
    const json = readResultJson(result.resultsPath);

    // identity + scenario
    expect(json.schema).toBe("bench-compact.result-v1");
    expect(json.runId).toBe("2026-08-11-1");
    expect(json.cfgId).toMatch(/^cfg-/);
    expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.scenario.id).toBe("smoke-scen");
    expect(json.scenario.manifestRef).toContain("manifest.json");

    // config block (everything except toolVersions, which is split out)
    expect(json.config.armsEnabled).toEqual(["A1", "A3"]);
    expect(json.config.N).toBe(1);
    expect(json.config.compactionBoundary).toBe(140000);
    expect(json.config.evaluatedModel).toBe("test/model");

    // toolVersions: bare-pi carries none; the memory arm resolves a git version
    expect(json.toolVersions.A1).toBeUndefined();
    expect(json.toolVersions.A3).toMatchObject({ source: "git", commit: "gabcdef", full: "abcdef1234567890" });

    // metricDefs: exactly the 13 metrics, each self-describing
    expect(Object.keys(json.metricDefs).sort()).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
      "E1",
      "E10",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
    ]);
    for (const def of Object.values(json.metricDefs)) {
      expect(def).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          channel: expect.any(String),
          polarity: expect.any(String),
          desc: expect.any(String),
        }),
      );
    }

    // both arms present with their tool labels + run counts
    const a1 = json.arms.A1;
    const a3 = json.arms.A3;
    expect(a1).toBeDefined();
    expect(a3).toBeDefined();
    if (a1 === undefined || a3 === undefined) return;
    expect(a1.tool).toBe("bare-pi");
    expect(a3.tool).toBe("memkeeper-builder");
    expect(a1.runsCompleted).toBe(1);
    expect(a1.runsFailed).toBe(0);
    expect(a3.runsCompleted).toBe(1);

    // exact metrics (computed off the realistic traces): footprint + run-cost + compaction-cost
    expect(a1.metrics.C1).toMatchObject({ mean: 3 }); // "summary text" = 12 chars / 4
    expect(a1.metrics.C3).toMatchObject({ mean: 50 }); // the post-compaction assistant output
    expect(a1.metrics.C4).toMatchObject({
      tokensIn: 100,
      tokensOut: 20,
      cacheRead: 0,
      cacheWrite: 0,
      wallMs: 4200,
      stages: ["native-summary"],
    });
    expect((a1.metrics.C4 as { dollars: number }).dollars).toBeGreaterThan(0);
    expect((a1.metrics.C4 as { phase2CompactionCount: number }).phase2CompactionCount).toBe(0);

    // the memory arm's compaction-cost carries its named stages
    expect(a3.metrics.C4).toMatchObject({ stages: ["observer", "builder", "selector"] });

    // recall-cost: the planted fact is recovered at the post-compaction entry (50 output tokens)
    expect(a1.metrics.C2).toMatchObject({ mean: 50, notRecoveredRate: 0 });

    // binary axes (one sample each over N=1): redo-exec failed, the rest passed
    expect(a1.metrics.E2).toMatchObject({ rate: 0, n: 1 });
    expect(a1.metrics.E4).toMatchObject({ rate: 1, n: 1 });
    expect(a1.metrics.E5).toMatchObject({ rate: 1, n: 1 });
    expect(a1.metrics.E6).toMatchObject({ rate: 1, n: 1 });
    for (const axis of ["E2", "E4", "E5", "E6"] as const) {
      const m = a1.metrics[axis] as { rate: number; ci: readonly [number, number] } | undefined;
      expect(m?.rate).toBeGreaterThanOrEqual(0);
      expect(m?.rate).toBeLessThanOrEqual(1);
      expect(m?.ci).toHaveLength(2);
    }

    // comparative axes (per-arm rank pulled from the cross-arm ranks)
    expect(a1.metrics.E1).toMatchObject({ rank: 1 });
    expect(a3.metrics.E1).toMatchObject({ rank: 2 });
    expect(a1.metrics.E3).toMatchObject({ rank: 1 });
    expect(a1.metrics.E7).toMatchObject({ rank: 1 });
    expect(a1.metrics.E10).toMatchObject({ rank: 1 });

    // the ranks block carries the full cross-arm order + Elo for every comparative axis
    for (const axis of ["E1", "E3", "E7", "E10"] as const) {
      const rankAxis = json.ranks[axis];
      expect(rankAxis).toBeDefined();
      if (rankAxis === undefined) continue;
      expect(rankAxis.order).toEqual(["A1", "A3"]);
      expect(rankAxis.elo.A1).toBeGreaterThan(rankAxis.elo.A3 ?? 0);
    }

    // no failures + the reproducibility artifacts are recorded
    expect(json.failures).toEqual([]);
    expect(json.artifacts.scenarioRepo).toBe(join(root, "scenario-repo"));
    expect(json.artifacts.branches).toContain("arm-A1-base");
    expect(json.artifacts.config.endsWith(`${json.cfgId}.json`)).toBe(true);
    expect(json.artifacts.results).toBe(result.resultsPath);

    // the headline report rendered + names the scenario
    const report = readFileSync(result.reportPath, "utf8");
    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain("smoke-scen");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Test 2 — the command->run wiring: enter via the run-scenario command handler
// against a real frozen scenario folder (git repo + manifest.json on disk),
// through the REAL executeRun tail, into a fake startRun that captures the
// assembled StartRunDeps. Proves the handler resolves the layout, loads the
// manifest from disk, reads the live config, and hands a well-formed deps
// object to the run driver.
// ---------------------------------------------------------------------------
describe("run-scenario command handler -> real executeRun -> startRun wiring", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "bench-smoke-cmd-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("resolves the scenario folder, loads the manifest from disk, and calls startRun with config + repo + manifest", async () => {
    // --- a real frozen scenario folder: <scen>/manifest.json + <scen>/repo/ (git, committed on main) ---
    const scenDir = join(work, "smoke-scen");
    const repoDir = join(scenDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const manifest = makeSmokeManifest();
    writeFileSync(join(scenDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(repoDir, "session.jsonl"), '{"type":"session","version":3}\n', "utf8");
    writeFileSync(join(repoDir, "project.ts"), "export const x = 1;\n", "utf8");
    // freeze the repo on main via the production init (git init -b main + commit)
    initScenarioRepo(repoDir);

    // --- the live config (A1 + A3 enabled) is read via the settings handle ---
    const settings: Record<string, unknown> = {
      evaluatedModel: "test/model",
      evaluatedThinkingLevel: "high",
      judgeModel: "test/judge",
      judgeThinkingLevel: "high",
      judgesNumber: 1,
      N: 1,
      compactionBoundary: 140000,
      backupMode: "build",
      armBarePiEnabled: true,
      armOmDefaultEnabled: false,
      armMemkeeperObservationsRootEnabled: true,
      armMemkeeperSelectedRootEnabled: false,
      armOmFullEnabled: false,
      omFullReflectionThresholdTokens: 4000,
    };
    _setHandleForTest({ getSettings: () => settings } as unknown as SettingsHandle);

    // --- drive the handler; inject a fake startRun via the real executeRun tail ---
    const { ctx, notifies } = fakeCommandCtx();
    const captured: { deps: StartRunDeps | null } = { deps: null };
    const fakeStartRun = vi.fn(async (d: StartRunDeps) => {
      captured.deps = d;
      return {
        kind: "done" as const,
        runId: "2026-08-11-1",
        cfgId: "cfg-smoke",
        resultsPath: join(work, "results.json"),
        reportPath: join(work, "report.md"),
      };
    });
    const handler = makeRunScenarioHandler({
      exists: existsSync,
      readManifest: (p: string, opts: { encoding: "utf-8" }): string => readFileSync(p, opts),
      executeRun: (opts): Promise<unknown> =>
        executeRun({ ...(opts as Parameters<typeof executeRun>[0]), startRun: fakeStartRun }),
    });

    await handler(scenDir, ctx as unknown as RunHandlerContext);

    // --- the command->run wiring delivered a well-formed StartRunDeps ---
    expect(fakeStartRun).toHaveBeenCalledTimes(1);
    const deps = captured.deps;
    expect(deps).not.toBeNull();
    if (deps === null) return;
    expect(deps.config.armsEnabled).toEqual(["A1", "A3"]); // read from the live settings handle
    expect(deps.scenarioRepo).toBe(repoDir); // resolved from the folder layout
    expect(deps.manifest.id).toBe("smoke-scen"); // loaded + parsed from disk
    expect(deps.manifest.recallFacts).toHaveLength(1);
    expect(deps.manifest.probes).toHaveLength(2);

    // the operator was notified of the clean completion
    expect(notifies.some((n) => n.level === "info" && n.msg.includes("done"))).toBe(true);
  }, 30000);
});
