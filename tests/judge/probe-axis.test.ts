// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { axisForProbe } from "../../src/judge/probe-axis.js";
import type { Probe, ScenarioManifest } from "../../src/manifest/schema.js";

/** Build a manifest with the given condition ids so the resolver can tell a
 *  supersession target from a recallFact target. */
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
      entryIds: [],
      domain: "technical",
      lanes: ["direct-probe"],
    })),
    doneOps: [],
    supersessions: supersessions.map((id) => ({
      id,
      subject: `${id} subj`,
      oldValue: "old",
      latestValue: "new",
      entryIds: [],
      lanes: ["direct-probe"],
    })),
    abstentions: [{ id: "ab1", question: "undecided?", correctRefusal: true, entryIds: [], lanes: ["direct-probe"] }],
    taskObjective: { description: "goal", testSpec: "" },
    probes: [],
  };
}

/** Build a probe targeting the given condition ids, with accept[] or correctRefusal. */
function probe(targets: string[], opts: { accept?: string[]; correctRefusal?: true } = {}): Probe {
  return { question: "q?", targets, lanes: ["direct-probe"], ...opts };
}

describe("axisForProbe", () => {
  it("maps a correctRefusal probe to E6 (abstention: never-decided)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["ab1"], { correctRefusal: true }), manifest)).toBe("E6");
  });

  it("maps a correctRefusal probe targeting a supersession to E6 (stale-item face)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["ss1"], { correctRefusal: true }), manifest)).toBe("E6");
  });

  it("maps an accept[] probe targeting a supersession to E8 (latest-value)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["ss1"], { accept: ["new"] }), manifest)).toBe("E8");
  });

  it("maps an accept[] probe targeting a recallFact to E5 (recall-accuracy)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["rf1"], { accept: ["yes"] }), manifest)).toBe("E5");
  });

  it("maps an accept[] probe with mixed targets to E8 when any target is a supersession", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: ["ss1"] });
    expect(axisForProbe(probe(["rf1", "ss1"], { accept: ["x"] }), manifest)).toBe("E8");
  });

  it("defaults an accept[] probe with unknown targets to E5 (recall-style)", () => {
    const manifest = manifestWith({ recallFacts: [], supersessions: [] });
    expect(axisForProbe(probe(["unknown"], { accept: ["x"] }), manifest)).toBe("E5");
  });

  it("returns null for a malformed probe (no accept, no correctRefusal)", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["rf1"]), manifest)).toBe(null);
  });

  it("returns null for a probe with empty accept[] and no correctRefusal", () => {
    const manifest = manifestWith({ recallFacts: ["rf1"], supersessions: [] });
    expect(axisForProbe(probe(["rf1"], { accept: [] }), manifest)).toBe(null);
  });
});
