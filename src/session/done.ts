// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `awaitAgentSettled` — the bench's job-done signal.
 *
 * `agent_settled` fires once both the message and tool queues have fully drained
 * (the agent finished its run, including any compaction-resumed turn). This resolves
 * a Promise on that event; the caller treats it as "the agent is done with this turn".
 *
 * Runaway bound: the `avtc-pi-notification` extension's 2-min idle-alert fires when
 * the agent stalls (no activity) or fails to resume within 2 min after a manual compact
 * — that is the bench's stop-and-surface safety net for hung runs. It is NOT
 * reimplemented here; the operator (and the notification channel) own it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { awaitOnce } from "./events.js";

/** The run signal aborted before the agent settled. Distinct from a generic Error so
 *  the caller can STOP+surface a hung run (matches the CompactAbortedError pattern). */
export class AgentSettledAbortedError extends Error {
  constructor(cause: unknown) {
    super("awaitAgentSettled aborted (run signal)", { cause });
    this.name = "AgentSettledAbortedError";
  }
}

export interface AwaitSettledOptions {
  /** Run signal — aborting it rejects the promise (AgentSettledAbortedError). A signal
   *  already aborted at call time rejects immediately. */
  signal?: AbortSignal;
}

/** Resolve when the active session's agent settles (both queues drained). Rejects with
 *  `AgentSettledAbortedError` on `signal` abort. The one-shot `agent_settled` listener
 *  AND the signal abort listener are both removed on settle (no accumulation across
 *  multiple awaits on the long-lived run signal) — handled by the shared `awaitOnce`. */
export async function awaitAgentSettled(pi: ExtensionAPI, options: AwaitSettledOptions | null): Promise<void> {
  const opts = options ?? {};
  await awaitOnce(pi, "agent_settled", {
    signal: opts.signal,
    makeAbortedError: (reason) => new AgentSettledAbortedError(reason),
  });
}

/** A drive-level settle wait exceeded the stall budget — the agent turn (or its
 *  LLM request) is wedged; surfaced as a stop-and-surface error. */
export class AgentStalledError extends Error {
  constructor(label: string, stallMs: number) {
    super(
      `${label}: agent did not settle within ${Math.round(stallMs / 60000)} min — the turn looks stalled (hung LLM request?)`,
    );
    this.name = "AgentStalledError";
  }
}

/** Wrap an awaitSettled function with a stall watchdog: resolves normally on
 *  settle; rejects with {@link AgentStalledError} when `stallMs` elapses first.
 *  The timer always clears (settle, reject, or abort). Legitimately long turns
 *  set the budget generously (marathon tool-looping turns run 45+ min). */
export function withStallWatch(
  awaitSettled: (options: AwaitSettledOptions | null) => Promise<void>,
  stallMs: number,
  label: string,
): (options: AwaitSettledOptions | null) => Promise<void> {
  return (options) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgentStalledError(label, stallMs)), stallMs);
      void (async () => {
        try {
          await awaitSettled(options);
          clearTimeout(timer);
          resolve();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      })();
    });
}
