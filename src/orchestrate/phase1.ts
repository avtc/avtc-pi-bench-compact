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

import type { CompactionEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearArmConfig } from "../arms/config.js";
import { ARM_DEFS } from "../arms/definitions.js";
import { getMemoryProxies } from "../arms/proxies.js";
import { ArmIsolationError, configureArm } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, resolveToolVersion, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { judgeEnsembleFields } from "../config/types.js";
import { log } from "../log.js";
import { CompactionCancelledError, triggerCompact } from "../session/compact.js";
import { inject } from "../session/inject.js";
import { loadSession } from "../session/switch.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { buildArmBaseBranch, type RunConfig, type ToolVersion } from "../storage/branches.js";
import { branchExists, checkout, commitAll, forkBranch } from "../storage/repo.js";
import type { WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL } from "../widget/tracker.js";
import { getBenchPi } from "./bench-ctx.js";
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
export type Phase1StopReason = "cancelled" | "empty-summary" | "config-failed";

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
 *  ({@link buildRunConfig} + `buildCfgId`) so run-state can be set eagerly.
 *
 *  The fresh `pi` + memory proxies are NOT passed in — `switchSession` invalidates
 *  the command-handler `pi`/ctx, so `runPhase1` reads the FRESH `pi` + proxies from
 *  `globalThis` (stashed by `activate`, refreshed on each re-activation) INSIDE each
 *  `withSession` callback (see `bench-ctx.ts`). Only the starting `cmdCtx` is passed
 *  (the first arm's `switchSession`); subsequent arms use the fresh ctx threaded
 *  from each `withSession`. */
export interface Phase1Deps {
  /** The command context that starts the inline loop (the first arm's `switchSession`).
   *  Each arm's `switchSession` invalidates the prior ctx, so `runPhase1` threads the
   *  fresh ctx from each `withSession` callback into the next arm's `switchSession`. */
  cmdCtx: ExtensionCommandContext;
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
  /** The live-progress widget (TUI-only; null/absent → no-op). */
  widget?: WidgetPort | null;
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
    ...judgeEnsembleFields(config),
    evaluatedModel: config.evaluatedModel,
    evaluatedThinkingLevel: config.evaluatedThinkingLevel,
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
 * compacted base. Throws {@link Phase1StoppedError} on arm-cancel, empty summary, or
 * config-failure; the caller stops + surfaces, never auto-retries.
 *
 * The fresh `pi` + memory proxies are read from `globalThis` INSIDE each `withSession`
 * callback — `switchSession` invalidates the command-handler `pi`/ctx, but its
 * `createRuntime` RE-ACTIVATES the extension (`activate(freshPi)` runs again, stashing
 * the fresh `pi` + proxies via `bench-ctx.ts`/`proxies.ts`). The fresh command ctx from
 * each `withSession` is threaded into the next arm's `switchSession` (switchSession
 * invalidates the ctx it's called on, the same way `reload` does).
 */
export async function runPhase1(deps: Phase1Deps): Promise<Phase1Result> {
  const ops = { ...DEFAULT_OPS, ...deps.ops };
  const { cmdCtx, scenarioRepo, date, id, cfgId, toolVersions, omFullReflectionThresholdTokens, armsEnabled } = deps;
  const sessionPath = `${scenarioRepo}/session.jsonl`;
  log.info(`phase-1: run ${date}-${id} cfg ${cfgId} arms [${armsEnabled.join(", ")}]`);

  // Thread the command ctx: each arm's switchSession invalidates the ctx it's called
  // on, so the next arm must use the FRESH ctx threaded from this arm's withSession.
  let currentCtx: ExtensionCommandContext = cmdCtx;
  const bases: ArmBase[] = [];
  try {
    for (const arm of armsEnabled) {
      const def = ARM_DEFS[arm];
      deps.widget?.setArm(armsEnabled.indexOf(arm) + 1, armsEnabled.length, def.tool);
      deps.widget?.setDetail(NO_DETAIL);
      const tv = toolVersions[arm] ?? null;
      const ver = tv?.commit;
      const branch = buildArmBaseBranch({ date, id, cfgId, tool: def.tool, ver });

      // Fork main → arm-base (idempotent: re-running an arm reuses an existing base).
      if (!branchExists(scenarioRepo, branch)) {
        ops.fork(scenarioRepo, "main", branch);
      }
      ops.checkout(scenarioRepo, branch);
      if (getRunState() !== null) updateRunState({ currentArm: arm });

      // Load the frozen backup in-place + compact it. switchSession RE-ACTIVATES the
      // extension (fresh pi + proxies stashed in globalThis by activate) AND invalidates
      // the prior ctx — so ALL per-arm work runs INSIDE withSession using the fresh
      // pi/proxies (read from globalThis) + the fresh ctx (the withSession arg). The
      // fresh ctx is threaded into currentCtx for the next arm's switchSession.
      // ANTI_PEEK is injected first as a followUp preamble so the maintenance LLM sees
      // it before compacting. An arm-cancel / config-failure surfaces as a stop — no
      // fallback, no retry.
      let compactionEntry: CompactionEntry;
      let wallMs: number;
      try {
        ({ compactionEntry, wallMs } = await ops.loadSession(currentCtx, sessionPath, async (sessionCtx) => {
          currentCtx = sessionCtx;
          const pi = getBenchPi();
          const proxies = getMemoryProxies();
          if (proxies === null) {
            throw new Phase1StoppedError(
              arm,
              "config-failed",
              `arm ${arm}: bench-compact activate has not cached the memory proxies — ensure the extension is active.`,
            );
          }
          // Isolate the arm IN-PLACE: write OM+memkeeper config → reloadConfig ×2 (fresh
          // proxies) → setActiveTools (fresh pi). NO ctx.reload().
          configureArm(pi, proxies.om, proxies.mk, arm, scenarioRepo, { omFullReflectionThresholdTokens });
          inject(pi, ANTI_PEEK_PROMPT, "followUp");
          return ops.trigger(pi, sessionCtx, {});
        }));
      } catch (err) {
        if (err instanceof Phase1StoppedError) throw err;
        if (err instanceof CompactionCancelledError) {
          throw new Phase1StoppedError(
            arm,
            "cancelled",
            `arm ${arm} compaction was cancelled (${err.message}) — the arm produced no memory. Inspect branch ${branch} and resume or re-prepare.`,
          );
        }
        if (err instanceof ArmIsolationError) {
          throw new Phase1StoppedError(
            arm,
            "config-failed",
            `arm ${arm} ${err.provider} is enabled but its extension proxy is not live (not loaded, or older than the reloadConfig bridge). Stop and ensure ${
              err.provider === "observational-memory" ? "pi-observational-memory" : "avtc-pi-memkeeper"
            } is in the loaded packages.`,
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

    return { bases, finalCtx: currentCtx };
  } finally {
    // Tear down the per-arm env (no leak into the post-bench session / next run).
    clearArmConfig(scenarioRepo);
  }
}

/** {@link runPhase1} result: the arm bases + the FINAL fresh command ctx (threaded through
 * the last arm's `withSession`). The run driver threads `finalCtx` into Phase-2 so the
 * first continuation's `switchSession` doesn't throw "stale after session replacement"
 * (Phase-1's first arm already invalidated the original `cmdCtx`). */
export interface Phase1Result {
  readonly bases: ArmBase[];
  readonly finalCtx: ExtensionCommandContext;
}

// Re-export so callers importing from phase1 catch the cancel error by type.
export { CompactionCancelledError };
