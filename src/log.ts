// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root bench-compact logger.
 *
 * Thin wrapper over `console` for now. If richer logging (file backend,
 * rotation, levels) is needed later, swap the body for `avtc-pi-logger`
 * (add it to `pi.allowedCodeDeps` + `dependencies`); the call sites are
 * unchanged because they target this module's surface.
 */

const TAG = "[bench-compact]";
const debugOn = process.env.BENCH_COMPACT_DEBUG === "1";

export const log = {
  debug(...args: unknown[]): void {
    if (debugOn) {
      console.log(TAG, ...args);
    }
  },
  info(...args: unknown[]): void {
    console.log(TAG, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(TAG, ...args);
  },
  error(...args: unknown[]): void {
    console.error(TAG, ...args);
  },
};
