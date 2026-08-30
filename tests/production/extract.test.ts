// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractError, extractBackup } from "../../src/production/extract.js";

function writeSession(dir: string, name: string, entries: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return path;
}

const header = (cwd: string) => ({ type: "session", id: "s1", timestamp: "t0", cwd });
const msg = (id: string, role: string, content: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "t1",
  message: { role, content },
});
const custom = (id: string, customType: string) => ({
  type: "custom",
  id,
  parentId: null,
  timestamp: "t2",
  customType,
  data: { x: 1 },
});

const CWD = "/repo";

describe("extractBackup — guards", () => {
  it("accepts a clean un-compacted session (no CompactionEntry, cwd matches)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-extract-"));
    try {
      const src = writeSession(dir, "src.jsonl", [header(CWD), msg("e1", "user", "hi"), msg("e2", "assistant", "yo")]);
      const out = join(dir, "clean.jsonl");
      const result = extractBackup({ fromSessionPath: src, outputPath: out, cwd: CWD });
      expect(result.backupPath).toBe(out);
      expect(result.sourceCwd).toBe(CWD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a session containing a CompactionEntry (must be pre-compacted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-extract-"));
    try {
      const src = writeSession(dir, "src.jsonl", [
        header(CWD),
        msg("e1", "user", "hi"),
        {
          type: "compaction",
          id: "c1",
          parentId: "e1",
          timestamp: "t3",
          summary: "...",
          firstKeptEntryId: "e2",
          tokensBefore: 1000,
        },
      ]);
      expect(() => extractBackup({ fromSessionPath: src, outputPath: join(dir, "o.jsonl"), cwd: CWD })).toThrow(
        ExtractError,
      );
      expect(() => extractBackup({ fromSessionPath: src, outputPath: join(dir, "o.jsonl"), cwd: CWD })).toThrow(
        /compaction/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a cwd mismatch (header.cwd != process cwd — codebase not present)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-extract-"));
    try {
      const src = writeSession(dir, "src.jsonl", [header("/elsewhere"), msg("e1", "user", "hi")]);
      expect(() => extractBackup({ fromSessionPath: src, outputPath: join(dir, "o.jsonl"), cwd: CWD })).toThrow(
        ExtractError,
      );
      expect(() => extractBackup({ fromSessionPath: src, outputPath: join(dir, "o.jsonl"), cwd: CWD })).toThrow(/cwd/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractBackup — strip memory-extension entries", () => {
  it("strips session-owl.* + om.* custom entries, keeps renderable types", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-extract-"));
    try {
      const src = writeSession(dir, "src.jsonl", [
        header(CWD),
        msg("e1", "user", "hi"),
        custom("e2", "session-owl.observation"),
        custom("e3", "session-owl.selection"),
        custom("e4", "om.observation"),
        msg("e5", "assistant", "yo"),
      ]);
      const out = join(dir, "clean.jsonl");
      extractBackup({ fromSessionPath: src, outputPath: out, cwd: CWD });
      const cleaned = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; customType?: string });
      const ids = cleaned.map((e) => e.id);
      expect(ids).toEqual(["s1", "e1", "e5"]); // header + messages; memory customs dropped
      expect(cleaned.some((e) => e.customType?.startsWith("session-owl."))).toBe(false);
      expect(cleaned.some((e) => e.customType?.startsWith("om."))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-memory custom entries (e.g. todo/user-decisions) — only strips memory extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-extract-"));
    try {
      const src = writeSession(dir, "src.jsonl", [
        header(CWD),
        msg("e1", "user", "hi"),
        custom("e2", "todo.task"),
        custom("e3", "session-owl.observation"),
      ]);
      const out = join(dir, "clean.jsonl");
      extractBackup({ fromSessionPath: src, outputPath: out, cwd: CWD });
      const cleaned = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; customType?: string });
      const customTypes = cleaned.filter((e) => e.customType).map((e) => e.customType);
      expect(customTypes).toEqual(["todo.task"]); // todo kept, session-owl stripped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
