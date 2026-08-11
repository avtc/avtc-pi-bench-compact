// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import type { BuildSeams } from "../../src/production/build.js";
import { prepareScenario } from "../../src/production/prepare.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const scenarioCtx = {
  id: "t",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
  taskObjective: { description: "b", testSpec: "npm test", lane: "embedded-test" as const },
};

const cannedManifest: ScenarioManifest = {
  id: "t",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "p" },
  recallFacts: [{ id: "rf1", fact: "x", accept: ["x"], entryIds: ["e1"], domain: "technical", lanes: [] }],
  doneOps: [{ id: "do1", description: "x", artifact: "f", reworkable: false, entryIds: ["e2"], lanes: [] }],
  supersessions: [{ id: "ss1", subject: "x", oldValue: "a", latestValue: "b", entryIds: ["e3"], lanes: [] }],
  abstentions: [{ id: "ab1", question: "q?", correctRefusal: true, entryIds: ["e3"], lanes: [] }],
  taskObjective: { description: "b", testSpec: "npm test", lane: "embedded-test" },
  probes: [],
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bench-prepare-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "game.ts"), "export const x = 1;");
  const manifestPath = join(root, "manifest.json");
  const preSliceDir = join(root, "sliced");
  mkdirSync(preSliceDir, { recursive: true });
  return { root, repo, manifestPath, preSliceDir };
}

describe("prepareScenario — build mode", () => {
  it("drives build → freeze: main holds session.jsonl + files, manifest outside repo", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      const backupPath = join(root, "built.jsonl");
      writeFileSync(
        backupPath,
        [
          JSON.stringify({ type: "session", id: "s1", timestamp: "t0", cwd: repo }),
          ...["e1", "e2", "e3", "e4", "e5"].map((id) =>
            JSON.stringify({
              type: "message",
              id,
              parentId: null,
              timestamp: "t",
              message: { role: "user", content: id },
            }),
          ),
        ].join("\n"),
      );
      const seams: BuildSeams = {
        async driveAndCapture() {
          return { backupPath, backupEntries: ["e1", "e2", "e3", "e4", "e5"].map((id) => ({ id })) };
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" }; // e1,e2,e3 in-span
        },
        async author() {
          return cannedManifest; // all conditions cite e1/e2/e3 (< e4) → landed
        },
      };
      const result = await prepareScenario({
        scenario: "tycoon",
        compactionBoundary: 140000,
        repoPath: repo,
        manifestPath,
        preSliceDir,
        scenarioCtx,
        seams,
      });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      const files = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
      expect(files).toContain("session.jsonl");
      expect(files).toContain("game.ts");
      expect(files).not.toContain("manifest.json");
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).recallFacts[0].id).toBe("rf1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareScenario — extract mode", () => {
  it("extracts a real session → trial → author → freeze", async () => {
    const { root, repo, manifestPath, preSliceDir } = setup();
    try {
      // a real session file at process.cwd() (use repo as the coherent cwd)
      const sessionPath = join(root, "real.jsonl");
      writeFileSync(
        sessionPath,
        [
          JSON.stringify({ type: "session", id: "s1", timestamp: "t0", cwd: root }), // cwd === root (coherent)
          ...["e1", "e2", "e3", "e4", "e5"].map((id) =>
            JSON.stringify({
              type: "message",
              id,
              parentId: null,
              timestamp: "t",
              message: { role: "user", content: id },
            }),
          ),
        ].join("\n"),
      );
      const extractOutput = join(root, "cleaned.jsonl");
      const seams: BuildSeams = {
        async driveAndCapture() {
          throw new Error("driveAndCapture should not be called in extract mode");
        },
        async trialCompact() {
          return { firstKeptEntryId: "e4", summary: "cut at e4" };
        },
        async author() {
          return cannedManifest;
        },
      };
      const result = await prepareScenario({
        fromSessionPath: sessionPath,
        extractOutputPath: extractOutput,
        extractCwd: root, // coherent with the session header cwd
        compactionBoundary: 140000,
        repoPath: repo,
        manifestPath,
        preSliceDir,
        scenarioCtx,
        seams,
      });
      expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
      expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n")).toContain("session.jsonl");
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).id).toBe("t");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
