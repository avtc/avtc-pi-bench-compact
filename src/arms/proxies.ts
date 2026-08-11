// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The cached observational-memory + memkeeper config proxies. `activate` subscribes
// to each extension's `:ready` event once (via the vendored snippets) and caches the
// returned lazy proxies here on `globalThis` (PiCtx-style) so the orchestrator can
// read them per arm without re-subscribing. The proxies are lazy — safe to cache
// before `:ready` ever fires (reloadConfig is a no-op, getConfig returns null).

import type { MemoryConfigProxy } from "./switch.js";

/** The two memory-extension config proxies, cached for the orchestrator. */
export interface MemoryProxies {
  om: MemoryConfigProxy;
  mk: MemoryConfigProxy;
}

const GLOBAL_KEY = "__benchCompactMemoryProxies";

/** Named sentinel for "clear the cache" (the no-bare-literals lint forbids a bare null arg). */
const CLEARED: MemoryProxies | null = null;

function readGlobal(): MemoryProxies | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as MemoryProxies | null) ?? null;
}

function writeGlobal(p: MemoryProxies | null): void {
  const g = globalThis as Record<string, unknown>;
  if (p === null) delete g[GLOBAL_KEY];
  else g[GLOBAL_KEY] = p;
}

/** The cached proxies, or null when activate has not run / was cleared. */
export function getMemoryProxies(): MemoryProxies | null {
  return readGlobal();
}

/** Cache the proxies (called once at activate, after subscribing to both `:ready` events). */
export function setMemoryProxies(proxies: MemoryProxies): void {
  writeGlobal(proxies);
}

/** Clear the cache (teardown / between runs). */
export function clearMemoryProxies(): void {
  writeGlobal(CLEARED);
}
