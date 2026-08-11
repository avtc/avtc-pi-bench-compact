// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBenchPi, getBenchPi, setBenchPi } from "../../src/orchestrate/bench-ctx.js";

afterEach(() => {
  clearBenchPi();
});

describe("orchestrate/bench-ctx — fresh-pi globalThis holder", () => {
  it("setBenchPi/getBenchPi round-trips the stashed pi", () => {
    const pi = { id: "fresh-pi-1" } as unknown as ExtensionAPI;
    setBenchPi(pi);
    expect(getBenchPi()).toBe(pi);
  });

  it("getBenchPi throws a clear error before any setBenchPi (activate has not run)", () => {
    clearBenchPi();
    expect(() => getBenchPi()).toThrow(/no bench pi stashed/);
  });

  it("setBenchPi overwrites the prior pi (models re-activation refreshing the handle)", () => {
    const pi1 = { id: "fresh-pi-1" } as unknown as ExtensionAPI;
    const pi2 = { id: "fresh-pi-2" } as unknown as ExtensionAPI;
    setBenchPi(pi1);
    expect(getBenchPi()).toBe(pi1);
    setBenchPi(pi2); // re-activation
    expect(getBenchPi()).toBe(pi2);
  });

  it("clearBenchPi removes the stashed pi", () => {
    setBenchPi({} as ExtensionAPI);
    clearBenchPi();
    expect(() => getBenchPi()).toThrow();
  });

  it("does not pollute globalThis after clear (the key is deleted, not just nulled)", () => {
    setBenchPi({} as ExtensionAPI);
    clearBenchPi();
    expect("__benchCompactPi" in globalThis).toBe(false);
  });
});

// Silence the unused-import lint for the vi import retained for future assertions.
void vi;
