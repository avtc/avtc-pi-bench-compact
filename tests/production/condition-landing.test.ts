// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import { buildEntryOrder, classifyLanding, decideLandingAction } from "../../src/production/condition-landing.js";
import { CONDITION_TOPICS } from "../../src/simulator/condition-topics.js";

// backup entries e1..e5 (indices 0..4). firstKeptEntryId = e4 (index 3) → in-span = e1,e2,e3.
const entryOrder = buildEntryOrder(["e1", "e2", "e3", "e4", "e5"].map((id) => ({ id })));

const baseManifest: ScenarioManifest = {
  id: "t",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "b", testSpec: "npm test", lane: "embedded-test" },
  probes: [],
};

const FIRST_KEPT = "e4";

describe("classifyLanding", () => {
  it("marks a topic LANDED when its conditions' entryIds are all in the compacted-away span", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const byId = Object.fromEntries(cls.map((c) => [c.topic.id, c.status]));
    expect(byId["key-decision"]).toBe("landed"); // e1 < e4
    expect(byId["completed-system"]).toBe("landed"); // e2 < e4
  });

  it("marks a topic TAIL when a condition's entryId is in the kept tail (>= firstKeptEntryId)", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e5"], domain: "technical", lanes: [] }], // e5 >= e4 → tail
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const byId = Object.fromEntries(cls.map((c) => [c.topic.id, c.status]));
    expect(byId["key-decision"]).toBe("tail");
    expect(byId["completed-system"]).toBe("landed");
  });

  it("marks a topic MISSING when no condition of that type was authored", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      // supersessions + abstentions empty → change-mind + open-question missing
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const byId = Object.fromEntries(cls.map((c) => [c.topic.id, c.status]));
    expect(byId["change-mind"]).toBe("missing");
    expect(byId["open-question"]).toBe("missing");
  });

  it("marks a MISSING topic as TAIL when tailContentTopics reports its content is in the kept tail (content-in-tail, not never-materialized)", () => {
    // The author sees only the pre-sliced span, so it can't cite a tail entry. When a topic has
    // NO condition, the harness's separate tail-check (tailContentTopics) decides tail vs missing.
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      // change-mind + open-question have NO conditions (the author found nothing in the span)
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, new Set(["change-mind"]));
    const byId = Object.fromEntries(cls.map((c) => [c.topic.id, c.status]));
    expect(byId["change-mind"]).toBe("tail"); // content exists in kept tail → auto-continue
    expect(byId["open-question"]).toBe("missing"); // content nowhere → surface
  });
});

describe("decideLandingAction", () => {
  it("proceeds when all topics landed", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      supersessions: [{ id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: [] }],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    expect(decideLandingAction(cls)).toEqual({ kind: "proceed" });
  });

  it("continues when a topic is in the tail (auto-continue to slide into span)", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e5"], domain: "technical", lanes: [] }], // tail
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      supersessions: [{ id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: [] }],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    expect(action.kind).toBe("continue");
  });

  it("surfaces when an ESSENTIAL topic is missing (skip NOT offered)", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      // recallFacts empty → key-decision (essential) missing
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      supersessions: [{ id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: [] }],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    expect(action.kind).toBe("surface");
    if (action.kind === "surface") expect(action.skipOffered).toBe(false); // essential missing → no skip
  });

  it("surfaces with skip offered when ONLY safeToSkip topics are missing", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      // change-mind + open-question (both safeToSkip) missing
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    expect(action.kind).toBe("surface");
    if (action.kind === "surface") expect(action.skipOffered).toBe(true);
  });

  it("surfaces (skip NOT offered) when missing includes essential even if safeToSkip also missing", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      // recallFacts (essential) + supersessions (safeToSkip) both empty
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    if (action.kind === "surface") expect(action.skipOffered).toBe(false);
  });

  it("prioritizes surface over continue when both missing + tail present", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e5"], domain: "technical", lanes: [] }], // tail
      // doneOps empty → completed-system (essential) missing
      supersessions: [{ id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: [] }],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    expect(decideLandingAction(cls).kind).toBe("surface"); // missing wins over tail
  });
});

describe("decideLandingAction — surface carries the missing topics", () => {
  it("surface action names every missing topic (labels/tags flow to the notify + landing.json)", () => {
    const m: ScenarioManifest = { ...baseManifest }; // ALL lists empty → every topic missing
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    expect(action.kind).toBe("surface");
    if (action.kind !== "surface") return;
    expect(action.missing.map((t) => t.id)).toEqual(CONDITION_TOPICS.map((t) => t.id));
    expect(action.skipOffered).toBe(false); // essential topics among the missing
  });

  it("surface with only safeToSkip missing: skipOffered true + only those topics carried", () => {
    const m: ScenarioManifest = {
      ...baseManifest,
      recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
      doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
    };
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null);
    const action = decideLandingAction(cls);
    expect(action.kind).toBe("surface");
    if (action.kind !== "surface") return;
    expect(action.missing.map((t) => t.id).sort()).toEqual(["change-mind", "open-question"]);
    expect(action.missing.every((t) => t.tag === "safeToSkip")).toBe(true);
    expect(action.skipOffered).toBe(true);
  });
});

describe("classifyLanding — author-reported tail conflicts", () => {
  const landedRecall = {
    ...baseManifest,
    recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical" as const, lanes: [] }],
    doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
  };

  it("marks a topic TAIL-ANSWERABLE when a conflict (kind answerable) matches its condition's span entryIds", () => {
    const m: ScenarioManifest = {
      ...landedRecall,
      tailConflicts: [{ entryIds: ["e1"], kind: "answerable" }],
    };
    const byId = Object.fromEntries(
      classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null).map((c) => [c.topic.id, c.status]),
    );
    expect(byId["key-decision"]).toBe("tail-answerable");
    expect(byId["completed-system"]).toBe("landed"); // no conflict on do1's ids
  });

  it("marks a topic TAIL-SUPERSEDED when a conflict (kind superseded) matches — superseded wins over answerable", () => {
    const m: ScenarioManifest = {
      ...landedRecall,
      tailConflicts: [
        { entryIds: ["e1"], kind: "answerable" },
        { entryIds: ["e1"], kind: "superseded" },
      ],
    };
    const byId = Object.fromEntries(
      classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null).map((c) => [c.topic.id, c.status]),
    );
    expect(byId["key-decision"]).toBe("tail-superseded");
  });

  it("a conflict on ids NO condition of the topic cites does not affect the topic", () => {
    const m: ScenarioManifest = {
      ...landedRecall,
      tailConflicts: [{ entryIds: ["e3"], kind: "superseded" }], // e3 is in-span but cited by nobody
    };
    const byId = Object.fromEntries(
      classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS, null).map((c) => [c.topic.id, c.status]),
    );
    expect(byId["key-decision"]).toBe("landed");
  });

  it("both tail-conflict statuses route to the auto-continue landing action (like a tail landing)", () => {
    const landed = { topic: CONDITION_TOPICS[1], status: "landed" as const };
    for (const kind of ["tail-answerable", "tail-superseded"] as const) {
      const cls = [{ topic: CONDITION_TOPICS[0], status: kind }, landed];
      expect(decideLandingAction(cls)).toEqual({ kind: "continue" });
    }
  });
});
