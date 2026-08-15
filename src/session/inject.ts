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

/** Separator between the anti-peek preamble and the simulator's first injected message. */
const ANTI_PEEK_SEPARATOR = "\n\n";
/** Delivery mode for simulator injects (queued after the current run settles). */
const SIMULATOR_DELIVER_AS: InjectMode = "followUp";

/** Send a user-role message to the active session, selecting steer vs follow-up delivery. */
export function inject(pi: ExtensionAPI, text: string, mode: InjectMode): void {
  pi.sendUserMessage(text, { deliverAs: mode });
}

/** Build an inject seam that prepends the anti-peek preamble to the FIRST inject only
 *  (the agent sees the forbid-peek instruction before its first tool-bearing turn —
 *  zero extra turns); subsequent injects pass the text through unchanged. Shared by the
 *  build (Phase 0) + continuation (Phase 2) simulator drivers. */
export function makeAntiPeekInject(pi: ExtensionAPI, antiPeekPrompt: string): (text: string) => void {
  return makeAntiPeekInjectFactory(antiPeekPrompt)(pi);
}

/** Build a FAMILY of inject seams sharing ONE first-inject flag. Use when the same
 *  conversation is driven across several loads (the build session's continue
 *  attempts re-switchSession the stable session file): the session is never
 *  compacted, so the preamble from the first inject stays in the agent's context —
 *  a per-attempt fresh seam would duplicate it in the transcript. Each produced
 *  injector binds its own `pi` (a fresh ExtensionAPI per load); the flag is shared.
 *  Post-compaction forks do NOT use this — each fork's context lost the original
 *  preamble to compaction, so each fork gets its own single inject. */
export function makeAntiPeekInjectFactory(antiPeekPrompt: string): (pi: ExtensionAPI) => (text: string) => void {
  let firstInject = true;
  return (pi: ExtensionAPI): ((text: string) => void) => {
    return (text: string): void => {
      const body = firstInject ? `${antiPeekPrompt}${ANTI_PEEK_SEPARATOR}${text}` : text;
      firstInject = false;
      inject(pi, body, SIMULATOR_DELIVER_AS);
    };
  };
}
