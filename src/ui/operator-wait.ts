// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** The stage-clock registry — the bridge between operator dialogs and the bench
 *  stages' per-LLM-call wall clock.
 *
 *  Problem this solves: an operator dialog opened from INSIDE a stage tool (the
 *  latent finalize deadlock dialog) blocks the tool for as long as the operator
 *  takes — minutes, hours, or an overnight machine sleep. The stage's per-call
 *  timer keeps running behind the dialog, fires, and the pass ends as a timeout
 *  while the operator's decision is still pending: the answer resolves a dead
 *  dialog and is silently dropped, and the stage auto-restarts authoring the
 *  operator just decided to accept.
 *
 *  Fix: every running bench stage registers its clock here while it runs, and
 *  `askOperator` pauses the ACTIVE clock for the whole time its dialog is open
 *  (including time queued behind another modal), then resumes it with a FULL
 *  fresh window (the next LLM call gets its whole budget, not the remainder of
 *  the call that preceded the dialog). Operator wait never counts against the
 *  stage's wall clock.
 *
 *  Nesting: stages run tools sequentially, and dialogs open from a stage's tool
 *  only while no inner stage is mid-run, so the innermost (last-pushed) entry is
 *  always the stage whose tool is dialog-blocking. A clock whose stage ended
 *  (unregistered) is neutralized: a dialog answered late must not re-arm a dead
 *  stage's timer. */

/** Pause/resume a stage's per-LLM-call wall clock. */
export interface StageClock {
  /** Stop the armed timer (operator wait starts — it must not consume budget). */
  pause(): void;
  /** Re-arm the timer with a full fresh window (operator wait ended). */
  resume(): void;
}

/** A registered stage's guarded clock (calls pass through only while registered). */
interface ClockEntry {
  readonly clock: StageClock;
  active: boolean;
}

/** The stack of running stages' clocks — the LAST entry is the active stage. */
const entries: ClockEntry[] = [];

/** Register a running stage's clock. Returns the unregister fn — call it when the
 *  stage ends (its clock goes dead: later pause/resume calls never reach it). */
export function pushStageClock(clock: StageClock): () => void {
  const entry: ClockEntry = { clock, active: true };
  entries.push(entry);
  return () => {
    entry.active = false;
    const i = entries.lastIndexOf(entry);
    if (i !== -1) entries.splice(i, 1);
  };
}

/** The active stage's clock (the innermost running stage), or null when no bench
 *  stage is running (a run-level dialog pauses nothing). The returned handle is
 *  safe to hold across the dialog: it is neutralized if its stage ends. */
export function activeStageClock(): StageClock | null {
  const top = entries[entries.length - 1];
  if (top === undefined) return null;
  return {
    pause: (): void => {
      if (top.active) top.clock.pause();
    },
    resume: (): void => {
      if (top.active) top.clock.resume();
    },
  };
}

/** Test/cleanup hook: drop every registration (between-suite isolation). */
export function _resetStageClocks(): void {
  for (const e of entries) e.active = false;
  entries.length = 0;
}
