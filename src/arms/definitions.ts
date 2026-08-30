// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ArmId } from "../config/types.js";

/**
 * The five compaction/memory arms under test. Every arm runs within the FULL
 * avtc-pi suite with ONE shared package set (suite + harness + both memory
 * extensions loaded at startup); arms differ ONLY in the per-arm OM/session-owl
 * config knobs + the tool allowlist. {@link ARM_DEFS} is the single source of
 * truth for each arm's tool name, per-arm config, memory-tool package (for
 * version identity), and the memory recall tools exposed to the evaluated agent.
 *
 * Arm isolation is the configure-API model: the harness writes each arm's
 * OM+session-owl config to the existing config sources, calls each extension's
 * `reloadConfig()` (vendored proxies), and sets the tool allowlist via
 * `setActiveTools` — no per-arm `packages` edit, no `ctx.reload()`.
 */

// --- memory-tool package identifiers (for version identity only) ------------

/** The observational-memory package name — the om-default and om-full arms resolve
 *  their tool version from this. NOT a per-arm package set (all arms share one set). */
export const OM_PACKAGE = "pi-observational-memory";
/** The session-owl package name — the session-owl-builder and session-owl-selector arms
 *  resolve their tool version from this. NOT a per-arm package set. */
export const SESSION_OWL_PACKAGE = "avtc-pi-session-owl";

// --- per-arm config shapes --------------------------------------------------

/** The observational-memory config knobs the bench pins per OM arm. `passive`
 *  (the forked-OM catch-up fix) is the OM default for every OM arm; the fork is
 *  a hard bench dependency. `overrideReflectionThreshold` is a marker — the
 *  harness injects the actual threshold number from bench config at write time
 *  (forces the reflector/pruner to always run). */
export interface OmArmConfig {
  enabled: boolean;
  /** Present (true) when the arm runs OM in passive catch-up mode (the OM-default + OM-full arms). */
  passive?: true;
  /** Marker: inject `reflectionThresholdTokens` from bench config at write time
   *  (forces the reflector/pruner to always run). The OM-default arm omits it. */
  overrideReflectionThreshold?: true;
}

/** The session-owl config knobs the bench pins per session-owl arm. `observations-root`
 *  gates the Selector OFF (the builder's full view); `selected-root` runs the
 *  Selector (task-relative curated tree). All stages run on-compaction. */
interface SessionOwlArmConfig {
  enabled: boolean;
  /** `observations-root` (Selector OFF) or `selected-root` (Selector runs). */
  renderMode?: "observations-root" | "selected-root";
  observerMode?: "on-compaction";
  builderMode?: "on-compaction";
  selectorMode?: "on-compaction";
}

/**
 * One arm's definition. Pure data — consumed by {@link writeArmConfig}
 * (config.ts), {@link configureArm} (switch.ts), and {@link resolveToolVersion}
 * (version.ts). No per-arm `packages` array: all arms share one loaded package set.
 */
export interface ArmDef {
  id: ArmId;
  /** Branch-name `{tool}` token: `bare-pi` · `om-default` · `session-owl-builder` · `session-owl-selector` · `om-full`. */
  tool: string;
  /** Memory-tool package name for version-identity resolution (`null` for the bare-pi arm). */
  memoryPackage: string | null;
  /** The observational-memory config the harness writes for this arm. */
  omConfig: OmArmConfig;
  /** The session-owl config the harness writes for this arm. */
  sessionOwlConfig: SessionOwlArmConfig;
  /** Memory-recall tool names this arm exposes to the evaluated agent (added to the tool allowlist). */
  memoryTools: string[];
}

/** The five arm definitions. */
export const ARM_DEFS: Record<ArmId, ArmDef> = {
  A1: {
    id: "A1",
    tool: "bare-pi",
    memoryPackage: null,
    omConfig: { enabled: false },
    sessionOwlConfig: { enabled: false },
    memoryTools: [],
  },
  A2: {
    id: "A2",
    tool: "om-default",
    memoryPackage: OM_PACKAGE,
    omConfig: { enabled: true, passive: true },
    sessionOwlConfig: { enabled: false },
    memoryTools: ["recall"],
  },
  A3: {
    id: "A3",
    tool: "session-owl-builder",
    memoryPackage: SESSION_OWL_PACKAGE,
    omConfig: { enabled: false },
    sessionOwlConfig: {
      enabled: true,
      renderMode: "observations-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    },
    memoryTools: ["owl_recall"],
  },
  A4: {
    id: "A4",
    tool: "session-owl-selector",
    memoryPackage: SESSION_OWL_PACKAGE,
    omConfig: { enabled: false },
    sessionOwlConfig: {
      enabled: true,
      renderMode: "selected-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    },
    memoryTools: ["owl_recall"],
  },
  A5: {
    id: "A5",
    tool: "om-full",
    memoryPackage: OM_PACKAGE,
    omConfig: { enabled: true, passive: true, overrideReflectionThreshold: true },
    sessionOwlConfig: { enabled: false },
    memoryTools: ["recall"],
  },
};
