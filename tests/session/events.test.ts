// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { awaitOnce, once, onTurnEnd, readMessageEndUsage, subscribeAgentEvent } from "../../src/session/events.js";
import { fakeBus, fakeSignal } from "./helpers.js";

/** Minimal EventBus fake: events.on registers + returns a disposer; emit fires handlers. */
// NOTE: the shared fakeBus/fakeSignal live in ./helpers.ts (R2-3 dedup).

describe("readMessageEndUsage", () => {
  it("extracts input/output/cacheRead/cacheWrite/cost/totalTokens from a message_end event", () => {
    const event = {
      type: "message_end",
      message: {
        usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 }, totalTokens: 155 },
      },
    };
    expect(readMessageEndUsage(event as unknown as MessageEndEvent)).toEqual({
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.01,
      totalTokens: 155,
    });
  });

  it("returns null when the message carries no usage", () => {
    const event = { type: "message_end", message: {} };
    expect(readMessageEndUsage(event as unknown as MessageEndEvent)).toBeNull();
  });
});

describe("subscribeAgentEvent — the agent-event surface", () => {
  it("subscribes via pi.on (NOT the pi.events.on custom-channel bus — agent events never flow there)", () => {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    let customBusMisuse = 0;
    const pi = {
      on: (event: string, handler: (data: unknown) => void): void => {
        const list = handlers.get(event);
        if (list) list.push(handler);
        else handlers.set(event, [handler]);
      },
      // The custom inter-extension bus — subscribing an AGENT event here would silently
      // never fire (nothing emits agent events onto it). Count any use as misuse.
      events: {
        on: (): (() => void) => {
          customBusMisuse += 1;
          return () => {};
        },
      },
    } as unknown as ExtensionAPI;

    const seen: unknown[] = [];
    const dispose = subscribeAgentEvent(pi, "agent_settled", (data) => {
      seen.push(data);
    });
    expect(customBusMisuse).toBe(0); // registered on the AGENT surface

    // Dispatch through the pi.on handler map (how the extension runner delivers)
    for (const h of [...(handlers.get("agent_settled") ?? [])]) h({ type: "agent_settled" });
    expect(seen).toHaveLength(1);

    // Disposer guards the handler off (pi.on offers no removal)
    dispose();
    for (const h of [...(handlers.get("agent_settled") ?? [])]) h({ type: "agent_settled" });
    expect(seen).toHaveLength(1); // no further fires
  });
});

describe("onTurnEnd", () => {
  it("registers a handler that fires on turn_end, and the disposer stops it", () => {
    const { pi, emit } = fakeBus();
    const seen: TurnEndEvent[] = [];
    const dispose = onTurnEnd(pi, (e) => seen.push(e));
    const ev = { type: "turn_end" } as unknown as TurnEndEvent;
    emit("turn_end", ev);
    expect(seen).toEqual([ev]);
    dispose();
    emit("turn_end", ev);
    expect(seen).toEqual([ev]); // not fired again after dispose
  });
});

describe("once", () => {
  it("fires the handler at most once, then auto-removes the listener", () => {
    const { pi, emit } = fakeBus();
    const seen: unknown[] = [];
    once(pi, "agent_settled", (data) => seen.push(data));
    emit("agent_settled", { type: "agent_settled", n: 1 });
    emit("agent_settled", { type: "agent_settled", n: 2 }); // must NOT fire again
    expect(seen).toEqual([{ type: "agent_settled", n: 1 }]);
  });

  it("the returned disposer removes the listener before it fires", () => {
    const { pi, emit } = fakeBus();
    const seen: unknown[] = [];
    const dispose = once(pi, "agent_settled", (data) => seen.push(data));
    dispose();
    emit("agent_settled", { type: "agent_settled" });
    expect(seen).toEqual([]);
  });
});

describe("awaitOnce", () => {
  it("resolves with the event data when the channel fires", async () => {
    const { pi, emit } = fakeBus();
    const p = awaitOnce<{ n: number }>(pi, "agent_settled", { makeAbortedError: (r) => new Error(String(r)) });
    emit("agent_settled", { n: 7 });
    await expect(p).resolves.toEqual({ n: 7 });
  });

  it("rejects via makeAbortedError when the signal aborts first", async () => {
    const { pi } = fakeBus();
    const signal = fakeSignal();
    const p = awaitOnce(pi, "agent_settled", { signal, makeAbortedError: () => new Error("boom-abort") });
    signal.abort();
    await expect(p).rejects.toThrow(/boom-abort/);
  });

  it("rejects immediately (no listener registered) when the signal is pre-aborted", async () => {
    const { pi, listenerCount } = fakeBus();
    const signal = fakeSignal();
    signal.abort();
    await expect(
      awaitOnce(pi, "agent_settled", { signal, makeAbortedError: () => new Error("pre-abort") }),
    ).rejects.toThrow(/pre-abort/);
    expect(listenerCount("agent_settled")).toBe(0); // no listener was registered
  });

  it("extra.resolve settles the same race (joins the idempotent settler)", async () => {
    const { pi } = fakeBus();
    const p = awaitOnce<{ v: number }>(pi, "agent_settled", {
      makeAbortedError: () => new Error("x"),
      extra: ({ resolve }) => resolve({ v: 42 }),
    });
    await expect(p).resolves.toEqual({ v: 42 });
  });

  it("no double-settle: an event after extra.resolve is ignored (one-shot, idempotent)", async () => {
    const { pi, emit } = fakeBus();
    let resolves = 0;
    const p = awaitOnce<{ v: number }>(pi, "agent_settled", {
      makeAbortedError: () => new Error("x"),
      extra: ({ resolve }) => resolve({ v: 1 }),
    });
    p.then(() => {
      resolves += 1;
    });
    emit("agent_settled", { v: 99 }); // must NOT re-resolve
    await p;
    expect(resolves).toBe(1);
    // The settled race guards its listener off (no further fires). pi.on offers no
    // removal, so the wrapper stays registered — a LATER event must be a no-op.
    let lateFire = 0;
    const late = once(pi, "agent_settled", () => {
      lateFire += 1;
    });
    void late;
    emit("agent_settled", { v: 100 });
    expect(lateFire).toBe(1); // sanity: events still reach NEW listeners
    expect(resolves).toBe(1); // the settled race did not re-fire
  });

  it("R2-1: if extra throws synchronously, awaitOnce rejects AND guards the event listener off", async () => {
    const { pi, emit } = fakeBus();
    const signal = fakeSignal();
    await expect(
      awaitOnce(pi, "session_compact", {
        signal,
        makeAbortedError: (r) => new Error(String(r)),
        extra: () => {
          throw new Error("stale ctx");
        },
      }),
    ).rejects.toThrow(/stale ctx/);
    // the signal listener is removed (real removeEventListener) …
    expect(signal.listenerCount()).toBe(0);
    // … and a later event on the channel is harmless: the rejected race cannot
    // re-settle (promise already settled), and NEW listeners still receive events
    // (the channel is not poisoned by the guarded wrapper).
    let lateFire = 0;
    const late = once(pi, "session_compact", () => {
      lateFire += 1;
    });
    void late;
    emit("session_compact", { type: "session_compact" });
    expect(lateFire).toBe(1);
  });
});
