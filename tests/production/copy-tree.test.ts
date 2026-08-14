// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyProjectTree, isSecretBasename } from "../../src/production/copy-tree.js";

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
      copyProjectTree(src, dest, null);
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
      copyProjectTree(src, dest, null);
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
      expect(() => copyProjectTree(src, dest, null)).toThrow(/inside|recurse/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("copyProjectTree — ignore rules + secret denylist (judge-readable repo)", () => {
  const makeSecretCodebase = (dir: string): string => {
    const src = join(dir, "codebase");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "main.ts"), "export const x = 1;");
    writeFileSync(join(src, ".env"), "API_KEY=supersecret");
    mkdirSync(join(src, "config"), { recursive: true });
    writeFileSync(join(src, "config", "service-account.json"), "{}");
    writeFileSync(join(src, "config", "db.ts"), "export const t = 1;");
    return src;
  };

  it("git source: copies ONLY git-listed files (gitignored ones excluded) + skips listed secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-git-"));
    try {
      const src = makeCodebase(dir); // main.ts README.md src/util.ts + .git/node_modules dirs
      writeFileSync(join(src, "build-output.js"), "// gitignored artifact");
      writeFileSync(join(src, ".env"), "API_KEY=supersecret");
      const dest = join(dir, "repo");
      const fakeGit = (cwd: string, args: string[]): string => {
        expect(cwd).toBe(src);
        expect(args).toContain("ls-files");
        // git's own view: tracked + untracked-not-ignored — .env is FORCE-ADDED (listed),
        // build-output.js is gitignored (not listed).
        return "main.ts\u0000README.md\u0000src/util.ts\u0000.env\u0000";
      };
      const skipped = copyProjectTree(src, dest, { git: fakeGit });
      expect(existsSync(join(dest, "main.ts"))).toBe(true);
      expect(existsSync(join(dest, "src", "util.ts"))).toBe(true);
      expect(existsSync(join(dest, "build-output.js"))).toBe(false); // gitignored → not copied
      expect(existsSync(join(dest, ".env"))).toBe(false); // denylist beats git tracking
      expect(skipped).toEqual([".env"]); // surfaced to the operator
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git source: force-added node_modules path segments still excluded", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-git2-"));
    try {
      const src = join(dir, "codebase");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "main.ts"), "x");
      const dest = join(dir, "repo");
      const skipped = copyProjectTree(src, dest, {
        git: () => "main.ts\u0000node_modules/pkg/index.js\u0000",
      });
      expect(existsSync(join(dest, "main.ts"))).toBe(true);
      expect(existsSync(join(dest, "node_modules"))).toBe(false);
      expect(skipped).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-git source: recursive fallback skips + reports nested secret files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-copy-nogit-"));
    try {
      const src = makeSecretCodebase(dir);
      const dest = join(dir, "repo");
      const skipped = copyProjectTree(src, dest, {
        git: () => {
          throw new Error("not a git repository");
        },
      });
      expect(existsSync(join(dest, "main.ts"))).toBe(true);
      expect(existsSync(join(dest, "config", "db.ts"))).toBe(true);
      expect(existsSync(join(dest, ".env"))).toBe(false);
      expect(existsSync(join(dest, "config", "service-account.json"))).toBe(false);
      expect(skipped).toEqual([".env", "config/service-account.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isSecretBasename matches the denylist families (dotenv/keys/credentials)", () => {
    expect(isSecretBasename(".env")).toBe(true);
    expect(isSecretBasename(".env.production")).toBe(true);
    expect(isSecretBasename(".npmrc")).toBe(true);
    expect(isSecretBasename("server.pem")).toBe(true);
    expect(isSecretBasename("signing.key")).toBe(true);
    expect(isSecretBasename("gcp-service-account.json")).toBe(true);
    expect(isSecretBasename("id_rsa")).toBe(true);
    expect(isSecretBasename("Credentials.ts")).toBe(true);
    expect(isSecretBasename("main.ts")).toBe(false);
    expect(isSecretBasename("monkey.ts")).toBe(false); // no substring false-positives on 'key'
    expect(isSecretBasename("README.md")).toBe(false);
  });
});
