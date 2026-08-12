// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeRunScenarioHandler } from "../../src/commands/run-scenario.js";

/** A capturing fake ctx with the notify + widget surface. */
function fakeCtx(): { ctx: unknown; notifies: { msg: string; level: string }[] } {
  const notifies: { msg: string; level: string }[] = [];
  return {
    notifies,
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (msg: string, level: string): void => void notifies.push({ msg, level }),
        setWidget: (): void => {},
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    },
  };
}

describe("makeRunScenarioHandler", () => {
  it("missing folder arg → warning notify, no run", async () => {
    const { ctx, notifies } = fakeCtx();
    const executeRun = vi.fn();
    const handler = makeRunScenarioHandler({ executeRun });
    await handler("", ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("non-existent folder → warning notify, no run", async () => {
    const { ctx, notifies } = fakeCtx();
    const handler = makeRunScenarioHandler({ executeRun: vi.fn(), exists: (): boolean => false });
    await handler("/no/such/folder", ctx);
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("not found"))).toBe(true);
  });

  it("folder with no manifest.json → warning notify (layout resolution failure)", async () => {
    const { ctx, notifies } = fakeCtx();
    const folder = "/scen/repo";
    const handler = makeRunScenarioHandler({
      executeRun: vi.fn(),
      exists: (p: string): boolean => p === folder, // folder exists; no manifest at either candidate
    });
    await handler(folder, ctx);
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("manifest.json"))).toBe(true);
  });

  it("valid folder → resolves layout + loads manifest + calls executeRun with repoPath + manifest", async () => {
    const { ctx } = fakeCtx();
    const folder = "/scen/repo";
    const manifest = { id: "scen-1" };
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
    const { ctx, notifies } = fakeCtx();
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
