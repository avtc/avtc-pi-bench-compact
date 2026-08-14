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
