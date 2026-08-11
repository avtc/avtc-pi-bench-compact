// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  ARM_DEFS,
  HARNESS_PACKAGE,
  MEMKEEPER_PACKAGE,
  OM_PACKAGE,
  SUITE_PACKAGES,
} from "../../src/arms/definitions.js";
import { ARM_IDS, ARM_LABELS, type ArmId } from "../../src/config/types.js";

describe("arms/definitions — constants", () => {
  it("SUITE_PACKAGES = the four avtc-pi suite members (§2.1)", () => {
    expect([...SUITE_PACKAGES]).toEqual([
      "avtc-pi-todo",
      "avtc-pi-user-decisions",
      "avtc-pi-portrait",
      "avtc-pi-notification",
    ]);
  });

  it("HARNESS_PACKAGE is the bench itself", () => {
    expect(HARNESS_PACKAGE).toBe("avtc-pi-bench-compact");
  });

  it("OM_PACKAGE + MEMKEEPER_PACKAGE name the two memory tools under test", () => {
    expect(OM_PACKAGE).toBe("pi-observational-memory");
    expect(MEMKEEPER_PACKAGE).toBe("avtc-pi-memkeeper");
  });
});

describe("arms/definitions — ARM_DEFS covers all five arms", () => {
  it("has a definition for every ArmId and nothing else", () => {
    expect(Object.keys(ARM_DEFS).sort()).toEqual([...ARM_IDS].sort());
  });
});

describe("arms/definitions — per-arm spec (§2.1–2.5)", () => {
  const arms: [ArmId, string][] = [
    ["A1", "bare-pi"],
    ["A2", "om-default"],
    ["A3", "memkeeper-builder"],
    ["A4", "memkeeper-selector"],
    ["A5", "om-full"],
  ];

  for (const [id, tool] of arms) {
    it(`${id}: tool name "${tool}" (matches ARM_LABELS)`, () => {
      expect(ARM_DEFS[id].id).toBe(id);
      expect(ARM_DEFS[id].tool).toBe(tool);
      expect(ARM_LABELS[id]).toBe(tool); // single source of truth stays consistent
    });
  }

  it("A1 bare-pi: no memory extension, no knobs", () => {
    const a1 = ARM_DEFS.A1;
    expect(a1.memoryPackage).toBeNull();
    expect(a1.memkeeperSettings).toBeUndefined();
    expect(a1.overrideReflectionThreshold).toBeUndefined();
    expect(a1.envPreconditions).toBeUndefined();
  });

  it("A2 om-default: OM fork, passive env precondition, NO threshold override (author-intended)", () => {
    const a2 = ARM_DEFS.A2;
    expect(a2.memoryPackage).toBe(OM_PACKAGE);
    expect(a2.overrideReflectionThreshold).toBeUndefined(); // A2 = author defaults
    expect(a2.memkeeperSettings).toBeUndefined();
    expect(a2.envPreconditions?.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");
  });

  it("A3 memkeeper-builder: memkeeper, observations-root (Selector does NOT run), on-compaction modes", () => {
    const a3 = ARM_DEFS.A3;
    expect(a3.memoryPackage).toBe(MEMKEEPER_PACKAGE);
    expect(a3.memkeeperSettings).toBeDefined();
    expect(a3.memkeeperSettings?.renderMode).toBe("observations-root");
    expect(a3.memkeeperSettings?.observerMode).toBe("on-compaction");
    expect(a3.memkeeperSettings?.builderMode).toBe("on-compaction");
    expect(a3.memkeeperSettings?.selectorMode).toBe("on-compaction");
  });

  it("A4 memkeeper-selector: memkeeper, selected-root (Selector runs)", () => {
    const a4 = ARM_DEFS.A4;
    expect(a4.memoryPackage).toBe(MEMKEEPER_PACKAGE);
    expect(a4.memkeeperSettings?.renderMode).toBe("selected-root");
    expect(a4.memkeeperSettings?.observerMode).toBe("on-compaction");
  });

  it("A5 om-full: OM fork, passive env, threshold override FORCED (reflector/pruner always run)", () => {
    const a5 = ARM_DEFS.A5;
    expect(a5.memoryPackage).toBe(OM_PACKAGE);
    expect(a5.overrideReflectionThreshold).toBe(true);
    expect(a5.envPreconditions?.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");
  });
});

describe("arms/definitions — isolation invariants", () => {
  it("exactly the OM arms carry the passive env precondition (A2 + A5)", () => {
    const passiveArms = ARM_IDS.filter((a) => ARM_DEFS[a].envPreconditions?.PI_OBSERVATIONAL_MEMORY_PASSIVE);
    expect([...passiveArms].sort()).toEqual(["A2", "A5"]);
  });

  it("exactly the memkeeper arms (A3 + A4) carry memkeeperSettings", () => {
    const mkArms = ARM_IDS.filter((a) => ARM_DEFS[a].memkeeperSettings);
    expect([...mkArms].sort()).toEqual(["A3", "A4"]);
  });

  it("exactly A1 has no memory package", () => {
    expect(ARM_IDS.filter((a) => ARM_DEFS[a].memoryPackage === null)).toEqual(["A1"]);
  });

  it("A3 vs A4 differ ONLY in renderMode (same package + modes)", () => {
    const mk3 = ARM_DEFS.A3.memkeeperSettings;
    const mk4 = ARM_DEFS.A4.memkeeperSettings;
    if (!mk3 || !mk4) throw new Error("test invariant: A3/A4 must define memkeeperSettings");
    const { renderMode: r3, ...rest3 } = mk3;
    const { renderMode: r4, ...rest4 } = mk4;
    expect(rest3).toEqual(rest4);
    expect(r3).toBe("observations-root");
    expect(r4).toBe("selected-root");
  });
});
