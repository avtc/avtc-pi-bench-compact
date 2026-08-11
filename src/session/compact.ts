// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// `triggerCompact` — the bench's typed wrapper around `ctx.compact()` (§3.5).
//
// The public `ctx.compact({onError})` is fire-and-forget: success arrives via the
// `session_compact` event (carrying the persisted `CompactionEntry`); every failure —
// including a `session_before_compact` hook's `{cancel:true}` ("Compaction cancelled",
// no CompactionEntry, no native fallback) — surfaces via `onError`. We race those three
// outcomes (event / onError / signal) via the shared `awaitOnce` helper, mapping the
// cancel message to a distinct `CompactionCancelledError` so the caller can STOP+surface.
//
// `wallMs` is bench-timed (Date.now bracket around compact->event): `CompactionEntry`
// has no duration field (verified — only usage/timestamp/firstKeptEntryId/details).
// The CALLER carries wallMs into the run's cost record (NOT the JSONL).

import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import { awaitOnce } from "./events.js";

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
  /** Run/compaction signal — aborting it rejects the promise (CompactAbortedError).
   *  A signal already aborted at call time rejects WITHOUT firing `ctx.compact`. */
  signal?: AbortSignal;
  /** Fired once on success with the persisted entry + the bench-measured wall time.
   *  Isolated: a throw here is logged + swallowed (it never hangs the promise). */
  onCompacted?: (compactionEntry: CompactionEntry, wallMs: number) => void;
}

export interface CompactResult {
  compactionEntry: CompactionEntry;
  /** Wall-clock ms from the compact() call to the session_compact event (bench-timed). */
  wallMs: number;
}

/**
 * Trigger exactly one compaction and await its outcome.
 *
 * @param pi — the extension API (carries the event bus for `session_compact`).
 * @param ctx — the session context (carries `compact()`).
 *
 * Resolves with `{compactionEntry, wallMs}` on the `session_compact` event; rejects
 * with `CompactionCancelledError` on a hook cancel, `CompactAbortedError` on signal
 * abort, or the raw `Error` for any other failure (surfaced via `onError`). A signal
 * already aborted at call time rejects immediately WITHOUT firing `ctx.compact`
 * (no unwanted session mutation).
 */
export async function triggerCompact(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: TriggerCompactOptions | null,
): Promise<CompactResult> {
  const { signal, onCompacted } = options ?? {};
  const start = Date.now();

  // Race session_compact (success) vs signal-abort vs onError (failure). The compaction
  // is fired inside `extra` so its onError joins the same idempotent race; a pre-aborted
  // signal short-circuits in awaitOnce BEFORE ctx.compact is ever called (R4-6).
  const event = await awaitOnce<SessionCompactEvent>(pi, "session_compact", {
    signal,
    makeAbortedError: (reason) => new CompactAbortedError(reason),
    extra: ({ reject }) => {
      ctx.compact({
        onError: (err: Error) => {
          if (err.message === CANCEL_MESSAGE) reject(new CompactionCancelledError(err));
          else reject(err);
        },
      });
    },
  });

  const wallMs = Date.now() - start;
  // R4-1: isolate onCompacted so a throwing callback cannot hang the promise.
  try {
    onCompacted?.(event.compactionEntry, wallMs);
  } catch (err) {
    log.warn(`triggerCompact onCompacted callback threw: ${String(err)}`);
  }
  return { compactionEntry: event.compactionEntry, wallMs };
}
