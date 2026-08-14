// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { makeRunHandler } from "../../src/commands/run.js";
import type { PrepareDeps } from "../../src/production/prepare.js";

import { fakeCommandCtx, fakeGuardedCtx } from "./helpers.js";

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

describe("makeRunHandler", () => {
  it("missing idea + no --from-session → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunHandler({ prepareScenario, executeRun: vi.fn() });
    await handler("", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("valid idea → prepareScenario (build) → loadManifest → executeRun with repoPath + manifest", async () => {
    const { ctx } = fakeCommandCtx();
    const manifest = VALID_MANIFEST;
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

  it("prepareThenRun guards the prepare window: flag set during prepare, cleared on failure", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const { isPrepareInFlight } = await import("../../src/orchestrate/run-state.js");
    let seenDuringPrepare = false;
    const prepareScenario = vi.fn().mockImplementation(async () => {
      seenDuringPrepare = isPrepareInFlight();
      throw new Error("simulator blew up");
    });
    const handler = makeRunHandler({ prepareScenario, buildDeps: vi.fn(), executeRun: vi.fn() });
    await handler("some idea", ctx);
    expect(seenDuringPrepare).toBe(true); // the window WAS guarded
    expect(isPrepareInFlight()).toBe(false); // finally cleared it
    expect(notifies.some((n) => n.level === "error" && n.msg.includes("simulator blew up"))).toBe(true);
  });

  it("executeRun receives the prepare's FINAL fresh ctx — the staled command ctx is not reused", async () => {
    // Models the real shorthand flow: prepare's switchSessions invalidate the command
    // ctx; the holder's final fresh ctx must be handed to executeRun (its entry reads
    // ui/mode/hasUI + Phase-1's first switchSession needs a live ctx).
    const { ctx: stale, invalidate, notifies } = fakeGuardedCtx();
    const fresh = fakeGuardedCtx();
    const prepareScenario = vi.fn().mockImplementation(async () => {
      invalidate(); // prepare's switchSessions staled the command ctx
      return { repoPath: "/repo/x", manifestPath: "/m.json", liveCtx: { current: fresh.ctx } };
    });
    const executeRun = vi.fn().mockImplementation(async (opts: { ctx: unknown }) => {
      // entry reads (executeRun's first lines) must work on the handed ctx
      const c = opts.ctx as { ui: { notify: (m: string, l: string) => void }; mode: string; hasUI: boolean };
      c.ui.notify("entry read ok", "info");
      expect(c.mode).toBe("tui");
      expect(c.hasUI).toBe(true);
      return { kind: "done" };
    });
    const handler = makeRunHandler({
      prepareScenario,
      buildDeps: vi.fn().mockReturnValue({} as unknown as PrepareDeps),
      executeRun,
      readManifest: (): string => JSON.stringify(VALID_MANIFEST),
    });
    await handler("my tycoon idea", stale);
    expect(executeRun).toHaveBeenCalledOnce();
    expect((executeRun.mock.calls[0][0] as { ctx: unknown }).ctx).toBe(fresh.ctx);
    expect(fresh.notifies.some((n) => n.msg.includes("entry read ok"))).toBe(true);
    expect(notifies.length).toBe(0); // the stale ctx's ui was never touched
  });

  it("executeRun falls back to the command ctx when prepare reports no liveCtx (extract/skip: no switch happened)", async () => {
    const { ctx } = fakeCommandCtx();
    const prepareScenario = vi.fn().mockResolvedValue({ repoPath: "/r", manifestPath: "/m.json" });
    const executeRun = vi.fn().mockResolvedValue({ kind: "done" });
    const handler = makeRunHandler({
      prepareScenario,
      buildDeps: vi.fn().mockReturnValue({} as unknown as PrepareDeps),
      executeRun,
      readManifest: (): string => JSON.stringify(VALID_MANIFEST),
    });
    await handler("some idea", ctx);
    expect((executeRun.mock.calls[0][0] as { ctx: unknown }).ctx).toBe(ctx);
  });

  it("prepare failure → error notify, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const prepareScenario = vi.fn().mockRejectedValue(new Error("simulator blew up"));
    const executeRun = vi.fn();
    const handler = makeRunHandler({ prepareScenario, buildDeps: vi.fn(), executeRun });
    await handler("some idea", ctx);
    expect(executeRun).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "error" && n.msg.includes("simulator blew up"))).toBe(true);
  });

  it("invalid manifest after prepare → error notify, no executeRun", async () => {
    const { ctx, notifies } = fakeCommandCtx();
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
