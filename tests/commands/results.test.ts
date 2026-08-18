// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { afterEach, describe, expect, it } from "vitest";
import { type ResultsSeams, registerResultsCommand, runResultsCommand } from "../../src/commands/results.js";
import { _setHandleForTest } from "../../src/config/accessor.js";
import type { ArmId } from "../../src/config/types.js";
import { METRIC_DEFS } from "../../src/metrics/defs.js";
import type { ArmResultJson, BenchResultJson, MetricJson } from "../../src/report/result-json.js";

/** A minimal result-JSON with one arm (configurable) for dispatch testing. */
function mkResult(
  runId: string,
  arms: Partial<Record<ArmId, { tool: string; metrics?: Partial<Record<string, MetricJson>> }>>,
): BenchResultJson {
  const armsJson: Partial<Record<ArmId, ArmResultJson>> = {};
  for (const [arm, spec] of Object.entries(arms) as [
    ArmId,
    { tool: string; metrics?: Partial<Record<string, MetricJson>> } | undefined,
  ][]) {
    if (spec === undefined) continue;
    armsJson[arm] = { tool: spec.tool, runsCompleted: 10, runsFailed: 0, metrics: spec.metrics ?? {} };
  }
  return {
    schema: "bench-compact.result-v1",
    runId,
    cfgId: `cfg-${runId}`,
    timestamp: "t",
    scenario: { id: "tycoon", manifestRef: "/m.json" },
    config: {
      evaluatedModel: "eval",
      evaluatedThinkingLevel: "high",
      judgeModel: "judge",
      judgeThinkingLevel: "high",
      judgesNumber: 1,
      judge2Model: null,
      judge2ThinkingLevel: "high",
      judge3Model: null,
      judge3ThinkingLevel: "high",
      N: 10,
      compactionBoundary: 140000,
      armsEnabled: Object.keys(arms) as ArmId[],
      omFullReflectionThresholdTokens: 4000,
      backupMode: "build",
      fastEval: "off",
      latentProbes: "off",
    },
    toolVersions: {},
    metricDefs: METRIC_DEFS,
    arms: armsJson,
    ranks: {},
    failures: [],
    artifacts: { scenarioRepo: "/r", branches: ["main"], judgeDir: "/j", config: "/c.json" },
  };
}

const seams = (results: Record<string, BenchResultJson>): ResultsSeams => ({
  loadResultJson: (runId) => results[runId],
});

describe("runResultsCommand", () => {
  it("single run → renders the headline report", () => {
    const outcome = runResultsCommand(
      "run1",
      seams({
        run1: mkResult("run1", { A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1000, ci: [900, 1100] } } } }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toBeDefined();
    expect(outcome.report).toContain("bench-compact — tycoon · run run1"); // headline header
  });

  it("multiple runs → renders the cross-run comparison", () => {
    const outcome = runResultsCommand(
      "run1 run2",
      seams({
        run1: mkResult("run1", { A3: { tool: "memkeeper-builder" } }),
        run2: mkResult("run2", { A3: { tool: "memkeeper-builder" } }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toContain("comparison");
    expect(outcome.report).toContain("run1·A3");
    expect(outcome.report).toContain("run2·A3");
  });

  it("reportFile: full single-run → canonical report.md; subset + comparison get their own siblings", () => {
    const arms = { A1: { tool: "bare-pi" }, A3: { tool: "memkeeper-builder" } };
    const single = runResultsCommand("run1", { loadResultJson: () => mkResult("run1", arms) });
    expect(single.reportFile).toBe("report.md");
    const subset = runResultsCommand("run1:A1,A3", { loadResultJson: () => mkResult("run1", arms) });
    expect(subset.reportFile).toBe("report-arms.md");
    const cmp = runResultsCommand("run1 run2", {
      loadResultJson: (id) => mkResult(id, arms),
    });
    expect(cmp.reportFile).toBe("report-compare.md");
  });

  it("arm-subset on a single run filters the report to the selected arms (A1 deselected → no ΔvsA1)", () => {
    const outcome = runResultsCommand(
      "run1:A3",
      seams({
        run1: mkResult("run1", {
          A1: { tool: "bare-pi", metrics: { C1: { mean: 500, ci: [400, 600] } } },
          A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1200, ci: [1100, 1300] } } },
        }),
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report).toContain("A3"); // A3 present
    expect(outcome.report).not.toContain("bare-pi"); // A1 deselected → its tool name absent
    expect(outcome.report).not.toMatch(/\[\+\d+\]/); // no delta values (no baseline to delta against)
  });

  it("surfaces an error when a referenced run's result-JSON is missing", () => {
    const outcome = runResultsCommand("run1 run2", seams({ run1: mkResult("run1", { A3: { tool: "mk" } }) }));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/run2/); // names the missing run
  });

  it("surfaces a parse error (empty args)", () => {
    const outcome = runResultsCommand("", seams({}));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/runId/);
  });

  it("surfaces a parse error (trailing comma in :arms)", () => {
    const outcome = runResultsCommand("run1:A3,", seams({}));
    expect(outcome.report).toBeUndefined();
    expect(outcome.error).toMatch(/trailing comma/);
  });
});

describe("registerResultsCommand (handler: real file IO)", () => {
  afterEach(() => _setHandleForTest(null));

  it("reads results.json, writes report.md, + notifies the path (single run)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bench-results-"));
    const runId = "run-handler-1";
    const result = mkResult(runId, {
      A3: { tool: "memkeeper-builder", metrics: { C1: { mean: 1000, ci: [900, 1100] as [number, number] } } },
    });
    const dir = path.join(root, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(result), "utf8");
    _setHandleForTest({ getSettings: () => ({ outputDir: root }) } as unknown as SettingsHandle);

    const { pi, commands } = fakePi();
    registerResultsCommand(pi);
    const { ctx, notifies } = fakeCtx();
    {
      const h = commands.get("bench-compact:results");
      if (h === undefined) throw new Error("results command not registered");
      await h.handler(runId, ctx);
    }

    const reportPath = path.join(dir, "report.md");
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("bench-compact — tycoon");
    expect(notifies.some((n) => /report written/.test(n.msg))).toBe(true);
  });

  it("notifies a warning when the run's results.json is missing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bench-results-missing-"));
    _setHandleForTest({ getSettings: () => ({ outputDir: root }) } as unknown as SettingsHandle);
    const { pi, commands } = fakePi();
    registerResultsCommand(pi);
    const { ctx, notifies } = fakeCtx();
    {
      const h = commands.get("bench-compact:results");
      if (h === undefined) throw new Error("results command not registered");
      await h.handler("no-such-run", ctx);
    }
    expect(notifies.some((n) => /not found/.test(n.msg) && n.type === "warning")).toBe(true);
  });
});

/** Minimal fake pi capturing the registered command handler. */
function fakePi(): {
  pi: ExtensionAPI;
  commands: Map<string, { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }>;
} {
  const commands = new Map<string, { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }>();
  const pi = {
    registerCommand: (name: string, opts: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) =>
      commands.set(name, opts),
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

/** Minimal fake ctx capturing notifies. */
function fakeCtx(): { ctx: ExtensionCommandContext; notifies: { msg: string; type?: string }[] } {
  const notifies: { msg: string; type?: string }[] = [];
  const ctx = {
    ui: { notify: (msg: string, type?: string) => notifies.push({ msg, type }) },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifies };
}
