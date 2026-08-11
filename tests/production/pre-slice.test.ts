// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preSlice } from "../../src/production/pre-slice.js";

/** A backup JSONL: header + 4 message entries (e1..e4). firstKeptEntryId will be e3. */
function writeBackup(dir: string): string {
  const path = join(dir, "backup.jsonl");
  const lines = [
    { type: "session", id: "s1", timestamp: "t0", cwd: "/repo" },
    { type: "message", id: "e1", parentId: null, timestamp: "t1", message: { role: "user", content: "first" } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: { role: "assistant", content: "second" } },
    { type: "message", id: "e3", parentId: "e2", timestamp: "t3", message: { role: "user", content: "kept-start" } },
    { type: "message", id: "e4", parentId: "e3", timestamp: "t4", message: { role: "assistant", content: "kept-end" } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("preSlice", () => {
  it("slices all entries BEFORE firstKeptEntryId (the compacted-away span) into the output JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      const result = preSlice(backup, "e3", out);
      const sliced = readFileSync(out, "utf8").trim().split("\n");
      const ids = sliced.map((l) => JSON.parse(l).id);
      expect(ids).toEqual(["e1", "e2"]); // compacted-away span (NOT header, NOT e3/e4)
      expect(result.jsonlPath).toBe(out);
      expect(result.entryIds).toEqual(["e1", "e2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes the session header (type:session) from the slice", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      preSlice(backup, "e4", out);
      const sliced = readFileSync(out, "utf8").trim().split("\n");
      const types = sliced.map((l) => JSON.parse(l).type);
      expect(types).not.toContain("session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ALL entries before the last entry (firstKept = last → everything before is sliced)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      const result = preSlice(backup, "e4", out); // e4 is last kept
      expect(result.entryIds).toEqual(["e1", "e2", "e3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns entryTextById mapping each span id → its raw JSON line (for the cited-content-present check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      const result = preSlice(backup, "e3", out); // span = e1, e2
      expect(result.entryTextById.get("e1")).toContain("first");
      expect(result.entryTextById.get("e2")).toContain("second");
      expect(result.entryTextById.has("e3")).toBe(false); // not in span
      expect(result.entryTextById.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when firstKeptEntryId is not found in the backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      expect(() => preSlice(backup, "nonexistent", out)).toThrow(/firstKeptEntryId|not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty span when firstKeptEntryId is the first entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-preslice-"));
    try {
      const backup = writeBackup(dir);
      const out = join(dir, "sliced.jsonl");
      const result = preSlice(backup, "e1", out); // nothing before e1
      expect(result.entryIds).toEqual([]);
      expect(readFileSync(out, "utf8").trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
