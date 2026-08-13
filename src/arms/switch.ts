// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Per-arm isolation via the configure-API model: write the arm's observational-memory
// + memkeeper config, ask each extension's proxy to `reloadConfig()` (so every read
// site sees the new values), and set the tool allowlist so a disabled arm's recall
// tool never reaches the evaluated agent. NO `ctx.reload()` — the command ctx stays
// valid across arms (all extensions load once at startup; only their config + the
// active tool set change per arm).
//
// `reloadConfig()` + `getConfig()` come from the vendored subscribe-to-* snippets
// (lazy proxies over the `:ready` events each extension emits at session_start). The
// harness subscribes once at activate + caches the proxies (proxies.ts); the
// orchestrator reads them + passes them here per arm.

import type { ArmId } from "../config/types.js";
import { type WriteArmConfigOpts, writeArmConfig } from "./config.js";
import { ARM_DEFS } from "./definitions.js";
import { getMemoryProxies } from "./proxies.js";

/**
 * The narrow tool-setting seam `configureArm` needs. The real `ExtensionAPI`
 * satisfies this structurally via `pi.setActiveTools(names)` — the public method
 * that filters the active tool set by name (provider-agnostic, so a disabled arm's
 * recall tool is never sent to the model).
 */
export interface ToolSetSeam {
  setActiveTools(toolNames: string[]): void;
}

/**
 * The narrow config-proxy seam `configureArm` needs. Both vendored
 * subscribe-to-* proxies satisfy this structurally: `reloadConfig()` refreshes the
 * extension's live config from the sources `writeArmConfig` just wrote;
 * `getConfig()` returns a non-null snapshot once the provider's `:ready` event has
 * fired (null before / when the extension is absent or older — graceful degrade).
 */
export interface MemoryConfigProxy {
  reloadConfig(): void;
  getConfig(): unknown;
}

/**
 * An enabled arm's memory extension is not live (absent or older than the
 * `reloadConfig` bridge). Thrown by {@link configureArm}'s presence check; the Phase-1
 * driver catches it + surfaces it as a stop-and-surface `Phase1StoppedError`
 * (reason `config-failed`) — never auto-retries.
 */
export class ArmIsolationError extends Error {
  readonly arm: ArmId;
  readonly provider: "observational-memory" | "memkeeper";
  constructor(arm: ArmId, provider: "observational-memory" | "memkeeper", message: string) {
    super(message);
    this.name = "ArmIsolationError";
    this.arm = arm;
    this.provider = provider;
  }
}

/**
 * The pi default coding tools every evaluated agent starts with (read-only set
 * read/grep/find/ls + the mutation set bash/edit/write). The full default set is
 * pinned here so every arm's agent has the same baseline filesystem tools — the
 * arm only ADDS its memory recall tool(s) on top.
 */
export const BUILTIN_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/**
 * The agent-facing tools the avtc-pi suite extensions register (todo + user-decisions).
 * portrait + notification are background extensions with NO agent-facing tools, so
 * they contribute nothing to the allowlist. Every arm runs within the full suite, so
 * every arm's allowlist includes these.
 */
export const SUITE_TOOLS: readonly string[] = [
  "todo_init",
  "todo_add",
  "todo_move",
  "todo_list",
  "todo_complete",
  "user_decision_add",
  "user_decision_list",
  "user_decision_detail",
];

/**
 * Isolate one arm for a compaction run: write its observational-memory + memkeeper
 * config, reload both extensions' live config, and set the tool allowlist. Sync —
 * every operation (file/env write, proxy reload, tool set) is synchronous.
 *
 * @param toolCtx — the tool-setting seam (the real `pi` satisfies this; tests pass a fake).
 * @param omProxy — the observational-memory config proxy (vendored subscribe-to-OM snippet).
 * @param mkProxy — the memkeeper config proxy (vendored subscribe-to-memkeeper snippet).
 * @param arm — the arm to isolate.
 * @param repoCwd — the scenario repo working dir (the agent's cwd; `.pi/` is gitignored).
 * @param opts — carries the om-full arm's threshold value from bench config.
 *
 * Presence check: if an enabled arm's provider proxy is not live (`getConfig()` null)
 * — the extension is absent or older — this throws (stop-and-surface). The reload is
 * unconditional (it runs before the check), so a provider that IS loaded always sees
 * the freshly-written config regardless of the presence outcome.
 */
