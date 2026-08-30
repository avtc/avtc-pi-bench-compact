// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeRunScenarioHandler } from "../../src/commands/run-scenario.js";

import { fakeCommandCtx } from "./helpers.js";

/** A capturing fake ctx with the notify + widget surface. */

const VALID_MANIFEST = {
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

describe("makeRunScenarioHandler", () => {
  it("missing folder arg → warning notify, no run", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const executeRun = vi.fn();
    const handler = makeRunScenarioHandler({ executeRun });
    await handler("", ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("non-existent folder → warning notify, no run", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const handler = makeRunScenarioHandler({ executeRun: vi.fn(), exists: (): boolean => false });
    await handler("/no/such/folder", ctx);
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("not found"))).toBe(true);
  });

  it("folder with no manifest.json → warning notify (layout resolution failure)", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const folder = "/scen/repo";
    const handler = makeRunScenarioHandler({
      executeRun: vi.fn(),
      exists: (p: string): boolean => p === folder, // folder exists; no manifest at either candidate
    });
    await handler(folder, ctx);
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("manifest.json"))).toBe(true);
  });

  it("valid folder → resolves layout + loads manifest + calls executeRun with repoPath + manifest", async () => {
    const { ctx } = fakeCommandCtx();
    const folder = "/scen/repo";
    const manifest = VALID_MANIFEST;
    const executeRun = vi
      .fn()
      .mockResolvedValue({ kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" });
    const parentManifest = join(dirname(folder), "manifest.json");
    const handler = makeRunScenarioHandler({
      executeRun,
      exists: (p: string): boolean => p === folder || p === parentManifest,
      readManifest: (): string => JSON.stringify(manifest),
    });
    await handler(folder, ctx);
    expect(executeRun).toHaveBeenCalledOnce();
    const arg = executeRun.mock.calls[0][0] as {
      scenarioRepo: string;
      manifest: { id: string };
      config: unknown;
      ctx: unknown;
    };
    expect(arg.scenarioRepo).toBe("/scen/repo");
    expect(arg.manifest.id).toBe("scen-1");
  });

  it("no folder arg + configured default → runs the default scenario folder", async () => {
    const { ctx } = fakeCommandCtx();
    const folder = "/scen";
    const manifest = VALID_MANIFEST;
    const executeRun = vi
      .fn()
      .mockResolvedValue({ kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" });
    const handler = makeRunScenarioHandler({
      executeRun,
      exists: (p: string): boolean => p === folder || p === join(folder, "repo") || p === join(folder, "manifest.json"),
      readManifest: (): string => JSON.stringify(manifest),
      defaultScenarioFolder: () => folder,
    });
    await handler("", ctx); // no args at all — the setting fills in
    expect(executeRun).toHaveBeenCalledOnce();
    const arg = executeRun.mock.calls[0][0] as { scenarioRepo: string };
    expect(arg.scenarioRepo).toBe(join(folder, "repo"));
  });

  it("no folder arg + NO default → warning notify (folder still required)", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const executeRun = vi.fn();
    const handler = makeRunScenarioHandler({
      executeRun,
      exists: (): boolean => true,
      defaultScenarioFolder: () => null,
    });
    await handler("", ctx);
    expect(notifies.some((n) => n.msg.includes("provide a scenario folder path"))).toBe(true);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("invalid manifest JSON → error notify (load failure)", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const folder = "/scen/repo";
    const parentManifest = join(dirname(folder), "manifest.json");
    const handler = makeRunScenarioHandler({
      executeRun: vi.fn(),
      exists: (p: string): boolean => p === folder || p === parentManifest,
      readManifest: (): string => "{not json",
    });
    await handler(folder, ctx);
    expect(notifies.some((n) => n.level === "error")).toBe(true);
    expect(notifies.some((n) => n.msg.includes("manifest"))).toBe(true);
  });
});

describe("makeRunScenarioHandler — --resume", () => {
  const FOLDER = "/scen/repo";
  const PARENT_MANIFEST = join(dirname(FOLDER), "manifest.json");
  // The crashed run's arm-base branches (A1-A4 committed; A5 mid-arm).
  const RUN4_BRANCHES = [
    "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-default",
    "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-session-owl-builder",
    "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-session-owl-pruner",
    "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-session-owl-full",
    "bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-om-full-g9785fb",
    // an OLDER complete run — its results.json exists (see completeRunIds)
    "bench-compact/run-2026-08-16-3/cfg-bd0f9a/arm-om-default",
  ];

  /** Standard fixture: folder + manifest resolve; branches listable; completion settable. */
  function makeResumeFixture(completeRunIds: readonly string[]) {
    const executeRun = vi.fn().mockResolvedValue({ kind: "done" });
    const capturedRepos: string[] = [];
    const handler = makeRunScenarioHandler({
      executeRun,
      exists: (p: string): boolean =>
        p === FOLDER ||
        p === PARENT_MANIFEST ||
        p === join(FOLDER, "repo") ||
        completeRunIds.some((id) => p.replaceAll("\\", "/").endsWith(`runs/${id}/results.json`)),
      readManifest: (): string => JSON.stringify(VALID_MANIFEST),
      listBranches: (repo, pattern): string[] => {
        capturedRepos.push(`${repo} ${pattern}`);
        return RUN4_BRANCHES;
      },
    });
    return { handler, executeRun, capturedRepos };
  }

  it("bare --resume auto-detects the latest incomplete run → resume target + info notify", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture(["2026-08-16-3"]); // run-3 complete, run-4 incomplete
    await handler(`${FOLDER} --resume`, ctx);
    expect(executeRun).toHaveBeenCalledOnce();
    const arg = executeRun.mock.calls[0][0] as { resume?: { runId: string; cfgId: string } };
    expect(arg.resume).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-bd0f9a" });
    expect(notifies.some((n) => n.level === "info" && n.msg.includes("resuming run 2026-08-16-4"))).toBe(true);
  });

  it("bare --resume with no incomplete run → warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture(["2026-08-16-3", "2026-08-16-4"]); // both complete
    await handler(`${FOLDER} --resume`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(
      notifies.some(
        (n) => n.level === "warning" && n.msg.includes("no incomplete bench run found in") && n.msg.includes(FOLDER),
      ),
    ).toBe(true);
  });

  it("explicit --resume=<runId> resolves its namespace → resume target", async () => {
    const { ctx } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --resume=2026-08-16-4`, ctx);
    const arg = executeRun.mock.calls[0][0] as { resume?: { runId: string; cfgId: string } };
    expect(arg.resume).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-bd0f9a" });
  });

  it("--allow-config-change threads the override onto the resume target", async () => {
    const { ctx } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --resume --allow-config-change`, ctx);
    const arg = executeRun.mock.calls[0][0] as {
      resume?: { runId: string; cfgId: string; allowConfigChange?: boolean };
    };
    expect(arg.resume).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-bd0f9a", allowConfigChange: true });
  });

  it("--reuse-bases threads onto the resume target", async () => {
    const { ctx } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --resume --allow-config-change --reuse-bases`, ctx);
    const arg = executeRun.mock.calls[0][0] as {
      resume?: { runId: string; cfgId: string; reuseBases?: boolean };
    };
    expect(arg.resume).toEqual({
      runId: "2026-08-16-4",
      cfgId: "cfg-bd0f9a",
      allowConfigChange: true,
      reuseBases: true,
    });
  });

  it("--allow-config-change without --resume → parse warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --allow-config-change`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(
      notifies.some((n) => n.level === "warning" && n.msg.includes("--allow-config-change requires --resume")),
    ).toBe(true);
  });

  it("explicit --resume=<complete runId> → already-complete warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture(["2026-08-16-3"]);
    await handler(`${FOLDER} --resume=2026-08-16-3`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("already complete"))).toBe(true);
  });

  it("--resume=<complete runId> --rescore → proceeds (rescore on the resume target)", async () => {
    const { ctx } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture(["2026-08-16-3"]);
    await handler(`${FOLDER} --resume=2026-08-16-3 --rescore`, ctx);
    expect(executeRun).toHaveBeenCalled();
    const arg = executeRun.mock.calls[0][0] as {
      resume?: { runId: string; cfgId: string; rescore?: boolean };
    };
    expect(arg.resume).toEqual({ runId: "2026-08-16-3", cfgId: "cfg-bd0f9a", rescore: true });
  });

  it("--rescore without an explicit --resume=<runId> → parse warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --rescore`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(
      notifies.some((n) => n.level === "warning" && n.msg.includes("--rescore requires an explicit --resume=<runId>")),
    ).toBe(true);
  });

  it("explicit --resume=<unknown runId> → no-branches warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --resume=2026-01-01-9`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(
      notifies.some(
        (n) => n.level === "warning" && n.msg.includes("no bench-compact branches found for run 2026-01-01-9"),
      ),
    ).toBe(true);
  });

  it("unknown flag → parse warning, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { handler, executeRun } = makeResumeFixture([]);
    await handler(`${FOLDER} --frobnicate`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });
});

