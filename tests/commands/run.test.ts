// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { makeRunHandler } from "../../src/commands/run.js";
import type { PrepareDeps } from "../../src/production/prepare.js";

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

describe("makeRunHandler", () => {
  it("missing idea + no --from-session → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunHandler({ prepareScenario, executeRun: vi.fn() });
    await handler("", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("valid idea → prepareScenario (build) → loadManifest → executeRun with repoPath + manifest", async () => {
    const { ctx } = fakeCtx();
    const manifest = { id: "scen-1" };
    const prepareScenario = vi.fn().mockResolvedValue({ repoPath: "/repo/x", manifestPath: "/m.json" });
    const executeRun = vi.fn().mockResolvedValue({ kind: "done" });
    const buildDeps = vi.fn().mockReturnValue({} as unknown as PrepareDeps);
    const handler = makeRunHandler({
      prepareScenario,
      buildDeps,
      executeRun,
      readManifest: (): string => JSON.stringify(manifest),
    });
    await handler("my tycoon idea", ctx);
    expect(prepareScenario).toHaveBeenCalledOnce();
    expect(executeRun).toHaveBeenCalledOnce();
    const arg = executeRun.mock.calls[0][0] as { scenarioRepo: string; manifest: { id: string } };
    expect(arg.scenarioRepo).toBe("/repo/x");
    expect(arg.manifest.id).toBe("scen-1");
    // buildDeps got the parsed build-mode args (idea set, fromSession undefined)
    const parsed = buildDeps.mock.calls[0][1] as { idea?: string; fromSession?: string };
    expect(parsed.idea).toBe("my tycoon idea");
    expect(parsed.fromSession).toBeUndefined();
  });

  it("prepare failure → error notify, no executeRun", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn().mockRejectedValue(new Error("simulator blew up"));
    const executeRun = vi.fn();
    const handler = makeRunHandler({ prepareScenario, buildDeps: vi.fn(), executeRun });
    await handler("some idea", ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "error" && n.msg.includes("simulator blew up"))).toBe(true);
  });

  it("invalid manifest after prepare → error notify, no executeRun", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn().mockResolvedValue({ repoPath: "/r", manifestPath: "/m.json" });
    const handler = makeRunHandler({
      prepareScenario,
      buildDeps: vi.fn(),
      executeRun: vi.fn(),
      readManifest: (): string => "{bad",
    });
    await handler("idea", ctx);
    expect(notifies.some((n) => n.level === "error")).toBe(true);
  });
});
