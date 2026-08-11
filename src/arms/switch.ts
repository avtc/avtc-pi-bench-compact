// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import type { ArmId } from "../config/types.js";
import { ARM_DEFS, type MemkeeperArmConfig } from "./definitions.js";
import { buildPackages } from "./packages.js";

/** Options carrying the A5 threshold value (from bench config `omFullReflectionThresholdTokens`). */
export interface BuildProjectSettingsOpts {
  omFullReflectionThresholdTokens: number;
}

/**
 * The `.pi/settings.json` content for one arm: `packages` (the isolated suite+harness+arm
 * set) + the `observational-memory` section for A5 (threshold override). pi's settings
 * deep-merge treats `packages` arrays as REPLACE-not-concat, so this set fully defines
 * what loads on `ctx.reload()`.
 */
export interface ProjectSettings {
  packages: PackageSource[];
  /** A5 only — the low threshold forcing the OM reflector/pruner to run. */
  "observational-memory"?: { reflectionThresholdTokens: number };
}

/**
 * Build the project `.pi/settings.json` content for an arm (§2.5). Pure — the I/O is in
 * {@link switchArm}. A5 injects `reflectionThresholdTokens` from config (the harness owns
 * that one value); A2 OM-default leaves the author threshold intact (no section written).
 */
export function buildProjectSettings(arm: ArmId, opts: BuildProjectSettingsOpts): ProjectSettings {
  const def = ARM_DEFS[arm];
  const settings: ProjectSettings = { packages: buildPackages(arm) };
  if (def.overrideReflectionThreshold) {
    settings["observational-memory"] = { reflectionThresholdTokens: opts.omFullReflectionThresholdTokens };
  }
  return settings;
}

/**
 * The memkeeper config for an arm (A3/A4), or `null` (no memkeeper settings file) otherwise.
 * Written to `.pi/avtc-pi-memkeeper-settings.json` (the avtc-pi-settings-ui file for
 * `avtc-pi-memkeeper`). Pure.
 */
export function buildMemkeeperSettings(arm: ArmId): MemkeeperArmConfig | null {
  return ARM_DEFS[arm].memkeeperSettings ?? null;
}

/**
 * Minimal seam over {@link ExtensionCommandContext} — the harness only needs `reload()`.
 * The real command context satisfies this structurally; tests pass a fake.
 */
export interface SwitchContext {
  /** Re-read project settings + re-discover extensions (G-iso: agent-session.js:2057). */
  reload(): Promise<void>;
}

/** Memkeeper's settings-ui file name (avtc-pi-settings-ui convention: `<name>-settings.json`). */
const MEMKEEPER_SETTINGS_FILE = "avtc-pi-memkeeper-settings.json";

/**
 * Isolate an arm: write its project settings (packages + arm-specific config) + `reload()`
 * so pi loads exactly the suite + harness + this arm's memory extension (§2.4/§3.2/UD33).
 *
 * **G-iso (verified):** `ctx.reload()` → `settingsManager.reload()` (re-reads the project
 * `.pi/settings.json` we just wrote — `packages` REPLACES global, so the harness is
 * included) → `resourceLoader.reload()` (re-discovers extensions from the new packages).
 *
 * **Lifecycle:** `reload()` invalidates THIS ctx (runner.js:352). Harness state survives in
 * `globalThis` (UD25); post-reload continuation runs in the NEW ctx via a `session_start`
 * (reason "reload") listener (Task 12 orchestration). The OM `passive` env precondition
 * (A2/A5) is operator-set globally — the harness does not manage process env.
 */
export async function switchArm(
  ctx: SwitchContext,
  arm: ArmId,
  repoCwd: string,
  opts: BuildProjectSettingsOpts,
): Promise<void> {
  const piDir = join(repoCwd, ".pi");
  mkdirSync(piDir, { recursive: true });

  // 1. project .pi/settings.json — packages + (A5) observational-memory threshold
  const settingsPath = join(piDir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(buildProjectSettings(arm, opts), null, 2)}\n`, "utf-8");

  // 2. memkeeper settings (A3/A4 only) — .pi/avtc-pi-memkeeper-settings.json
  const mk = buildMemkeeperSettings(arm);
  if (mk) {
    writeFileSync(join(piDir, MEMKEEPER_SETTINGS_FILE), `${JSON.stringify(mk, null, 2)}\n`, "utf-8");
  }

  // 3. reload — re-read project settings + re-discover extensions (the arm loads)
  await ctx.reload();
}
