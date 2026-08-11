// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadSession } from "../../src/session/switch.js";

/** Fake ExtensionCommandContext whose switchSession invokes the withSession callback
 *  with a fake new ctx (modeling pi's in-place switch + ctx invalidation). */
function fakeCmdCtx(opts: { cancelled?: boolean } = {}): {
  cmdCtx: ExtensionCommandContext;
  calls: { path: string; withSession: boolean }[];
} {
  const calls: { path: string; withSession: boolean }[] = [];
  const newCtx = { id: "new-ctx" } as unknown as ExtensionCommandContext;
  const cmdCtx = {
    switchSession: async (path: string, o?: { withSession?: (c: ExtensionCommandContext) => Promise<void> }) => {
      calls.push({ path, withSession: o?.withSession !== undefined });
      if (!opts.cancelled) await o?.withSession?.(newCtx);
      return { cancelled: opts.cancelled ?? false };
    },
  } as unknown as ExtensionCommandContext;
  return { cmdCtx, calls };
}

describe("loadSession", () => {
  it("switches to the path, runs the callback with the new ctx, and returns its result", async () => {
    const { cmdCtx, calls } = fakeCmdCtx();
    const result = await loadSession(cmdCtx, "/path/to/session.jsonl", async (newCtx) => {
      expect(newCtx).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toEqual([{ path: "/path/to/session.jsonl", withSession: true }]);
  });

  it("throws when the switch is cancelled (withSession did not run)", async () => {
    const { cmdCtx } = fakeCmdCtx({ cancelled: true });
    await expect(loadSession(cmdCtx, "/p.jsonl", async () => "never")).rejects.toThrow(/cancel/i);
  });

  it("R4-5: propagates a throw from the withSession callback", async () => {
    const { cmdCtx } = fakeCmdCtx();
    await expect(
      loadSession(cmdCtx, "/p.jsonl", async () => {
        throw new Error("work inside withSession failed");
      }),
    ).rejects.toThrow(/work inside withSession failed/);
  });
});
