// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { makeRunSessionFileHandler } from "../../src/commands/run-session-file.js";
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

describe("makeRunSessionFileHandler", () => {
  it("missing path → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunSessionFileHandler({ prepareScenario, executeRun: vi.fn(), exists: (): boolean => true });
    await handler("", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("non-existent path → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunSessionFileHandler({ prepareScenario, executeRun: vi.fn(), exists: (): boolean => false });
    await handler("/no/such/session.jsonl", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("not found"))).toBe(true);
  });

  it("valid path → prepareScenario (extract) → loadManifest → executeRun; buildDeps gets fromSession", async () => {
    const { ctx } = fakeCtx();
    const manifest = { id: "scen-1" };
    const prepareScenario = vi.fn().mockResolvedValue({ repoPath: "/repo/x", manifestPath: "/m.json" });
    const executeRun = vi.fn().mockResolvedValue({ kind: "done" });
    const buildDeps = vi.fn().mockReturnValue({} as unknown as PrepareDeps);
    const handler = makeRunSessionFileHandler({
      prepareScenario,
      buildDeps,
      executeRun,
      exists: (): boolean => true,
      readManifest: (): string => JSON.stringify(manifest),
    });
    await handler("/path/to/session.jsonl", ctx);
    expect(prepareScenario).toHaveBeenCalledOnce();
    expect(executeRun).toHaveBeenCalledOnce();
    const parsed = buildDeps.mock.calls[0][1] as { idea?: string; fromSession?: string };
    expect(parsed.fromSession).toBe("/path/to/session.jsonl");
    expect(parsed.idea).toBeUndefined();
  });

  it("prepare failure → error notify, no executeRun", async () => {
    const { ctx, notifies } = fakeCtx();
    const prepareScenario = vi.fn().mockRejectedValue(new Error("extract guard failed"));
    const handler = makeRunSessionFileHandler({
      prepareScenario,
      buildDeps: vi.fn(),
      executeRun: vi.fn(),
      exists: (): boolean => true,
    });
    await handler("/path/session.jsonl", ctx);
    expect(notifies.some((n) => n.level === "error" && n.msg.includes("extract guard failed"))).toBe(true);
  });
});
