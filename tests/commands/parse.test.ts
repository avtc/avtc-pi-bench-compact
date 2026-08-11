// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { parsePositional, parsePrepareArgs, parseResultsArgs } from "../../src/commands/parse.js";

describe("parsePrepareArgs", () => {
  it("treats a bare string as the build idea", () => {
    expect(parsePrepareArgs("an incremental AI tycoon game")).toEqual({
      idea: "an incremental AI tycoon game",
      fromSession: undefined,
      force: false,
      error: undefined,
    });
  });
  it("extracts --from-session <path>", () => {
    expect(parsePrepareArgs("--from-session /sessions/real.jsonl")).toEqual({
      idea: undefined,
      fromSession: "/sessions/real.jsonl",
      force: false,
      error: undefined,
    });
  });
  it("extracts --force (with idea)", () => {
    expect(parsePrepareArgs("some idea --force")).toEqual({
      idea: "some idea",
      fromSession: undefined,
      force: true,
      error: undefined,
    });
  });
  it("extracts --from-session + --force together", () => {
    expect(parsePrepareArgs("--force --from-session /p.jsonl")).toEqual({
      idea: undefined,
      fromSession: "/p.jsonl",
      force: true,
      error: undefined,
    });
  });
  it("errors when --from-session has no path", () => {
    const r = parsePrepareArgs("--from-session");
    expect(r.error).toMatch(/from-session/i);
    expect(r.fromSession).toBeUndefined();
  });
  it("errors when --from-session= has an empty value (R5-4)", () => {
    const r = parsePrepareArgs("--from-session=");
    expect(r.error).toMatch(/from-session/i);
    expect(r.fromSession).toBeUndefined();
  });
  it("empty args -> nothing set, no error (completeness is preflight's job)", () => {
    expect(parsePrepareArgs("")).toEqual({ idea: undefined, fromSession: undefined, force: false, error: undefined });
  });
});

describe("parseResultsArgs", () => {
  it("parses a single runId", () => {
    expect(parseResultsArgs("run-2026-08-10-1")).toEqual({ runs: [{ runId: "run-2026-08-10-1" }], error: undefined });
  });
  it("parses a runId with an :arms subset", () => {
    expect(parseResultsArgs("run1:A1,A3")).toEqual({ runs: [{ runId: "run1", arms: ["A1", "A3"] }], error: undefined });
  });
  it("parses multiple runIds (comparison)", () => {
    expect(parseResultsArgs("run1:A1,A3 run2:A2")).toEqual({
      runs: [
        { runId: "run1", arms: ["A1", "A3"] },
        { runId: "run2", arms: ["A2"] },
      ],
      error: undefined,
    });
  });
  it("errors on an invalid arm id in :arms", () => {
    const r = parseResultsArgs("run1:A1,A9");
    expect(r.error).toMatch(/arm/i);
  });
  it("errors when runId is empty (:A1 — R5-1)", () => {
    const r = parseResultsArgs(":A1");
    expect(r.error).toMatch(/runId/i);
    expect(r.runs).toEqual([]);
  });
  it("errors when :arms is empty (run1: — R5-1)", () => {
    const r = parseResultsArgs("run1:");
    expect(r.error).toMatch(/arm/i);
    expect(r.runs).toEqual([]);
  });
  it("errors when no runId is given", () => {
    expect(parseResultsArgs("").error).toMatch(/runId/i);
  });
});

describe("parsePositional", () => {
  it("joins all tokens into one positional value", () => {
    expect(parsePositional("/path/with spaces/here")).toEqual({ value: "/path/with spaces/here", error: undefined });
  });
  it("empty -> undefined value, no error", () => {
    expect(parsePositional("")).toEqual({ value: undefined, error: undefined });
  });
});
