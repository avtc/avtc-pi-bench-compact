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
    accept: ["3 tick periods"],
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
  it("stays loose on question length — the floor lives in the add-time tool gate with its specific rejection", () => {
    // The A3 pool of run-2026-08-18-1: the authoring agent gamed the cued minimum with
    // "Test"/"Test4"/... placeholders. Length is NOT schema-enforced so the authoring
    // agent gets the per-field rejection message (latent-author.test.ts covers the gate);
    // pool loads re-check the floor in validateLatentProbes (test below).
    expect(Value.Check(LATENT_PROBE_ITEM_SCHEMA, { ...cleanItem("cued"), question: "Test4" })).toBe(true);
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

  it("rejects placeholder-grade questions (reuse path — a pre-floor pool fails validation)", () => {
    const r = validateLatentProbes([poolProbe({ ...cleanItem("cued"), question: "Test4" }, null)], CTX);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("question shorter than 12 chars");
  });

  it('rejects placeholder-grade notes and accept lists (the A3 junk had note "t", accept "a")', () => {
    const note = validateLatentProbes([poolProbe({ ...cleanItem("cued"), note: "t" }, null)], CTX);
    expect(note.ok).toBe(false);
    expect(note.reasons[0]).toContain("note shorter than 8 chars");

    const accept = validateLatentProbes([poolProbe({ ...cleanItem("cued"), accept: ["a"] }, null)], CTX);
    expect(accept.ok).toBe(false);
    expect(accept.reasons[0]).toContain("accept shorter than 10 chars");
  });

  it("rejects near-duplicate questions (one fact recorded twice) and keeps distinct adjacent facts", () => {
    const dup = validateLatentProbes(
      [
        poolProbe(cleanItem("cued"), { id: "l1" }),
        poolProbe({ ...cleanItem("cued"), question: "What is the exact LEGACY_DECAY value used?" }, { id: "l2" }),
      ],
      CTX,
    );
    expect(dup.ok).toBe(false);
    expect(dup.reasons[0]).toContain("l1 and l2: near-duplicate questions");

    // A4's l16≡l17 byte-identical pair is the 1.0 case…
    const same = validateLatentProbes(
      [poolProbe(cleanItem("cued"), { id: "l1" }), poolProbe(cleanItem("cued"), { id: "l2" })],
      CTX,
    );
    expect(same.ok).toBe(false);

    // …while real distinct probes about adjacent facts (A1's ≈0.70 pairs) stay valid.
    const distinct = validateLatentProbes(
      [
        poolProbe(cleanItem("cued"), { id: "l1" }),
        poolProbe(
          { ...cleanItem("cued"), question: "Which module path hosts the decay override constant?" },
          { id: "l2" },
        ),
      ],
      CTX,
    );
    expect(distinct).toEqual({ ok: true, reasons: [] });
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
      poolProbe(
        { ...cleanItem("cued"), question: `What does fact number ${i} pin down exactly?` },
        { id: `l${i + 1}` },
      ),
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
