// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-1 orchestration: compact the frozen pre-compaction backup ONCE PER ARM,
// producing each arm's compacted base branch (the Phase-2 fork point).
//
// configure-API model: each arm is isolated in-place via
// `configureArm` — write the arm's observational-memory + memkeeper config, call
// each extension proxy's `reloadConfig()`, and set the tool allowlist. NO
// `ctx.reload()`, so the command ctx stays valid across the whole inline for-loop
// (reload would invalidate it with no `withSession`, breaking a per-arm loop). One
// process runs every arm; only the per-arm config + active tool set change.
//
// Per arm: configureArm → fork main→arm-base → checkout → loadSession(inject
// ANTI_PEEK + re-set the allowlist after the switch + triggerCompact) → commit. The
// compaction's `usage` (every arm patched to emit per-stage usage; the bare-pi arm
// emits natively) + bench-timed `wallMs` flow into the run's compaction-cost record.
//
// Stop-and-surface: an arm-cancel (CompactionCancelledError) or a degenerate empty
// summary HALTS the run — the operator inspects + decides. No auto-retry, no silent
// skip. Surfaced via {@link Phase1StoppedError}; the run driver catches + notifies.

import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ARM_DEFS } from "../arms/definitions.js";
import { BUILTIN_TOOLS, configureArm, SUITE_TOOLS } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, resolveToolVersion, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import { CompactionCancelledError, triggerCompact } from "../session/compact.js";
import { inject } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { buildArmBaseBranch, type RunConfig, type ToolVersion } from "../storage/branches.js";
import { branchExists, checkout, commitAll, forkBranch } from "../storage/repo.js";
import { getRunState, updateRunState } from "./run-state.js";

/** One arm's compacted base (Phase-1 result). Consumed by Phase-2 forking. */
export interface ArmBase {
  arm: ArmId;
  /** Branch-name `{tool}` token: `bare-pi` · `om-default` · … */
  tool: string;
  /** Short tool-version token (`g<6hex>`/`npm<ver>`); `undefined` for the bare-pi arm (omitted from branch name). */
  ver: string | undefined;
  /** The run-config fingerprint `cfg-<hex>` (shared across all arms of this run). */
  cfgId: string;
  /** The arm compacted-base branch (Phase-2 fork point). */
  branch: string;
  /** Bench-timed compaction wall-clock (ms). Carried into the compaction-cost metric (the JSONL has no duration). */
  wallMs: number;
  /** Per-stage LLM usage from the compaction; `undefined` only if the arm emitted none. */
  usage: CompactionEntry["usage"];
}

/** Why Phase-1 halted on an arm (stop-and-surface). */
export type Phase1StopReason = "cancelled" | "empty-summary";

/** Thrown/recorded when Phase-1 must stop-and-surface. The run driver catches it,
 *  records `lastStopReason`, notifies the operator, and yields — never auto-retries. */
export class Phase1StoppedError extends Error {
  readonly arm: ArmId;
  readonly reason: Phase1StopReason;
  constructor(arm: ArmId, reason: Phase1StopReason, message: string) {
    super(message);
    this.name = "Phase1StoppedError";
    this.arm = arm;
    this.reason = reason;
  }
}

/** Injectable operations — the I/O / non-deterministic seams. `configureArm` is NOT
 *  here: it is imported + always real (a pure write+reload+setActiveTools the tests
 *  exercise directly). Defaults are the real implementations; tests inject fakes. */
export interface Phase1Ops {
  trigger: typeof triggerCompact;
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  commit: typeof commitAll;
}

const DEFAULT_OPS: Phase1Ops = {
  trigger: triggerCompact,
  loadSession,
  fork: forkBranch,
  checkout,
  commit: commitAll,
};

/** Inputs to {@link runPhase1}. `cfgId` is pre-computed by the run driver
 *  ({@link buildRunConfig} + `buildCfgId`) so run-state can be set eagerly. */
export interface Phase1Deps {
  /** The extension API (carries `sendUserMessage` for inject + `setActiveTools` for the allowlist). */
  pi: ExtensionAPI;
  /** The command context (carries `switchSession`); stays valid across the whole loop (no reload). */
  cmdCtx: ExtensionCommandContext;
  /** The observational-memory config proxy (vendored subscribe-to-OM snippet). */
  omProxy: { reloadConfig(): void; getConfig(): unknown };
  /** The memkeeper config proxy (vendored subscribe-to-memkeeper snippet). */
  mkProxy: { reloadConfig(): void; getConfig(): unknown };
  /** The scenario repo path (holds `main` + `session.jsonl` + project files; agent cwd = repo). */
  scenarioRepo: string;
  /** Calendar date the run started (UTC YYYY-MM-DD; fixed across arms). */
  date: string;
  /** 1-based run id for `date`. */
  id: number;
  /** Pre-computed run-config fingerprint (`cfg-<hex>`) — shared across all arms of this run. */
  cfgId: string;
  /** Per-arm resolved tool versions (from {@link buildRunConfig}; the bare-pi arm is absent). */
  toolVersions: Partial<Record<ArmId, ToolVersion>>;
  /** OM-full arm's threshold value (from bench config). */
  omFullReflectionThresholdTokens: number;
  /** Enabled arms in processing order. */
  armsEnabled: ArmId[];
  /** Injectable seams (defaults = real implementations). */
  ops?: Partial<Phase1Ops>;
}

