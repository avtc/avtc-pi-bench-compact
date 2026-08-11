// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CompactionCancelledError, triggerCompact } from "../../src/session/compact.js";

/** Fake pi (events bus) + ctx (compact). pi.events.on returns a disposer; emit fires
 *  handlers; triggerError invokes the onError captured from ctx.compact. */
function fakeRuntime(): {
  pi: { events: { on: (channel: string, handler: (data: unknown) => void) => () => void } };
  ctx: ExtensionContext;
  emit: (channel: string, data: unknown) => void;
  triggerError: (err: Error) => void;
  compactCalls: number;
} {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  let capturedOnError: ((err: Error) => void) | undefined;
  let compactCalls = 0;
  const on = (channel: string, handler: (data: unknown) => void): (() => void) => {
    const list = handlers.get(channel);
    if (list) list.push(handler);
    else handlers.set(channel, [handler]);
    return () => {
      const arr = handlers.get(channel);
      if (arr) {
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      }
    };
  };
  const pi = { events: { on } };
  const ctx = {
    compact(opts?: { onError?: (e: Error) => void }) {
      compactCalls += 1;
      capturedOnError = opts?.onError;
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    emit: (channel, data) => {
      const arr = handlers.get(channel);
      if (arr) for (const h of arr) h(data);
    },
    triggerError: (err) => capturedOnError?.(err),
    get compactCalls() {
      return compactCalls;
    },
  };
}

describe("triggerCompact", () => {
  it("resolves {compactionEntry, wallMs} when the session_compact event fires; calls onCompacted", async () => {
    const f = fakeRuntime();
    let compacted: { entry: unknown; wallMs: number } | null = null;
    const promise = triggerCompact(f.pi, f.ctx, {
      onCompacted: (entry, wallMs) => (compacted = { entry, wallMs }),
    });
    const entry = { type: "compaction", summary: "s", firstKeptEntryId: "e9" };
    f.emit("session_compact", { type: "session_compact", compactionEntry: entry });
    const result = await promise;
    expect(result.compactionEntry).toBe(entry);
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
    expect(compacted).toEqual({ entry, wallMs: result.wallMs });
    expect(f.compactCalls).toBe(1);
  });

  it("rejects with the raw error when onError fires for a non-cancel failure", async () => {
    const f = fakeRuntime();
    const promise = triggerCompact(f.pi, f.ctx, {});
    f.triggerError(new Error("summarizer LLM failed"));
    await expect(promise).rejects.toThrow(/summarizer LLM failed/);
  });

  it("rejects with CompactionCancelledError when onError reports a cancel (no CompactionEntry)", async () => {
    const f = fakeRuntime();
    const promise = triggerCompact(f.pi, f.ctx, {});
    f.triggerError(new Error("Compaction cancelled"));
    await expect(promise).rejects.toBeInstanceOf(CompactionCancelledError);
  });

  it("rejects when the run signal aborts before compaction completes", async () => {
    const f = fakeRuntime();
    const ac = new AbortController();
    const promise = triggerCompact(f.pi, f.ctx, { signal: ac.signal });
    ac.abort(new Error("user aborted"));
    await expect(promise).rejects.toThrow(/abort/i);
  });
});
