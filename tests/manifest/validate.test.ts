// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { Probe, RecallFact, ScenarioManifest } from "../../src/manifest/schema.js";

/** Replace manifest.recallFacts[0] with a patched copy (readonly arrays → rebuild). */
function withFirstRecallFact(m: ScenarioManifest, patch: Partial<RecallFact>): ScenarioManifest {
  return { ...m, recallFacts: [{ ...m.recallFacts[0], ...patch }, ...m.recallFacts.slice(1)] };
}

import { type ManifestValidationContext, validateManifest } from "../../src/manifest/validate.js";

/** Build a clean manifest with one condition per type, all citing in-span entries. */
function cleanManifest(): ScenarioManifest {
  return {
    id: "t-1",
    description: "d",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
    recallFacts: [
      {
        id: "rf1",
        fact: "scores in ~/.scores.json",
        accept: ["~/.scores.json"],
        entryIds: ["e1"],
        domain: "technical",
        lanes: ["embedded"],
      },
    ],
    doneOps: [
      {
        id: "do1",
        description: "built the game loop",
        artifact: "src/loop.ts",
        reworkable: false,
        entryIds: ["e2"],
        lanes: ["embedded"],
      },
    ],
    supersessions: [
      {
        id: "ss1",
        subject: "movement keys",
        oldValue: "WASD",
        latestValue: "arrows",
        entryIds: ["e3"],
        lanes: ["direct-probe"],
      },
    ],
    abstentions: [
      {
        id: "ab1",
        question: "which renderer should we use",
        correctRefusal: true,
        entryIds: ["e4"],
        lanes: ["direct-probe"],
      },
    ],
    taskObjective: { description: "build", testSpec: "npm test", lane: "embedded-test" },
    probes: [
      { question: "scores?", accept: ["~/.scores.json"], targets: ["e1"], lanes: ["direct-probe"] },
      { question: "keys?", accept: ["arrows"], targets: ["e3"], lanes: ["direct-probe"] },
      { question: "we use WASD, right?", correctRefusal: true, targets: ["e3"], lanes: ["direct-probe"] },
      { question: "renderer?", correctRefusal: true, targets: ["e4"], lanes: ["direct-probe"] },
    ],
  };
}

/** Entries whose text contains each condition's content (clean content-present). */
const entryText = new Map<string, string>([
  ["e1", "the user said: store scores in ~/.scores.json"],
  ["e2", "agent: I built the game loop in src/loop.ts"],
  ["e3", "user: movement keys — actually let's use arrows not WASD"],
  ["e4", "user: which renderer should we use?"],
]);

function cleanCtx(overrides: Partial<ManifestValidationContext>): ManifestValidationContext {
  return {
    preSlicedEntryIds: new Set(["e1", "e2", "e3", "e4"]),
    entryTextById: entryText,
    essentialLists: new Set(["recallFacts", "doneOps"]),
    compactionCount: 0, // source is pre-compaction by construction
    expectedCompactionCount: 0,
    ...overrides,
  };
}

describe("validateManifest — accept", () => {
  it("accepts a clean manifest with all conditions in-span + content present", () => {
    const r = validateManifest(cleanManifest(), cleanCtx({}));
    expect(r.ok).toBe(true);
  });

  it("accepts a PARAPHRASED fact when the cited entry shares distinctive tokens (real authoring shape)", () => {
    // The authoring agent summarizes what it read: the fact sentence is its own
    // wording, not a verbatim quote. Verbatim-only matching rejected every real
    // authored manifest; token overlap is the paraphrase-tolerant signal.
    const base = cleanManifest();
    const rf = base.recallFacts[0];
    if (rf === undefined) throw new Error("fixture");
    const m = {
      ...base,
      recallFacts: [{ ...rf, fact: "scores get persisted into the dot-scores file", accept: ["~/.scores.json"] }],
    };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(true);
  });

  it("rejects a citation whose entries share NO content with the claim (hallucinated citation)", () => {
    const base = cleanManifest();
    const rf = base.recallFacts[0];
    if (rf === undefined) throw new Error("fixture");
    const m = {
      ...base,
      recallFacts: [{ ...rf, fact: "terraform provisioning uses eu-central region", accept: ["eu-central-1"] }],
    };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reasons.some((x) => x.includes("rf1") && x.includes("not present"))).toBe(true);
  });

  it("accepts when a non-essential list (supersessions/abstentions) is empty", () => {
    const m = cleanManifest();
    const r = validateManifest({ ...m, supersessions: [], abstentions: [] }, cleanCtx({}));
    expect(r.ok).toBe(true);
  });
});

