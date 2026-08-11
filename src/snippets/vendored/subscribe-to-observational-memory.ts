// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** API object emitted on the `pi-observational-memory:ready` event. Lets a host
 *  reconfigure observational-memory LIVE (clear the cached config + reload from
 *  settings.json/env) without `ctx.reload()` (which would invalidate the command
 *  ctx). `getConfig` may be absent on older bridges — the proxy returns null then. */
export interface ObservationalMemoryReadyApi {
	/** Clear the cached config + reload from settings.json + env. Optional cwd
	 *  override; defaults to the live session cwd. */
	reloadConfig: (cwd?: string) => void;
	/** Read the current effective config (snapshot). May be absent on older
	 *  bridges — the proxy returns null then. */
	getConfig?: () => unknown;
}

/**
 * Subscribe to pi-observational-memory:ready and expose its reloadConfig/getConfig
 * lazily.
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 * Copy this file into your consumer's src/snippets/vendored/ directory verbatim — no changes needed.
 *
 * Returns a sync lazy proxy — reloadConfig + getConfig delegate to an internal
 * `_api` ref populated when :ready fires at session_start.
 * Before :ready fires (or when the bridge is absent/older): reloadConfig is a
 * no-op and getConfig returns null (safe defaults — graceful degrade).
 */
export function subscribeToObservationalMemory(
	pi: ExtensionAPI,
): {
	reloadConfig(cwd?: string): void;
	getConfig(): unknown;
} {
	const unsubs: Array<() => void> = [];

	// Internal API ref — populated when :ready fires
	let _api: ObservationalMemoryReadyApi | null = null;

	// On session_shutdown (fires before reload): clean pi.events.on listeners
	pi.on("session_shutdown", () => {
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
	});

	// Register :ready listener
	unsubs.push(
		pi.events.on("pi-observational-memory:ready", (api: unknown) => {
			_api = api as ObservationalMemoryReadyApi;
		}),
	);

	// Return sync lazy proxy — methods delegate to _api when available
	return {
		reloadConfig(cwd?: string): void {
			_api?.reloadConfig?.(cwd);
		},
		getConfig(): unknown {
			return _api?.getConfig?.() ?? null;
		},
	};
}
