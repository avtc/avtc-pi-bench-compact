// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Initializes the settings panel
// (/bench-compact:settings via registerBenchSettings) + registers every other
// /bench-compact:* command (registerBenchCommands). Subscribes to the observational-
// memory + memkeeper `:ready` events once (vendored snippets) and caches the lazy
// config proxies on globalThis so the orchestrator can reconfigure each arm live
// (configureArm: writeArmConfig + reloadConfig + setActiveTools — no ctx.reload()).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setMemoryProxies } from "./arms/proxies.js";
import { registerBenchCommands } from "./commands/index.js";
import { initBenchConfig } from "./config/accessor.js";
import { registerBenchSettings } from "./config/schema.js";
import { log } from "./log.js";
import { subscribeToMemkeeper } from "./snippets/vendored/subscribe-to-memkeeper.js";
import { subscribeToObservationalMemory } from "./snippets/vendored/subscribe-to-observational-memory.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  registerBenchCommands(pi);

  // Subscribe to each memory extension's :ready event + cache the lazy config
  // proxies. Both are safe before :ready fires (reloadConfig no-op, getConfig null);
  // configureArm reads them per arm and asserts presence for an enabled arm.
  const om = subscribeToObservationalMemory(pi);
  const mk = subscribeToMemkeeper(pi);
  setMemoryProxies({ om, mk });
}
