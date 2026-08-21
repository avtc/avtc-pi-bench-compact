// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { axisForProbe, matchedSupersession } from "../../src/judge/probe-axis.js";
import type { Probe, ScenarioManifest } from "../../src/manifest/schema.js";

/** Build a manifest where each condition id maps to a distinct ENTRY id (`e-<id>`).
 * Per the schema, a probe's `targets` are ENTRY ids (the target's `entryIds`), so
 * probes must reference `e-<id>` — NOT the condition id. This is what masks the
 * axisForProbe regression (comparing entry-id targets against condition `s.id`). */
function manifestWith({
  recallFacts,
  supersessions,
}: {
  recallFacts: string[];
  supersessions: string[];
}): ScenarioManifest {
  return {
    id: "scen-1",
    description: "x",
    compactionBoundary: { phaseATokenBudget: 140_000, plan: "p" },
    recallFacts: recallFacts.map((id) => ({
      id,
      fact: `${id} fact`,
      accept: ["yes"],
      entryIds: [`e-${id}`],
      domain: "technical",
      lanes: ["direct-probe"],
    })),
    doneOps: [],
    supersessions: supersessions.map((id) => ({
      id,
      subject: `${id} subj`,
      oldValue: "old",
      latestValue: "new",
      entryIds: [`e-${id}`],
      lanes: ["direct-probe"],
    })),
    abstentions: [
      { id: "ab1", question: "undecided?", correctRefusal: true, entryIds: ["e-ab1"], lanes: ["direct-probe"] },
    ],
    taskObjective: { description: "goal", testSpec: "" },
    probes: [],
  };
}

/** Build a probe targeting the given ENTRY ids, with accept[] or correctRefusal. */
function probe(
  targets: string[],
  opts: { accept?: string[]; correctRefusal?: true; supersessionId?: string } = {},
): Probe {
  return { question: "q?", targets, lanes: ["direct-probe"], ...opts };
}

describe("axisForProbe", () => {
  it("maps a correctRefusal probe to E6 (abstention: never-decided)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["e-ab1"], { correctRefusal: true }), manifest)).toBe("E6");
  });

  it("maps a correctRefusal probe targeting a supersession to E6 (stale-item face)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["e-ss1"], { correctRefusal: true }), manifest)).toBe("E6");
  });

  it("maps a supersession-latest probe (explicit supersessionId) to E8", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["e-ss1"], { accept: ["new"], supersessionId: "ss1" }), manifest)).toBe("E8");
  });

  it("maps an accept[] probe targeting a recallFact to E5.1 (recall-accuracy)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["e-rf1"], { accept: ["yes"] }), manifest)).toBe("E5.1");
  });

  it("maps an accept[] probe citing a supersession's entries WITHOUT the link to E5.1 (no inferred routing)", () => {
    // probes and supersessions cite the same broad entries for unrelated facts —
    // entry-id overlap must never imply the supersession axis (the over-match bug).
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["e-rf1", "e-ss1"], { accept: ["x"] }), manifest)).toBe("E5.1");
    expect(axisForProbe(probe(["e-ss1"], { accept: ["new"] }), manifest)).toBe("E5.1");
  });

  it("defaults an accept[] probe with unknown targets to E5.1 (recall-style)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: [] });
    expect(axisForProbe(probe(["e-unknown"], { accept: ["x"] }), manifest)).toBe("E5.1");
  });

  it("returns null for a malformed probe (no accept, no correctRefusal)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["e-rf1"]), manifest)).toBe(null);
  });

  it("returns null for a probe with empty accept[] and no correctRefusal", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["e-rf1"], { accept: [] }), manifest)).toBe(null);
  });

  it("does NOT match a supersession condition id used as a target (targets are entry ids)", () => {
    // Regression guard: a probe that mistakenly targets the condition id (`ss1`) instead of
    // the entry id (`e-ss1`) must NOT route to E8 — it falls through to "E5.1" (recall-style).
    // This pins the schema contract (targets = entry ids) the resolver now honors.
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["ss1"], { accept: ["new"] }), manifest)).toBe("E5.1");
  });
});

describe("matchedSupersession / supersessionId routing", () => {
  it("prefers the explicit supersessionId even when targets cite another supersession's entries", () => {
    // ss1 owns entry e-ss1; ss2 owns e-ss2. The probe cites ss1's entry but NAMES ss2 —
    // the authored link is the only matcher, and it wins over any target evidence.
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1", "ss2"] });
    const p = probe(["e-ss1"], { accept: ["new"], supersessionId: "ss2" });
    expect(matchedSupersession(p, manifest)?.id).toBe("ss2");
    expect(axisForProbe(p, manifest)).toBe("E8");
  });

  it("routes to E8 by explicit supersessionId even when targets cite no supersession entry", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: ["ss1"] });
    const p = probe(["e-rf1"], { accept: ["new"], supersessionId: "ss1" });
    expect(matchedSupersession(p, manifest)?.id).toBe("ss1");
    expect(axisForProbe(p, manifest)).toBe("E8");
  });

  it("an absent supersessionId matches nothing (no entry-id fallback)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    const p = probe(["e-ss1"], { accept: ["new"] });
    expect(matchedSupersession(p, manifest)).toBeNull();
    expect(axisForProbe(p, manifest)).toBe("E5.1");
  });

  it("an unknown supersessionId matches nothing -> recall axis (validateManifest rejects it at load)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    const p = probe(["e-ss1"], { accept: ["new"], supersessionId: "ss-nope" });
    expect(matchedSupersession(p, manifest)).toBeNull();
    expect(axisForProbe(p, manifest)).toBe("E5.1");
  });
});
