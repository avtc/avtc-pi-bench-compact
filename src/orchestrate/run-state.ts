// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run-state singleton — survives `/reload` by living on `globalThis`
// (`/reload` re-reads settings + re-discovers extensions, but does NOT reset
// globalThis, so the harness state persists across arm switches).
//
// Read by `/bench-compact:status` + the live-progress widget. Written
// by the orchestrator (Tasks 12/13a/13b) as phases advance + on stop-and-surface.

import type { ArmId } from "../config/types.js";

/** The bench pipeline phases (the run-state tracks the SAME stages the widget
 *  bar shows — compaction, evaluated-agent continuations, direct probes, scoring). */
type BenchPhase = "phase-1" | "phase-2" | "probe" | "score";

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
  /** Continuation-attempt index (1-based; null outside phase-2). */
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

const PREPARE_KEY = "__benchCompactPrepareInFlight";
const PREPARE_ABORT_KEY = "__benchCompactPrepareAbort";

function readPrepareAbort(): AbortController | null {
  return ((globalThis as Record<string, unknown>)[PREPARE_ABORT_KEY] as AbortController | null) ?? null;
}

/** Begin a prepare window atomically: set the in-flight guard AND register a fresh
 *  abort controller whose signal the prepare threads into its drive/stage seams —
 *  `/bench-compact:abort` fires it, so a live prepare actually STOPS (its own
 *  stop-and-surface path runs, and its `finally` calls {@link endPrepare}).
 *  Returns the signal to thread. Callers MUST pair with {@link endPrepare} in a
 *  `finally`. */
export function beginPrepare(): AbortSignal {
  setPrepareInFlight(true);
  const controller = new AbortController();
  (globalThis as Record<string, unknown>)[PREPARE_ABORT_KEY] = controller;
  return controller.signal;
}

/** End a prepare window: drop the abort controller + clear the in-flight guard.
 *  Called from the prepare flow's `finally` on EVERY exit path (done, stopped,
 *  thrown). */
export function endPrepare(): void {
  delete (globalThis as Record<string, unknown>)[PREPARE_ABORT_KEY];
  setPrepareInFlight(false);
}

/** The live prepare window's abort signal. Falls back to a fresh never-aborted
 *  signal when no window is open (direct programmatic deps use outside a handler). */
export function getPrepareAbortSignal(): AbortSignal {
  return readPrepareAbort()?.signal ?? new AbortController().signal;
}

/** Fire the live prepare's abort controller (registered by {@link beginPrepare})
 *  and drop the holder. Returns true if a prepare controller was fired. Does NOT
 *  clear the in-flight guard — the aborting prepare's own `finally` does that, so
 *  the concurrency window stays closed until the prepare has actually exited. */
export function abortActivePrepare(): boolean {
  const controller = readPrepareAbort();
  if (controller === null) return false;
  controller.abort();
  delete (globalThis as Record<string, unknown>)[PREPARE_ABORT_KEY];
  return true;
}

/** Mark the prepare window in-flight (the run-state is only set later, inside
 *  `startRun` — but a prepare ALSO drives the ONE main pi session for potentially
 *  hours: build drive + trial + authoring). Callers MUST clear it in a `finally`.
 *  Lives on globalThis like the run-state (survives `/reload`). */
export function setPrepareInFlight(inFlight: boolean): void {
  const g = globalThis as Record<string, unknown>;
  if (inFlight) g[PREPARE_KEY] = true;
  else delete g[PREPARE_KEY];
}

/** True while a prepare-scenario / shorthand prepare window is active. While set,
 *  NO other bench command may run (same concurrency rule as {@link isRunInFlight}
 *  — interleaved switchSessions + git would corrupt both). */
export function isPrepareInFlight(): boolean {
  return ((globalThis as Record<string, unknown>)[PREPARE_KEY] ?? false) === true;
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
