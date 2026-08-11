// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ArmId } from "../config/types.js";
import { shortGitVersion, shortNpmVersion } from "../storage/branches.js";
import { ARM_DEFS } from "./definitions.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Resolved memory-tool version for one arm (§3.14 version identity). {@link commit}
 * is the short `{ver}` token (branch name + `toolVersions.<arm>.commit`);
 * {@link full} is the full hash (git) or version (npm) mirrored in run-meta.
 */
export interface ResolvedToolVersion {
  source: "git" | "npm";
  /** Short form used in branch names: `g<6hex>` (git) or `npm<ver>` (npm). */
  commit: string;
  /** Full hash (git) or version (npm). */
  full: string;
}

/**
 * Injectable version-resolution seams (so {@link resolveToolVersion} is unit-testable
 * without a real filesystem / git). The DEFAULT uses `require.resolve` + git rev-parse
 * + package.json; Task 12 supplies a resolver that prefers the extension's resolved
 * path from the live pi runtime.
 */
export interface VersionResolver {
  /** Resolve a package's install-root dir (or null if not found). */
  resolveRoot(pkg: string): string | null;
  /** Read the git HEAD hash of a dir (or null if not a git repo). */
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

function tryGitHead(dir: string): string | null {
  try {
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
 * Resolve the memory-tool version for an arm. Returns `null` for A1 (no memory
 * tool). A local-folder (git) install yields the commit hash; an npm install
 * yields the package version. Throws if the package cannot be resolved or its
 * version determined (the harness must surface this — §3.8 stop-and-surface).
 */
export function resolveToolVersion(
  arm: ArmId,
  resolver: VersionResolver = DEFAULT_VERSION_RESOLVER,
): ResolvedToolVersion | null {
  const def = ARM_DEFS[arm];
  if (def.memoryPackage === null) return null; // A1 — bare-pi carries no tool version
  const root = resolver.resolveRoot(def.memoryPackage);
  if (root === null) {
    throw new Error(`resolveToolVersion(${arm}): cannot resolve install root of "${def.memoryPackage}"`);
  }
  // Local-folder (git) takes precedence — a git checkout is the authoritative version.
  const git = resolver.gitHead(root);
  if (git) return { source: "git", commit: shortGitVersion(git), full: git };
  // npm install — fall back to the package.json version.
  const version = resolver.npmVersion(root);
  if (version) return { source: "npm", commit: shortNpmVersion(version), full: version };
  throw new Error(`resolveToolVersion(${arm}): cannot determine version of "${def.memoryPackage}" at ${root}`);
}
