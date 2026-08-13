// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for isQaOnlyBranch + addedSessionLines. The session transcript now lives
// OUTSIDE the repo (in a per-branch sessions store), so isQaOnlyBranch compares two
// session FILES directly (baseSessionFile vs probeSessionFile) for the added-lines
// check, while the git diff (diffNameOnly) still guards project-file changes.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addedSessionLines, isQaOnlyBranch } from "../../src/storage/probe-lifecycle.js";
import { checkout, commitAll, forkBranch, initScenarioRepo } from "../../src/storage/repo.js";

// Synthetic JSONL entries (pi shape: {type:"message", message:{role, content:[{type,...}]}})
const SESSION = '{"type":"session","cwd":"/x"}';
const USER = (t: string) =>
  `{"type":"message","id":"u-${t}","message":{"role":"user","content":[{"type":"text","text":"${t}"}]}}`;
const ASSISTANT_TEXT = (t: string) =>
  `{"type":"message","id":"a-${t}","message":{"role":"assistant","content":[{"type":"thinking","text":"m"},{"type":"text","text":"${t}"}]}}`;
const ASSISTANT_TOOL = (t: string) =>
  `{"type":"message","id":"a-${t}","message":{"role":"assistant","content":[{"type":"text","text":""},{"type":"toolCall","name":"read","args":{}}]}}`;
const TOOL_RESULT = (t: string) =>
  `{"type":"message","id":"r-${t}","message":{"role":"toolResult","content":[{"type":"text","text":"${t}"}]}}`;

describe("isQaOnlyBranch (real git + two session files)", () => {
  let repo: string;
  let sessionsDir: string;
  let baseSessionFile: string;
  const BASE_BRANCH = "main";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "bench-probe-"));
    sessionsDir = mkdtempSync(path.join(tmpdir(), "bench-probe-sessions-"));
    // repo tracks ONLY project files (session.jsonl is NOT in the repo anymore)
    writeFileSync(path.join(repo, "game.ts"), "export const x = 1;\n");
    initScenarioRepo(repo, { message: "base" });
    // base session: session header + a user question (lives OUTSIDE the repo)
    baseSessionFile = path.join(sessionsDir, "base.jsonl");
    writeFileSync(baseSessionFile, `${[SESSION, USER("base-q")].join("\n")}\n`);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  /** Fork main→branch, optionally mutate a project file, commit, write the probe
   *  session file (base + appended lines), return the probe session-file path. */
  function probeBranch(name: string, appended: string[], mutateFile: boolean): string {
    forkBranch(repo, BASE_BRANCH, name);
    checkout(repo, name);
    if (mutateFile) {
      writeFileSync(path.join(repo, "game.ts"), "export const x = 2;\n");
    }
    commitAll(repo, `probe ${name}`);
    const probeSessionFile = path.join(sessionsDir, `${name}.jsonl`);
    writeFileSync(probeSessionFile, `${[SESSION, USER("base-q"), ...appended].join("\n")}\n`);
    return probeSessionFile;
  }

  it("true when the probe added only Q&A text messages (no toolCall/toolResult/file change)", () => {
    const probeFile = probeBranch("p-qa", [ASSISTANT_TEXT("just a text answer")], false);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-qa", baseSessionFile, probeFile)).toBe(true);
  });

  it("false when the probe added a toolCall (assistant invoked a tool)", () => {
    const probeFile = probeBranch("p-tool", [ASSISTANT_TOOL("tool"), TOOL_RESULT("res")], false);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-tool", baseSessionFile, probeFile)).toBe(false);
  });

  it("false when the probe added a toolResult entry", () => {
    const probeFile = probeBranch("p-res", [ASSISTANT_TEXT("ans"), TOOL_RESULT("only-result")], false);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-res", baseSessionFile, probeFile)).toBe(false);
  });

  it("false when the probe mutated a project file (git diff on project files)", () => {
    const probeFile = probeBranch("p-file", [ASSISTANT_TEXT("ans")], true);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-file", baseSessionFile, probeFile)).toBe(false);
  });

  it("true when the probe changed nothing (empty append + no file change)", () => {
    const probeFile = probeBranch("p-empty", [], false);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-empty", baseSessionFile, probeFile)).toBe(true);
  });

  it("false when the probe MODIFIED a base entry (probe prefix != base — R1-4)", () => {
    forkBranch(repo, BASE_BRANCH, "p-mod");
    checkout(repo, "p-mod");
    commitAll(repo, "probe modify");
    // probe session replaces the base user line (not a clean append)
    const probeFile = path.join(sessionsDir, "p-mod.jsonl");
    writeFileSync(probeFile, `${[SESSION, USER("changed-q")].join("\n")}\n`);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-mod", baseSessionFile, probeFile)).toBe(false);
  });

  it("false when an added session line is unparseable (defensive keep — Issue #1)", () => {
    const probeFile = probeBranch("p-bad", ["this is not valid json"], false);
    expect(isQaOnlyBranch(repo, BASE_BRANCH, "p-bad", baseSessionFile, probeFile)).toBe(false);
  });
});

describe("addedSessionLines (pure helper)", () => {
  it("returns the probe's tail past the base prefix (clean append)", () => {
    const base = [SESSION, USER("q")].join("\n");
    const probe = [SESSION, USER("q"), ASSISTANT_TEXT("a1"), ASSISTANT_TEXT("a2")].join("\n");
    expect(addedSessionLines(base, probe)).toEqual([ASSISTANT_TEXT("a1"), ASSISTANT_TEXT("a2")]);
  });

  it("returns [] when the probe adds nothing (probe === base)", () => {
    const base = [SESSION, USER("q")].join("\n");
    expect(addedSessionLines(base, base)).toEqual([]);
  });

  it("throws when the probe does not start with the base (a line was modified)", () => {
    const base = [SESSION, USER("q")].join("\n");
    const probe = [SESSION, USER("changed")].join("\n");
    expect(() => addedSessionLines(base, probe)).toThrow(/not a clean append|modif/i);
  });

  it("throws when the probe is shorter than the base (a line was removed)", () => {
    const base = [SESSION, USER("q"), ASSISTANT_TEXT("a")].join("\n");
    const probe = [SESSION, USER("q")].join("\n");
    expect(() => addedSessionLines(base, probe)).toThrow(/not a clean append|shorter/i);
  });

  it("ignores trailing blank lines when splitting (robust to trailing newline)", () => {
    const base = `${SESSION}\n${USER("q")}\n`;
    const probe = `${SESSION}\n${USER("q")}\n${ASSISTANT_TEXT("a")}\n`;
    expect(addedSessionLines(base, probe)).toEqual([ASSISTANT_TEXT("a")]);
  });
});
