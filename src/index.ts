// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Initializes the settings panel
// (/bench-compact:settings via registerBenchSettings) + registers every other
// /bench-compact:* command (registerBenchCommands). Subscribes to the observational-
// memory + memkeeper `:ready` events (vendored snippets) + stashes the fresh `pi` +
// the lazy config proxies on globalThis so the orchestrator can reconfigure each arm
// live (configureArm: writeArmConfig + reloadConfig + setActiveTools — no ctx.reload()).
//
// `activate` runs on EVERY extension (re)activation — `switchSession`'s
// `createRuntime` re-activates the extension with a fresh `pi` (the old one is
// invalidated: runner.js `invalidate` → every `pi.*` method throws "stale"). So
// re-stashing `pi` + re-subscribing the proxies here keeps the globalThis handles
// fresh across arms — `runPhase1` reads them inside each `withSession` (bench-ctx.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setMemoryProxies } from "./arms/proxies.js";
import { registerBenchCommands } from "./commands/index.js";
import { initBenchConfig } from "./config/accessor.js";
import { registerBenchSettings } from "./config/schema.js";
import { log } from "./log.js";
import { setBenchPi } from "./orchestrate/bench-ctx.js";
import { subscribeToMemkeeper } from "./snippets/vendored/subscribe-to-memkeeper.js";
import { subscribeToObservationalMemory } from "./snippets/vendored/subscribe-to-observational-memory.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  // Stash the fresh pi FIRST — re-activation on switchSession invalidates the prior
  // pi; re-stashing here keeps globalThis current for runPhase1's withSession reads.
  setBenchPi(pi);

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  registerBenchCommands(pi);

  // Subscribe to each memory extension's :ready event + cache the lazy config
  // proxies. Re-subscribed on every re-activation (fresh pi.events), so the cached
  // proxies stay bound to the live extension after each switchSession. Both are safe
  // before :ready fires (reloadConfig no-op, getConfig null); configureArm reads them
  // per arm and asserts presence for an enabled arm.
  const om = subscribeToObservationalMemory(pi);
  const mk = subscribeToMemkeeper(pi);
  setMemoryProxies({ om, mk });
}
