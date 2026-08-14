// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LandingState,
  parseLandingState,
  readLandingState,
  writeLandingState,
} from "../../src/production/landing-state.js";

const MANIFEST = {
  id: "scen-1",
  taskObjective: "build the game",
  domain: "technical",
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
} as unknown as LandingState["manifest"];

const STATE: LandingState = {
  missingTopics: [
    { id: "change-mind", label: "Changed mind", tag: "safeToSkip" },
    { id: "open-question", label: "Open question", tag: "safeToSkip" },
  ],
  skipOffered: true,
  buildSessionPath: "/scenario-x/pre-slice/build.jsonl",
  firstKeptEntryId: "e42",
  attempt: 2,
  scenario: "build a tycoon game",
  manifest: MANIFEST,
};

describe("landing-state", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "bench-landing-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("write → read roundtrips the full state", () => {
    const dir = tmp();
    const path = join(dir, "landing.json");
    writeLandingState(path, STATE);
    const back = readLandingState(path);
    expect(back.missingTopics).toEqual(STATE.missingTopics);
    expect(back.skipOffered).toBe(true);
    expect(back.buildSessionPath).toBe(STATE.buildSessionPath);
    expect(back.firstKeptEntryId).toBe("e42");
    expect(back.attempt).toBe(2);
    expect(back.scenario).toBe("build a tycoon game");
    expect(back.manifest).toEqual(MANIFEST);
  });

  it("write emits a trailing newline (JSONL-style files convention)", () => {
    const dir = tmp();
    const path = join(dir, "landing.json");
    writeLandingState(path, STATE);
    expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
  });

  it("rejects invalid JSON with a one-line error", () => {
    expect(() => parseLandingState("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects empty missingTopics (a surface always has ≥1 missing topic)", () => {
    expect(() => parseLandingState(JSON.stringify({ ...STATE, missingTopics: [] }))).toThrow(/missingTopics/);
  });

  it("rejects malformed topic entries (wrong shape)", () => {
    expect(() => parseLandingState(JSON.stringify({ ...STATE, missingTopics: [{ id: "x" }] }))).toThrow(
      /missingTopics/,
    );
  });

  it("rejects wrong-typed fields, naming the field", () => {
    expect(() => parseLandingState(JSON.stringify({ ...STATE, skipOffered: "yes" }))).toThrow(/skipOffered/);
    expect(() => parseLandingState(JSON.stringify({ ...STATE, attempt: -1 }))).toThrow(/attempt/);
    expect(() => parseLandingState(JSON.stringify({ ...STATE, firstKeptEntryId: "" }))).toThrow(/firstKeptEntryId/);
    expect(() => parseLandingState(JSON.stringify({ ...STATE, manifest: null }))).toThrow(/manifest/);
    expect(() => parseLandingState(JSON.stringify({ ...STATE, scenario: "" }))).toThrow(/scenario/);
  });
});