describe("makeRunScenarioHandler — preserve (reuse compaction + latent pools)", () => {
  function preserveHarness() {
    const folder = "/scen/repo";
    const parentManifest = join(dirname(folder), "manifest.json");
    const executeRun = vi
      .fn()
      .mockResolvedValue({ kind: "done", runId: "r", cfgId: "c", resultsPath: "/p", reportPath: "/r" });
    const handler = makeRunScenarioHandler({
      executeRun,
      exists: (p: string): boolean => p === folder || p === parentManifest,
      readManifest: (): string => JSON.stringify(VALID_MANIFEST),
      listBranches: (): string[] => [],
    });
    return { ctx: fakeCommandCtx().ctx, executeRun, handler, folder };
  }

  it("a fresh invocation passes preserve by default (newest per arm)", async () => {
    const { ctx, executeRun, handler, folder } = preserveHarness();
    await handler(folder, ctx);
    const arg = executeRun.mock.calls[0][0] as { preserve?: { from: string | null } };
    expect(arg.preserve).toEqual({ from: null });
  });

  it("--from=<runId> pins the preserved source run", async () => {
    const { ctx, executeRun, handler, folder } = preserveHarness();
    await handler(`${folder} --from=2026-08-23-2`, ctx);
    const arg = executeRun.mock.calls[0][0] as { preserve?: { from: string | null } };
    expect(arg.preserve).toEqual({ from: "2026-08-23-2" });
  });

  it("--fresh forces a full run (no preserve)", async () => {
    const { ctx, executeRun, handler, folder } = preserveHarness();
    await handler(`${folder} --fresh`, ctx);
    const arg = executeRun.mock.calls[0][0] as { preserve?: unknown };
    expect(arg.preserve).toBeUndefined();
  });

  it("--resume keeps the resume path (no preserve)", async () => {
    const { ctx, executeRun, handler, folder } = preserveHarness();
    // bare --resume: the branch scan finds nothing incomplete → warning, no run
    await handler(`${folder} --resume`, ctx);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("--resume=<runId> passes no preserve", async () => {
    const { ctx, executeRun } = { ctx: fakeCommandCtx().ctx, executeRun: preserveHarness().executeRun };
    const folder = "/scen/repo";
    const handler2 = makeRunScenarioHandler({
      executeRun,
      exists: (p: string): boolean => p === folder || p === join(dirname(folder), "manifest.json"),
      readManifest: (): string => JSON.stringify(VALID_MANIFEST),
      listBranches: (): string[] => ["bench-compact/run-2026-08-16-4/cfg-abc/arm-bare-pi"],
    });
    await handler2(`${folder} --resume=2026-08-16-4`, ctx);
    expect(executeRun).toHaveBeenCalledOnce();
    const arg = executeRun.mock.calls[0][0] as { preserve?: unknown; resume?: unknown };
    expect(arg.preserve).toBeUndefined();
    expect(arg.resume).toBeDefined();
  });

  it("--fresh with --resume is refused before any run", async () => {
    const c = fakeCommandCtx();
    const harness = preserveHarness();
    await harness.handler("/scen/repo --resume --fresh", c.ctx);
    expect(harness.executeRun).not.toHaveBeenCalled();
    expect(c.notifies.some((n) => n.level === "warning")).toBe(true);
  });
});
