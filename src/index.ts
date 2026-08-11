// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Registers the settings panel
// (/bench-compact:settings) + the status command (later tasks wire the rest).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initBenchConfig } from "./config/accessor.js";
import { registerBenchSettings } from "./config/schema.js";
import { log } from "./log.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  pi.registerCommand("bench-compact:status", {
    description: "Show the current bench-compact run status.",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      ctx.ui.notify("not started", "info");
    },
  });
}
