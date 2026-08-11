// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { resolveToolVersion, type VersionResolver } from "../../src/arms/version.js";

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

  it("A3 (memkeeper, local-folder/git install) → git short+full", () => {
    const hash = "deadbeefcaffbabe1234";
    const r = fakeResolver({ "avtc-pi-memkeeper": "/path/to/mk" }, { "/path/to/mk": hash }, {});
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

  it("A4 (memkeeper, npm install) → npm short+full", () => {
    const r = fakeResolver({ "avtc-pi-memkeeper": "/nm/mk" }, { "/nm/mk": null }, { "/nm/mk": "0.9.0" });
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
    const r = fakeResolver({ "avtc-pi-memkeeper": "/p" }, { "/p": hash }, {});
    expect(resolveToolVersion("A3", r)).toEqual(resolveToolVersion("A3", r));
  });

  it("throws if the package install root cannot be resolved", () => {
    const r = fakeResolver({}, {}, {}); // resolveRoot returns null for everything
    expect(() => resolveToolVersion("A2", r)).toThrow(/cannot resolve.*pi-observational-memory/i);
    expect(() => resolveToolVersion("A3", r)).toThrow(/cannot resolve.*avtc-pi-memkeeper/i);
  });

  it("throws if the root resolves but neither git nor a version can be determined", () => {
    const r = fakeResolver({ "pi-observational-memory": "/p" }, { "/p": null }, { "/p": null });
    expect(() => resolveToolVersion("A2", r)).toThrow(/cannot determine version/i);
  });
});
