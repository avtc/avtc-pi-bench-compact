// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Unit tests for the crash-resume namespace plumbing: runId/cfgId parsing off
// bench-compact branch names (branches.ts) + incomplete-run detection
// (resume.ts). Pure functions — the git side (listBranches/commitCountAhead)
// lives in repo.test.ts against real git.

import { describe, expect, it } from "vitest";
import { buildArmBaseBranch, parseRunNamespace } from "../../src/storage/branches.js";
import { detectLatestIncompleteRun, findRunNamespace, parseResumeRunId } from "../../src/storage/resume.js";

/** A realistic run-4-shaped arm base branch. */
function armBranch(date: string, id: number, cfgId: string, tool: string, ver: string | undefined): string {
  return buildArmBaseBranch({ date, id, cfgId, tool, ver });
}

/** The branch list of a 5-arm run where A5 never committed (forked only). */
function run4Branches(): string[] {
  const ns = (tool: string, ver: string | undefined) => armBranch("2026-08-16", 4, "cfg-bd0f9a", tool, ver);
  return [
    ns("bare-pi", undefined),
    `${ns("om-default", "g9785fb")}-1`,
    `${ns("om-default", "g9785fb")}-2`,
    `${ns("om-default", "g9785fb")}-probe-1-1`,
    ns("session-owl-builder", "gf18193"),
    ns("session-owl-selector", "gf18193"),
    ns("om-full", "g9785fb"),
  ];
}

describe("parseRunNamespace", () => {
  it("parses an arm-base branch into runId + cfgId", () => {
    expect(parseRunNamespace(armBranch("2026-08-16", 4, "cfg-bd0f9a", "om-full", "g9785fb"))).toEqual({
      runId: "2026-08-16-4",
      cfgId: "cfg-bd0f9a",
    });
  });

  it("parses attempt + probe branches (the suffix is ignored)", () => {
    expect(parseRunNamespace("bench-compact/run-2026-08-16-2/cfg-d1c86a/arm-om-default-g29f945-3")).toEqual({
      runId: "2026-08-16-2",
      cfgId: "cfg-d1c86a",
    });
    expect(parseRunNamespace("bench-compact/run-2026-08-16-2/cfg-d1c86a/arm-bare-pi-probe-2-1")).toEqual({
      runId: "2026-08-16-2",
      cfgId: "cfg-d1c86a",
    });
  });

  it("parses the bare-pi arm (ver omitted)", () => {
    expect(parseRunNamespace("bench-compact/run-2026-08-16-4/cfg-bd0f9a/arm-bare-pi")).toEqual({
      runId: "2026-08-16-4",
      cfgId: "cfg-bd0f9a",
    });
  });

  it("rejects non-bench branches + malformed namespaces", () => {
    expect(parseRunNamespace("main")).toBeNull();
    expect(parseRunNamespace("feature/foo")).toBeNull();
    expect(parseRunNamespace("bench-compact/run-2026-08-16/cfg-bd0f9a/arm-bare-pi")).toBeNull(); // no -<id>
    expect(parseRunNamespace("bench-compact/run-notadate-4/cfg-bd0f9a/arm-bare-pi")).toBeNull(); // bad date
    expect(parseRunNamespace("bench-compact/run-2026-08-16-4/notcfg/arm-bare-pi")).toBeNull(); // bad cfg segment
    expect(parseRunNamespace("bench-compact/run-2026-08-16-4/cfg-bd0f9a")).toBeNull(); // no arm segment
  });
});

describe("detectLatestIncompleteRun", () => {
  it("picks the latest run whose results.json is absent", () => {
    const branches = [
      ...run4Branches(),
      armBranch("2026-08-16", 3, "cfg-d1c86a", "bare-pi", undefined),
      armBranch("2026-08-16", 2, "cfg-d1c86a", "bare-pi", undefined),
    ];
    const completed = new Set(["2026-08-16-2"]);
    const target = detectLatestIncompleteRun(branches, (runId) => completed.has(runId));
    expect(target).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-bd0f9a" });
  });

  it("falls back to an older incomplete run when the latest is complete", () => {
    const branches = [
      armBranch("2026-08-16", 4, "cfg-bd0f9a", "bare-pi", undefined),
      armBranch("2026-08-16", 3, "cfg-d1c86a", "bare-pi", undefined),
    ];
    const completed = new Set(["2026-08-16-4"]);
    expect(detectLatestIncompleteRun(branches, (runId) => completed.has(runId))).toEqual({
      runId: "2026-08-16-3",
      cfgId: "cfg-d1c86a",
    });
  });

  it("prefers a later date over a larger id (date is the major key)", () => {
    const branches = [
      armBranch("2026-08-15", 7, "cfg-aaaaaa", "bare-pi", undefined),
      armBranch("2026-08-16", 1, "cfg-bbbbbb", "bare-pi", undefined),
    ];
    expect(detectLatestIncompleteRun(branches, () => false)).toEqual({
      runId: "2026-08-16-1",
      cfgId: "cfg-bbbbbb",
    });
  });

  it("returns null when every run is complete (or no bench branches exist)", () => {
    expect(detectLatestIncompleteRun(run4Branches(), () => true)).toBeNull();
    expect(detectLatestIncompleteRun([], () => false)).toBeNull();
  });

  it("deduplicates across a run's many branches (one target per runId)", () => {
    const target = detectLatestIncompleteRun(run4Branches(), () => false);
    expect(target).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-bd0f9a" });
  });

  it("resolves an ambiguous runId (two cfgs) deterministically to the cfg with more branches", () => {
    const branches = [
      armBranch("2026-08-16", 4, "cfg-fa0e01", "bare-pi", undefined),
      armBranch("2026-08-16", 4, "cfg-0d0b2c", "bare-pi", undefined),
      armBranch("2026-08-16", 4, "cfg-0d0b2c", "om-full", "g9785fb"),
    ];
    expect(detectLatestIncompleteRun(branches, () => false)).toEqual({ runId: "2026-08-16-4", cfgId: "cfg-0d0b2c" });
  });
});

describe("findRunNamespace", () => {
  it("finds the namespace of an explicit runId", () => {
    expect(findRunNamespace(run4Branches(), "2026-08-16-4")).toEqual({
      runId: "2026-08-16-4",
      cfgId: "cfg-bd0f9a",
    });
  });

  it("returns null for a runId with no branches", () => {
    expect(findRunNamespace(run4Branches(), "2026-08-16-9")).toBeNull();
  });
});

describe("parseResumeRunId", () => {
  it("parses a runId into date + numeric id", () => {
    expect(parseResumeRunId("2026-08-16-4")).toEqual({ date: "2026-08-16", id: 4 });
    expect(parseResumeRunId("2026-01-01-12")).toEqual({ date: "2026-01-01", id: 12 });
  });

  it("refuses malformed runIds with the operator-facing message", () => {
    expect(() => parseResumeRunId("2026-08-16")).toThrow(/is not a run id/);
    expect(() => parseResumeRunId("notadate-4")).toThrow(/is not a run id/);
    expect(() => parseResumeRunId("")).toThrow(/is not a run id/);
  });
});
