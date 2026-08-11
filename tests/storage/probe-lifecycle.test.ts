// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for isQaOnlyBranch — uses real git in temp repos with synthetic session JSONL.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isQaOnlyBranch } from "../../src/storage/probe-lifecycle.js";
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

describe("isQaOnlyBranch (real git, synthetic JSONL)", () => {
  let repo: string;
  let base: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "bench-probe-"));
    // base session: session header + a user question
    writeFileSync(path.join(repo, "session.jsonl"), `${[SESSION, USER("base-q")].join("\n")}\n`);
    writeFileSync(path.join(repo, "game.ts"), "export const x = 1;\n");
    initScenarioRepo(repo, { message: "base" });
    base = "main";
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function probeBranch(name: string): string {
    forkBranch(repo, base, name);
    checkout(repo, name);
    return name;
  }
  function appendSession(lines: string[]): void {
    const prev = readFileSync(path.join(repo, "session.jsonl"), "utf8");
    writeFileSync(path.join(repo, "session.jsonl"), `${prev}${lines.join("\n")}\n`);
  }

  it("true when the probe added only Q&A text messages (no toolCall/toolResult/file change)", () => {
    const br = probeBranch("p-qa");
    appendSession([ASSISTANT_TEXT("just a text answer")]);
    commitAll(repo, "probe qa");
    expect(isQaOnlyBranch(repo, base, br)).toBe(true);
  });

  it("false when the probe added a toolCall (assistant invoked a tool)", () => {
    const br = probeBranch("p-tool");
    appendSession([ASSISTANT_TOOL("tool"), TOOL_RESULT("res")]);
    commitAll(repo, "probe tool");
    expect(isQaOnlyBranch(repo, base, br)).toBe(false);
  });

  it("false when the probe added a toolResult entry", () => {
    const br = probeBranch("p-res");
    appendSession([ASSISTANT_TEXT("ans"), TOOL_RESULT("only-result")]);
    commitAll(repo, "probe result");
    expect(isQaOnlyBranch(repo, base, br)).toBe(false);
  });

  it("false when the probe mutated a project file (not just session.jsonl)", () => {
    const br = probeBranch("p-file");
    appendSession([ASSISTANT_TEXT("ans")]);
    writeFileSync(path.join(repo, "game.ts"), "export const x = 2;\n");
    commitAll(repo, "probe file-edit");
    expect(isQaOnlyBranch(repo, base, br)).toBe(false);
  });

  it("true when the probe changed nothing (empty diff)", () => {
    const br = probeBranch("p-empty"); // forked == base, no changes committed
    expect(isQaOnlyBranch(repo, base, br)).toBe(true);
  });
});
