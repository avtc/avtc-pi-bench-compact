// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-1 orchestration: compact the frozen pre-compaction backup ONCE PER ARM,
// producing each arm's compacted base branch (the Phase-2 fork point).
//
// **Cross-reload auto-drive (CR-R1-1).** `switchArm` calls `ctx.reload()`, which
// INVALIDATES this ctx (runner.js invalidate — no `withSession` for reload). A loop that
// reuses the ctx across arms is therefore non-functional end-to-end (tests pass only
// because fakes do not model invalidation). The fix is the featyard auto-agent pattern:
// the phase-1 progress (which arm is next) lives on `globalThis` (survives reload — UD25),
// and a `session_start{reason:"reload"}` listener ({@link registerPhase1Driver}) checks
// that state on every reload and drives the next arm with the FRESH ctx the event carries.
// `switchArm`'s reload becomes the "advance to next arm" signal — cheap state, no
// await-across-reload bets.
//
// Per arm (one reload each): switchArm already loaded this arm's memory extension (the
// reload that fired this listener) → fork main→arm-base → checkout → loadSession(inject
// ANTI_PEEK + triggerCompact) → commit. The compaction's `usage` (every arm patched to
// emit per-stage usage; the bare-pi arm emits natively) + bench-timed `wallMs` flow into
// the run's compaction-cost record.
//
// Stop-and-surface: an arm-cancel (CompactionCancelledError) or a degenerate empty summary
// HALTS the run — the operator inspects + decides. No auto-retry, no silent skip.

import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { updateRunState } from "./run-state.js";
import { getRunState } from "./run-state.js";

/** Best-effort run-state update — the driver is always registered + may fire when run-state
 *  was cleared (e.g. post-abort). The cursor on globalThis is the source of truth; the
 *  run-state is a reflection for the widget/status, so a missing run-state is logged, not fatal. */
function reflectRunState(patch: Parameters<typeof updateRunState>[0]): void {
  if (getRunState() === null) {
    log.debug("phase-1: run-state absent, skipping reflection");
    return;
  }
  updateRunState(patch);
}

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
  /** Per-stage LLM usage from the compaction (UD32); `undefined` only if the arm emitted none. */
  usage: CompactionEntry["usage"];
}

/** Why Phase-1 halted on an arm (stop-and-surface). */
export type Phase1StopReason = "cancelled" | "empty-summary";

/** Thrown/recorded when Phase-1 must stop-and-surface. The driver notifies the operator
 *  and yields — never auto-retries. */
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
 *  implementations; tests inject fakes to keep the orchestrators pure. */
export interface Phase1Ops {
  switchArm: typeof switchArm;
  trigger: typeof triggerCompact;
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  commit: typeof commitAll;
}

export const DEFAULT_OPS: Phase1Ops = {
  switchArm,
  trigger: triggerCompact,
  loadSession,
  fork: forkBranch,
  checkout,
  commit: commitAll,
};

/** Everything {@link compactOneArm} + the driver need for one arm, EXCEPT the fresh
 *  `pi`/`ctx` (those arrive on each reload via the session_start event — the stored pi
 *  would be stale after reload). */
export interface Phase1RunDeps {
  /** The scenario repo path (holds `main` + `session.jsonl` + project files; agent cwd = repo). */
  scenarioRepo: string;
  /** Calendar date the run started (UTC YYYY-MM-DD; fixed across arms). */
  date: string;
  /** 1-based run id for `date`. */
  id: number;
  /** Pre-computed run-config fingerprint (`cfg-<hex>`) — shared across all arms of this run. */
  cfgId: string;
  /** Per-arm resolved tool versions (the bare-pi arm is absent). */
  toolVersions: Partial<Record<ArmId, ToolVersion>>;
  /** OM-full arm's threshold value (from bench config). */
  omFullReflectionThresholdTokens: number;
  /** Injectable seams (defaults = real implementations). */
  ops: Phase1Ops;
  /** Operator-attention channel (e.g. `ctx.ui.notify`). Invoked on stop-and-surface. */
  notify?: (message: string) => void;
  /** Completion hook — Phase-2 (Task 13a) wires its start here; tests resolve a deferred. */
  onDone?: (bases: ArmBase[]) => void;
}

