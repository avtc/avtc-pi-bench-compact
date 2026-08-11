// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { PackageSource } from "@earendil-works/pi-coding-agent";
import type { ArmId } from "../config/types.js";
import { ARM_DEFS, HARNESS_PACKAGE, SUITE_PACKAGES } from "./definitions.js";

/**
 * Build the exact `packages` set for one arm: the full avtc-pi suite
 * + the harness + the arm's memory extension (if any).
 *
 * The list ALWAYS includes {@link HARNESS_PACKAGE}: pi's settings deep-merge
 * treats `packages` arrays as REPLACE-not-concat (settings-manager.js
 * `deepMergeObjects`), so when {@link switchArm} writes this set to project
 * `.pi/settings.json` + `ctx.reload()`s, omitting the harness would unload the
 * bench itself mid-run (G-iso). The harness must persist across the reload.
 *
 * Pure + deterministic — safe to call per arm-switch.
 */
export function buildPackages(arm: ArmId): PackageSource[] {
  const def = ARM_DEFS[arm];
  const pkgs: PackageSource[] = [...SUITE_PACKAGES, HARNESS_PACKAGE];
  if (def.memoryPackage !== null) {
    pkgs.push(def.memoryPackage);
  }
  return pkgs;
}
