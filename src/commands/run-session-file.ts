// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:run-session-file <path>` command — the extract-mode one-shot
// shorthand: `prepare-scenario --from-session <path>` + `run-scenario`. Parses the
// session-file path, prefights, lifts it into a `PrepareArgs` (extract mode), then
// runs the shared `invokeShorthand` tail. The prepare live-seam construction is
// shared with `prepare-scenario` + `run` via `defaultBuildPrepareDeps`.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parsePositional } from "./parse.js";
import {
  guardPreflight,
  invokeShorthand,
  type RunHandlerContext,
  type RunShorthandOptions,
  registerHandler,
} from "./run-shared.js";

/** Build the handler for `/bench-compact:run-session-file`. */
export function makeRunSessionFileHandler(opts: RunShorthandOptions) {
  const exists = opts.exists ?? existsSync;
  return async (args: string, ctx: unknown): Promise<void> => {
    const handlerCtx = ctx as RunHandlerContext;

    const parsed = parsePositional(args);
    if (!guardPreflight(handlerCtx, "run-session-file", parsed, exists)) return;

    // Lift the positional path into a PrepareArgs (extract mode) for the shared tail.
    const prepareArgs = {
      idea: undefined,
      fromSession: parsed.value,
      plantFrom: undefined,
      skipFrom: undefined,
      skipTopics: undefined,
      force: false,
      error: undefined,
    };
    await invokeShorthand(handlerCtx, prepareArgs, opts);
  };
}

/** Register the run-session-file command on `pi`. */
export function registerRunSessionFileCommand(pi: ExtensionAPI): void {
  registerHandler(
    pi,
    "bench-compact:run-session-file",
    "Extract a real session file + run.",
    makeRunSessionFileHandler({}),
  );
}