/** The cross-reload cursor: which arm is next + accumulated bases + the run deps.
 *  Lives on `globalThis` so it survives `ctx.reload()` (UD25). */
export interface Phase1Cursor {
  /** Enabled arms in processing order. */
  arms: ArmId[];
  /** Index into `arms` of the arm to compact NEXT (the reload just loaded it). */
  nextArmIndex: number;
  /** Completed arms' compacted bases (appended as each arm finishes). */
  bases: ArmBase[];
  /** The run deps (everything except the per-reload fresh pi/ctx). */
  deps: Phase1RunDeps;
}

const CURSOR_KEY = "__benchCompactPhase1Cursor";

function readCursor(): Phase1Cursor | null {
  return ((globalThis as Record<string, unknown>)[CURSOR_KEY] as Phase1Cursor | null) ?? null;
}

function writeCursor(c: Phase1Cursor | null): void {
  const g = globalThis as Record<string, unknown>;
  if (c === null) delete g[CURSOR_KEY];
  else g[CURSOR_KEY] = c;
}

/** The active phase-1 cursor, or null when no phase-1 run is in progress. */
export function getPhase1Cursor(): Phase1Cursor | null {
  return readCursor();
}

/** Install the cursor (called by {@link startRun} before triggering the first arm). */
export function setPhase1Cursor(cursor: Phase1Cursor): void {
  writeCursor(cursor);
}

/** Clear the cursor (phase-1 done / stopped / aborted). */
export function clearPhase1Cursor(): void {
  writeCursor(null);
}

/**
 * Assemble the run-config snapshot (resolving every enabled arm's tool version; the bare-pi arm → null).
 * Pure transformation of {@link BenchConfig} + a {@link VersionResolver}. The run driver
 * calls this once to compute `cfgId` (`buildCfgId(rc)`) + persist the snapshot.
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
 * Compact ONE arm's frozen backup into its base branch. Single arm, NO `switchArm` inside
 * (the reload that loaded this arm's extension already happened — it is what fired the
 * listener calling this). Uses the FRESH `ctx` (from the session_start event) for
 * `loadSession` + the FRESH `pi` (from the driver closure) for `inject`.
 *
 * Steps: fork main→arm-base (idempotent) → checkout → loadSession(inject ANTI_PEEK +
 * triggerCompact) → commit. Throws {@link Phase1StoppedError} on arm-cancel or empty summary.
 */
