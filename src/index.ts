// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact extension activate entry point. Initializes the settings panel
// (/bench-compact:settings via registerBenchSettings) + registers every other
// /bench-compact:* command (registerBenchCommands). Subscribes to the observational-
// memory + session-owl `:ready` events (vendored snippets) + stashes the fresh `pi` +
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
import { NO_COMMAND_SEAMS, registerBenchCommands } from "./commands/index.js";
import { initBenchConfig } from "./config/accessor.js";
import { registerBenchSettings } from "./config/schema.js";
import { registerCrashWitness } from "./crash-guard.js";
import { log } from "./log.js";
import { setBenchPi } from "./orchestrate/bench-ctx.js";
import { subscribeToDialogCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.js";
import { subscribeToSessionOwl } from "./snippets/vendored/subscribe-to-session-owl.js";
import { subscribeToNotificationApi } from "./snippets/vendored/subscribe-to-notifications.js";
import { subscribeToObservationalMemory } from "./snippets/vendored/subscribe-to-observational-memory.js";

export default function activate(pi: ExtensionAPI): void {
  log.debug("bench-compact activated");

  // Stash the fresh pi FIRST — re-activation on switchSession invalidates the prior
  // pi; re-stashing here keeps globalThis current for runPhase1's withSession reads.
  setBenchPi(pi);

  // Crash black box: persist the exit code + any uncaught exception to the bench
  // log at the moment of death (silent exits leave a forensic record).
  registerCrashWitness();

  const handle = registerBenchSettings(pi);
  initBenchConfig(handle);

  registerBenchCommands(pi, NO_COMMAND_SEAMS);

  // Subscribe to each memory extension's :ready event + cache the lazy config
  // proxies. Re-subscribed on every re-activation (fresh pi.events), so the cached
  // proxies stay bound to the live extension after each switchSession. Both are safe
  // before :ready fires (reloadConfig no-op, getConfig null); configureArm reads them
  // per arm and asserts presence for an enabled arm.
  const om = subscribeToObservationalMemory(pi);
  const mk = subscribeToSessionOwl(pi);
  setMemoryProxies({ om, mk });

  // Operator-facing UI plumbing (both no-ops when the extensions are absent):
  // - dialog coordination — bench dialogs queue behind any open modal instead of
  //   stealing focus (askOperator serializes through it)
  // - notification attention — an away-from-keyboard operator is pinged while a
  //   bench dialog blocks (askOperator wraps the ask with it)
  subscribeToDialogCoordinator(pi);
  subscribeToNotificationApi(pi);
}
