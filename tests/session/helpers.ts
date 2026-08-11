// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared test fakes for the session-primitive tests (compact/done/events/switch).
// Extracted to kill the copy-paste drift the round-2 review flagged (R2-3).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared fake event bus: `events.on` registers + returns a disposer; `emit` fires
 *  handlers; `listenerCount` introspects a channel (to assert one-shot/dispose
 *  cleanup). Models the disposer-returning `pi.events.on` surface the primitives use. */
export function fakeBus(): {
  pi: ExtensionAPI;
  emit: (channel: string, data: unknown) => void;
  listenerCount: (channel: string) => number;
} {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const on = (channel: string, handler: (data: unknown) => void): (() => void) => {
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
  };
  return {
    pi: { events: { on } } as unknown as ExtensionAPI,
    emit: (channel, data) => {
      const arr = handlers.get(channel);
      if (arr) for (const h of arr) h(data);
    },
    listenerCount: (channel) => handlers.get(channel)?.length ?? 0,
  };
}

/** Shared fake AbortSignal that tracks add/removeEventListener (to assert the signal
 *  listener is removed on settle). `abort(reason?)` mirrors the real API: sets
 *  `aborted`, records `reason`, and fires registered listeners. */
export function fakeSignal(): AbortSignal & { listenerCount: () => number; abort: (reason?: unknown) => void } {
  const listeners: Array<() => void> = [];
  const state: { aborted: boolean; reason: unknown } = { aborted: false, reason: undefined };
  return {
    get aborted(): boolean {
      return state.aborted;
    },
    get reason(): unknown {
      return state.reason;
    },
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_type: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    listenerCount: () => listeners.length,
    abort: (reason?: unknown) => {
      state.aborted = true;
      state.reason = reason ?? new Error("aborted");
      for (const fn of listeners) fn();
    },
  } as unknown as AbortSignal & { listenerCount: () => number; abort: (reason?: unknown) => void };
}
