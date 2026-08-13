// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `loadSession` — typed wrapper over `cmdCtx.switchSession(path, {withSession})`.
 *
 * switchSession loads a session file IN-PLACE: the old `ctx` is invalidated, so ALL
 * work against the new context must happen inside the `withSession` callback (which
 * receives the live replacement context). This wrapper funnels the callback's return
 * value out and surfaces a cancelled switch (withSession did not run) as an error so
 * the caller STOPs+surfaces.
 *
 * NOTE: `switchSession` lives on `ExtensionCommandContext` (command handlers), NOT the
 * plain `ExtensionContext` passed to extension factories. The `withSession` callback
 * receives a `ReplacedSessionContext` (extends `ExtensionCommandContext`); we type the
 * param as `ExtensionCommandContext` since `ReplacedSessionContext` is not re-exported
 * from the public surface and the bench uses only `ExtensionCommandContext` members.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** A session switch was cancelled (the `withSession` callback never ran). */
class SessionSwitchCancelledError extends Error {
  constructor(path: string) {
    super(`session switch to "${path}" was cancelled (withSession did not run)`);
    this.name = "SessionSwitchCancelledError";
  }
}

/**
 * Switch to `path` and run `withSession` against the new (live) context, returning
 * its result. Throws `SessionSwitchCancelledError` if the switch is cancelled.
 *
 * @param cmdCtx — a command-handler context (ExtensionCommandContext.switchSession).
 * @param path — absolute path to the session JSONL file to load.
 * @param withSession — receives the NEW ctx (old ctx is invalidated); runs all work.
 */
export async function loadSession<T>(
  cmdCtx: ExtensionCommandContext,
  path: string,
  withSession: (ctx: ExtensionCommandContext) => Promise<T>,
): Promise<T> {
  const slot: { value?: T } = {};
  let ran = false;
  const outcome = await cmdCtx.switchSession(path, {
    withSession: async (newCtx) => {
      ran = true;
      slot.value = await withSession(newCtx);
    },
  });
  if (!ran || outcome?.cancelled) {
    throw new SessionSwitchCancelledError(path);
  }
  return slot.value as T;
}
