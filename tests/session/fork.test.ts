// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copySessionFork } from "../../src/session/fork.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-fork-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SRC_SESSION = [
  JSON.stringify({
    type: "session",
    id: "17eec942-79ee-4cf2-9966-5a9d7a946675",
    timestamp: "2026-08-16T05:58:28.895Z",
    cwd: "C:\\repo",
    version: 3,
  }),
  JSON.stringify({ type: "model_change", id: "403f8a39", parentId: null }),
  JSON.stringify({ type: "message", id: "a1", parentId: "403f8a39", role: "user" }),
].join("\n");

describe("copySessionFork", () => {
  it("rewrites the header id to a fresh UUID and preserves the rest byte-for-byte", () => {
    const dir = tempDir();
    const src = join(dir, "src.jsonl");
    const dest = join(dir, "dest.jsonl");
    writeFileSync(src, SRC_SESSION);

    copySessionFork(src, dest);

    const outLines = readFileSync(dest, "utf8").split("\n");
    const header = JSON.parse(outLines[0]) as { type: string; id: string };
    expect(header.type).toBe("session");
    expect(header.id).not.toBe("17eec942-79ee-4cf2-9966-5a9d7a946675");
    expect(header.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(outLines.slice(1).join("\n")).toBe(SRC_SESSION.split("\n").slice(1).join("\n"));
    // Source file is untouched.
    expect(readFileSync(src, "utf8")).toBe(SRC_SESSION);
  });

  it("keeps non-id header fields (timestamp, cwd, version) intact", () => {
    const dir = tempDir();
    const src = join(dir, "src.jsonl");
    const dest = join(dir, "dest.jsonl");
    writeFileSync(src, SRC_SESSION);

    copySessionFork(src, dest);

    const srcHeader = JSON.parse(SRC_SESSION.split("\n")[0]) as Record<string, unknown>;
    const destHeader = JSON.parse(readFileSync(dest, "utf8").split("\n")[0]) as Record<string, unknown>;
    delete srcHeader.id;
    delete destHeader.id;
    expect(destHeader).toEqual(srcHeader);
  });

  it("produces a different id per fork (two forks of one source diverge)", () => {
    const dir = tempDir();
    const src = join(dir, "src.jsonl");
    writeFileSync(src, SRC_SESSION);

    copySessionFork(src, join(dir, "a.jsonl"));
    copySessionFork(src, join(dir, "b.jsonl"));

    const idA = (JSON.parse(readFileSync(join(dir, "a.jsonl"), "utf8").split("\n")[0]) as { id: string }).id;
    const idB = (JSON.parse(readFileSync(join(dir, "b.jsonl"), "utf8").split("\n")[0]) as { id: string }).id;
    expect(idA).not.toBe(idB);
  });

  it("handles a header-only file (no trailing newline)", () => {
    const dir = tempDir();
    const src = join(dir, "src.jsonl");
    const dest = join(dir, "dest.jsonl");
    writeFileSync(src, JSON.stringify({ type: "session", id: "aaa", version: 3 }));

    copySessionFork(src, dest);

    const header = JSON.parse(readFileSync(dest, "utf8")) as { type: string; id: string };
    expect(header.type).toBe("session");
    expect(header.id).not.toBe("aaa");
  });

  it("throws when the first line is not a session header", () => {
    const dir = tempDir();
    const src = join(dir, "src.jsonl");
    writeFileSync(src, [JSON.stringify({ type: "message", id: "m1" }), JSON.stringify({ type: "session" })].join("\n"));

    expect(() => copySessionFork(src, join(dir, "dest.jsonl"))).toThrow(/does not start with a session header/);
  });
});
