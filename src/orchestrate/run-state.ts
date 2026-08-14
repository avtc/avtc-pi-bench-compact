// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run-state singleton — survives `/reload` by living on `globalThis`
// (UD25: `/reload` re-reads settings + re-discovers extensions, but does NOT
// reset globalThis, so the harness state persists across arm switches).
//
// Read by `/bench-compact:status` + the live-progress widget. Written
// by the orchestrator (Tasks 12/13a/13b) as phases advance + on stop-and-surface.

import type { ArmId } from "../config/types.js";

/** The bench pipeline phases. */
type BenchPhase = "phase-1" | "phase-2" | "phase-3";

/** The harness run-state. One active run per process (TUI-primary). */
export interface BenchRunState {
  /** `<date>-<id>` (e.g. `2026-08-11-1`). */
  runId: string;
  /** Calendar date the run started (UTC YYYY-MM-DD; fixed across arms/attempts). */
  date: string;
  /** 1-based, incremented per run started on `date`. */
  id: number;
  /** Run-config fingerprint `cfg-<hex>`. */
  cfgId: string;
  /** The scenario repo path (holds `main` + per-arm branches). */
  scenarioRepo: string;
  /** Current phase (null between runs). */
  phase: BenchPhase;
  /** The arm currently being processed (null between arms). */
  currentArm: ArmId | null;
  /** Phase-2 attempt index (1-based; null outside phase-2). */
  currentAttempt: number | null;
  /** Set on stop-and-surface — surfaces the reason to the operator. */
  lastStopReason: string | null;
}

const GLOBAL_KEY = "__benchCompactRunState";

/** Sentinel for "clear the run-state" (named so the call site reads as intent,
 *  not an opaque null). */
const CLEARED: BenchRunState | null = null;

function readGlobal(): BenchRunState | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as BenchRunState | null) ?? null;
}

function writeGlobal(s: BenchRunState | null): void {
  const g = globalThis as Record<string, unknown>;
  if (s === null) delete g[GLOBAL_KEY];
  else g[GLOBAL_KEY] = s;
}

/** The active run-state, or null when no run is active. */
export function getRunState(): BenchRunState | null {
  return readGlobal();
}

/** Persist a fresh run-state (overwrites any prior). */
export function setRunState(state: BenchRunState): void {
  writeGlobal(state);
}

/** Patch fields of the active run-state. Throws if no run is active (no silent no-op —
 *  a stale write would mislead the operator). */
export function updateRunState(patch: Partial<BenchRunState>): void {
  const current = readGlobal();
  if (current === null) throw new Error("updateRunState: no active bench run to update");
  writeGlobal({ ...current, ...patch });
}

/** Clear the run-state (run finished or aborted). */
export function clearRunState(): void {
  writeGlobal(CLEARED);
}

// --- cooperative-abort holder ------------------------------------------------
// The active run's AbortController, stashed on globalThis so `/bench-compact:abort`
// (a separate command invocation) can fire it. The run's phases thread the controller's
// signal into `awaitSettled({ signal })`, so firing it short-circuits the live loops.
// Kept on a SEPARATE global key from BenchRunState (which is pure data).
const ABORT_KEY = "__benchCompactRunAbort";

function readAbort(): AbortController | null {
  return ((globalThis as Record<string, unknown>)[ABORT_KEY] as AbortController | null) ?? null;
}

/** Register the active run's abort controller (null to clear). */
export function setActiveRunAbort(controller: AbortController | null): void {
  const g = globalThis as Record<string, unknown>;
  if (controller === null) delete g[ABORT_KEY];
  else g[ABORT_KEY] = controller;
}

/** Named null for {@link setActiveRunAbort} — clearing the active run abort holder. */
export const NO_RUN_ABORT: null = null;

/** Fire the active run's abort controller + clear the holder.
 *  Returns true if a run was active (controller fired), false if no run to abort. */
export function abortActiveRun(): boolean {
  const controller = readAbort();
  if (controller === null) return false;
  controller.abort();
  setActiveRunAbort(NO_RUN_ABORT);
  return true;
}

/** True when a bench run is in-flight (state set + not yet stopped). While a run is
 *  in-flight, NO other bench command may drive the main pi session — prepare AND run
 *  phases all switchSession the ONE main session (plus git on the shared scenario
 *  repo), so a concurrent command would corrupt both. Stopped/done/crashed runs are
 *  NOT in-flight (done clears the state; stop + unexpected-error paths record
 *  `lastStopReason`), so a follow-up run is allowed. */
export function isRunInFlight(): boolean {
  const s = readGlobal();
  return s !== null && s.lastStopReason === null;
}

/** A one-line status for `/bench-compact:status` + the widget. */
export function statusString(): string {
  const s = readGlobal();
  if (s === null) return "idle";
  const parts: string[] = [s.phase];
  if (s.currentArm !== null) parts.push(s.currentArm);
  if (s.currentAttempt !== null) parts.push(`attempt ${s.currentAttempt}`);
  if (s.lastStopReason !== null) {
    parts.unshift("stopped");
    return `${parts.join(" · ")} — ${s.lastStopReason}`;
  }
  return parts.join(" · ");
}
