// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VERSION_RESOLVER,
  resolveRootFromSettings,
  resolveToolVersion,
  type VersionResolver,
} from "../../src/arms/version.js";

/** A fake resolver scripted per package. */
function fakeResolver(
  roots: Record<string, string>,
  gitHeads: Record<string, string | null>,
  npmVersions: Record<string, string | null>,
): VersionResolver {
  return {
    resolveRoot: (pkg) => roots[pkg] ?? null,
    gitHead: (dir) => gitHeads[dir] ?? null,
    npmVersion: (dir) => npmVersions[dir] ?? null,
  };
}

describe("arms/version — resolveToolVersion", () => {
  it("A1 (bare-pi) returns null (no memory tool)", () => {
    const r = fakeResolver({}, {}, {});
    expect(resolveToolVersion("A1", r)).toBeNull();
  });

  it("A2 (OM, local-folder/git install) → {source:git, commit=short, full=hash}", () => {
    const hash = "4a2f8e9abcdef0123456789";
    const r = fakeResolver({ "pi-observational-memory": "/path/to/om" }, { "/path/to/om": hash }, {});
    const v = resolveToolVersion("A2", r);
    expect(v).not.toBeNull();
    expect(v?.source).toBe("git");
    expect(v?.commit).toBe("g4a2f8e"); // g + first 6 hex (shortGitVersion)
    expect(v?.full).toBe(hash);
  });

  it("A3 (session-owl, local-folder/git install) → git short+full", () => {
    const hash = "deadbeefcaffbabe1234";
    const r = fakeResolver({ "avtc-pi-session-owl": "/path/to/mk" }, { "/path/to/mk": hash }, {});
    const v = resolveToolVersion("A3", r);
    expect(v?.source).toBe("git");
    expect(v?.commit).toBe("gdeadbe");
    expect(v?.full).toBe(hash);
  });

  it("A5 (OM, npm install — no git) → {source:npm, commit=npm<ver>, full=ver}", () => {
    const r = fakeResolver(
      { "pi-observational-memory": "/node_modules/om" },
      { "/node_modules/om": null }, // not a git repo
      { "/node_modules/om": "1.4.2" },
    );
    const v = resolveToolVersion("A5", r);
    expect(v?.source).toBe("npm");
    expect(v?.commit).toBe("npm1.4.2"); // shortNpmVersion
    expect(v?.full).toBe("1.4.2");
  });

  it("A4 (session-owl, npm install) → npm short+full", () => {
    const r = fakeResolver({ "avtc-pi-session-owl": "/nm/mk" }, { "/nm/mk": null }, { "/nm/mk": "0.9.0" });
    const v = resolveToolVersion("A4", r);
    expect(v?.source).toBe("npm");
    expect(v?.commit).toBe("npm0.9.0");
    expect(v?.full).toBe("0.9.0");
  });

  it("git takes precedence over npm when both are available (local-folder with git)", () => {
    const r = fakeResolver({ "pi-observational-memory": "/p" }, { "/p": "aabbccdd0000" }, { "/p": "2.0.0" });
    expect(resolveToolVersion("A2", r)?.source).toBe("git");
  });

  it("is deterministic — same root resolves to the same version (same checkout)", () => {
    const hash = "112233445566";
    const r = fakeResolver({ "avtc-pi-session-owl": "/p" }, { "/p": hash }, {});
    expect(resolveToolVersion("A3", r)).toEqual(resolveToolVersion("A3", r));
  });

  it("throws if the package install root cannot be resolved", () => {
    const r = fakeResolver({}, {}, {}); // resolveRoot returns null for everything
    expect(() => resolveToolVersion("A2", r)).toThrow(/cannot resolve.*pi-observational-memory/i);
    expect(() => resolveToolVersion("A3", r)).toThrow(/cannot resolve.*avtc-pi-session-owl/i);
  });

  it("throws if the root resolves but neither git nor a version can be determined", () => {
    const r = fakeResolver({ "pi-observational-memory": "/p" }, { "/p": null }, { "/p": null });
    expect(() => resolveToolVersion("A2", r)).toThrow(/cannot determine version/i);
  });
});

describe("arms/version — DEFAULT resolver git-toplevel guard", () => {
  // `git rev-parse HEAD` walks UP to the nearest ancestor repo. An npm package nested in a
  // repo must NOT resolve to the parent's hash — gitHead must return null unless the dir IS
  // the git toplevel (so resolveToolVersion falls through to the npm version).
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-ver-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "package.json"), '{"version":"9.9.9"}');
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns the HEAD hash when the dir IS the git toplevel (local-folder install)", () => {
    const head = DEFAULT_VERSION_RESOLVER.gitHead(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a nested dir inside a repo (would otherwise steal the parent hash)", () => {
    const nested = join(repo, "sub");
    mkdirSync(nested);
    expect(DEFAULT_VERSION_RESOLVER.gitHead(nested)).toBeNull();
  });

  it("returns null for a dir with no git repo at all", () => {
    const noGit = mkdtempSync(join(tmpdir(), "bench-nogit-"));
    try {
      expect(DEFAULT_VERSION_RESOLVER.gitHead(noGit)).toBeNull();
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });
});

describe("resolveRootFromSettings (local-folder installs in pi packages settings)", () => {
  const mkSettings = (packages: string[]): string => JSON.stringify({ packages });

  it("matches a Windows folder-path entry by basename (the pi-agent dev setup)", () => {
    const settings = mkSettings([
      "npm:pi-tool-display",
      "E:\\sync\\unique\\work\\git\\pi\\avtc-pi-session-owl",
      "E:/sync/unique/work/git/pi/pi-observational-memory",
    ]);
    const readers = { read: (p: string) => (p === "/s1.json" ? settings : '{"packages":[]}') };
    const got = resolveRootFromSettings("pi-observational-memory", ["/s1.json"], readers);
    expect(got).toContain("pi-observational-memory");
  });

  it("matches an entry whose FOLDER name differs by its package.json name", () => {
    const settings = mkSettings(["/opt/checkouts/om-fork"]);
    const readers = {
      read: (p: string): string => {
        if (p === "/s1.json") return settings;
        if (p.endsWith("package.json")) return JSON.stringify({ name: "pi-observational-memory" });
        return "{}";
      },
    };
    expect(resolveRootFromSettings("pi-observational-memory", ["/s1.json"], readers)).toBe("/opt/checkouts/om-fork");
  });

  it("skips npm:-managed entries and unparseable/absent settings files → null", () => {
    const readers = {
      read: (p: string) =>
        p === "/s1.json" ? "{ not json" : JSON.stringify({ packages: ["npm:pi-observational-memory"] }),
    };
    expect(resolveRootFromSettings("pi-observational-memory", ["/s1.json", "/s2.json"], readers)).toBeNull();
  });

  it("real run resolution: tryResolveRoot falls back to settings (end-to-end with the real default resolver)", () => {
    // the real default resolver reads the REAL pi settings — on the dev machine the
    // folder installs are present; assert it finds the OM root (null-safe skip on CI).
    const root = DEFAULT_VERSION_RESOLVER.resolveRoot("pi-observational-memory");
    if (root === null) return; // settings without the folder install — environment-dependent, skip
    expect(root.length).toBeGreaterThan(0);
  });
});
