// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildDoneSnapshot,
  buildProbeAnswerSlice,
  buildStartSlice,
  buildTwoCheckpointSlice,
} from "../../src/judge/slices.js";
import type { DoneOp, Probe, ScenarioManifest, TaskObjective } from "../../src/manifest/schema.js";
import type { TestSpecResult } from "../../src/orchestrate/testspec.js";
import type { CapturedCompaction, RunTrace } from "../../src/orchestrate/trace.js";

function msg(id: string, role: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    timestamp: "2026-08-12T00:00:00Z",
    message: { role, content: [{ type: "text", text }] },
  } as SessionEntry;
}

function compaction(summary: string): CapturedCompaction {
  return {
    entry: {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: "",
      summary,
      firstKeptEntryId: "k1",
      tokensBefore: 1000,
    } as CompactionEntry,
    wallMs: 0,
  };
}

function traceOf(entries: SessionEntry[], compactions: CapturedCompaction[]): RunTrace {
  return { branch: "arm-x-1", entries, compactions, tracePath: "/repo/session.jsonl" };
}

const manifest: ScenarioManifest = {
  id: "scen-1",
  description: "tycoon game",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build the economy" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "build a tycoon game", testSpec: "npm test" } as TaskObjective,
  probes: [],
};

describe("buildStartSlice (E1 resume)", () => {
  it("renders the compaction summary + the first post-compaction actions, bounded", () => {
    const c1 = compaction("We were building a tycoon game; economy loop done, next is save/load.");
    const entries: SessionEntry[] = [
      c1.entry,
      msg("a1", "assistant", "Let me add the save system next."),
      msg("a2", "assistant", "Writing src/save.ts..."),
      msg("a3", "assistant", "Third action."),
      msg("a4", "assistant", "Fourth action."),
      msg("a5", "assistant", "Fifth action."),
      msg("a6", "assistant", "Sixth action (should be dropped by the bound)."),
    ];
    const slice = buildStartSlice(traceOf(entries, [c1]), manifest, null);
    expect(slice).toContain("save/load");
    expect(slice).toContain("save system next");
    expect(slice).toContain("Fifth action");
    expect(slice).not.toContain("Sixth action");
  });

  it("notes the task-in-progress + next planned step from the manifest", () => {
    const c1 = compaction("summary");
    const slice = buildStartSlice(traceOf([c1.entry], [c1]), manifest, null);
    expect(slice.toLowerCase()).toContain("tycoon");
  });
});

describe("buildProbeAnswerSlice (E5/E6/E8)", () => {
  it("renders the probe question + accept[] + the agent's answer", () => {
    const probe: Probe = {
      question: "How is revenue calculated?",
      accept: ["revenue = price * units sold"],
      targets: ["rf1"],
      lanes: ["direct-probe"],
    };
    const slice = buildProbeAnswerSlice(
      { probe, answerText: "Revenue is price times units sold.", supersessionEntryIds: new Set() },
      null,
    );
    expect(slice).toContain("How is revenue calculated?");
    expect(slice).toContain("price * units sold");
    expect(slice).toContain("price times units sold");
  });

  it("never-decided face: correctRefusal probe with no supersession target → REFUSE criteria", () => {
    const probe: Probe = {
      question: "What is the lab's power source?",
      correctRefusal: true,
      targets: ["ab1"],
      lanes: ["direct-probe"],
    };
    const slice = buildProbeAnswerSlice(
      { probe, answerText: "I don't know — we never decided.", supersessionEntryIds: new Set() },
      null,
    );
    expect(slice.toLowerCase()).toContain("refus");
    expect(slice).not.toMatch(/flag the value as stale/i);
    expect(slice).toContain("I don't know");
  });

  it("stale-value face: correctRefusal probe whose targets intersect a supersession → FLAG AS STALE criteria", () => {
    const probe: Probe = {
      question: "What's the company's org structure?",
      correctRefusal: true,
      targets: ["sup-entry-2"],
      lanes: ["direct-probe"],
    };
    // The probe targets an entry id belonging to a supersession — the stale-value face.
    const supersessionEntryIds = new Set(["sup-entry-1", "sup-entry-2"]);
    const slice = buildProbeAnswerSlice(
      { probe, answerText: "That structure is outdated — we reorganized since.", supersessionEntryIds },
      null,
    );
    expect(slice.toLowerCase()).toContain("flag the value as stale");
    expect(slice).not.toMatch(/correct answer = refuse/i);
    expect(slice).toContain("reorganized");
  });

  it("a correctRefusal probe whose target is NOT a supersession stays on the never-decided face (REFUSE)", () => {
    const probe: Probe = {
      question: "What is the lab's power source?",
      correctRefusal: true,
      targets: ["ab1"],
      lanes: ["direct-probe"],
    };
    // supersession entry ids exist, but the probe targets an abstention (not a supersession).
    const supersessionEntryIds = new Set(["sup-entry-1"]);
    const slice = buildProbeAnswerSlice({ probe, answerText: "I don't know.", supersessionEntryIds }, null);
    expect(slice.toLowerCase()).toContain("refus");
    expect(slice).not.toMatch(/flag the value as stale/i);
  });
});

describe("buildDoneSnapshot (E7 task quality)", () => {
  it("renders the task objective + the testSpec result (pass/fail + output) + final actions", () => {
    const testSpecResult: TestSpecResult = { kind: "ran", pass: false, output: "2 failing", runError: false };
    const finalEntries: SessionEntry[] = [
      msg("f1", "assistant", "Finished the save system."),
      msg("f2", "assistant", "Running tests..."),
    ];
    const slice = buildDoneSnapshot(
      { branch: "arm-x-1", taskObjective: manifest.taskObjective, testSpecResult, finalEntries },
      null,
    );
    expect(slice).toContain("tycoon game");
    expect(slice).toContain("test");
    expect(slice.toLowerCase()).toContain("fail");
    expect(slice).toContain("2 failing");
    expect(slice).toContain("save system");
  });

  it("notes when the testSpec was skipped (no embedded test)", () => {
    const slice = buildDoneSnapshot(
      {
        branch: "arm-x-1",
        taskObjective: { description: "x", testSpec: "" },
        testSpecResult: { kind: "skipped" },
        finalEntries: [],
      },
      null,
    );
    expect(slice.toLowerCase()).toContain("skip");
  });
});

describe("buildTwoCheckpointSlice (E2 redo, short)", () => {
  it("renders the completed doneOps + the run's action list", () => {
    const doneOps: DoneOp[] = [
      {
        id: "do1",
        description: "Economy loop",
        artifact: "src/economy.ts",
        reworkable: false,
        entryIds: ["e1"],
        lanes: ["embedded"],
      },
      { id: "do2", description: "Save system", artifact: "src/save.ts", reworkable: true, entryIds: ["e2"], lanes: [] },
    ];
    const runActions: SessionEntry[] = [
      msg("r1", "assistant", "Re-implementing the economy loop from scratch."),
      msg("r2", "assistant", "Adding save tests (requested rework)."),
    ];
    const slice = buildTwoCheckpointSlice({ doneOps, runActions }, null);
    expect(slice).toContain("Economy loop");
    expect(slice).toContain("reworkable"); // marks which doneOps are exempt
    expect(slice).toContain("Re-implementing the economy loop");
  });
});
