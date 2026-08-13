// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNotInRepo,
  benchRoot,
  branchSessionFile,
  configPath,
  isInsideRepo,
  runDir,
  scenarioDir,
  scenarioManifest,
  scenarioRepo,
  scenarioSessionsDir,
} from "../../src/storage/paths.js";

describe("benchRoot", () => {
  it("defaults to ~/.pi/bench-compact when outputDir is null/undefined", () => {
    expect(benchRoot(null)).toMatch(/[\\/]\.pi[\\/]bench-compact$/);
    expect(benchRoot(undefined)).toMatch(/[\\/]\.pi[\\/]bench-compact$/);
  });
  it("uses outputDir when provided", () => {
    expect(benchRoot("/tmp/bench-out")).toBe("/tmp/bench-out");
  });
});

describe("path builders", () => {
  const root = "/tmp/bench";
  it("scenario paths nest under scenarios/<id>", () => {
    expect(scenarioDir(root, "s1")).toBe(path.join(root, "scenarios", "s1"));
    expect(scenarioRepo(root, "s1")).toBe(path.join(root, "scenarios", "s1", "repo"));
    expect(scenarioManifest(root, "s1")).toBe(path.join(root, "scenarios", "s1", "manifest.json"));
  });
  it("run paths nest under runs/<runId>", () => {
    expect(runDir(root, "run-1")).toBe(path.join(root, "runs", "run-1"));
  });
  it("config paths nest under configs/<cfgId>.json", () => {
    expect(configPath(root, "cfg-a3f2c1")).toBe(path.join(root, "configs", "cfg-a3f2c1.json"));
  });
});

describe("sessions store (scenarioSessionsDir + branchSessionFile)", () => {
  const root = "/tmp/bench";
  it("scenarioSessionsDir is a sibling of repo/ under scenarios/<id>", () => {
    expect(scenarioSessionsDir(root, "s1")).toBe(path.join(root, "scenarios", "s1", "sessions"));
    // sibling of repo/ + manifest.json (NOT inside repo/) → agent-invisible
    expect(path.dirname(scenarioSessionsDir(root, "s1"))).toBe(path.dirname(scenarioRepo(root, "s1")));
  });
  it("branchSessionFile sanitizes branch slashes (git branch names can't be filenames)", () => {
    const dir = scenarioSessionsDir(root, "s1");
    expect(branchSessionFile(dir, "bench-compact/run-x/cfg-y/arm-bare-pi")).toBe(
      path.join(dir, "bench-compact-run-x-cfg-y-arm-bare-pi.jsonl"),
    );
  });
  it("branchSessionFile is deterministic (same branch → same file)", () => {
    const dir = scenarioSessionsDir(root, "s1");
    const branch = "bench-compact/run-2026-08-11-1/cfg-ab12/arm-om-default-g4a2f8e";
    expect(branchSessionFile(dir, branch)).toBe(branchSessionFile(dir, branch));
  });
  it("branchSessionFile preserves safe chars [a-zA-Z0-9._-] and replaces everything else", () => {
    const dir = scenarioSessionsDir(root, "s1");
    expect(branchSessionFile(dir, "main")).toBe(path.join(dir, "main.jsonl"));
    // a space + a slash both become '-'
    expect(branchSessionFile(dir, "arm with space/v1")).toBe(path.join(dir, "arm-with-space-v1.jsonl"));
  });
  it("scenarioSessionsDir rejects a scenarioId that escapes scenarios/ (traversal guard)", () => {
    expect(() => scenarioSessionsDir(root, "../configs/cfg-x")).toThrow(/unsafe scenario/i);
  });
});

describe("path-traversal guard (R1-3: ids cannot escape their subdir)", () => {
  const root = "/tmp/bench";
  it("configPath rejects a cfgId that escapes configs/ into a repo", () => {
    expect(() => configPath(root, "../scenarios/s1/repo/evil")).toThrow(/unsafe cfgId/i);
    expect(() => configPath(root, "..\\scenarios\\s1\\repo\\evil")).toThrow(/unsafe cfgId/i);
  });
  it("scenarioDir rejects a scenarioId that escapes scenarios/", () => {
    expect(() => scenarioDir(root, "../configs/cfg-x")).toThrow(/unsafe scenario/i);
    expect(() => scenarioDir(root, "..")).toThrow(/unsafe scenario/i);
  });
  it("runDir rejects a runId that escapes runs/", () => {
    expect(() => runDir(root, "../../etc/passwd")).toThrow(/unsafe run/i);
  });
  it("valid ids are accepted", () => {
    expect(() => configPath(root, "cfg-a3f2c1")).not.toThrow();
    expect(() => scenarioDir(root, "2026-08-10-tycoon")).not.toThrow();
    expect(() => runDir(root, "run-2026-08-10-1")).not.toThrow();
  });
});

describe("contamination rule (isInsideRepo / assertNotInRepo)", () => {
  const repo = path.join("/tmp/bench", "scenarios", "s1", "repo");
  it("isInsideRepo: true for paths under the repo, false for siblings/outside", () => {
    expect(isInsideRepo(path.join(repo, "session.jsonl"), repo)).toBe(true);
    expect(isInsideRepo(path.join(repo, "src", "game.ts"), repo)).toBe(true);
    expect(isInsideRepo(repo, repo)).toBe(false); // the repo root itself is not "inside"
    // manifest.json is a sibling of repo/ (under scenarios/s1/), NOT inside repo/
    expect(isInsideRepo(path.join(repo, "..", "manifest.json"), repo)).toBe(false);
    // configs/ is under the bench root, far outside the repo
    expect(isInsideRepo(path.join("/tmp/bench", "configs", "cfg-x.json"), repo)).toBe(false);
  });
  it("assertNotInRepo: passes for outside paths, throws for inside paths", () => {
    expect(() => assertNotInRepo(path.join("/tmp/bench", "configs", "cfg-x.json"), repo)).not.toThrow();
    expect(() => assertNotInRepo(path.join(repo, "..", "manifest.json"), repo)).not.toThrow();
    expect(() => assertNotInRepo(path.join(repo, "session.jsonl"), repo)).toThrow(/contamination/i);
    expect(() => assertNotInRepo(path.join(repo, "src", "game.ts"), repo)).toThrow(/contamination/i);
  });
});
