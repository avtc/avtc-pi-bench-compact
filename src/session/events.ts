// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Typed event helpers for the bench's session-driving primitives.
//
// The pi event bus has two surfaces: `pi.on(event, handler)` (typed per-event
// overloads, returns void — no removal) and `pi.events.on(channel, handler)` (raw
// bus, returns a `() => void` disposer). The bench uses the disposer-returning
// `pi.events.on` everywhere so one-shot listeners (compact, agent-settled) and
// widget listeners (turn_end) can be cleanly torn down — no handler leak.

import type { ExtensionAPI, MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { type MessageUsage, messageEndUsage } from "../runtime/streaming-tokens.js";

/** Read the usage slice off a `message_end` event's assistant message. Returns null
 *  when the message carries no usage (prompt/steering messages). Delegates to the
 *  streaming-tokens extractor (input/output/cacheRead/cacheWrite/cost/totalTokens). */
export function readMessageEndUsage(event: MessageEndEvent): MessageUsage | null {
  return messageEndUsage(event.message);
}

/** Register a `turn_end` handler; returns a disposer to stop listening. Used by the
 *  live-progress widget (§3.15) and the Phase-2 context monitor. */
export function onTurnEnd(pi: ExtensionAPI, fn: (event: TurnEndEvent) => void): () => void {
  return pi.events.on("turn_end", (data) => {
    fn(data as TurnEndEvent);
  });
}

/** Register a ONE-SHOT listener for `channel` on `pi.events`: `fn` fires at most once,
 *  then the listener is auto-removed. Returns a disposer for early external teardown
 *  (idempotent — safe to call after the listener already fired/removed). The shared
 *  basis for the session-driving primitives' one-shot listeners (`triggerCompact`,
 *  `awaitAgentSettled`) so the one-shot + dispose pattern lives in one place. */
export function once<T = unknown>(pi: ExtensionAPI, channel: string, fn: (data: T) => void): () => void {
  let disposed = false;
  const eventDispose = pi.events.on(channel, (data) => {
    if (disposed) return;
    disposed = true;
    eventDispose();
    fn(data as T);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    eventDispose();
  };
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
    // R2-1: if `extra` throws synchronously (e.g. ctx.compact on a stale ctx — a real
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
