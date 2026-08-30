// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Typed event helpers for the bench's session-driving primitives.
//
// pi has TWO event surfaces, and they never cross:
//  - `pi.on(event, handler)` — the typed per-event registrations that AGENT/SESSION
//    events flow through (agent-session emits via the extension runner → the
//    extension's handler map). This is the ONLY surface agent_settled / turn_end /
//    message_end / session_before_compact / session_compact ever reach.
//  - `pi.events.on(channel, handler)` — a separate bus for CUSTOM inter-extension
//    channels (e.g. `session-owl:ready`); the only emitter onto it is another
//    extension's `pi.events.emit`.
// The bench subscribes to agent events via `pi.on` (see {@link subscribeAgentEvent}).
// `pi.on` returns void — no unsubscribe — so disposers here are GUARD FLAGS: a
// disposed listener no-ops, and the registration itself dies with the pi's runner
// when the next switchSession/newSession invalidates it (createRuntime re-activates
// extensions with a fresh handler map). Handlers return undefined — never a hook
// result — so the bench never interferes with `session_before_*` aggregation.

import type { ExtensionAPI, MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { type MessageUsage, messageEndUsage } from "../runtime/streaming-tokens.js";

/** `pi.on`'s typed per-event overloads cannot accept a dynamic event name, so this
 *  named seam types the one call site that registers by (bench-internal) name.
 *  The handler's extra `ctx` parameter is intentionally absent (TS allows fewer
 *  parameters) and the handler returns undefined — never a hook result. */
type PiOnByName = (event: string, handler: (data: unknown) => void) => void;

/** Subscribe to an AGENT/SESSION event on `pi` via `pi.on` — the surface those events
 *  actually flow through. Returns a guard-flag disposer: after it runs, the handler
 *  no-ops (pi offers no removal; the registration dies with the pi's runner at the
 *  next session switch). */
export function subscribeAgentEvent(pi: ExtensionAPI, event: string, handler: (data: unknown) => void): () => void {
  let disposed = false;
  const onByName = pi.on as PiOnByName;
  onByName(event, (data: unknown) => {
    if (disposed) return;
    // Crash black box: a throwing handler propagates into pi's emit and can kill
    // the process (uncaughtCrash). Persist the fault BEFORE rethrowing so the
    // bench log carries the event name + stack even when the TUI shows nothing.
    try {
      handler(data);
    } catch (err) {
      log.error(`bench event handler threw (event=${event})`, err);
      throw err;
    }
  });
  return () => {
    disposed = true;
  };
}

/** Read the usage slice off a `message_end` event's assistant message. Returns null
 *  when the message carries no usage (prompt/steering messages). Delegates to the
 *  streaming-tokens extractor (input/output/cacheRead/cacheWrite/cost/totalTokens). */
export function readMessageEndUsage(event: MessageEndEvent): MessageUsage | null {
  return messageEndUsage(event.message);
}

/** Register a `turn_end` handler; returns a disposer to stop listening. Used by the
 *  Phase-2 context monitor (the widget consumes the message events instead). */
export function onTurnEnd(pi: ExtensionAPI, fn: (event: TurnEndEvent) => void): () => void {
  return subscribeAgentEvent(pi, "turn_end", (data) => {
    fn(data as TurnEndEvent);
  });
}

/** Register a ONE-SHOT listener for `event` on `pi`: `fn` fires at most once, then
 *  the listener is guarded off (no further fires). Returns a disposer for early
 *  external teardown (idempotent — safe to call after the listener already fired).
 *  The shared basis for the session-driving primitives' one-shot listeners
 *  (`triggerCompact`, `awaitAgentSettled`) so the one-shot + dispose pattern lives
 *  in one place. */
export function once<T = unknown>(pi: ExtensionAPI, channel: string, fn: (data: T) => void): () => void {
  let fired = false;
  const dispose = subscribeAgentEvent(pi, channel, (data) => {
    if (fired) return;
    fired = true;
    dispose();
    fn(data as T);
  });
  return dispose;
}

/** Race a one-shot `channel` event against an optional `signal`, settling exactly once
 *  and tearing down BOTH listeners (no accumulation on the long-lived run signal). The
 *  shared basis for the bench's two one-shot event-vs-signal races:
 *  `awaitAgentSettled` (agent_settled) and `triggerCompact` (session_compact — which
 *  also wires a third onError path via `extra`). A signal already aborted at call time
 *  rejects immediately (no listener registered, no side effect fired).
 *
 *  Contract: NOT safe for CONCURRENT calls on the same `channel` — the pi event bus
 *  fans out to every listener, so two racing `awaitOnce`s on the same channel would
 *  both resolve on one event. The bench only ever drives one such race per channel at
 *  a time (sequential Phase-1 compaction; one continuation/probe await per forked
 *  session), so this is fine today — but do not introduce concurrent same-channel
 *  races without a per-call correlation key. */
export function awaitOnce<T>(
  pi: ExtensionAPI,
  channel: string,
  options: {
    signal?: AbortSignal;
    /** Builds the rejection error for a signal abort (caller picks the typed error). */
    makeAbortedError: (reason: unknown) => Error;
    /** Optional extra settle paths joined to the SAME idempotent race (e.g.
     *  `triggerCompact`'s onError). Receives resolve/reject that settle the promise
     *  exactly once alongside the event/signal paths. */
    extra?: (settle: { resolve: (value: T) => void; reject: (error: unknown) => void }) => void;
  },
): Promise<T> {
  const { signal, makeAbortedError, extra } = options;
  if (signal?.aborted) return Promise.reject(makeAbortedError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => settle(() => reject(makeAbortedError(signal?.reason)));
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      dispose();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const dispose = once(pi, channel, (data) => settle(() => resolve(data as T)));
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    // If `extra` throws synchronously (e.g. ctx.compact on a stale ctx — a real
    // hazard since loadSession invalidates the old ctx), settle via reject so BOTH
    // listeners are torn down (no leak) instead of escaping via the Promise ctor.
    try {
      extra?.({
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
    } catch (err) {
      settle(() => reject(err));
    }
  });
}
