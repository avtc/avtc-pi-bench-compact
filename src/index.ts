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
import { registerPhase1Driver } from "./orchestrate/phase1.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  registerBenchCommands(pi);

  // The phase-1 driver: advances the run across per-arm reloads (CR-R1-1). Registered on
  // every activate so the post-reload fresh ctx arrives via session_start{reload}.
  registerPhase1Driver(pi);
}
