// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { parsePositional, parsePrepareArgs, parseResultsArgs, parseRunScenarioArgs } from "../../src/commands/parse.js";

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
  it("extracts --from-session=PATH (equals form,)", () => {
    expect(parsePrepareArgs("--from-session=/sessions/real.jsonl")).toEqual({
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
  it("errors when --from-session is followed by another flag", () => {
    const r = parsePrepareArgs("--from-session --force");
    expect(r.error).toMatch(/from-session/i);
    expect(r.fromSession).toBeUndefined();
  });
  it("errors when --from-session= has an empty value", () => {
    const r = parsePrepareArgs("--from-session=");
    expect(r.error).toMatch(/from-session/i);
    expect(r.fromSession).toBeUndefined();
  });
  it("empty args -> nothing set, no error (completeness is preflight's job)", () => {
    expect(parsePrepareArgs("")).toEqual({
      idea: undefined,
      fromSession: undefined,
      plantFrom: undefined,
      skipFrom: undefined,
      skipTopics: undefined,
      force: false,
      error: undefined,
    });
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
  it("errors when runId is empty (:A1 —)", () => {
    const r = parseResultsArgs(":A1");
    expect(r.error).toMatch(/runId/i);
    expect(r.runs).toEqual([]);
  });
  it("errors when :arms is empty (run1: —)", () => {
    const r = parseResultsArgs("run1:");
    expect(r.error).toMatch(/arm/i);
    expect(r.runs).toEqual([]);
  });
  it("errors on a trailing comma in :arms (space-after-comma,)", () => {
    // "run1:A1, A3" tokenizes -> "run1:A1," + "A3"; the trailing comma signals the mistake.
    const r = parseResultsArgs("run1:A1, A3");
    expect(r.error).toMatch(/comma|space/i);
    expect(r.runs).toEqual([]);
  });
  it("errors on a leading comma in :arms", () => {
    const r = parseResultsArgs("run1:,A1");
    expect(r.error).toMatch(/comma|empty/i);
    expect(r.runs).toEqual([]);
  });
  it("errors on an internal double comma in :arms", () => {
    const r = parseResultsArgs("run1:A1,,A3");
    expect(r.error).toMatch(/comma|empty/i);
    expect(r.runs).toEqual([]);
  });
  it("errors when no runId is given", () => {
    expect(parseResultsArgs("").error).toMatch(/runId/i);
  });
});

describe("parsePositional", () => {
  it("returns the trimmed arg verbatim, preserving internal spaces", () => {
    expect(parsePositional("/path/with spaces/here")).toEqual({ value: "/path/with spaces/here", error: undefined });
  });
  it("empty -> undefined value, no error", () => {
    expect(parsePositional("")).toEqual({ value: undefined, error: undefined });
  });
});

describe("parsePrepareArgs — recovery flags (--plant / --skip-topics / --from)", () => {
  it("parses --plant <folder>", () => {
    const r = parsePrepareArgs("--plant /scen/2026-08-14-1");
    expect(r.plantFrom).toBe("/scen/2026-08-14-1");
    expect(r.idea).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("parses --skip-topics a,b --from <folder> (space form)", () => {
    const r = parsePrepareArgs("--skip-topics change-mind,open-question --from /scen/x");
    expect(r.skipTopics).toEqual(["change-mind", "open-question"]);
    expect(r.skipFrom).toBe("/scen/x");
    expect(r.error).toBeUndefined();
  });

  it("parses --skip-topics=a,b (equals form, space-free ids)", () => {
    const r = parsePrepareArgs("--skip-topics=change-mind,open-question");
    expect(r.skipTopics).toEqual(["change-mind", "open-question"]);
  });

  it("--plant with no value errors", () => {
    expect(parsePrepareArgs("--plant").error).toMatch(/--plant requires a value/);
  });

  it("--plant followed by another flag errors", () => {
    expect(parsePrepareArgs("--plant --force").error).toMatch(/--plant requires a value/);
  });

  it("--skip-topics with empty entries errors", () => {
    expect(parsePrepareArgs("--skip-topics a,,b").error).toMatch(/no empty entries/);
    expect(parsePrepareArgs("--skip-topics=").error).toMatch(/non-empty/);
  });

  it("--from with no value errors", () => {
    expect(parsePrepareArgs("--from").error).toMatch(/--from requires a value/);
  });
});

describe("parsePrepareArgs — eq-forms + unknown flags", () => {
  it("accepts --plant=<folder> (inline eq-form)", () => {
    const r = parsePrepareArgs("--plant=/scen/abc");
    expect(r.error).toBeUndefined();
    expect(r.plantFrom).toBe("/scen/abc");
  });

  it("accepts --from=<folder> (inline eq-form)", () => {
    const r = parsePrepareArgs("--skip-topics change-mind --from=/scen/abc");
    expect(r.error).toBeUndefined();
    expect(r.skipFrom).toBe("/scen/abc");
    expect(r.skipTopics).toEqual(["change-mind"]);
  });

  it("rejects an empty eq value", () => {
    expect(parsePrepareArgs("--plant=").error).toContain("--plant=");
    expect(parsePrepareArgs("--from=").error).toContain("--from=");
  });

  it("rejects an unknown --flag instead of silently making it the idea", () => {
    const r = parsePrepareArgs("my tycoon idea --forc");
    expect(r.error).toContain('unknown flag "--forc"');
    expect(r.idea).not.toContain("--forc"); // the flag never becomes idea text
  });

  it("rejects a lone unknown flag token", () => {
    const r = parsePrepareArgs("--idea=x");
    expect(r.error).toContain("unknown flag");
  });
});

describe("parseRunScenarioArgs", () => {
  it("parses a bare folder (no flags)", () => {
    const r = parseRunScenarioArgs("~/.pi/bench-compact/scenarios/ae2d92c1");
    expect(r).toEqual({
      folder: "~/.pi/bench-compact/scenarios/ae2d92c1",
      resume: undefined,
      allowConfigChange: false,
      reuseBases: false,
      rescore: false,
      error: undefined,
    });
  });

  it("parses --resume (bare — auto-detect)", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume");
    expect(r.folder).toBe("/scen/abc");
    expect(r.resume).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("parses --resume=<runId> (explicit) in either position", () => {
    const a = parseRunScenarioArgs("/scen/abc --resume=2026-08-16-4");
    const b = parseRunScenarioArgs("--resume=2026-08-16-4 /scen/abc");
    expect(a).toEqual({
      folder: "/scen/abc",
      resume: "2026-08-16-4",
      allowConfigChange: false,
      reuseBases: false,
      rescore: false,
      error: undefined,
    });
    expect(b).toEqual({
      folder: "/scen/abc",
      resume: "2026-08-16-4",
      allowConfigChange: false,
      reuseBases: false,
      rescore: false,
      error: undefined,
    });
  });

  it("parses --allow-config-change alongside --resume (either order)", () => {
    const a = parseRunScenarioArgs("/scen/abc --resume --allow-config-change");
    const b = parseRunScenarioArgs("--allow-config-change --resume=2026-08-16-4 /scen/abc");
    expect(a.resume).toBe(true);
    expect(a.allowConfigChange).toBe(true);
    expect(a.error).toBeUndefined();
    expect(b.resume).toBe("2026-08-16-4");
    expect(b.allowConfigChange).toBe(true);
    expect(b.error).toBeUndefined();
  });

  it("parses --reuse-bases alongside --resume --allow-config-change", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume --allow-config-change --reuse-bases");
    expect(r.resume).toBe(true);
    expect(r.allowConfigChange).toBe(true);
    expect(r.reuseBases).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("rejects --reuse-bases without --resume", () => {
    const r = parseRunScenarioArgs("/scen/abc --reuse-bases");
    expect(r.error).toContain("--reuse-bases requires --resume");
  });

  it("rejects --allow-config-change without --resume", () => {
    const r = parseRunScenarioArgs("/scen/abc --allow-config-change");
    expect(r.error).toContain("--allow-config-change requires --resume");
  });

  it("rejects --rescore with a bare --resume (an explicit runId is required)", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume --rescore");
    expect(r.error).toContain("--rescore requires an explicit --resume=<runId>");
  });

  it("parses --rescore alongside an explicit --resume=<runId>", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume=2026-08-16-4 --rescore");
    expect(r.error).toBeUndefined();
    expect(r.rescore).toBe(true);
  });

  it("allows --resume with no folder yet (completeness is preflight's job)", () => {
    const r = parseRunScenarioArgs("--resume");
    expect(r.folder).toBeUndefined();
    expect(r.resume).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("rejects --resume= with an empty id", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume=");
    expect(r.error).toContain("--resume= requires a non-empty runId");
  });

  it("rejects an unknown flag", () => {
    const r = parseRunScenarioArgs("/scen/abc --resum");
    expect(r.error).toContain('unknown flag "--resum"');
  });

  it("rejects multiple positionals (a folder path with spaces must be quoted)", () => {
    const r = parseRunScenarioArgs("/scen/with spaces --resume");
    expect(r.error).toContain("expected one scenario folder path, got 2 tokens");
    expect(r.folder).toBeUndefined();
  });

  it("last --resume form wins on repetition", () => {
    const r = parseRunScenarioArgs("/scen/abc --resume --resume=2026-08-16-4");
    expect(r.resume).toBe("2026-08-16-4");
  });
});

describe("parsePrepareArgs — --re-author <folder>", () => {
  it("parses the space form", () => {
    const r = parsePrepareArgs("--re-author ~/.pi/bench-compact/scenarios/ae2d92c1");
    expect(r.error).toBeUndefined();
    expect(r.reAuthorFrom).toBe("~/.pi/bench-compact/scenarios/ae2d92c1");
  });

  it("parses the inline = form", () => {
    const r = parsePrepareArgs("--re-author=/tmp/scen");
    expect(r.error).toBeUndefined();
    expect(r.reAuthorFrom).toBe("/tmp/scen");
  });

  it("errors when the value is missing or another flag", () => {
    expect(parsePrepareArgs("--re-author").error).toMatch(/requires a value/);
    expect(parsePrepareArgs("--re-author --force").error).toMatch(/requires a value/);
  });
});

describe("parseRunScenarioArgs — --resume=<runId> format tolerance", () => {
  it("accepts the bare date-id form", () => {
    const r = parseRunScenarioArgs("C:/s --resume=2026-08-16-4");
    expect(r.error).toBeUndefined();
    expect(r.resume).toBe("2026-08-16-4");
  });

  it("normalizes the run- prefixed form (branch-name style) to the bare runId", () => {
    const r = parseRunScenarioArgs("C:/s --resume=run-2026-08-16-4");
    expect(r.error).toBeUndefined();
    expect(r.resume).toBe("2026-08-16-4");
  });

  it("still rejects an empty value", () => {
    expect(parseRunScenarioArgs("C:/s --resume=").error).toMatch(/non-empty runId/);
  });
});
