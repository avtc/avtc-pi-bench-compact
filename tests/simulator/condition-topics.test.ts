// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  buildPlantInstruction,
  CONDITION_TOPICS,
  type ConditionTag,
  type ConditionTopic,
  type MetricAxis,
} from "../../src/simulator/condition-topics.js";

describe("CONDITION_TOPICS", () => {
  it("exposes exactly the 4 canonical topics (§4.17)", () => {
    expect(CONDITION_TOPICS).toHaveLength(4);
  });

  it("has unique ids", () => {
    const ids = CONDITION_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps each topic to a distinct metricAxis", () => {
    const axes = CONDITION_TOPICS.map((t) => t.metricAxis);
    expect(new Set(axes).size).toBe(axes.length);
    expect(new Set(axes)).toEqual(new Set<MetricAxis>(["recallFact", "doneOp", "supersession", "abstention"]));
  });

  it("tags split exactly 2 essential + 2 safeToSkip", () => {
    const essential = CONDITION_TOPICS.filter((t) => t.tag === "essential");
    const safeToSkip = CONDITION_TOPICS.filter((t) => t.tag === "safeToSkip");
    expect(essential).toHaveLength(2);
    expect(safeToSkip).toHaveLength(2);
  });

  it("binds recallFact + doneOp to essential; supersession + abstention to safeToSkip (§4.17)", () => {
    const byAxis = new Map(CONDITION_TOPICS.map((t) => [t.metricAxis, t.tag]));
    expect(byAxis.get("recallFact")).toBe("essential");
    expect(byAxis.get("doneOp")).toBe("essential");
    expect(byAxis.get("supersession")).toBe("safeToSkip");
    expect(byAxis.get("abstention")).toBe("safeToSkip");
  });

  it("every topic has non-empty id, label, hint", () => {
    for (const t of CONDITION_TOPICS) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.hint.length).toBeGreaterThan(0);
    }
  });

  it("is frozen (immutable bench constants — single source of truth)", () => {
    expect(Object.isFrozen(CONDITION_TOPICS)).toBe(true);
    for (const t of CONDITION_TOPICS) {
      expect(Object.isFrozen(t)).toBe(true);
    }
  });

  it("constrains tag + metricAxis to their unions", () => {
    const tags: ConditionTag[] = ["essential", "safeToSkip"];
    const axes: MetricAxis[] = ["recallFact", "doneOp", "supersession", "abstention"];
    for (const t of CONDITION_TOPICS) {
      expect(tags).toContain(t.tag);
      expect(axes).toContain(t.metricAxis);
    }
  });

  it("hints are domain-agnostic (work for ANY user idea / task, not just tycoon)", () => {
    // The 4 axes are the bench's fixed SCORING STRUCTURE; the task (what to build) is a
    // parameter. Hints must NOT leak a specific scenario's vocabulary, or they'd steer the
    // simulator toward one domain. The simulator fills specifics from whatever `task` it got.
    const scenarioTerms = [
      "tycoon",
      "game",
      "economy",
      "economic",
      "compute",
      "revenue",
      "resources",
      "company",
      "lab",
    ];
    for (const t of CONDITION_TOPICS) {
      const lower = t.hint.toLowerCase();
      for (const term of scenarioTerms) {
        expect(lower, `hint for "${t.id}" must not mention scenario term "${term}"`).not.toContain(term);
      }
    }
  });

  it("satisfies the ConditionTopic shape contract", () => {
    const sample: ConditionTopic = CONDITION_TOPICS[0];
    // structural: every field present + correctly typed via the assignment above
    expect(typeof sample.id).toBe("string");
    expect(typeof sample.label).toBe("string");
    expect(typeof sample.hint).toBe("string");
  });
});

describe("buildPlantInstruction", () => {
  it("embeds each topic's label + hint (the approved plant steering text)", () => {
    const text = buildPlantInstruction(["change-mind", "open-question"]);
    expect(text).toContain("Changed mind —");
    expect(text).toContain("Open question —");
    expect(text).toContain("one per step, naturally, as the user");
  });

  it("unknown topic id throws (ids come from landing.json / CONDITION_TOPICS)", () => {
    expect(() => buildPlantInstruction(["nope"])).toThrow(/unknown condition topic id/);
  });
});
