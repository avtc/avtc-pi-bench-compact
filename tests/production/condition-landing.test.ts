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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
    const byId = Object.fromEntries(cls.map((c) => [c.topic.id, c.status]));
    expect(byId["change-mind"]).toBe("missing");
    expect(byId["open-question"]).toBe("missing");
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
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
    const cls = classifyLanding(m, FIRST_KEPT, entryOrder, CONDITION_TOPICS);
    expect(decideLandingAction(cls).kind).toBe("surface"); // missing wins over tail
  });
});