export function configureArm(
  toolCtx: ToolSetSeam,
  omProxy: MemoryConfigProxy,
  mkProxy: MemoryConfigProxy,
  arm: ArmId,
  repoCwd: string,
  opts: WriteArmConfigOpts,
): void {
  const def = ARM_DEFS[arm];

  // 1. Write this arm's OM + memkeeper config to the sources those extensions read.
  writeArmConfig(arm, repoCwd, opts);

  // 2. Reload both extensions' live config (no-op when a provider is absent — the
  //    proxies graceful-degrade; the presence check below surfaces a genuinely-missing
  //    enabled extension).
  omProxy.reloadConfig();
  mkProxy.reloadConfig();

  // 3. Presence check: an enabled arm whose provider is not live cannot run — surface it.
  if (def.omConfig.enabled && omProxy.getConfig() === null) {
    throw new ArmIsolationError(
      arm,
      "observational-memory",
      `configureArm(${arm}): observational-memory is enabled for this arm but its extension proxy is not live ` +
        "(extension not loaded, or older than the reloadConfig bridge). Stop and ensure pi-observational-memory is in the loaded packages.",
    );
  }
  if (def.memkeeperConfig.enabled && mkProxy.getConfig() === null) {
    throw new ArmIsolationError(
      arm,
      "memkeeper",
      `configureArm(${arm}): memkeeper is enabled for this arm but its extension proxy is not live ` +
        "(extension not loaded, or older than the reloadConfig bridge). Stop and ensure avtc-pi-memkeeper is in the loaded packages.",
    );
  }

  // 4. Tool allowlist: builtins + suite + this arm's memory recall tool(s). A disabled
  //    arm's recall tool is excluded so the evaluated agent never sees it.
  toolCtx.setActiveTools([...BUILTIN_TOOLS, ...SUITE_TOOLS, ...def.memoryTools]);
}

/**
 * The shared "read cached proxies → null-check → configureArm → map ArmIsolationError"
 * sequence every phase runs (Phase-1 compaction, Phase-2 continuation, probe). Each
 * phase supplies its own `stop` factory so the thrown error carries that phase's
 * identity (arm / arm+attempt / arm+probeId) while the message wording stays uniform
 * across phases — collapsing what was three ~30-line near-identical blocks (the
 * block had already started to drift in wording).
 *
 * @param toolCtx — the tool-setting seam (the real `pi` satisfies this; tests pass a fake).
 * @param context — the run-identity prefix for messages (e.g. "arm <id> attempt 2").
 * @param stop — builds the phase-specific stop error from a message (the reason is
 *   always `config-failed`, so the factory hardcodes it).
 */
export function isolateArmOrStop(
  toolCtx: ToolSetSeam,
  arm: ArmId,
  repoCwd: string,
  opts: WriteArmConfigOpts,
  context: string,
  stop: (message: string) => Error,
): void {
  const proxies = getMemoryProxies();
  if (proxies === null) {
    throw stop(
      `${context}: bench-compact activate has not cached the memory proxies — ensure the extension is active.`,
    );
  }
  try {
    configureArm(toolCtx, proxies.om, proxies.mk, arm, repoCwd, opts);
  } catch (err) {
    if (err instanceof ArmIsolationError) {
      const pkg = err.provider === "observational-memory" ? "pi-observational-memory" : "avtc-pi-memkeeper";
      throw stop(
        `${context} ${err.provider} is enabled but its extension proxy is not live (extension not loaded, or older than the reloadConfig bridge). Stop and ensure ${pkg} is in the loaded packages.`,
      );
    }
    throw err;
  }
}
