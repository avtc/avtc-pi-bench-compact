// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root bench-compact logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library — the convention every
 * avtc-pi sibling follows (memkeeper/subagent/portrait/user-decisions). The
 * implementation (file backend, rotation, retention, level formatting) lives in
 * the library; this module only owns the bench-compact singleton + the debug gate.
 *
 * Logs land at `~/.pi/logs/avtc-pi-bench-compact/<YYYY-MM-DD>.log` (date-partitioned,
 * size roll-over + age-based retention — all handled by the library). Best-effort:
 * a logging failure never throws to the host. This file backend is load-bearing for
 * the design's stop-and-surface model (the operator inspects logs when a run
 * stops on failure); pi's Ink-based TUI does not surface `console.*` output, so a
 * console logger would silently drop every diagnostic.
 *
 * `debug` honors the `BENCH_COMPACT_DEBUG` env var (Task 2 may swap this for a live
 * settings gate like memkeeper's `debugLog`); `info`/`warn`/`error` always write.
 */

import { createLogger } from "avtc-pi-logger";

/** Library logger created with debug-level enabled; this module gates `.debug`. */
const baseLogger = createLogger("avtc-pi-bench-compact", { debug: true });

/** The methods this wrapper actually uses. */
export type LogSink = Pick<typeof baseLogger, "info" | "warn" | "error" | "debug">;

// `current` lets a test seam redirect calls (assert delegation without writing to
// the real log file); defaults to the real baseLogger.
let current: LogSink = baseLogger;

/** Test-only: swap the underlying logger sink (pass `null` to restore the real
 *  one). Returns the previous sink so a test can restore it. */
export function _setBaseLoggerForTest(replacement: LogSink | null): LogSink {
  const prev = current;
  current = replacement ?? baseLogger;
  return prev;
}

const debugOn = process.env.BENCH_COMPACT_DEBUG === "1";

/** Root bench-compact logger. `debug` is gated by `BENCH_COMPACT_DEBUG`. */
export const log = {
  info: (msg: string) => current.info(msg),
  warn: (msg: string) => current.warn(msg),
  error: (msg: string, err?: unknown) => current.error(msg, err ?? null),
  debug: (msg: string) => {
    if (debugOn) {
      current.debug(msg);
    }
  },
};
