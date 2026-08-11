// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-1 orchestration: compact the frozen pre-compaction backup ONCE PER ARM,
// producing each arm's compacted base branch (the Phase-2 fork point).
//
// Per enabled arm (§3.1, §3.5): switchArm (isolate) → fork main→arm-base →
// checkout arm-base → loadSession(inject ANTI_PEEK + triggerCompact) → commit.
// The compaction's `usage` (UD32: every arm patched to emit per-stage usage; A1
// native) + bench-timed `wallMs` flow into the run's C4 cost record.
//
// Stop-and-surface (§3.8): an arm-cancel (CompactionCancelledError) or a
// degenerate empty summary HALTS the run — the operator inspects + decides. No
// auto-retry, no silent skip. Surfaced via {@link Phase1StoppedError}.

import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ARM_DEFS } from "../arms/definitions.js";
import { type SwitchContext, switchArm } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, resolveToolVersion, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import { CompactionCancelledError, triggerCompact } from "../session/compact.js";
import { inject } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { buildArmBaseBranch, type RunConfig, type ToolVersion } from "../storage/branches.js";
import { branchExists, checkout, commitAll, forkBranch } from "../storage/repo.js";

/** One arm's compacted base (Phase-1 result). Consumed by Phase-2 forking (Task 13a). */
export interface ArmBase {
  arm: ArmId;
  /** Branch-name `{tool}` token (§3.14): `bare-pi` · `om-default` · … */
  tool: string;
  /** Short tool-version token (`g<6hex>`/`npm<ver>`); `undefined` for A1 (omitted from branch name). */
  ver: string | undefined;
  /** The run-config fingerprint `cfg-<hex>` (shared across all arms of this run). */
  cfgId: string;
  /** The arm compacted-base branch (Phase-2 fork point). */
  branch: string;
  /** Bench-timed compaction wall-clock (ms). Carried into C4 (the JSONL has no duration). */
  wallMs: number;
  /** Per-stage LLM usage from the compaction (UD32); `undefined` only if the arm emitted none. */
  usage: CompactionEntry["usage"];
}

/** Why Phase-1 halted on an arm (§3.8 stop-and-surface). */
export type Phase1StopReason = "cancelled" | "empty-summary";

/** Thrown when Phase-1 must stop-and-surface. The run driver (Task 12c) catches it,
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

/** Injectable operations — the I/O / non-deterministic seams. Defaults are the real
 *  implementations; tests inject fakes to keep {@link runPhase1} a pure orchestrator. */
export interface Phase1Ops {
  switchArm: typeof switchArm;
  trigger: typeof triggerCompact;
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  commit: typeof commitAll;
}

const DEFAULT_OPS: Phase1Ops = {
  switchArm,
  trigger: triggerCompact,
  loadSession,
  fork: forkBranch,
  checkout,
  commit: commitAll,
};

/** Inputs to {@link runPhase1}. `cfgId` is pre-computed by the run driver
 *  ({@link buildRunConfig} + `buildCfgId`) so run-state can be set eagerly. */
export interface Phase1Deps {
  pi: ExtensionAPI;
  cmdCtx: ExtensionCommandContext;
  switchCtx: SwitchContext;
  config: BenchConfig;
  /** The scenario repo path (holds `main` + `session.jsonl` + project files; agent cwd = repo). */
  scenarioRepo: string;
  /** Calendar date the run started (UTC YYYY-MM-DD; fixed across arms). */
  date: string;
  /** 1-based run id for `date`. */
  id: number;
  /** Pre-computed run-config fingerprint (`cfg-<hex>`) — shared across all arms of this run. */
  cfgId: string;
  /** Per-arm resolved tool versions (from {@link buildRunConfig}; A1 absent). */
  toolVersions: Partial<Record<ArmId, ToolVersion>>;
  /** Injectable seams (defaults = real implementations). */
  ops?: Partial<Phase1Ops>;
}

/**
 * Assemble the run-config snapshot (resolving every enabled arm's tool version; A1 → null).
 * Pure transformation of {@link BenchConfig} + a {@link VersionResolver}. The run driver
 * calls this once to compute `cfgId` (`buildCfgId(rc)`) + persist the snapshot, then passes
 * `cfgId` + `rc.toolVersions` into {@link runPhase1}.
 */
export function buildRunConfig(config: BenchConfig, resolver: VersionResolver = DEFAULT_VERSION_RESOLVER): RunConfig {
  const toolVersions: Partial<Record<ArmId, ToolVersion>> = {};
  for (const arm of config.armsEnabled) {
    const tv = resolveToolVersion(arm, resolver);
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
 * compacted base. Throws {@link Phase1StoppedError} on arm-cancel or empty summary
 * (§3.8 — the caller stops + surfaces, never auto-retries).
 *
 * The run-config fingerprint (`cfgId`) + tool-version map are pre-computed by the run
 * driver ({@link buildRunConfig} + `buildCfgId`) and passed in — this function is purely
 * the per-arm isolate→fork→compact→commit loop.
 */
export async function runPhase1(deps: Phase1Deps): Promise<ArmBase[]> {
  const ops = { ...DEFAULT_OPS, ...deps.ops };
  const { config, scenarioRepo, date, id, cfgId, toolVersions } = deps;
  const sessionPath = `${scenarioRepo}/session.jsonl`;
  log.info(`phase-1: run ${date}-${id} cfg ${cfgId} arms [${config.armsEnabled.join(", ")}]`);

  // Per arm: isolate → fork → checkout → compact → commit.
  const bases: ArmBase[] = [];
  for (const arm of config.armsEnabled) {
    const def = ARM_DEFS[arm];
    const tv = toolVersions[arm] ?? null;
    const ver = tv?.commit;
    const branch = buildArmBaseBranch({ date, id, cfgId, tool: def.tool, ver });

    // Fork main → arm-base (idempotent: re-running an arm reuses an existing base).
    if (!branchExists(scenarioRepo, branch)) {
      ops.fork(scenarioRepo, "main", branch);
    }
    ops.checkout(scenarioRepo, branch);

    // Isolate the arm (writes .pi/settings.json + env, then reloads extensions).
    await ops.switchArm(deps.switchCtx, arm, scenarioRepo, {
      omFullReflectionThresholdTokens: config.omFullReflectionThresholdTokens,
    });

    // Load the frozen backup in-place + compact it. ANTI_PEEK is injected first as a
    // followUp preamble so the maintenance LLM sees it before compacting. An arm-cancel
    // (hook returned {cancel:true}) surfaces as a stop — no native fallback, no retry.
    let compactionEntry: CompactionEntry;
    let wallMs: number;
    try {
      ({ compactionEntry, wallMs } = await ops.loadSession(deps.cmdCtx, sessionPath, async (sessionCtx) => {
        inject(deps.pi, ANTI_PEEK_PROMPT, "followUp");
        return ops.trigger(deps.pi, sessionCtx);
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
