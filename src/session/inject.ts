// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `inject` — typed wrapper over `pi.sendUserMessage(text, {deliverAs})`.
 *
 * On the `ExtensionAPI` (`pi`), NOT the context. `deliverAs` selects how the message
 * is queued relative to an in-flight agent turn:
 *  - `"steer"`: queued mid-stream (interrupts/steers the current run);
 *  - `"followUp"`: delivered after the current run settles (next turn).
 * The harness uses `steer` to pace/redirect the user-simulator mid-build and
 * `followUp` to launch continuation/probe turns after the agent settles. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type InjectMode = "steer" | "followUp";

/** Send a user-role message to the active session, selecting steer vs follow-up delivery. */
export function inject(pi: ExtensionAPI, text: string, mode: InjectMode): void {
  pi.sendUserMessage(text, { deliverAs: mode });
}
