// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readArmCompaction } from "../../src/session/compaction-record.js";
import { tempDir } from "../temp-dirs.js";

describe("readArmCompaction", () => {
  it("returns the last compaction record's summary + tail anchor", () => {
    const dir = tempDir("arm-compaction-");
    const path = join(dir, "arm.jsonl");
    writeFileSync(
      path,
      [
        { id: "e1", type: "message", content: "span" },
        { id: "cut-1", type: "message", content: "tail" },
        { id: "c1", type: "compaction", summary: "first summary", firstKeptEntryId: "cut-1" },
        { id: "e2", type: "message", content: "post" },
        { id: "c2", type: "compaction", summary: "second summary", firstKeptEntryId: "cut-2" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    expect(readArmCompaction(path)).toEqual({ summary: "second summary", firstKeptEntryId: "cut-2" });
  });

  it("returns null when the file has no compaction record", () => {
    const dir = tempDir("arm-compaction-");
    const path = join(dir, "arm.jsonl");
    writeFileSync(path, `${JSON.stringify({ id: "e1", type: "message", content: "x" })}\n`);
    expect(readArmCompaction(path)).toBeNull();
  });
});
