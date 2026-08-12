// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:run <idea>` command — the build-mode one-shot shorthand:
// `prepare-scenario <idea>` + `run-scenario`. Parses the idea, prefights, then runs
// the shared `invokeShorthand` tail (prepare in build mode → load manifest → executeRun).
//
// The prepare live-seam construction is shared with `prepare-scenario` +
// `run-session-file` via `defaultBuildPrepareDeps` (in run-shared.ts).

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { parsePrepareArgs } from "./parse.js";
import {
  invokeShorthand,
  notifyOf,
  type RunHandlerContext,
  type RunShorthandOptions,
  registerHandler,
} from "./run-shared.js";
import { preflight } from "./validate.js";

/** Build the handler for `/bench-compact:run`. */
export function makeRunHandler(opts: RunShorthandOptions) {
  return async (args: string, ctx: unknown): Promise<void> => {
    const handlerCtx = ctx as RunHandlerContext;
    const notify = notifyOf(handlerCtx);

    const parsed = parsePrepareArgs(args);
    if (parsed.error !== undefined) {
      notify(parsed.error, "warning");
      return;
    }
    const check = preflight(getBenchConfig(), "run", parsed, existsSync);
    if (!check.ok) {
      notify(check.reason, "warning");
      return;
    }

    await invokeShorthand(handlerCtx, parsed, opts);
  };
}

/** Register the run command on `pi`. */
export function registerRunCommand(pi: ExtensionAPI): void {
  registerHandler(pi, "bench-compact:run", "Prepare + run a scenario from <idea>.", makeRunHandler({}));
}
