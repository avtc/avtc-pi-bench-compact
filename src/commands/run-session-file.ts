// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:run-session-file <path>` command — the extract-mode one-shot
// shorthand: `prepare-scenario --from-session <path>` + `run-scenario`. Parses the
// session-file path, prefights, lifts it into a `PrepareArgs` (extract mode), then
// runs the shared `invokeShorthand` tail. The prepare live-seam construction is
// shared with `prepare-scenario` + `run` via `defaultBuildPrepareDeps`.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { parsePositional } from "./parse.js";
import {
  invokeShorthand,
  notifyOf,
  type RunHandlerContext,
  type RunShorthandOptions,
  registerHandler,
} from "./run-shared.js";
import { preflight } from "./validate.js";

/** Injectable inputs for {@link makeRunSessionFileHandler}. Extends the shared
 *  shorthand options with a path-existence checker (extract preflight needs it). */
export interface RunSessionFileHandlerOptions extends RunShorthandOptions {
  /** Path-existence checker (default = fs.existsSync). */
  readonly exists?: (path: string) => boolean;
}

/** Build the handler for `/bench-compact:run-session-file`. */
export function makeRunSessionFileHandler(opts: RunSessionFileHandlerOptions) {
  const exists = opts.exists ?? existsSync;
  return async (args: string, ctx: unknown): Promise<void> => {
    const handlerCtx = ctx as RunHandlerContext;
    const notify = notifyOf(handlerCtx);

    const parsed = parsePositional(args);
    const check = preflight(getBenchConfig(), "run-session-file", parsed, exists);
    if (!check.ok) {
      notify(check.reason, "warning");
      return;
    }

    // Lift the positional path into a PrepareArgs (extract mode) for the shared tail.
    const prepareArgs = { idea: undefined, fromSession: parsed.value, force: false, error: undefined };
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
