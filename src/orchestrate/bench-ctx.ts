// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench's current `ExtensionAPI` (pi), stashed on `globalThis` at `activate` +
// refreshed on every extension (re)activation.
//
// WHY THIS EXISTS: `switchSession` invalidates the captured command-handler `pi`
// (runner.js `invalidate` → every `pi.*` method calls `runtime.assertActive()` and
// throws "stale after session replacement"). But `switchSession`'s `createRuntime`
// RE-ACTIVATES the extension — `activate(freshPi)` runs again — so stashing that
// fresh `pi` here keeps a valid handle. `runPhase1` reads it INSIDE each
// `withSession` callback (which runs after the re-activation), never the stale
// command-handler `pi`. This is the featyard PiCtx pattern (stash the fresh handle
// at activation, read it at execution time).
//
// The memory-config proxies (`arms/proxies.ts`) follow the same model — `activate`
// re-subscribes them on the fresh `pi`, so `getMemoryProxies()` returns the fresh
// proxies after each re-activation too.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GLOBAL_KEY = "__benchCompactPi";

function readGlobal(): ExtensionAPI | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as ExtensionAPI | null) ?? null;
}

function writeGlobal(pi: ExtensionAPI | null): void {
  const g = globalThis as Record<string, unknown>;
  if (pi === null) delete g[GLOBAL_KEY];
  else g[GLOBAL_KEY] = pi;
}

/**
 * The current bench `pi` (fresh as of the latest activation). Throws when no `pi` is
 * stashed yet — callers (`runPhase1`) only invoke this inside `withSession`, by which
 * point `activate` has run (re-activation) + stashed the fresh `pi`.
 */
export function getBenchPi(): ExtensionAPI {
  const pi = readGlobal();
  if (pi === null) {
    throw new Error("bench-ctx: no bench pi stashed — activate has not run (setBenchPi).");
  }
  return pi;
}

/** Cache the fresh `pi` (called at `activate`, re-run on every extension re-activation). */
export function setBenchPi(pi: ExtensionAPI): void {
  writeGlobal(pi);
}

/** Clear the cache (teardown / test reset). */
export function clearBenchPi(): void {
  // Named sentinel — the no-bare-literals lint forbids a bare null arg.
  const cleared: ExtensionAPI | null = null;
  writeGlobal(cleared);
}
