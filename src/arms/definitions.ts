// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ArmId } from "../config/types.js";

/**
 * The five compaction/memory arms under test. Every arm runs within
 * the FULL avtc-pi suite; arms differ ONLY in the compaction-memory
 * extension. {@link ARM_DEFS} is the single source of truth for each arm's tool
 * name + memory package + per-arm config knobs.
 */

// --- package identifiers ----------------------------------------------------

/** The four avtc-pi suite members active for EVERY arm. */
export const SUITE_PACKAGES = [
  "avtc-pi-todo",
  "avtc-pi-user-decisions",
  "avtc-pi-portrait",
  "avtc-pi-notification",
] as const;

/**
 * The bench harness itself. CRITICAL: the harness writes project
 * `.pi/settings.json` `packages` to isolate an arm — pi's settings deep-merge
 * treats `packages` arrays as REPLACE-not-concat (verified: settings-manager.js
 * `deepMergeObjects`), so the written list MUST include the harness or it unloads
 * ITSELF on `ctx.reload()`. Consumed by {@link buildPackages}
 * (packages.ts).
 */
export const HARNESS_PACKAGE = "avtc-pi-bench-compact";

/** The observational-memory package (the fork — used by the OM-default and OM-full arms). */
export const OM_PACKAGE = "pi-observational-memory";
/** The memkeeper package (the memkeeper-builder and memkeeper-selector arms). */
export const MEMKEEPER_PACKAGE = "avtc-pi-memkeeper";

// --- arm config shapes ------------------------------------------------------

/** The memkeeper config the bench pins for the memkeeper-builder and memkeeper-selector arms — all stages on-compaction. */
export interface MemkeeperArmConfig {
  /** `observations-root` (memkeeper-builder, Selector OFF) or `selected-root` (memkeeper-selector, Selector runs). */
  renderMode: "observations-root" | "selected-root";
  observerMode: "on-compaction";
  builderMode: "on-compaction";
  selectorMode: "on-compaction";
}

/**
 * One arm's definition. Pure data — consumed by {@link buildPackages}
 * (packages.ts) + {@link buildProjectSettings} / {@link switchArm} (switch.ts).
 */
export interface ArmDef {
  id: ArmId;
  /** Branch-name `{tool}` token: `bare-pi` · `om-default` · … */
  tool: string;
  /** The memory-extension package added to the suite (`null` for the bare-pi arm). */
  memoryPackage: string | null;
  /** The memkeeper-builder and memkeeper-selector arms: the memkeeper config written to `.pi/avtc-pi-memkeeper-settings.json`. */
  memkeeperSettings?: MemkeeperArmConfig;
  /**
   * The OM-full arm: force `reflectionThresholdTokens` low (the value is injected at
   * `buildProjectSettings` from config `omFullReflectionThresholdTokens`) so the
   * reflector/pruner ALWAYS run. The OM-default arm leaves the author threshold intact.
   */
  overrideReflectionThreshold?: true;
  /**
   * Static process-env the bench APPLIES for this arm at `switchArm` (env-only knobs with no
   * file equivalent). `switchArm` sets each `key=value` + clears stale keys from other arms —
   * this field is the single source of truth for which static env the bench manages.
   * OM `passive` (`PI_OBSERVATIONAL_MEMORY_PASSIVE=1`) is env-only (OM `readEnvConfig`); the OM-default
   * and OM-full arms need it + the forked OM (passive catch-up). (Teardown of these env vars is Task-12 orchestration.)
   */
  envPreconditions?: Readonly<Record<string, string>>;
}

/** The five arm definitions. */
export const ARM_DEFS: Record<ArmId, ArmDef> = {
  A1: {
    id: "A1",
    tool: "bare-pi",
    memoryPackage: null,
  },
  A2: {
    id: "A2",
    tool: "om-default",
    memoryPackage: OM_PACKAGE,
    envPreconditions: { PI_OBSERVATIONAL_MEMORY_PASSIVE: "1" },
  },
  A3: {
    id: "A3",
    tool: "memkeeper-builder",
    memoryPackage: MEMKEEPER_PACKAGE,
    memkeeperSettings: {
      renderMode: "observations-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    },
  },
  A4: {
    id: "A4",
    tool: "memkeeper-selector",
    memoryPackage: MEMKEEPER_PACKAGE,
    memkeeperSettings: {
      renderMode: "selected-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    },
  },
  A5: {
    id: "A5",
    tool: "om-full",
    memoryPackage: OM_PACKAGE,
    overrideReflectionThreshold: true,
    envPreconditions: { PI_OBSERVATIONAL_MEMORY_PASSIVE: "1" },
  },
};
