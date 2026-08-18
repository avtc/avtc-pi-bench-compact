// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { axisForProbe } from "../../src/judge/probe-axis.js";
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
function probe(targets: string[], opts: { accept?: string[]; correctRefusal?: true } = {}): Probe {
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

  it("maps an accept[] probe targeting a supersession to E8 (latest-value)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["e-ss1"], { accept: ["new"] }), manifest)).toBe("E8");
  });

  it("maps an accept[] probe targeting a recallFact to E5.1 (recall-accuracy)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["e-rf1"], { accept: ["yes"] }), manifest)).toBe("E5.1");
  });

  it("maps an accept[] probe with mixed targets to E8 when any target is a supersession", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["e-rf1", "e-ss1"], { accept: ["x"] }), manifest)).toBe("E8");
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
