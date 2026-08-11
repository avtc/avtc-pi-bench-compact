// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CompactionCancelledError, triggerCompact } from "../../src/session/compact.js";
import { fakeBus, fakeSignal } from "./helpers.js";

/** Fake pi (events bus, via the shared fakeBus) + ctx (compact). pi.events.on returns a
 *  disposer; emit fires handlers; triggerError invokes the onError captured from
 *  ctx.compact. fakeSignal (for R4-3 listener-cleanup assertions) is shared too. */
function fakeRuntime(): {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  emit: (channel: string, data: unknown) => void;
  triggerError: (err: Error) => void;
  compactCalls: number;
} {
  const bus = fakeBus();
  let capturedOnError: ((err: Error) => void) | undefined;
  let compactCalls = 0;
  const ctx = {
    compact(opts?: { onError?: (e: Error) => void }) {
      compactCalls += 1;
      capturedOnError = opts?.onError;
    },
  } as unknown as ExtensionContext;
  return {
    pi: bus.pi,
    ctx,
    emit: bus.emit,
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

  it("R4-6: a PRE-aborted signal rejects WITHOUT firing ctx.compact (no unwanted session mutation)", async () => {
    const f = fakeRuntime();
    const ac = new AbortController();
    ac.abort(new Error("pre-abort"));
    await expect(triggerCompact(f.pi, f.ctx, { signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(f.compactCalls).toBe(0); // ctx.compact must NOT have fired
  });

  it("R4-1: a throwing onCompacted does not hang the promise (it still resolves)", async () => {
    const f = fakeRuntime();
    const promise = triggerCompact(f.pi, f.ctx, {
      onCompacted: () => {
        throw new Error("callback boom");
      },
    });
    const entry = { type: "compaction", summary: "s", firstKeptEntryId: "e9" };
    f.emit("session_compact", { type: "session_compact", compactionEntry: entry });
    await expect(promise).resolves.toMatchObject({ compactionEntry: entry });
  });

  it("R4-3: on settle the signal abort listener is removed (no accumulation on the run signal)", async () => {
    const f = fakeRuntime();
    const signal = fakeSignal();
    const promise = triggerCompact(f.pi, f.ctx, { signal });
    f.emit("session_compact", { type: "session_compact", compactionEntry: { type: "compaction" } });
    await promise;
    expect(signal.listenerCount()).toBe(0); // the abort listener was removed on settle
  });
});
