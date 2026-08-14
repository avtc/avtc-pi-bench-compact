// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global test setup, registered via `setupFiles` in vitest.config.ts.
 *
 * The suite runs with `isolate: false` for speed, which shares ONE module
 * registry across every test file. That turns module singletons into
 * cross-test leak vectors — so they are reset here centrally, mirroring the
 * sibling-repo setupFiles pattern (avtc-pi-memkeeper / avtc-pi-portrait).
 *
 * No bench test uses `vi.mock` on a shared src module (all dependency-inject
 * their fakes via deps objects), so — unlike memkeeper — there is no centralized
 * vi.mock/stub-flag layer here. Only the singletons + the run-state globalThis
 * slot are reset.
 */

import { afterAll, beforeEach } from "vitest";
import { clearArmEnv } from "../src/arms/config.js";
import { _setHandleForTest } from "../src/config/accessor.js";
import { _setRegisterSettingsCommand } from "../src/config/schema.js";
import { _setBaseLoggerForTest } from "../src/log.js";

// Tests must NEVER write to the real production log file (~/.pi/logs/...). The
// real avtc-pi-logger is created at log.ts module load (shared under
// isolate:false), so redirect it to a no-op sink here.
const NO_OP_LOG_SINK = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
_setBaseLoggerForTest(NO_OP_LOG_SINK);

// These singletons live on globalThis (survive /reload in production; under
// isolate:false they survive across test files too). Clear them before each test
// so no test sees another's singleton state.
const GLOBAL_KEYS = [
  "__benchCompactRunState",
  "__benchCompactMemoryProxies",
  // the active-widget slot: widget tests install capturing widgets; a leaked one
  // silently wires into any later getActiveWidget() reader (live-seams default deps)
  "__benchCompactActiveWidget",
  // the prepare-in-flight guard: prepare tests set it in try/finally, but the
  // beforeEach clear makes the invariant structural instead of per-test discipline
  "__benchCompactPrepareInFlight",
  // the prepare window's abort controller (fired by /bench-compact:abort)
  "__benchCompactPrepareAbort",
  // the stashed fresh ExtensionAPI read by getBenchPi (live-seams getPi seam)
  "__benchCompactPi",
  // the active run's AbortController (fired by abortActiveRun)
  "__benchCompactRunAbort",
] as const;

// Cleared before EACH test: a test that writes one (via writeGlobal) must never
// bleed into the next, and every test starts from a known-empty slot.
beforeEach(() => {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  // configureArm (writeArmConfig) sets three managed env keys; under isolate:false
  // they persist across test files (the same cross-file hazard the globalThis
  // resets above address). Clear them centrally so no test inherits another's arm
  // config — e.g. arms/config.test.ts (asserts these undefined) is order-safe.
  clearArmEnv();
});

// Reset the config/settings singletons at the FILE boundary — the isolate:false
// leak boundary (mirrors avtc-pi-memkeeper/tests/setup.ts, which resets in
// afterAll). Resetting per-test (afterEach) would clash with files that install
// a fake for the whole file in beforeAll (tests/smoke.test.ts installs a fake
// registerSettingsCommand in beforeAll and asserts against it across all tests).
// Every file that swaps a singleton already self-clears it (accessor.test.ts and
// commands/index.test.ts clear the handle in their own afterEach; smoke.test.ts
// in afterAll), so this afterAll only guards the cross-FILE leak.
afterAll(() => {
  _setHandleForTest(null);
  _setRegisterSettingsCommand(null);
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});
