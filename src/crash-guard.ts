// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** The bench's crash black box. pi can exit silently (emergencyTerminalExit on a
 *  failed terminal write — exit 129, zero output; observed live during an arm
 *  compaction), and uncaught exceptions print only to the console — which the
 *  operator may miss and we can never read back. These witnesses persist the
 *  moment of death to the bench log file BEFORE the process goes, so any future
 *  silent exit leaves a forensic record with zero operator setup.
 *
 *  Semantics preserved: the uncaughtException witness only LOGS — pi's own
 *  uncaughtCrash handler (registered separately) still prints and exits; a
 *  registered handler does not remove pi's. `unhandledRejection` is deliberately
 *  NOT registered — Node suppresses the default crash for ANY registered handler,
 *  which would silently swallow genuine crash signals. */

import { log } from "./log.js";

/** Register the witnesses (idempotent — activate() re-runs per re-activation). */
export interface CrashWitnessTarget {
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

export function registerCrashWitness(target: CrashWitnessTarget = process): void {
  const g = globalThis as { __benchCompactCrashWitness?: boolean };
  if (g.__benchCompactCrashWitness === true) return;
  g.__benchCompactCrashWitness = true;

  target.on("exit", (code: number | null | undefined) => {
    log.warn(`witness: pi process exiting (code ${code ?? 0})`);
  });

  target.on("uncaughtException", (err: unknown) => {
    log.error("witness: uncaughtException", err);
  });
}
