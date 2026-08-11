// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Initializes the settings panel
// (/bench-compact:settings via registerBenchSettings) + registers every other
// /bench-compact:* command (registerBenchCommands). Later tasks wire the real
// phase implementations behind the command stubs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBenchCommands } from "./commands/index.js";
import { initBenchConfig } from "./config/accessor.js";
import { registerBenchSettings } from "./config/schema.js";
import { log } from "./log.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  registerBenchCommands(pi);
}
