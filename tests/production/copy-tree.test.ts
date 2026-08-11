// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyProjectTree } from "../../src/production/copy-tree.js";

function makeCodebase(dir: string): string {
  const src = join(dir, "codebase");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.ts"), "export const x = 1;");
  writeFileSync(join(src, "README.md"), "# game");
  mkdirSync(join(src, "src"), { recursive: true });
  writeFileSync(join(src, "src", "util.ts"), "export const y = 2;");
  mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(src, "node_modules", "pkg", "index.js"), "module.exports = 0;");
  mkdirSync(join(src, ".git"), { recursive: true });
  writeFileSync(join(src, ".git", "config"), "[core]");
  return src;
}

describe("copyProjectTree", () => {
  it("copies all project files recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-"));
    try {
      const src = makeCodebase(dir);
      const dest = join(dir, "repo");
      copyProjectTree(src, dest);
      expect(existsSync(join(dest, "main.ts"))).toBe(true);
      expect(existsSync(join(dest, "README.md"))).toBe(true);
      expect(readFileSync(join(dest, "src", "util.ts"), "utf8")).toContain("y = 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes .git + node_modules (the repo has its own .git; deps are reinstalled)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-"));
    try {
      const src = makeCodebase(dir);
      const dest = join(dir, "repo");
      copyProjectTree(src, dest);
      expect(existsSync(join(dest, ".git"))).toBe(false);
      expect(existsSync(join(dest, "node_modules"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when dest is inside src (would recurse into itself)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-"));
    try {
      const src = makeCodebase(dir);
      const dest = join(src, "sub");
      expect(() => copyProjectTree(src, dest)).toThrow(/inside|recurse/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
