// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared test fakes for the session-primitive tests (compact/done/events/switch).
// Extracted to kill the copy-paste drift the round-2 review flagged (R2-3).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared fake pi agent-event surface: `on` registers (returns void — no removal,
 *  exactly like the real `pi.on`; guard-flag disposal lives in the production
 *  `subscribeAgentEvent` wrapper) + `emit` fires handlers the way the extension
 *  runner does. `listenerCount` introspects an event (registered wrappers — a
 *  disposed listener's wrapper REMAINS registered, mirroring production). */
export function fakeBus(): {
  pi: ExtensionAPI;
  emit: (event: string, data: unknown) => void;
  listenerCount: (event: string) => number;
} {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const on = (event: string, handler: (data: unknown) => void): void => {
    const list = handlers.get(event);
    if (list) {
      list.push(handler);
    } else {
      handlers.set(event, [handler]);
    }
  };
  return {
    pi: { on } as unknown as ExtensionAPI,
    emit: (event, data) => {
      const arr = handlers.get(event);
      if (arr) for (const h of [...arr]) h(data); // snapshot — a self-guarding listener must not skip later ones
    },
    listenerCount: (event) => handlers.get(event)?.length ?? 0,
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
      for (const fn of [...listeners]) fn(); // snapshot — matches AbortSignal dispatch (R3-1)
    },
  } as unknown as AbortSignal & { listenerCount: () => number; abort: (reason?: unknown) => void };
}
