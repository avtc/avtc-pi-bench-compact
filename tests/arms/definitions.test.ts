// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { ARM_DEFS, SESSION_OWL_PACKAGE, OM_PACKAGE } from "../../src/arms/definitions.js";
import { ARM_IDS, ARM_LABELS, type ArmId } from "../../src/config/types.js";

describe("arms/definitions — package-name constants", () => {
  it("OM_PACKAGE + SESSION_OWL_PACKAGE name the two memory tools under test", () => {
    expect(OM_PACKAGE).toBe("pi-observational-memory");
    expect(SESSION_OWL_PACKAGE).toBe("avtc-pi-session-owl");
  });
});

describe("arms/definitions — ARM_DEFS covers all five arms", () => {
  it("has a definition for every ArmId and nothing else", () => {
    expect(Object.keys(ARM_DEFS).sort()).toEqual([...ARM_IDS].sort());
  });
});

describe("arms/definitions — per-arm spec (configure-API model)", () => {
  const arms: [ArmId, string][] = [
    ["A1", "bare-pi"],
    ["A2", "om-default"],
    ["A3", "session-owl-builder"],
    ["A4", "session-owl-selector"],
    ["A5", "om-full"],
  ];

  for (const [id, tool] of arms) {
    it(`${id}: tool name "${tool}" (matches ARM_LABELS)`, () => {
      expect(ARM_DEFS[id].id).toBe(id);
      expect(ARM_DEFS[id].tool).toBe(tool);
      expect(ARM_LABELS[id]).toBe(tool); // single source of truth stays consistent
    });
  }

  it("A1 bare-pi: both extensions disabled, no memory tool, empty memoryTools", () => {
    const a1 = ARM_DEFS.A1;
    expect(a1.memoryPackage).toBeNull();
    expect(a1.omConfig).toEqual({ enabled: false });
    expect(a1.sessionOwlConfig).toEqual({ enabled: false });
    expect(a1.memoryTools).toEqual([]);
  });

  it("A2 om-default: OM enabled + passive, session-owl disabled, recall tool", () => {
    const a2 = ARM_DEFS.A2;
    expect(a2.memoryPackage).toBe(OM_PACKAGE);
    expect(a2.omConfig).toEqual({ enabled: true, passive: true });
    expect(a2.omConfig.overrideReflectionThreshold).toBeUndefined(); // author-intended threshold
    expect(a2.sessionOwlConfig).toEqual({ enabled: false });
    expect(a2.memoryTools).toEqual(["recall"]);
  });

  it("A3 session-owl-builder: session-owl enabled observations-root (Selector OFF), OM disabled, owl_recall", () => {
    const a3 = ARM_DEFS.A3;
    expect(a3.memoryPackage).toBe(SESSION_OWL_PACKAGE);
    expect(a3.omConfig).toEqual({ enabled: false });
    expect(a3.sessionOwlConfig).toEqual({
      enabled: true,
      renderMode: "observations-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    });
    expect(a3.memoryTools).toEqual(["owl_recall"]);
  });

  it("A4 session-owl-selector: session-owl enabled selected-root (Selector runs), OM disabled, owl_recall", () => {
    const a4 = ARM_DEFS.A4;
    expect(a4.memoryPackage).toBe(SESSION_OWL_PACKAGE);
    expect(a4.omConfig).toEqual({ enabled: false });
    expect(a4.sessionOwlConfig?.renderMode).toBe("selected-root");
    expect(a4.sessionOwlConfig?.observerMode).toBe("on-compaction");
    expect(a4.memoryTools).toEqual(["owl_recall"]);
  });

  it("A5 om-full: OM enabled + passive + threshold-override marker, session-owl disabled, recall", () => {
    const a5 = ARM_DEFS.A5;
    expect(a5.memoryPackage).toBe(OM_PACKAGE);
    expect(a5.omConfig).toEqual({ enabled: true, passive: true, overrideReflectionThreshold: true });
    expect(a5.sessionOwlConfig).toEqual({ enabled: false });
    expect(a5.memoryTools).toEqual(["recall"]);
  });
});

describe("arms/definitions — isolation invariants", () => {
  it("exactly the OM arms (A2 + A5) enable observational-memory", () => {
    const omArms = ARM_IDS.filter((a) => ARM_DEFS[a].omConfig.enabled);
    expect([...omArms].sort()).toEqual(["A2", "A5"]);
  });

  it("exactly the session-owl arms (A3 + A4) enable session-owl", () => {
    const mkArms = ARM_IDS.filter((a) => ARM_DEFS[a].sessionOwlConfig.enabled);
    expect([...mkArms].sort()).toEqual(["A3", "A4"]);
  });

  it("exactly A1 has no memory package", () => {
    expect(ARM_IDS.filter((a) => ARM_DEFS[a].memoryPackage === null)).toEqual(["A1"]);
  });

  it("A3 vs A4 differ ONLY in renderMode (same enabled flags + on-compaction modes)", () => {
    const mk3 = ARM_DEFS.A3.sessionOwlConfig;
    const mk4 = ARM_DEFS.A4.sessionOwlConfig;
    if (!mk3 || !mk4) throw new Error("test invariant: A3/A4 must define sessionOwlConfig");
    const { renderMode: r3, ...rest3 } = mk3;
    const { renderMode: r4, ...rest4 } = mk4;
    expect(rest3).toEqual(rest4);
    expect(r3).toBe("observations-root");
    expect(r4).toBe("selected-root");
  });

  it("memoryTools matches the enabled extension per arm (recall for OM arms, owl_recall for session-owl arms, none for bare-pi)", () => {
    expect(ARM_DEFS.A1.memoryTools).toEqual([]);
    expect(ARM_DEFS.A2.memoryTools).toEqual(["recall"]);
    expect(ARM_DEFS.A3.memoryTools).toEqual(["owl_recall"]);
    expect(ARM_DEFS.A4.memoryTools).toEqual(["owl_recall"]);
    expect(ARM_DEFS.A5.memoryTools).toEqual(["recall"]);
  });
});
