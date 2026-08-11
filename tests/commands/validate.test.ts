// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { PrepareArgs, ResultsArgs } from "../../src/commands/parse.js";
import { preflight } from "../../src/commands/validate.js";
import type { BenchConfig } from "../../src/config/types.js";

function validConfig(over: Partial<BenchConfig> = {}): BenchConfig {
  return {
    evaluatedModel: null,
    evaluatedThinkingLevel: "high",
    judgeModel: null,
    judgeThinkingLevel: "high",
    N: 10,
    compactionBoundary: 140000,
    backupMode: "build",
    scenario: null,
    outputDir: null,
    omFullReflectionThresholdTokens: 4000,
    armBarePiEnabled: true,
    armOmDefaultEnabled: true,
    armMemkeeperObservationsRootEnabled: true,
    armMemkeeperSelectedRootEnabled: true,
    armOmFullEnabled: true,
    armsEnabled: ["A1", "A2", "A3", "A4", "A5"],
    ...over,
  };
}

const exists = (paths: Set<string>) => (p: string) => paths.has(p);

describe("preflight — config rules (all kinds)", () => {
  it("rejects when 0 arms are enabled", () => {
    const r = preflight(
      validConfig({ armsEnabled: [] }),
      "run-scenario",
      { value: "/repo" },
      exists(new Set(["/repo"])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/arm/i);
  });
  it("rejects when compactionBoundary < 20K", () => {
    const r = preflight(
      validConfig({ compactionBoundary: 10000 }),
      "run-scenario",
      { value: "/repo" },
      exists(new Set(["/repo"])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/boundary/i);
  });
});

describe("preflight — prepare (build idea)", () => {
  const args = (idea: string): PrepareArgs => ({ idea, fromSession: undefined, force: false, error: undefined });
  it("accepts a build idea", () => {
    expect(preflight(validConfig(), "prepare", args("a tycoon game"))).toEqual({ ok: true });
  });
  it("rejects when neither idea nor --from-session is given", () => {
    const r = preflight(validConfig(), "prepare", args(""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/idea|--from-session/i);
  });
});

describe("preflight — prepare (extract --from-session)", () => {
  it("accepts an existing --from-session path", () => {
    const args: PrepareArgs = { idea: undefined, fromSession: "/s.jsonl", force: false, error: undefined };
    expect(preflight(validConfig(), "prepare", args, exists(new Set(["/s.jsonl"])))).toEqual({ ok: true });
  });
  it("rejects a non-existent --from-session path", () => {
    const args: PrepareArgs = { idea: undefined, fromSession: "/missing.jsonl", force: false, error: undefined };
    const r = preflight(validConfig(), "prepare", args, exists(new Set()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/from-session|exist/i);
  });
});

describe("preflight — run-scenario folder", () => {
  it("accepts an existing folder", () => {
    expect(preflight(validConfig(), "run-scenario", { value: "/repo" }, exists(new Set(["/repo"])))).toEqual({
      ok: true,
    });
  });
  it("rejects a missing folder", () => {
    const r = preflight(validConfig(), "run-scenario", { value: "/nope" }, exists(new Set()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/folder|exist/i);
  });
  it("rejects when no folder is given", () => {
    const r = preflight(validConfig(), "run-scenario", { value: undefined }, exists(new Set()));
    expect(r.ok).toBe(false);
  });
});

describe("preflight — results", () => {
  it("accepts at least one runId", () => {
    const args: ResultsArgs = { runs: [{ runId: "r1" }], error: undefined };
    expect(preflight(validConfig(), "results", args)).toEqual({ ok: true });
  });
  it("rejects when no runId is given", () => {
    const args: ResultsArgs = { runs: [], error: undefined };
    const r = preflight(validConfig(), "results", args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/runId/i);
  });
});
