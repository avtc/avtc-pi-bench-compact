// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunConfig } from "../../src/storage/branches.js";
import { writeRunConfig } from "../../src/storage/configs.js";
import { configPath } from "../../src/storage/paths.js";

function sampleRunConfig(over: Partial<RunConfig>): RunConfig {
  return {
    evaluatedModel: "zai/glm-5.1",
    evaluatedThinkingLevel: "high",
    judgeModel: "anthropic/claude-sonnet-4",
    judgeThinkingLevel: "high",
    N: 10,
    compactionBoundary: 140000,
    armsEnabled: ["A1", "A2", "A3", "A4", "A5"],
    omFullReflectionThresholdTokens: 4000,
    backupMode: "build",
    toolVersions: {
      A3: { source: "git", commit: "g4a2f8e", full: "4a2f8e9abcdef" },
    },
    ...over,
  };
}

describe("writeRunConfig", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "bench-cfg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the full run config to configs/<cfgId>.json + returns the path", () => {
    const rc = sampleRunConfig({});
    const file = writeRunConfig("cfg-a3f2c1", rc, root);
    expect(file).toBe(configPath(root, "cfg-a3f2c1"));
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).toEqual(rc);
  });

  it("creates the configs/ dir if missing", () => {
    const rc = sampleRunConfig({});
    const file = writeRunConfig("cfg-deadbe", rc, root);
    expect(existsSync(path.dirname(file))).toBe(true);
  });

  it("contamination: the config path is exactly root/configs/<cfgId>.json, never in a repo", () => {
    const rc = sampleRunConfig({});
    const file = writeRunConfig("cfg-xyz123", rc, root);
    // exact path (R1-5: strengthen beyond substring checks)
    expect(file).toBe(path.join(root, "configs", "cfg-xyz123.json"));
    // strictly under root/configs (does not escape)
    expect(path.relative(path.join(root, "configs"), file)).toBe("cfg-xyz123.json");
    // outside any scenario repo (the agent's cwd)
    const scenarioRepo = path.join(root, "scenarios", "s1", "repo");
    expect(path.relative(scenarioRepo, file).startsWith("..")).toBe(true);
  });
});
