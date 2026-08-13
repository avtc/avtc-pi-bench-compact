// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run-state singleton — survives `/reload` by living on `globalThis`
// (UD25: `/reload` re-reads settings + re-discovers extensions, but does NOT
// reset globalThis, so the harness state persists across arm switches).
//
// Read by `/bench-compact:status` + the live-progress widget (Task 18). Written
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
