// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    return resolveRootFromSettings(pkg, piSettingsCandidates(), { read: (p) => readFileSync(p, "utf-8") });
  }
}

/** pi settings files whose `packages` list may carry the install (global agent
 * settings, legacy global, + the current project's). First match wins. */
function piSettingsCandidates(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return [
    join(home, ".pi", "agent", "settings.json"),
    join(home, ".pi", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
}

/** Resolve an install root from pi's packages settings: an entry that is a FOLDER
 *  path whose basename (or its package.json name) matches `pkg` IS the install
 *  root. Covers the local-folder development installs (`E:/…/pi-observational-
 *  memory`) that `require.resolve` cannot see from the bench's module context.
 *  `npm:`-managed entries fall back to the require.resolve path above. */
const SEP_F = "/";
const WINSEP = String.fromCharCode(92);

export function resolveRootFromSettings(
  pkg: string,
  files: readonly string[],
  readers: { read: (p: string) => string },
): string | null {
  const read = readers.read ?? ((p: string) => readFileSync(p, "utf-8"));
  for (const file of files) {
    let parsed: { packages?: unknown };
    try {
      parsed = JSON.parse(read(file)) as { packages?: unknown };
    } catch {
      continue; // absent/unparseable — not a source
    }
    if (!Array.isArray(parsed.packages)) continue;
    for (const entry of parsed.packages) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("npm:") || (!entry.includes(SEP_F) && !entry.includes(WINSEP))) continue;
      const base = entry.split(/[/\\]/).pop() ?? "";
      if (base === pkg) {
        try {
          return realpathSync(entry);
        } catch {
          return entry; // folder vanished? still report the configured root
        }
      }
      // entry folder named differently — match by its package.json name
      try {
        const pj = JSON.parse(read(join(entry, "package.json"))) as { name?: string };
        if (pj.name === pkg) {
          try {
            return realpathSync(entry);
          } catch {
            return entry;
          }
        }
      } catch {}
    }
  }
  return null;
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

/**
 * Resolve the pi runtime's own package version (the host the bench runs inside).
 * `nodeRequire.resolve` on the package's main export gives the HOST install's dist
 * file (not the bench's devDependency); walk up at most a few levels to the first
 * package.json and read its version. Returns null when resolution fails — the
 * version is result metadata, never a gate (the bench must run regardless).
 *
 * WHY this matters: pi 1.2.0 changed `serializeConversation()` (thinking blocks no
 * longer feed the summarization request) and pi 1.4.0 removed the summary output
 * cap (`reserveTokens` now only triggers auto-compaction). Compaction metrics
 * (footprint C1, compaction-cost C4, post-compaction run-cost C3) are only
 * comparable WITHIN one pi version — every result-JSON records the version it ran
 * under so cross-version result sets are detectable (never silently compared).
 */
export function resolvePiRuntimeVersion(): string | null {
  try {
    // ESM resolution: the package exposes only an `import` condition for "." — a CJS
    // require.resolve of the bare specifier throws "No 'exports' main defined".
    // Inside the host pi this resolves to the HOST's install (the version that ran
    // the bench), not the bench's devDependency.
    const mainPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    // Bounded walk up from the resolved entry (dist/index.js) to the package root.
    let dir = dirname(mainPath);
    for (let i = 0; i < 4; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version ?? null;
      } catch {
        // no package.json at this level — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    return null;
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
