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
 *  which would silently swallow genuine crash signals.
 *
 *  Known blind spots this guard CANNOT close (verified against pi's interactive
 *  mode): pi PREPENDS its own uncaughtException handler that calls process.exit(1)
 *  synchronously inside the dispatch — later-registered listeners (ours) never
 *  run, and pi's "pi exiting due to uncaughtException:" stderr print can be lost
 *  in Windows ConPTY teardown. So the guard additionally CAPTURES stderr into a
 *  ring buffer (tee — the passthrough is faithful) and dumps it to the log on
 *  process exit, plus logs a stack at every process.exit call site. The next
 *  crash then leaves pi's own error print + the exit stack in the bench log even
 *  when the terminal shows nothing. */

import { log } from "./log.js";

/** How much trailing stderr to keep for the exit dump. pi's crash print + stack
 *  is a few KB; TUI noise before it is irrelevant. */
const STDERR_RING_CHARS = 8192;

/** Register the witnesses (idempotent — activate() re-runs per re-activation). */
export interface CrashWitnessTarget {
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  /** The exit callable to wrap with a log-only stack witness (e.g. process.exit).
   *  Optional so pure-fake tests can exercise the event witnesses alone. */
  exit?: (code?: number) => never;
  /** The stderr writable to tee into the exit dump (e.g. process.stderr).
   *  Optional so pure-fake tests can exercise the event witnesses alone. */
  stderr?: { write: (chunk: unknown, ...rest: unknown[]) => unknown };
}

/** String form of a stderr chunk (Buffer | string). */
function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

export function registerCrashWitness(target: CrashWitnessTarget = process as unknown as CrashWitnessTarget): void {
  const g = globalThis as { __benchCompactCrashWitness?: boolean };
  if (g.__benchCompactCrashWitness === true) return;
  g.__benchCompactCrashWitness = true;

  // stderr ring buffer: capture the trailing output so a crash whose terminal
  // print is lost (ConPTY teardown) still lands in the log. `feeding` stops the
  // dump's own logging from re-entering the tee.
  let ring = "";
  let feeding = true;
  if (target.stderr !== undefined) {
    const stderr = target.stderr;
    const originalWrite = stderr.write.bind(stderr);
    stderr.write = ((chunk: unknown, ...rest: never[]) => {
      if (feeding) {
        ring = (ring + chunkText(chunk)).slice(-STDERR_RING_CHARS);
      }
      return originalWrite(chunk, ...rest);
    }) as typeof stderr.write;
  }

  target.on("exit", (code: number | null | undefined) => {
    log.warn(`witness: pi process exiting (code ${code ?? 0})`);
    if (ring.length > 0) {
      feeding = false;
      log.warn(`witness: stderr tail (last ${STDERR_RING_CHARS} chars):\n${ring}`);
    }
  });

  target.on("uncaughtException", (err: unknown) => {
    log.error("witness: uncaughtException", err);
  });

  // Exit-site stack witness: log-only passthrough around process.exit so the
  // bench log records WHERE the process was killed from (pi's uncaughtCrash /
  // handleFatalRuntimeError vs a natural drain), even when nothing prints.
  if (target.exit !== undefined) {
    const originalExit = target.exit.bind(target);
    const witnessedExit = (code?: number): never => {
      log.warn(`witness: process.exit(${code ?? 0}) called at\n${new Error("witness exit stack").stack ?? ""}`);
      return originalExit(code);
    };
    target.exit = witnessedExit as typeof target.exit;
  }
}