/**
 * Assemble the run-config snapshot (resolving every enabled arm's tool version; the bare-pi arm → null).
 * Pure transformation of {@link BenchConfig} + a {@link VersionResolver}. The run driver
 * calls this once to compute `cfgId` (`buildCfgId(rc)`) + persist the snapshot, then passes
 * `cfgId` + `rc.toolVersions` into {@link runPhase1}.
 */
export function buildRunConfig(config: BenchConfig, resolver: VersionResolver | null): RunConfig {
  const r = resolver ?? DEFAULT_VERSION_RESOLVER;
  const toolVersions: Partial<Record<ArmId, ToolVersion>> = {};
  for (const arm of config.armsEnabled) {
    const tv = resolveToolVersion(arm, r);
    if (tv) toolVersions[arm] = tv;
  }
  return {
    evaluatedModel: config.evaluatedModel,
    evaluatedThinkingLevel: config.evaluatedThinkingLevel,
    judgeModel: config.judgeModel,
    judgeThinkingLevel: config.judgeThinkingLevel,
    N: config.N,
    compactionBoundary: config.compactionBoundary,
    armsEnabled: [...config.armsEnabled],
    omFullReflectionThresholdTokens: config.omFullReflectionThresholdTokens,
    backupMode: config.backupMode,
    toolVersions,
  };
}

/**
 * Run Phase-1: compact the frozen backup once per enabled arm. Returns each arm's
 * compacted base. Throws {@link Phase1StoppedError} on arm-cancel or empty summary;
 * the caller stops + surfaces, never auto-retries.
 *
 * The run-config fingerprint (`cfgId`) + tool-version map are pre-computed by the run
 * driver ({@link buildRunConfig} + `buildCfgId`) and passed in — this function is purely
 * the per-arm configure→fork→compact→commit inline loop. The command ctx is reused
 * across every arm (configureArm does NOT reload, so the ctx never invalidates).
 */
export async function runPhase1(deps: Phase1Deps): Promise<ArmBase[]> {
  const ops = { ...DEFAULT_OPS, ...deps.ops };
  const {
    pi,
    cmdCtx,
    omProxy,
    mkProxy,
    scenarioRepo,
    date,
    id,
    cfgId,
    toolVersions,
    omFullReflectionThresholdTokens,
    armsEnabled,
  } = deps;
  const sessionPath = `${scenarioRepo}/session.jsonl`;
  log.info(`phase-1: run ${date}-${id} cfg ${cfgId} arms [${armsEnabled.join(", ")}]`);

  const bases: ArmBase[] = [];
  for (const arm of armsEnabled) {
    const def = ARM_DEFS[arm];
    const tv = toolVersions[arm] ?? null;
    const ver = tv?.commit;
    const branch = buildArmBaseBranch({ date, id, cfgId, tool: def.tool, ver });

    // Isolate the arm IN-PLACE: write OM+memkeeper config → reloadConfig ×2 → setActiveTools.
    // NO ctx.reload() — the ctx stays valid for the next arm.
    configureArm(pi, omProxy, mkProxy, arm, scenarioRepo, { omFullReflectionThresholdTokens });
    if (getRunState() !== null) updateRunState({ currentArm: arm });

    // Fork main → arm-base (idempotent: re-running an arm reuses an existing base).
    if (!branchExists(scenarioRepo, branch)) {
      ops.fork(scenarioRepo, "main", branch);
    }
    ops.checkout(scenarioRepo, branch);

    // Load the frozen backup in-place + compact it. ANTI_PEEK is injected first as a
    // followUp preamble so the maintenance LLM sees it before compacting. A session
    // switch resets the active tool set, so re-apply the arm's allowlist inside the
    // callback before the compaction. An arm-cancel surfaces as a stop — no fallback, no retry.
    let compactionEntry: CompactionEntry;
    let wallMs: number;
    try {
      ({ compactionEntry, wallMs } = await ops.loadSession(cmdCtx, sessionPath, async (sessionCtx) => {
        inject(pi, ANTI_PEEK_PROMPT, "followUp");
        pi.setActiveTools([...BUILTIN_TOOLS, ...SUITE_TOOLS, ...def.memoryTools]);
        return ops.trigger(pi, sessionCtx, {});
      }));
    } catch (err) {
      if (err instanceof CompactionCancelledError) {
        throw new Phase1StoppedError(
          arm,
          "cancelled",
          `arm ${arm} compaction was cancelled (${err.message}) — the arm produced no memory. Inspect branch ${branch} and resume or re-prepare.`,
        );
      }
      throw err;
    }

    // Stop-and-surface: degenerate empty summary = the arm produced no usable memory.
    if (compactionEntry.summary.trim().length === 0) {
      throw new Phase1StoppedError(
        arm,
        "empty-summary",
        `arm ${arm} compaction produced an empty/degenerate summary — no usable memory. Inspect branch ${branch} and resume or re-prepare.`,
      );
    }

    // Commit the compacted session.jsonl (+ any arm-specific .pi/ artifacts) to the arm base.
    ops.commit(scenarioRepo, `phase-1: compacted base for arm ${arm} (${def.tool})`);

    bases.push({ arm, tool: def.tool, ver, cfgId, branch, wallMs, usage: compactionEntry.usage });
    log.info(`phase-1: arm ${arm} compacted (${wallMs}ms) → ${branch}`);
  }

  return bases;
}

// Re-export so callers importing from phase1 catch the cancel error by type.
export { CompactionCancelledError };
