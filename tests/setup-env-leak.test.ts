// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Regression (review-5): under isolate:false, process.env is shared across
// every test file in one worker. The global beforeEach (tests/setup.ts →
// clearArmEnv) must clear the three managed arm-config env keys between EVERY
// test so no file inherits another's configureArm → writeArmConfig writes.
//
// This file deliberately has NO env-cleanup afterEach — only the global
// beforeEach stands between the two tests. If it ever stops clearing, test 2
// sees test 1's leaked values and fails.

import { describe, expect, it } from "vitest";

describe("arm-env leak guard (global beforeEach clears configureArm env between tests)", () => {
  it("test 1: writes the three managed arm-config env keys", () => {
    process.env.PI_OBSERVATIONAL_MEMORY_ENABLED = "1";
    process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
    process.env.PI_SETTINGS_SESSION_OWL = '{"enabled":true}';
  });

  it("test 2: sees clean env (global beforeEach cleared test 1's writes)", () => {
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
    expect(process.env.PI_SETTINGS_SESSION_OWL).toBeUndefined();
  });
});

describe("globalThis bench-slot leak guard (global beforeEach clears every __benchCompact* slot)", () => {
  it("test 1: writes all seven bench globalThis slots", () => {
    const g = globalThis as Record<string, unknown>;
    g.__benchCompactRunState = { stale: true };
    g.__benchCompactMemoryProxies = { stale: true };
    g.__benchCompactActiveWidget = { stale: true };
    g.__benchCompactPrepareInFlight = true;
    g.__benchCompactPrepareAbort = new AbortController();
    g.__benchCompactPi = { stale: true };
    g.__benchCompactRunAbort = new AbortController();
  });

  it("test 2: sees every slot cleared (no cross-file singleton leaks under isolate:false)", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g.__benchCompactRunState).toBeUndefined();
    expect(g.__benchCompactMemoryProxies).toBeUndefined();
    expect(g.__benchCompactActiveWidget).toBeUndefined();
    expect(g.__benchCompactPrepareInFlight).toBeUndefined();
    expect(g.__benchCompactPrepareAbort).toBeUndefined();
    expect(g.__benchCompactPi).toBeUndefined();
    expect(g.__benchCompactRunAbort).toBeUndefined();
  });
});
