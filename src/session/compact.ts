// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// `triggerCompact` — the bench's typed wrapper around `ctx.compact()` (§3.5).
//
// The public `ctx.compact({onError})` is fire-and-forget: success arrives via the
// `session_compact` event (carrying the persisted `CompactionEntry`); every failure —
// including a `session_before_compact` hook's `{cancel:true}` ("Compaction cancelled",
// no CompactionEntry, no native fallback) — surfaces via `onError`. We bridge those to a
// single Promise: resolve on `session_compact`, reject on `onError`, and map the cancel
// message to a distinct `CompactionCancelledError` so the caller can STOP+surface it.
//
// Two objects are involved: `pi` (ExtensionAPI) carries the event bus (`pi.events.on`
// returns a disposer so the listener is removed on fire — no leak); `ctx`
// (ExtensionContext) carries `compact()`.
//
// `wallMs` is bench-timed (Date.now bracket around compact->event): `CompactionEntry`
// has no duration field (verified — only usage/timestamp/firstKeptEntryId/details).
// The CALLER carries wallMs into the run's cost record (NOT the JSONL).

import type { CompactionEntry, ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";

/** pi message produced when a `session_before_compact` hook returns `{cancel:true}`. */
const CANCEL_MESSAGE = "Compaction cancelled";

/** A compaction was cancelled by a `session_before_compact` hook ({cancel:true}) — no
 *  CompactionEntry is produced and pi applies NO native fallback (the compaction is
 *  aborted entirely). Distinct from an LLM/runtime error so the caller STOPs+surfaces. */
export class CompactionCancelledError extends Error {
  constructor(cause: unknown) {
    super("compaction cancelled by a session_before_compact hook (no CompactionEntry)", { cause });
    this.name = "CompactionCancelledError";
  }
}

/** A run-signal abort during a compaction. */
export class CompactAbortedError extends Error {
  constructor(cause: unknown) {
    super("compaction aborted (run signal)", { cause });
    this.name = "CompactAbortedError";
  }
}

export interface TriggerCompactOptions {
  /** Run/compaction signal — aborting it rejects the promise (CompactAbortedError). */
  signal?: AbortSignal;
  /** Fired once on success with the persisted entry + the bench-measured wall time. */
  onCompacted?: (compactionEntry: CompactionEntry, wallMs: number) => void;
}

export interface CompactResult {
  compactionEntry: CompactionEntry;
  /** Wall-clock ms from the compact() call to the session_compact event (bench-timed). */
  wallMs: number;
}

/** Minimal event-bus surface triggerCompact needs from `pi` (only `events.on`). */
interface EventBusLike {
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

/**
 * Trigger exactly one compaction and await its outcome.
 *
 * @param pi — the extension API (carries the event bus for `session_compact`).
 * @param ctx — the session context (carries `compact()`).
 *
 * Resolves with `{compactionEntry, wallMs}` on the `session_compact` event; rejects
 * with `CompactionCancelledError` on a hook cancel, `CompactAbortedError` on signal
 * abort, or the raw `Error` for any other failure (surfaced via `onError`).
 */
export function triggerCompact(
  pi: EventBusLike,
  ctx: ExtensionContext,
  options: TriggerCompactOptions = {},
): Promise<CompactResult> {
  const { signal, onCompacted } = options;
  const start = Date.now();
  let settled = false;

  return new Promise<CompactResult>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Success path: the persisted CompactionEntry arrives via the session_compact event.
    // pi.events.on returns a disposer — call it on fire so the listener is removed.
    const dispose = pi.events.on("session_compact", (data) => {
      const event = data as SessionCompactEvent;
      finish(() => {
        dispose();
        const wallMs = Date.now() - start;
        onCompacted?.(event.compactionEntry, wallMs);
        resolve({ compactionEntry: event.compactionEntry, wallMs });
      });
    });

    // Run-signal abort path.
    if (signal !== undefined) {
      if (signal.aborted) {
        finish(() => {
          dispose();
          reject(new CompactAbortedError(signal.reason));
        });
      } else {
        signal.addEventListener(
          "abort",
          () =>
            finish(() => {
              dispose();
              reject(new CompactAbortedError(signal.reason));
            }),
          { once: true },
        );
      }
    }

    // Fire the compaction; failures (incl. cancel) surface via onError.
    ctx.compact({
      onError: (err: Error) =>
        finish(() => {
          dispose();
          if (err.message === CANCEL_MESSAGE) reject(new CompactionCancelledError(err));
          else reject(err);
        }),
    });
  });
}
