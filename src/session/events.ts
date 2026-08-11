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
