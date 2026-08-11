// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import type { ArmId } from "../config/types.js";
import { ARM_DEFS, type ArmDef, type MemkeeperArmConfig } from "./definitions.js";
import { buildPackages } from "./packages.js";

/** Options carrying the OM-full arm's threshold value (from bench config `omFullReflectionThresholdTokens`). */
export interface BuildProjectSettingsOpts {
  omFullReflectionThresholdTokens: number;
}

/**
 * The `.pi/settings.json` content for one arm: `packages` (the isolated suite+harness+arm
 * set) + the `observational-memory` section for the OM-full arm (threshold override). pi's settings
 * deep-merge treats `packages` arrays as REPLACE-not-concat, so this set fully defines
 * what loads on `ctx.reload()`.
 */
export interface ProjectSettings {
  packages: PackageSource[];
  /** OM-full arm only — the low threshold forcing the OM reflector/pruner to run. */
  "observational-memory"?: { reflectionThresholdTokens: number };
}

/**
 * Build the project `.pi/settings.json` content for an arm. Pure — the I/O is in
 * {@link switchArm}. The OM-full arm injects `reflectionThresholdTokens` from config (the harness owns
 * that one value); the OM-default arm leaves the author threshold intact (no section written).
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
 * The memkeeper config for an arm (the memkeeper-builder and memkeeper-selector arms), or `null` (no memkeeper settings file) otherwise.
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
/** avtc-pi-settings-ui env transport for memkeeper (read FIRST on load — factory.ts:184). */
const MEMKEEPER_ENV = "PI_SETTINGS_MEMKEEPER";
/**
 * Every static-env key any arm declares via `envPreconditions` — the union, so switchArm can
 * set this arm's keys + DELETE stale keys from other arms (isolation is deterministic, not
 * dependent on prior process state). envPreconditions is the single source of truth for which
 * static env the bench manages (R-2).
 */
const MANAGED_STATIC_ENV_KEYS = new Set(
  (Object.values(ARM_DEFS) as ArmDef[]).flatMap((d) => Object.keys(d.envPreconditions ?? {})),
);

/**
 * Isolate an arm: write its project settings (packages + arm-specific config) + `reload()`
 * so pi loads exactly the suite + harness + this arm's memory extension.
 *
 * **Env transport:** avtc-pi-settings-ui reads `PI_SETTINGS_MEMKEEPER` env FIRST
 * (factory.ts:184) + a stale value from a prior arm survives `ctx.reload()` (process env is
 * not cleared), so a stale memkeeper-builder env would silently override the memkeeper-selector arm's FILE. OM `passive` is env-only
 * (no file equivalent). So switchArm sets the memkeeper env per memkeeper arm (builder/selector) + applies the arm's
 * `envPreconditions` (OM passive=1 for the OM-default and OM-full arms) + DELETES all managed env keys for arms that
 * don't use them — isolation is deterministic. `envPreconditions` is the single source of truth
 * for static env; the memkeeper env is dynamic config switchArm computes from memkeeperSettings.
 *
 * **Lifecycle note:** switchArm mutates process.env with NO teardown — the env persists in the
 * operator's session post-run (only a restart clears it). Teardown is Task-12 orchestration
 * (R-4); switchArm is the per-arm isolation primitive.
 *
 * **G-iso (verified):** `ctx.reload()` → `settingsManager.reload()` (re-reads the project
 * `.pi/settings.json` we just wrote — `packages` REPLACES global, so the harness is
 * included) → `resourceLoader.reload()` (re-discovers extensions from the new packages).
 *
 * **Lifecycle:** `reload()` invalidates THIS ctx (runner.js:352). Harness state survives in
 * `globalThis` (UD25); post-reload continuation runs in the NEW ctx via a `session_start`
 * (reason "reload") listener (Task 12 orchestration).
 */
export async function switchArm(
  ctx: SwitchContext,
  arm: ArmId,
  repoCwd: string,
  opts: BuildProjectSettingsOpts,
): Promise<void> {
  const piDir = join(repoCwd, ".pi");
  mkdirSync(piDir, { recursive: true });

  // 1. project .pi/settings.json — packages + (OM-full) observational-memory threshold
  writeFileSync(join(piDir, "settings.json"), `${JSON.stringify(buildProjectSettings(arm, opts), null, 2)}\n`, "utf-8");

  // 2. memkeeper config — file + env transport (memkeeper-builder/selector); remove both otherwise (no stale override)
  const mk = buildMemkeeperSettings(arm);
  const mkPath = join(piDir, MEMKEEPER_SETTINGS_FILE);
  if (mk) {
    writeFileSync(mkPath, `${JSON.stringify(mk, null, 2)}\n`, "utf-8");
    process.env[MEMKEEPER_ENV] = JSON.stringify(mk);
  } else {
    rmSync(mkPath, { force: true }); // stale file from a prior memkeeper arm
    delete process.env[MEMKEEPER_ENV];
  }

  // 3. static env preconditions (envPreconditions) — apply this arm's, clear stale keys from other arms
  const staticEnv = ARM_DEFS[arm].envPreconditions ?? {};
  for (const key of MANAGED_STATIC_ENV_KEYS) {
    const val = staticEnv[key];
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }

  // 4. reload — re-read project settings + re-discover extensions (the arm loads)
  await ctx.reload();
}
