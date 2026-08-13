// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Regression (review-5 R5-2): under isolate:false, process.env is shared across
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
    process.env.PI_SETTINGS_MEMKEEPER = '{"enabled":true}';
  });

  it("test 2: sees clean env (global beforeEach cleared test 1's writes)", () => {
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeUndefined();
  });
});
