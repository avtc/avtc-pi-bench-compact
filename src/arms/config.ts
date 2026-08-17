// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Per-arm config writes for the configure-API isolation model. The harness writes
// each arm's observational-memory + memkeeper config to the SAME sources those
// extensions already read, then calls each extension's `reloadConfig()` (in
// `configureArm`) so every read site sees the new values with no per-site patching.
//
// observational-memory reads (loadConfig precedence, last wins): built-in defaults
// (enabled: true) → global settings.json → project `.pi/settings.json`
// `observational-memory` section → env (`PI_OBSERVATIONAL_MEMORY_ENABLED` /
// `PI_OBSERVATIONAL_MEMORY_PASSIVE`). Because env WINS, every arm sets both env
// keys explicitly to '1'/'0' so a stale value from a prior arm can never override
// this arm's intent. memkeeper reads `PI_SETTINGS_MEMKEEPER` env JSON first, so
// every arm sets it (carrying `enabled:false` for non-memkeeper arms) — same
// deterministic-isolation reasoning.
//
// Pure file/env writes — no `reloadConfig()` here (that is `configureArm`'s job).
// The `.pi/` directory is gitignored, so these writes are local-only (never committed
// into the scenario repo the agent works in).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArmId } from "../config/types.js";
import { ARM_DEFS, type OmArmConfig } from "./definitions.js";

/** Carries the om-full arm's threshold value (from bench config `omFullReflectionThresholdTokens`). */
export interface WriteArmConfigOpts {
  omFullReflectionThresholdTokens: number;
  /** The operator's GLOBAL memkeeper settings (parsed `avtc-pi-memkeeper-settings.json`),
   *  merged UNDER the arm pins — the bench pins only the arm-defining keys
   *  (enabled/modes/renderMode); everything else (models, timeouts, thinking levels,
   *  max tokens, thresholds) comes from here, so global panel tuning reaches the
   *  bench arms. Absent → pins only. */
  memkeeperGlobal?: Record<string, unknown>;
}

/** avtc-pi-settings-ui env transport for memkeeper (read FIRST on load — factory.ts). */
const MEMKEEPER_ENV = "PI_SETTINGS_MEMKEEPER";
/** observational-memory env knobs (env precedence WINS over settings.json — see file header). */
const OM_ENABLED_ENV = "PI_OBSERVATIONAL_MEMORY_ENABLED";
const OM_PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";
/** The `.pi/settings.json` key observational-memory reads its config from. */
const OM_SETTINGS_KEY = "observational-memory";
const SETTINGS_FILE = "settings.json";

/** Build the observational-memory settings.json section object for an arm's OM config. */
function buildOmSettings(om: OmArmConfig, opts: WriteArmConfigOpts): Record<string, unknown> {
  const section: Record<string, unknown> = { enabled: om.enabled };
  if (om.passive) section.passive = true;
  if (om.overrideReflectionThreshold) section.reflectionThresholdTokens = opts.omFullReflectionThresholdTokens;
  return section;
}

/** Read the project `.pi/settings.json` as an object ({} when absent / unparseable). */
function readSettings(repoCwd: string): Record<string, unknown> {
  const path = join(repoCwd, ".pi", SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write the project `.pi/settings.json` (creates the `.pi/` dir). */
function writeSettings(repoCwd: string, settings: Record<string, unknown>): void {
  const piDir = join(repoCwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * Write one arm's observational-memory + memkeeper config to the sources those
 * extensions read, so a subsequent `reloadConfig()` on each proxy applies it.
 * Deterministic: always sets every managed env key (no stale override from a prior arm).
 */
export function writeArmConfig(arm: ArmId, repoCwd: string, opts: WriteArmConfigOpts): void {
  const def = ARM_DEFS[arm];

  // 1. observational-memory `.pi/settings.json` section (enabled + optional passive/threshold).
  const settings = readSettings(repoCwd);
  settings[OM_SETTINGS_KEY] = buildOmSettings(def.omConfig, opts);
  writeSettings(repoCwd, settings);

  // 2. observational-memory env — set BOTH keys explicitly (env wins, so a stale value
  //    from a prior arm would otherwise override this arm's settings.json intent).
  process.env[OM_ENABLED_ENV] = def.omConfig.enabled ? "1" : "0";
  process.env[OM_PASSIVE_ENV] = def.omConfig.passive ? "1" : "0";

  // 3. memkeeper env JSON — always set (env-first precedence; `{enabled:false}` for
  //    non-memkeeper arms clears any stale config a prior memkeeper arm left behind).
  //    The env document REPLACES the whole config (settings files never load while it
  //    is set), so the operator's global settings are merged UNDER the pins — without
  //    this, every unpinned knob would silently fall back to memkeeper's built-in
  //    defaults instead of the operator's panel values.
  process.env[MEMKEEPER_ENV] = JSON.stringify({ ...(opts.memkeeperGlobal ?? {}), ...def.memkeeperConfig });
}

/** The memkeeper settings filename convention (avtc-pi-settings-ui `settingsFilePaths`). */
const MEMKEEPER_SETTINGS_FILE = "avtc-pi-memkeeper-settings.json";

/** Read the operator's GLOBAL memkeeper settings (`<~/.pi>/agent/avtc-pi-memkeeper-settings.json`).
 *  Absent or corrupt → {} (the arms then run the pinned keys + memkeeper defaults).
 *  Global only — a project-level file would live inside the scenario repo (agent-visible). */
export function readMemkeeperGlobalSettings(globalDir: string | null): Record<string, unknown> {
  const base = globalDir ?? join(homedir(), ".pi");
  const path = join(base, "agent", MEMKEEPER_SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Teardown: remove this arm's observational-memory section + every managed env key.
 * Keeps `.pi/settings.json` when it still has other keys; removes the file when empty.
 */
export function clearArmConfig(repoCwd: string): void {
  // Teardown is symmetric — clear everything the bench manages (the writes are per-arm,
  // but the env/settings keys are global, so one clear at run end suffices).

  const settings = readSettings(repoCwd);
  if (OM_SETTINGS_KEY in settings) {
    delete settings[OM_SETTINGS_KEY];
    const remaining = Object.keys(settings);
    if (remaining.length > 0) writeSettings(repoCwd, settings);
    else rmSync(join(repoCwd, ".pi", SETTINGS_FILE), { force: true });
  }

  clearArmEnv();
}

/**
 * Env-only teardown: delete the three managed arm-config env keys (no settings
 * file, no repo needed). `clearArmConfig` writes the settings file too (needs a
 * repo); this is the half tests use to reset the shared `process.env` between
 * cases, and the half any caller without a repo can reach.
 */
export function clearArmEnv(): void {
  delete process.env[OM_ENABLED_ENV];
  delete process.env[OM_PASSIVE_ENV];
  delete process.env[MEMKEEPER_ENV];
}
