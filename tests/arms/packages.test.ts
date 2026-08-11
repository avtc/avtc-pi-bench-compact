// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { HARNESS_PACKAGE, MEMKEEPER_PACKAGE, OM_PACKAGE, SUITE_PACKAGES } from "../../src/arms/definitions.js";
import { buildPackages } from "../../src/arms/packages.js";
import { ARM_IDS } from "../../src/config/types.js";

describe("arms/packages — buildPackages", () => {
  it("returns PackageSource[] (plain string sources)", () => {
    const pkgs = buildPackages("A1");
    for (const p of pkgs) expect(typeof p).toBe("string");
  });

  it("ALWAYS includes the harness (project packages REPLACE global — harness must survive reload)", () => {
    for (const arm of ARM_IDS) {
      expect(buildPackages(arm)).toContain(HARNESS_PACKAGE);
    }
  });

  it("ALWAYS includes the full suite (§2.1)", () => {
    for (const arm of ARM_IDS) {
      const pkgs = buildPackages(arm);
      for (const s of SUITE_PACKAGES) expect(pkgs).toContain(s);
    }
  });

  it("A1 = suite + harness, NO memory extension", () => {
    const pkgs = buildPackages("A1");
    expect(pkgs).not.toContain(OM_PACKAGE);
    expect(pkgs).not.toContain(MEMKEEPER_PACKAGE);
    // exactly suite + harness
    expect(pkgs).toHaveLength(SUITE_PACKAGES.length + 1);
  });

  it("A2 / A5 add OM (and only OM) on top of suite + harness", () => {
    for (const arm of ["A2", "A5"] as const) {
      const pkgs = buildPackages(arm);
      expect(pkgs).toContain(OM_PACKAGE);
      expect(pkgs).not.toContain(MEMKEEPER_PACKAGE);
      expect(pkgs).toHaveLength(SUITE_PACKAGES.length + 2); // suite + harness + OM
    }
  });

  it("A3 / A4 add memkeeper (and only memkeeper) on top of suite + harness", () => {
    for (const arm of ["A3", "A4"] as const) {
      const pkgs = buildPackages(arm);
      expect(pkgs).toContain(MEMKEEPER_PACKAGE);
      expect(pkgs).not.toContain(OM_PACKAGE);
      expect(pkgs).toHaveLength(SUITE_PACKAGES.length + 2); // suite + harness + memkeeper
    }
  });

  it("exactly one memory extension per non-A1 arm, zero for A1", () => {
    for (const arm of ARM_IDS) {
      const pkgs = buildPackages(arm);
      const memCount = pkgs.filter((p) => p === OM_PACKAGE || p === MEMKEEPER_PACKAGE).length;
      expect(memCount).toBe(arm === "A1" ? 0 : 1);
    }
  });

  it("no duplicate packages for any arm", () => {
    for (const arm of ARM_IDS) {
      const pkgs = buildPackages(arm) as string[];
      expect(new Set(pkgs).size).toBe(pkgs.length);
    }
  });

  it("is pure / deterministic (same arm → same array content)", () => {
    const a = buildPackages("A3") as PackageSource[];
    const b = buildPackages("A3") as PackageSource[];
    expect(a).toEqual(b);
  });
});
