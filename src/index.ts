// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Registers the command
// surface (later tasks wire each command's real handler; for now `status`
// reports the bench is not running).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  pi.registerCommand("bench-compact:status", {
    description: "Show the current bench-compact run status.",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      ctx.ui.notify("not started", "info");
    },
  });
}
