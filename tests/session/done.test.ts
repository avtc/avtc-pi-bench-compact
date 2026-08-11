// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentSettledAbortedError, awaitAgentSettled } from "../../src/session/done.js";

/** A minimal fake AbortSignal that tracks add/removeEventListener. */
function fakeSignal(): AbortSignal & { listenerCount: () => number; abort: () => void } {
  const listeners: Array<() => void> = [];
  return {
    aborted: false,
    reason: undefined,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_type: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    listenerCount: () => listeners.length,
    abort: () => {
      for (const fn of listeners) fn();
    },
  } as unknown as AbortSignal & { listenerCount: () => number; abort: () => void };
}

function fakeBus(): { pi: ExtensionAPI; emit: (channel: string, data: unknown) => void } {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
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
  const pi = { events: { on } } as unknown as ExtensionAPI;
  return {
    pi,
    emit: (channel, data) => {
      const arr = handlers.get(channel);
      if (arr) for (const h of arr) h(data);
    },
  };
}

describe("awaitAgentSettled", () => {
  it("resolves when agent_settled fires", async () => {
    const { pi, emit } = fakeBus();
    const p = awaitAgentSettled(pi);
    emit("agent_settled", { type: "agent_settled" });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects when the signal aborts before the agent settles", async () => {
    const { pi } = fakeBus();
    const ac = new AbortController();
    const p = awaitAgentSettled(pi, { signal: ac.signal });
    ac.abort(new Error("operator aborted"));
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("R4-9: rejects with a named AgentSettledAbortedError on signal abort (not a generic Error)", async () => {
    const { pi } = fakeBus();
    const ac = new AbortController();
    const p = awaitAgentSettled(pi, { signal: ac.signal });
    ac.abort(new Error("operator aborted"));
    await expect(p).rejects.toBeInstanceOf(AgentSettledAbortedError);
  });

  it("R4-3: on settle the signal abort listener is removed (no accumulation)", async () => {
    const { pi, emit } = fakeBus();
    const signal = fakeSignal();
    const p = awaitAgentSettled(pi, { signal });
    emit("agent_settled", { type: "agent_settled" });
    await p;
    expect(signal.listenerCount()).toBe(0);
  });
});
