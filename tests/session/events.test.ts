// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { onTurnEnd, readMessageEndUsage } from "../../src/session/events.js";

/** Minimal EventBus fake: events.on registers + returns a disposer; emit fires handlers. */
function fakeBus(): { pi: ExtensionAPI; emit: (channel: string, data: unknown) => void } {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const pi = {
    events: {
      on(channel: string, handler: (data: unknown) => void): () => void {
        const list = handlers.get(channel);
        if (list) {
          list.push(handler);
        } else {
          handlers.set(channel, [handler]);
        }
        return () => {
          const arr = handlers.get(channel);
          if (arr) {
            const i = arr.indexOf(handler);
            if (i >= 0) arr.splice(i, 1);
          }
        };
      },
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    emit: (channel, data) => {
      const arr = handlers.get(channel);
      if (arr) for (const h of arr) h(data);
    },
  };
}

describe("readMessageEndUsage", () => {
  it("extracts input/output/cacheRead/cacheWrite/cost/totalTokens from a message_end event", () => {
    const event = {
      type: "message_end",
      message: {
        usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 }, totalTokens: 155 },
      },
    };
    expect(readMessageEndUsage(event as never)).toEqual({
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
    expect(readMessageEndUsage(event as never)).toBeNull();
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
