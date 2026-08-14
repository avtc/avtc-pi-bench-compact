// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { PrepareArgs, ResultsArgs } from "../../src/commands/parse.js";
import { preflight } from "../../src/commands/validate.js";
import { DEFAULTS } from "../../src/config/schema.js";
import type { BenchConfig } from "../../src/config/types.js";

function validConfig(over: Partial<BenchConfig>): BenchConfig {
  // Dedup against the single source of truth (DEFAULTS) — only `armsEnabled` (derived,
  // not stored) is added here. (R4-3)
  return { ...DEFAULTS, armsEnabled: ["A1", "A2", "A3", "A4", "A5"], ...over };
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
  const args = (idea: string): PrepareArgs => ({
    idea,
    fromSession: undefined,
    plantFrom: undefined,
    skipFrom: undefined,
    skipTopics: undefined,
    force: false,
    error: undefined,
  });
  it("accepts a build idea", () => {
    expect(preflight(validConfig({}), "prepare", args("a tycoon game"), null)).toEqual({ ok: true });
  });
  it("rejects when neither idea nor --from-session is given", () => {
    const r = preflight(validConfig({}), "prepare", args(""), null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/idea|--from-session/i);
  });
});

describe("preflight — prepare (extract --from-session)", () => {
  it("accepts an existing --from-session path", () => {
    const args: PrepareArgs = {
      idea: undefined,
      fromSession: "/s.jsonl",
      plantFrom: undefined,
      skipFrom: undefined,
      skipTopics: undefined,
      force: false,
      error: undefined,
    };
    expect(preflight(validConfig({}), "prepare", args, exists(new Set(["/s.jsonl"])))).toEqual({ ok: true });
  });
  it("rejects a non-existent --from-session path", () => {
    const args: PrepareArgs = {
      idea: undefined,
      fromSession: "/missing.jsonl",
      plantFrom: undefined,
      skipFrom: undefined,
      skipTopics: undefined,
      force: false,
      error: undefined,
    };
    const r = preflight(validConfig({}), "prepare", args, exists(new Set()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/from-session|exist/i);
  });
  it("rejects when BOTH idea and --from-session are given (mutual exclusivity, R5-2)", () => {
    const args: PrepareArgs = {
      idea: "a tycoon game",
      fromSession: "/s.jsonl",
      plantFrom: undefined,
      skipFrom: undefined,
      skipTopics: undefined,
      force: false,
      error: undefined,
    };
    const r = preflight(validConfig({}), "prepare", args, exists(new Set(["/s.jsonl"])));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/both|either|one of/i);
  });
});

describe("preflight — run-scenario folder", () => {
  it("accepts an existing folder", () => {
    expect(preflight(validConfig({}), "run-scenario", { value: "/repo" }, exists(new Set(["/repo"])))).toEqual({
      ok: true,
    });
  });
  it("rejects a missing folder", () => {
    const r = preflight(validConfig({}), "run-scenario", { value: "/nope" }, exists(new Set()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/folder|exist/i);
  });
  it("rejects when no folder is given", () => {
    const r = preflight(validConfig({}), "run-scenario", { value: undefined }, exists(new Set()));
    expect(r.ok).toBe(false);
  });
});

describe("preflight — run-session-file path", () => {
  it("accepts an existing path", () => {
    expect(
      preflight(validConfig({}), "run-session-file", { value: "/s.jsonl" }, exists(new Set(["/s.jsonl"]))),
    ).toEqual({
      ok: true,
    });
  });
  it("rejects a non-existent path", () => {
    const r = preflight(validConfig({}), "run-session-file", { value: "/missing.jsonl" }, exists(new Set()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/session file|exist/i);
  });
  it("rejects when no path is given", () => {
    const r = preflight(validConfig({}), "run-session-file", { value: undefined }, exists(new Set()));
    expect(r.ok).toBe(false);
  });
});

describe("preflight — results", () => {
  it("accepts at least one runId", () => {
    const args: ResultsArgs = { runs: [{ runId: "r1" }], error: undefined };
    expect(preflight(validConfig({}), "results", args, null)).toEqual({ ok: true });
  });
  it("rejects when no runId is given", () => {
    const args: ResultsArgs = { runs: [], error: undefined };
    const r = preflight(validConfig({}), "results", args, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/runId/i);
  });
});

describe("preflight — recovery modes (--plant / --skip-topics --from)", () => {
  const rec = (over: Partial<PrepareArgs>): PrepareArgs => ({
    idea: undefined,
    fromSession: undefined,
    plantFrom: undefined,
    skipFrom: undefined,
    skipTopics: undefined,
    force: false,
    error: undefined,
    ...over,
  });
  const cfg = validConfig({});

  it("plant mode ok when the folder exists", () => {
    expect(preflight(cfg, "prepare", rec({ plantFrom: "/scen/x" }), () => true)).toEqual({ ok: true });
  });

  it("plant folder missing → refuse", () => {
    expect(preflight(cfg, "prepare", rec({ plantFrom: "/scen/x" }), () => false).ok).toBe(false);
  });

  it("plant + idea (two modes) → refuse", () => {
    const r = preflight(cfg, "prepare", rec({ plantFrom: "/scen/x", idea: "a game" }), () => true);
    expect(r.ok).toBe(false);
  });

  it("plant + skip-topics → refuse (skip belongs to --from)", () => {
    const r = preflight(cfg, "prepare", rec({ plantFrom: "/scen/x", skipTopics: ["change-mind"] }), () => true);
    expect(r.ok).toBe(false);
  });

  it("skip mode ok when folder exists + ids given", () => {
    const r = preflight(cfg, "prepare", rec({ skipFrom: "/scen/x", skipTopics: ["change-mind"] }), () => true);
    expect(r).toEqual({ ok: true });
  });

  it("--from without --skip-topics → refuse", () => {
    expect(preflight(cfg, "prepare", rec({ skipFrom: "/scen/x" }), () => true).ok).toBe(false);
  });

  it("--skip-topics without --from → refuse", () => {
    expect(preflight(cfg, "prepare", rec({ skipTopics: ["change-mind"] }), () => true).ok).toBe(false);
  });

  it("skip folder missing → refuse", () => {
    const r = preflight(cfg, "prepare", rec({ skipFrom: "/scen/x", skipTopics: ["change-mind"] }), () => false);
    expect(r.ok).toBe(false);
  });
});
