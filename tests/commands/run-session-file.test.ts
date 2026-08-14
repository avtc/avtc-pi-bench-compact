// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { makeRunSessionFileHandler } from "../../src/commands/run-session-file.js";
import type { PrepareDeps } from "../../src/production/prepare.js";

import { fakeCommandCtx } from "./helpers.js";

const VALID_MANIFEST = {
  id: "scen-1",
  recallFacts: [{ fact: "scores live in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
  doneOps: [{ description: "built the shop", artifact: "src/shop.ts", reworkable: false, entryIds: ["e2"] }],
  supersessions: [],
  abstentions: [],
  probes: [{ question: "where are scores stored?", accept: ["~/.scores.json"], targets: ["e1"] }],
  taskObjective: { description: "the task", testSpec: "npm test" },
};

describe("makeRunSessionFileHandler", () => {
  it("missing path → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunSessionFileHandler({ prepareScenario, executeRun: vi.fn(), exists: (): boolean => true });
    await handler("", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning")).toBe(true);
  });

  it("non-existent path → warning notify, no prepare", async () => {
    const { ctx, notifies } = fakeCommandCtx();
    const prepareScenario = vi.fn();
    const handler = makeRunSessionFileHandler({ prepareScenario, executeRun: vi.fn(), exists: (): boolean => false });
    await handler("/no/such/session.jsonl", ctx);
    expect(prepareScenario).not.toHaveBeenCalled();
    expect(notifies.some((n) => n.level === "warning" && n.msg.includes("not found"))).toBe(true);
  });

  it("valid path → prepareScenario (extract) → loadManifest → executeRun; buildDeps gets fromSession", async () => {
    const { ctx } = fakeCommandCtx();
    const manifest = VALID_MANIFEST;
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
    const { ctx, notifies } = fakeCommandCtx();
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