describe("validateManifest — reject", () => {
  it("rejects an entryId not in the pre-sliced (in-span) set", () => {
    const m = withFirstRecallFact(cleanManifest(), { entryIds: ["e1", "e99"] }); // e99 not in span
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.join("\n")).toMatch(/e99/);
      expect(r.reasons.join("\n")).toMatch(/in.span|pre-slic|not in/i);
    }
  });

  it("rejects when cited content is not present at the entry (hallucinated mapping)", () => {
    // e2's text is about the game loop, not this fact → content check fails
    const m = withFirstRecallFact(cleanManifest(), {
      fact: "totally unrelated hallucinated fact xyz",
      entryIds: ["e2"],
    });
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/content|present|e2/i);
  });

  it("rejects when an essential list (recallFacts) is empty", () => {
    const m = cleanManifest();
    const r = validateManifest({ ...m, recallFacts: [] }, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/recallFacts|essential|empty/i);
  });

  it("rejects when doneOps essential list is empty", () => {
    const m = cleanManifest();
    const r = validateManifest({ ...m, doneOps: [] }, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/doneOps|essential|empty/i);
  });

  it("rejects when the source has a CompactionEntry (expected pre-compaction 0, got 1)", () => {
    const r = validateManifest(cleanManifest(), cleanCtx({ compactionCount: 1 })); // expected 0, got 1
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/compaction/i);
  });

  it("accumulates multiple reasons (not just the first)", () => {
    const m = withFirstRecallFact(cleanManifest(), { entryIds: ["e99"] }); // out-of-span
    const r = validateManifest({ ...m, doneOps: [] }, cleanCtx({})); // + essential empty
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateManifest — probe checks", () => {
  it("rejects a probe with neither accept nor correctRefusal", () => {
    const m = { ...cleanManifest(), probes: [{ question: "q?", targets: ["e1"], lanes: ["direct-probe"] }] as Probe[] };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/accept|correctRefusal|exactly one/i);
  });

  it("rejects a probe with BOTH accept and correctRefusal", () => {
    const m = {
      ...cleanManifest(),
      probes: [
        { question: "q?", accept: ["x"], correctRefusal: true, targets: ["e1"], lanes: ["direct-probe"] },
      ] as Probe[],
    };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/exactly one/i);
  });

  it("rejects a supersession targeted by only ONE probe (missing latest-value OR stale-value face)", () => {
    // ss1 (entryIds ["e3"]) needs BOTH a latest-value accept-probe (E8) AND a stale-value
    // correctRefusal probe (E6 stale face). Drop the stale probe → reject.
    const m = {
      ...cleanManifest(),
      probes: [
        { question: "scores?", accept: ["~/.scores.json"], targets: ["e1"], lanes: ["direct-probe"] },
        { question: "keys?", accept: ["arrows"], targets: ["e3"], lanes: ["direct-probe"] },
        { question: "renderer?", correctRefusal: true, targets: ["e4"], lanes: ["direct-probe"] },
      ] as Probe[],
    };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/stale-value correctRefusal/i);
  });

  it("rejects a manifest with conditions but NO probes", () => {
    const m = { ...cleanManifest(), probes: [] };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/probe/i);
  });

  it("accepts a manifest with no conditions AND no probes (edge: empty session)", () => {
    const m = {
      ...cleanManifest(),
      recallFacts: [],
      doneOps: [],
      supersessions: [],
      abstentions: [],
      probes: [],
    };
    // no essential lists required (essentialLists only has recallFacts+doneOps here → would fail)
    const r = validateManifest(m, cleanCtx({ essentialLists: new Set() }));
    expect(r.ok).toBe(true);
  });

  it("regression: a later condition's out-of-span citation is NOT masked by an earlier condition missing entryText", () => {
    // rf1 cites e1 (in-span but NOT in entryTextById → content check skips it via continue)
    // rf2 cites e99 (out-of-span) — MUST still be caught. `return` (bug) would skip rf2.
    const m: ScenarioManifest = {
      ...cleanManifest(),
      recallFacts: [
        { id: "rf1", fact: "unrelated", accept: ["unrelated"], entryIds: ["e1"], domain: "technical", lanes: [] },
        {
          id: "rf2",
          fact: "also unrelated",
          accept: ["also unrelated"],
          entryIds: ["e99"],
          domain: "technical",
          lanes: [],
        },
      ],
      probes: [{ question: "q?", accept: ["unrelated"], targets: ["e1"], lanes: ["direct-probe"] }],
    };
    // entryTextById deliberately omits e1 (rf1's cited entry) — partial map
    const ctx = cleanCtx({ entryTextById: new Map() });
    const r = validateManifest(m, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/e99/); // rf2's out-of-span caught
  });

  it("rejects a recallFact NOT targeted by any probe (: each condition needs a probe)", () => {
    // rf2 is not in any probe.targets
    const m: ScenarioManifest = {
      ...cleanManifest(),
      recallFacts: [
        { ...cleanManifest().recallFacts[0] },
        {
          id: "rf2",
          fact: "second fact xyz",
          accept: ["second fact xyz"],
          entryIds: ["e6"],
          domain: "technical",
          lanes: [],
        },
      ],
    };
    // give e6 text so content check passes; the failure is probe-targeting
    const ctx = cleanCtx({
      preSlicedEntryIds: new Set(["e1", "e2", "e3", "e4", "e6"]),
      entryTextById: new Map([...entryText, ["e6", "the second fact xyz is here"]]),
    });
    const r = validateManifest(m, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/rf2|probe|target/i);
  });

  it("R3-issue3: rejects a probe whose target is not in the pre-sliced (in-span) set — defense-in-depth", () => {
    // add an extra probe targeting e99 (out-of-span); conditions still targeted by clean probes
    const m: ScenarioManifest = {
      ...cleanManifest(),
      probes: [
        ...cleanManifest().probes,
        { question: "extra?", accept: ["x"], targets: ["e99"], lanes: ["direct-probe"] } as Probe,
      ],
    };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join("\n")).toMatch(/e99/);
  });

  it("when probes is empty, emits ONE summary reason (not N+1 redundant per-condition reasons)", () => {
    const m = { ...cleanManifest(), probes: [] };
    const r = validateManifest(m, cleanCtx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const probeReasons = r.reasons.filter((x) => /probe|target/i.test(x));
      // exactly one summary reason ("conditions but no probes"), NOT one-per-condition
      expect(probeReasons).toHaveLength(1);
      expect(probeReasons[0]).toMatch(/no probes/i);
    }
  });
});

describe("validateManifest — content check is lenient (any search-term matches)", () => {
  it("matches via an accept phrasing even if the fact string differs", () => {
    // fact paraphrased, but accept includes the exact substring present in e1
    const m = withFirstRecallFact(cleanManifest(), {
      fact: "the high score persistence choice",
      accept: ["~/.scores.json"],
      entryIds: ["e1"],
    });
    expect(validateManifest(m, cleanCtx({})).ok).toBe(true);
  });
});
