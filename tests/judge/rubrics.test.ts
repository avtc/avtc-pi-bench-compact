// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { JUDGE_RUBRICS } from "../../src/judge/rubrics.js";
import { BINARY_METRICS, COMPARATIVE_METRICS, type MetricId } from "../../src/metrics/defs.js";

const EFFECTIVENESS_AXES: readonly MetricId[] = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E10"];

describe("JUDGE_RUBRICS (§5.11 per-axis)", () => {
  it("defines a rubric for every effectiveness axis (the 9 judge-graded metrics)", () => {
    for (const axis of EFFECTIVENESS_AXES) {
      const rubric = JUDGE_RUBRICS[axis];
      expect(rubric).toBeDefined();
      expect(typeof rubric).toBe("string");
      expect(rubric?.length).toBeGreaterThan(0);
    }
  });

  it("defines NO rubric for the exact cost metrics (those are not judge-graded)", () => {
    for (const id of ["C1", "C2", "C3", "C4"] as const) {
      expect(JUDGE_RUBRICS[id]).toBeUndefined();
    }
  });

  it("E1 resume rubric: checks the agent resumes without re-asking + continues toward the next step", () => {
    const r = (JUDGE_RUBRICS.E1 ?? "").toLowerCase();
    expect(r).toContain("resume");
    expect(r).toMatch(/without re-asking|without asking/);
  });

  it("E2 redo-exec rubric: checks re-execution of a completed (non-reworkable) doneOp", () => {
    const r = (JUDGE_RUBRICS.E2 ?? "").toLowerCase();
    expect(r.match(/redo|re-execut/)).not.toBeNull();
    expect(r).toContain("doneop");
  });

  it("E5 recall rubric: checks the probe answer matches accept[]", () => {
    const r = (JUDGE_RUBRICS.E5 ?? "").toLowerCase();
    expect(r).toContain("accept");
  });

  it("E6 abstention rubric: per-probe — grades the one face the GRADING CRITERIA names (REFUSE or FLAG AS STALE)", () => {
    const r = (JUDGE_RUBRICS.E6 ?? "").toLowerCase();
    expect(r).toMatch(/grading criteria/); // per-probe face is named by the slice, not demanded in one call
    expect(r).toMatch(/refus|fabricat|never-decid/); // never-decided face
    expect(r).toMatch(/stale/); // stale-value face
  });

  it("E8 supersession rubric: checks latestValue used + oldValue suppressed", () => {
    const r = (JUDGE_RUBRICS.E8 ?? "").toLowerCase();
    expect(r).toContain("latestvalue");
    expect(r).toContain("oldvalue");
  });

  it("binary-axis rubrics ask for a yes/no judgment; comparative-axis rubrics ask for a rank judgment", () => {
    for (const axis of BINARY_METRICS) {
      expect((JUDGE_RUBRICS[axis] ?? "").toLowerCase()).toMatch(/yes\/no|pass or fail|pass\/fail/);
    }
    for (const axis of COMPARATIVE_METRICS) {
      // Comparative axes are NOT graded yes/no in the single-call slice (they're
      // ranked in Task 16b); the rubric still describes what to look for.
      expect(JUDGE_RUBRICS[axis]).toBeDefined();
    }
  });
});
