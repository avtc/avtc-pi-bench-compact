// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ArmId } from "../config/types.js";

/**
 * The five compaction/memory arms under test (§2.1–2.5). Every arm runs within
 * the FULL avtc-pi suite (§2.1); arms differ ONLY in the compaction-memory
 * extension. {@link ARM_DEFS} is the single source of truth for each arm's tool
 * name + memory package + per-arm config knobs.
 */

// --- package identifiers ----------------------------------------------------

/** The four avtc-pi suite members active for EVERY arm (§2.1). */
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
 * ITSELF on `ctx.reload()` (G-iso, §2.4). Consumed by {@link buildPackages}
 * (packages.ts).
 */
export const HARNESS_PACKAGE = "avtc-pi-bench-compact";

/** The observational-memory package (the fork — A2/A5). */
export const OM_PACKAGE = "pi-observational-memory";
/** The memkeeper package (A3/A4). */
export const MEMKEEPER_PACKAGE = "avtc-pi-memkeeper";

// --- arm config shapes ------------------------------------------------------

/** The memkeeper config the bench pins per arm (§2.5 A3/A4) — all stages on-compaction. */
export interface MemkeeperArmConfig {
  /** `observations-root` (A3, Selector OFF) or `selected-root` (A4, Selector runs). */
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
  /** Branch-name `{tool}` token (§3.14): `bare-pi` · `om-default` · … */
  tool: string;
  /** The memory-extension package added to the suite (`null` for A1). */
  memoryPackage: string | null;
  /** A3/A4: the memkeeper config written to `.pi/avtc-pi-memkeeper-settings.json`. */
  memkeeperSettings?: MemkeeperArmConfig;
  /**
   * A5: force `reflectionThresholdTokens` low (the value is injected at
   * `buildProjectSettings` from config `omFullReflectionThresholdTokens`) so the
   * reflector/pruner ALWAYS run. A2 OM-default leaves the author threshold intact.
   */
  overrideReflectionThreshold?: true;
  /**
   * Doc-only: env the OPERATOR must set globally (the harness does not manage
   * process env). OM `passive` is env-only (`PI_OBSERVATIONAL_MEMORY_PASSIVE`) —
   * a precondition for A2/A5 (the forked OM fixes upstream passive-no-catch-up).
   */
  envPreconditions?: Readonly<Record<string, string>>;
}

/** The five arm definitions (§2.1). */
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
