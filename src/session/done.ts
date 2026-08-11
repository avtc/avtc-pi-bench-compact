// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `awaitAgentSettled` — the bench's job-done signal (§3.6).
 *
 * `agent_settled` fires once both the message and tool queues have fully drained
 * (the agent finished its run, including any compaction-resumed turn). This resolves
 * a Promise on that event; the caller treats it as "the agent is done with this turn".
 *
 * Runaway bound: the `avtc-pi-notification` extension's 2-min idle-alert fires when
 * the agent stalls (no activity) or fails to resume within 2 min after a manual compact
 * — that is the bench's stop-and-surface safety net for hung runs (§3.8). It is NOT
 * reimplemented here; the operator (and the notification channel) own it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AwaitSettledOptions {
  /** Run signal — aborting it rejects the promise (the caller STOPs+surfaces). */
  signal?: AbortSignal;
}

/** Resolve when the active session's agent settles (both queues drained). Rejects on
 *  `signal` abort. The pi event bus exposes no `off()`, so the one-shot handler stays
 *  registered but no-ops after firing (bounded by the ctx lifetime). */
export function awaitAgentSettled(pi: ExtensionAPI, options: AwaitSettledOptions = {}): Promise<void> {
  const { signal } = options;
  let settled = false;

  return new Promise<void>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    // pi.events.on returns a disposer — call it on fire so the listener is removed.
    const dispose = pi.events.on("agent_settled", () => {
      finish(() => {
        dispose();
        resolve();
      });
    });

    if (signal !== undefined) {
      if (signal.aborted) {
        finish(() => {
          dispose();
          reject(new Error(`awaitAgentSettled aborted: ${String(signal.reason)}`));
        });
      } else {
        signal.addEventListener(
          "abort",
          () =>
            finish(() => {
              dispose();
              reject(new Error(`awaitAgentSettled aborted: ${String(signal.reason)}`));
            }),
          { once: true },
        );
      }
    }
  });
}