export async function compactOneArm(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  arm: ArmId,
  deps: Phase1RunDeps,
): Promise<ArmBase> {
  const { ops, scenarioRepo, date, id, cfgId, toolVersions } = deps;
  const def = ARM_DEFS[arm];
  const tv = toolVersions[arm] ?? null;
  const ver = tv?.commit;
  const branch = buildArmBaseBranch({ date, id, cfgId, tool: def.tool, ver });
  const sessionPath = `${scenarioRepo}/session.jsonl`;

  // Fork main → arm-base (idempotent: re-running an arm reuses an existing base).
  if (!branchExists(scenarioRepo, branch)) {
    ops.fork(scenarioRepo, "main", branch);
  }
  ops.checkout(scenarioRepo, branch);

  // Load the frozen backup in-place + compact it. ANTI_PEEK is injected first as a
  // followUp preamble so the maintenance LLM sees it before compacting. An arm-cancel
  // (hook returned {cancel:true}) surfaces as a stop — no native fallback, no retry.
  let compactionEntry: CompactionEntry;
  let wallMs: number;
  try {
    ({ compactionEntry, wallMs } = await ops.loadSession(ctx, sessionPath, async (sessionCtx) => {
      inject(pi, ANTI_PEEK_PROMPT, "followUp");
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
  log.info(`phase-1: arm ${arm} compacted (${wallMs}ms) → ${branch}`);
  return { arm, tool: def.tool, ver, cfgId, branch, wallMs, usage: compactionEntry.usage };
}

/** Stop-and-surface: clear the cursor, mark the run-state stopped, notify the operator. */
function surfaceStop(cursor: Phase1Cursor, arm: ArmId, err: unknown): void {
  clearPhase1Cursor();
  if (err instanceof Phase1StoppedError) {
    reflectRunState({ lastStopReason: err.message });
    cursor.deps.notify?.(`bench-compact stopped (arm ${arm}): ${err.message}`);
    log.warn(`phase-1 stopped: arm ${arm} ${err.reason} — ${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  reflectRunState({ lastStopReason: `arm ${arm}: ${message}` });
  cursor.deps.notify?.(`bench-compact stopped (arm ${arm}): ${message}`);
  log.warn(`phase-1 stopped: arm ${arm} — ${message}`);
}

/**
 * The reload check: drive ONE phase-1 step with the fresh `pi`/`ctx`. Called by the
 * `session_start{reload}` listener. Reads the cursor; if no phase-1 run is active, no-op
 * (the listener is always registered — it must be safe when idle). Otherwise compacts the
 * next arm, records the base, and either triggers the next arm's isolation (switchArm →
 * reload → next listener call) or completes phase-1 (clear cursor, advance run-state,
 * fire `onDone`). Fire-and-forget `switchArm` (cursor pre-incremented) avoids deeply
 * nested re-entrancy across the reload chain. Errors stop-and-surface (never auto-retry).
 */
export async function advancePhase1(pi: ExtensionAPI, eventCtx: ExtensionContext): Promise<void> {
  const cursor = readCursor();
  if (cursor === null) return;
  const { arms, nextArmIndex, deps } = cursor;
  if (nextArmIndex >= arms.length) return;
  // The event carries the FRESH command context (structurally ExtensionCommandContext —
  // featyard casts the same way). Using the stale pre-reload ctx would throw on invalidation.
  const ctx = eventCtx as unknown as ExtensionCommandContext;
  const arm = arms[nextArmIndex];
  try {
    const base = await compactOneArm(ctx, pi, arm, deps);
    cursor.bases.push(base);
    cursor.nextArmIndex = nextArmIndex + 1;
    reflectRunState({ currentArm: arm });

    if (nextArmIndex + 1 < arms.length) {
      // Trigger the NEXT arm's isolation. switchArm writes settings + reload() → emits
      // session_start{reload} → this listener fires again with a fresh ctx for the next arm.
      // Fire-and-forget (with stop-and-surface on failure) so this call returns + the next
      // reload drives the next step, rather than nesting N arms deep.
      const nextArm = arms[nextArmIndex + 1];
      void deps.ops
        .switchArm(ctx as unknown as SwitchContext, nextArm, deps.scenarioRepo, {
          omFullReflectionThresholdTokens: deps.omFullReflectionThresholdTokens,
        })
        .catch((err) => surfaceStop(readCursor() ?? cursor, nextArm, err));
    } else {
      // Phase-1 complete: clear cursor, advance run-state, hand off to Phase-2.
      clearPhase1Cursor();
      reflectRunState({ phase: "phase-2", currentArm: null });
      log.info(`phase-1 done: ${cursor.bases.length} arm bases`);
      deps.onDone?.(cursor.bases);
    }
  } catch (err) {
    surfaceStop(cursor, arm, err);
  }
}

/**
 * Register the phase-1 driver: a `session_start` listener that advances the phase-1 run
 * on every reload. Safe when idle (no-op if no cursor / not a reload reason). Must be
 * called from `activate` so it re-registers on each reload (the post-reload fresh ctx
 * arrives only via this event).
 */
export function registerPhase1Driver(pi: ExtensionAPI): void {
  pi.on("session_start", async (event: unknown, ctx: ExtensionContext) => {
    const reason = (event as { reason?: string } | null)?.reason;
    if (reason !== "reload") return;
    await advancePhase1(pi, ctx);
  });
}

/** The trigger-context for the FIRST arm's isolation ({@link startRun} calls switchArm
 *  with the original command ctx before any reload). Re-exported type alias for clarity. */
export type { SwitchContext };

// Re-export so callers importing from phase1 catch the cancel error by type.
export { CompactionCancelledError };
