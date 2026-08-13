// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ArmId } from "../config/types.js";
import { shortGitVersion, shortNpmVersion, type ToolVersion } from "../storage/branches.js";
import { ARM_DEFS } from "./definitions.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Injectable version-resolution seams (so {@link resolveToolVersion} is unit-testable
 * without a real filesystem / git). The DEFAULT uses `require.resolve` + git rev-parse
 * + package.json; the version resolver prefers the extension's resolved
 * path from the live pi runtime. Returns {@link ToolVersion} (the shape
 * `buildCfgId` consumes via `RunConfig.toolVersions`).
 */
export interface VersionResolver {
  /** Resolve a package's install-root dir (or null if not found). */
  resolveRoot(pkg: string): string | null;
  /** Read the git HEAD hash of a dir ONLY if the dir IS the git toplevel (else null). */
  gitHead(dir: string): string | null;
  /** Read the npm version from `package.json` of a dir (or null). */
  npmVersion(dir: string): string | null;
}

function tryResolveRoot(pkg: string): string | null {
  try {
    return dirname(nodeRequire.resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

/**
 * CRITICAL: `git rev-parse HEAD` walks UP to the nearest ancestor repo, so an
 * npm-installed package nested inside a git repo (e.g. node_modules under the bench
 * repo, or a monorepo) would silently resolve to the PARENT's hash. Require the dir to
 * BE the git toplevel (the package is its own repo) before trusting the hash; otherwise
 * return null so {@link resolveToolVersion} falls through to the npm version. Compare
 * normalized realpaths (Windows is case-insensitive + accepts either separator).
 */
function tryGitHead(dir: string): string | null {
  const norm = (p: string): string => resolve(p).replace(/\\/g, "/").toLowerCase();
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    if (!toplevel || norm(toplevel) !== norm(realpathSync(dir))) return null;
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function tryNpmVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Default resolver — best-effort filesystem/git/npm resolution. */
export const DEFAULT_VERSION_RESOLVER: VersionResolver = {
  resolveRoot: tryResolveRoot,
  gitHead: tryGitHead,
  npmVersion: tryNpmVersion,
};

/**
 * Resolve the memory-tool version for an arm. Returns `null` for the bare-pi arm (no memory
 * tool). A local-folder (git) install yields the commit hash; an npm install
 * yields the package version. Throws if the package cannot be resolved or its
 * version determined (the harness must surface this via stop-and-surface).
 */
export function resolveToolVersion(arm: ArmId, resolver: VersionResolver | null): ToolVersion | null {
  const r = resolver ?? DEFAULT_VERSION_RESOLVER;
  const def = ARM_DEFS[arm];
  if (def.memoryPackage === null) return null; // the bare-pi arm carries no tool version
  const root = r.resolveRoot(def.memoryPackage);
  if (root === null) {
    throw new Error(`resolveToolVersion(${arm}): cannot resolve install root of "${def.memoryPackage}"`);
  }
  // Local-folder (git) takes precedence — a git checkout is the authoritative version.
  const git = r.gitHead(root);
  if (git) return { source: "git", commit: shortGitVersion(git), full: git };
  // npm install — fall back to the package.json version.
  const version = r.npmVersion(root);
  if (version) return { source: "npm", commit: shortNpmVersion(version), full: version };
  throw new Error(`resolveToolVersion(${arm}): cannot determine version of "${def.memoryPackage}" at ${root}`);
}
