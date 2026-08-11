// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_OUTPUT_SCHEMA,
  type AuthorOutput,
  type Lane,
  type ScenarioManifest,
} from "../../src/manifest/schema.js";

const goodAuthor: AuthorOutput = {
  recallFacts: [{ fact: "scores stored in ~/.scores.json", accept: ["~/.scores.json"], entryIds: ["e1"] }],
  doneOps: [{ description: "built the game loop", artifact: "src/loop.ts", reworkable: false, entryIds: ["e2"] }],
  supersessions: [{ subject: "movement keys", oldValue: "WASD", latestValue: "arrow keys", entryIds: ["e3", "e5"] }],
  abstentions: [{ question: "which renderer?", correctRefusal: true, entryIds: ["e4"] }],
  probes: [
    { question: "how are scores stored?", accept: ["~/.scores.json"], targets: ["e1"] },
    { question: "was the renderer decided?", correctRefusal: true, targets: ["e4"] },
  ],
  taskObjective: { description: "build the game", testSpec: "npm test" },
};

describe("AUTHOR_OUTPUT_SCHEMA (write_manifest input)", () => {
  it("accepts a complete, well-formed author output", () => {
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, goodAuthor)).toBe(true);
  });

  it("accepts empty condition lists (a kind that didn't occur)", () => {
    expect(
      Value.Check(AUTHOR_OUTPUT_SCHEMA, {
        recallFacts: [],
        doneOps: [],
        supersessions: [],
        abstentions: [],
        probes: [],
        taskObjective: { description: "x", testSpec: "npm test" },
      }),
    ).toBe(true);
  });

  it("accepts a probe with accept[] (recall/supersession probe) — correctRefusal optional", () => {
    const ok = { ...goodAuthor, probes: [{ question: "q?", accept: ["a"], targets: ["e1"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, ok)).toBe(true);
  });

  it("accepts a probe with correctRefusal (abstention probe) — accept optional", () => {
    const ok = { ...goodAuthor, probes: [{ question: "q?", correctRefusal: true, targets: ["e1"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, ok)).toBe(true);
  });

  it("rejects a recallFact missing entryIds", () => {
    const bad = { ...goodAuthor, recallFacts: [{ fact: "x", accept: ["x"], entryIds: [] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects a recallFact with non-array accept", () => {
    const bad = { ...goodAuthor, recallFacts: [{ fact: "x", accept: "x", entryIds: ["e1"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects a doneOp missing reworkable", () => {
    const bad = { ...goodAuthor, doneOps: [{ description: "x", artifact: "f", entryIds: ["e2"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects an abstention with correctRefusal:false (must be true)", () => {
    const bad = { ...goodAuthor, abstentions: [{ question: "q?", correctRefusal: false, entryIds: ["e4"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects a probe missing targets", () => {
    const bad = { ...goodAuthor, probes: [{ question: "q?", accept: ["a"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects an output missing a top-level list", () => {
    const bad = { recallFacts: [], doneOps: [], supersessions: [], abstentions: [] }; // no probes
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, bad)).toBe(false);
  });

  it("rejects empty-string content fields (fact/description/subject/question/artifact)", () => {
    const badFact = { ...goodAuthor, recallFacts: [{ fact: "", accept: ["x"], entryIds: ["e1"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badFact)).toBe(false);
    const badDesc = {
      ...goodAuthor,
      doneOps: [{ description: "", artifact: "f", reworkable: false, entryIds: ["e2"] }],
    };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badDesc)).toBe(false);
    const badArtifact = {
      ...goodAuthor,
      doneOps: [{ description: "d", artifact: "", reworkable: false, entryIds: ["e2"] }],
    };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badArtifact)).toBe(false);
    const badSubject = {
      ...goodAuthor,
      supersessions: [{ subject: "", oldValue: "a", latestValue: "b", entryIds: ["e3"] }],
    };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badSubject)).toBe(false);
    const badQuestion = { ...goodAuthor, abstentions: [{ question: "", correctRefusal: true, entryIds: ["e4"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badQuestion)).toBe(false);
  });

  it("rejects empty-string elements in accept/entryIds/targets arrays", () => {
    const badAccept = { ...goodAuthor, recallFacts: [{ fact: "x", accept: [""], entryIds: ["e1"] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badAccept)).toBe(false);
    const badEntryId = { ...goodAuthor, recallFacts: [{ fact: "x", accept: ["x"], entryIds: [""] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badEntryId)).toBe(false);
    const badTarget = { ...goodAuthor, probes: [{ question: "q?", accept: ["x"], targets: [""] }] };
    expect(Value.Check(AUTHOR_OUTPUT_SCHEMA, badTarget)).toBe(false);
  });
});

describe("ScenarioManifest / Lane types (structural)", () => {
  it("Lane is embedded | direct-probe", () => {
    const a: Lane = "embedded";
    const b: Lane = "direct-probe";
    expect([a, b]).toEqual(["embedded", "direct-probe"]);
  });

  it("a full ScenarioManifest is constructible with harness-derived id/lanes/domain", () => {
    const m: ScenarioManifest = {
      id: "tycoon-1",
      description: "AI tycoon",
      compactionBoundary: { phaseATokenBudget: 140000, plan: "build to target" },
      recallFacts: [
        {
          id: "rf1",
          fact: "x",
          accept: ["x"],
          entryIds: ["e1"],
          domain: "technical",
          lanes: ["embedded", "direct-probe"],
        },
      ],
      doneOps: [
        { id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: ["embedded"] },
      ],
      supersessions: [
        { id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: ["direct-probe"] },
      ],
      abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e4"], lanes: ["direct-probe"] }],
      taskObjective: { description: "build the game", testSpec: "npm test", lane: "embedded-test" },
      probes: [{ question: "q?", accept: ["x"], targets: ["e1"], lanes: ["direct-probe"] }],
    };
    expect(m.id).toBe("tycoon-1");
  });
});
