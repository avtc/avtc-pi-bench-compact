// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ArmId } from "../../src/config/types.js";
import {
  type AuthorLatentProbe,
  activeLatentProbes,
  LATENT_PROBE_ITEM_SCHEMA,
  type LatentProbe,
  validateLatentProbes,
} from "../../src/manifest/latent.js";

const ARMS: readonly ArmId[] = ["A1", "A3", "A5"];

/** A clean per-item author payload (cited entry e1 is in-span by ctx below). */
function cleanItem(probeClass: "cued" | "uncued"): AuthorLatentProbe {
  return {
    question: "What is the exact LEGACY_DECAY value?",
    accept: ["3"],
    entryIds: ["e1"],
    probeClass,
    note: "engine tuning constant the task depends on",
  };
}

/** Validation ctx with span {e1, e2} and all arms enabled. */
const CTX = { mode: "per-arm" as const, spanEntryIds: new Set(["e1", "e2"]), enabledArms: ARMS };

/** Build a full pool probe from an author item (id + arm + verdicts). */
function poolProbe(item: AuthorLatentProbe, over: Partial<LatentProbe> | null): LatentProbe {
  return { id: "l1", arm: "A3", verdicts: { A3: "absent" }, ...item, ...(over ?? {}) };
}

describe("LATENT_PROBE_ITEM_SCHEMA (tool payload contract)", () => {
  it("accepts a clean item", () => {
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, cleanItem("cued"))).toBe(true);
  });
  it("rejects a non-cued/uncued class", () => {
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, { ...cleanItem("cued"), probeClass: "both" })).toBe(false);
  });
  it("rejects an empty accept list / entryIds / note", () => {
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, { ...cleanItem("cued"), accept: [] })).toBe(false);
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, { ...cleanItem("cued"), entryIds: [] })).toBe(false);
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, { ...cleanItem("cued"), note: "" })).toBe(false);
  });
});

describe("validateLatentProbes", () => {
  it("accepts a clean per-arm probe", () => {
    const r = validateLatentProbes([poolProbe(cleanItem("cued"), null)], CTX);
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it("rejects entryIds outside the pre-slice span (tail ids are never citable)", () => {
    const r = validateLatentProbes([poolProbe({ ...cleanItem("cued"), entryIds: ["tail-9"] }, null)], CTX);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('entryId "tail-9" not in the pre-sliced (in-span) set');
  });

  it("rejects an empty accept list and empty question", () => {
    expect(validateLatentProbes([poolProbe({ ...cleanItem("cued"), accept: [] }, null)], CTX).ok).toBe(false);
    expect(validateLatentProbes([poolProbe({ ...cleanItem("cued"), question: "" }, null)], CTX).ok).toBe(false);
  });

  it("rejects an unknown probe class (defense for pool loads past the tool schema)", () => {
    const r = validateLatentProbes(
      [poolProbe({ ...cleanItem("cued"), probeClass: "other" as unknown as "cued" }, null)],
      CTX,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('unknown probe class "other"');
  });

  it("per-arm mode: arm is required, must be enabled, and its verdict must be recorded absent", () => {
    const noArm = poolProbe(cleanItem("cued"), { arm: undefined });
    expect(validateLatentProbes([noArm], CTX).reasons[0]).toContain("requires arm");

    expect(validateLatentProbes([poolProbe(cleanItem("cued"), { arm: "A2" })], CTX).reasons[0]).toContain(
      'arm "A2" is not enabled',
    );

    expect(
      validateLatentProbes([poolProbe(cleanItem("cued"), { verdicts: { A3: "answerable" } })], CTX).reasons[0],
    ).toContain('verdict for its arm "A3" must be "absent"');
  });

  it("shared mode: arm is forbidden and every enabled arm needs an absent verdict", () => {
    const shared = { ...CTX, mode: "shared" as const };
    expect(validateLatentProbes([poolProbe(cleanItem("cued"), null)], shared).reasons[0]).toContain(
      "must not pin an arm in shared mode",
    );

    const probe = poolProbe(cleanItem("cued"), { arm: undefined, verdicts: { A1: "absent", A3: "absent" } });
    const r = validateLatentProbes([probe], shared);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('missing verdict for arm "A5"');
  });

  it("defends the per-class cap (10) per arm in per-arm mode", () => {
    const eleven = Array.from({ length: 11 }, (_, i) =>
      poolProbe({ ...cleanItem("cued"), question: `q${i}` }, { id: `l${i + 1}` }),
    );
    const r = validateLatentProbes(eleven, CTX);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("cued probes for arm A3 exceed the cap (11 > 10)");
  });
});

describe("activeLatentProbes (per-arm applicability)", () => {
  const cued = poolProbe(cleanItem("cued"), { id: "l1" });
  const uncued = poolProbe(cleanItem("uncued"), { id: "l2" });

  it("per-arm mode: only the owning arm with an absent verdict runs the probe", () => {
    expect(activeLatentProbes([cued, uncued], "per-arm", "A3")).toEqual([cued, uncued]);
    expect(activeLatentProbes([cued, uncued], "per-arm", "A1")).toEqual([]);
  });

  it("a flipped verdict (re-validation after re-compact) deactivates the probe", () => {
    const flipped = poolProbe(cleanItem("cued"), { id: "l1", verdicts: { A3: "answerable" } });
    expect(activeLatentProbes([flipped], "per-arm", "A3")).toEqual([]);
  });

  it("shared mode: each arm runs the probe iff its own verdict is absent", () => {
    const probe = poolProbe(cleanItem("cued"), {
      arm: undefined,
      verdicts: { A1: "answerable", A3: "absent", A5: "absent" },
    });
    expect(activeLatentProbes([probe], "shared", "A1")).toEqual([]);
    expect(activeLatentProbes([probe], "shared", "A3")).toEqual([probe]);
    expect(activeLatentProbes([probe], "shared", "A5")).toEqual([probe]);
  });
});
