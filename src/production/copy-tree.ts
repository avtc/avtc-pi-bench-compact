// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Copy a real session's codebase (extract mode) into the scenario repo so the project
// files are committed to `main` (the session transcript itself lives outside the repo, in the
// per-branch sessions store). The codebase at `session.cwd` IS the project files; this makes
// them repo-resident so the agent resumes work on them in the repo cwd.
//
// What gets copied — the source's OWN ignore rules are respected, because the scenario repo
// is readable by the cloud judge (an agentLoop with bash): a secret the operator gitignored
// must not become a committed file one `git show` away.
//   - Source IS a git repo: `git ls-files --cached --others --exclude-standard` lists exactly
//     tracked + untracked-not-ignored files (the .gitignore rules applied by git itself).
//   - Source is NOT a git repo (or git is unavailable): recursive copy of everything except
//     the structural excludes.
//   - Both paths additionally skip a SECRET-FILENAME DENYLIST (belt-and-suspenders: a
//     force-added `.env` in a git repo still must not land in the judge-readable repo).
//
// `.git` + `node_modules` are always excluded (the repo has its own `.git`; node_modules is
// bloat — the operator reinstalls deps in the repo before Phase 2 if tests need them).
//
// Returns the list of SKIPPED secret-like files (relative paths) so the caller can surface them.

import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

/** The root relative-path prefix for the recursive walk (no parent segment). */
const ROOT_PREFIX = "";

/** Structural directory excludes (never copied). */
const EXCLUDE = new Set([".git", "node_modules"]);

/** Committed-by-convention dotenv TEMPLATE suffixes — documented examples, not
 *  secrets; keeping them preserves the project's env-var documentation in the copy. */
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;

/** Secret-basename denylist (checked case-insensitively against every basename):
 *  dotenv family (.env, .env.local, .envrc, …) + .npmrc; key/certificate files;
 *  credential / service-account / SSH-private-key names. Heuristic on purpose —
 *  reserving a filename pattern is cheaper than exfiltrating one secret to a cloud
 *  judge. Template suffixed (.env.example …) dotfiles are allowed through. */
const SECRET_DOTFILE = /^\.(env|envrc|npmrc)(\.|$)/i;
const SECRET_SUFFIX = /\.(pem|key|p12|pfx)$/i;
const SECRET_SUBSTRING = /(credential|service[-_]?account|id_rsa|id_ed25519)/i;

/** Is this basename a secret-like file that must never be copied into the scenario
 *  repo? Template-suffixed dotfiles (.env.example) are documentation, not secrets. */
export function isSecretBasename(base: string): boolean {
  if (TEMPLATE_SUFFIX.test(base)) return false;
  return SECRET_DOTFILE.test(base) || SECRET_SUFFIX.test(base) || SECRET_SUBSTRING.test(base);
}

/** Run `git` in `cwd` (same exec pattern as the repo wrappers); throws on failure. */
const defaultGit = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).toString();

/** Injectable git runner (tests fake the ls-files listing; any throw = non-git source). */
export type GitRunner = (cwd: string, args: string[]) => string;

/** Options for {@link copyProjectTree}. */
export interface CopyTreeOptions {
  /** Git runner (default: execFileSync). Throw = fall back to the recursive copy. */
  readonly git?: GitRunner;
}

/** Copy the project tree from `src` to `dest`, honoring the source's ignore rules + the
 *  secret denylist. Returns the relative paths of SKIPPED secret-like files. Throws if
 *  `dest` is inside `src` (would recurse into itself). */
export function copyProjectTree(src: string, dest: string, opts: CopyTreeOptions | null): string[] {
  const git = opts?.git ?? defaultGit;
  const rel = path.relative(src, dest);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`copyProjectTree: dest "${dest}" is inside src "${src}" (would recurse into itself)`);
  }
  let listed: string[] | null = null;
  try {
    // Relative paths under `src` (ls-files from a subdirectory lists only files there,
    // relative to it) with the source's .gitignore rules applied by git itself.
    const out = git(src, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    listed = out.split("\0").filter((f) => f.length > 0);
  } catch {
    listed = null; // not a git repo (or git unavailable) → recursive fallback below
  }

  const skipped: string[] = [];
  mkdirSync(dest, { recursive: true });
  if (listed !== null) {
    for (const file of listed) {
      // Structural excludes still apply (a force-added node_modules gains nothing).
      if (file.split(/[/\\]/).some((seg) => EXCLUDE.has(seg))) continue;
      const base = path.basename(file);
      if (isSecretBasename(base)) {
        skipped.push(file);
        continue;
      }
      const from = path.join(src, file);
      const target = path.join(dest, file);
      // `ls-files` lists index entries, not the filesystem: submodule paths (mode
      // 160000) are directories on disk (copyFileSync would throw EISDIR) and a
      // file deleted from the worktree but still staged would throw ENOENT — skip
      // both instead of aborting the whole extract prepare.
      let st: Stats | null = null;
      try {
        st = lstatSync(from);
      } catch {
        continue; // not on disk (deleted-but-staged) — nothing to copy
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue; // submodule/directory entry
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(from, target);
    }
    return skipped;
  }

  // Non-git fallback: recursive walk with the same excludes + denylist.
  const walk = (srcDir: string, destDir: string, relPrefix: string): void => {
    for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
      if (EXCLUDE.has(ent.name)) continue;
      const relPath = relPrefix === "" ? ent.name : `${relPrefix}/${ent.name}`;
      if (isSecretBasename(ent.name)) {
        skipped.push(relPath);
        continue;
      }
      const from = path.join(srcDir, ent.name);
      const to = path.join(destDir, ent.name);
      if (ent.isDirectory()) {
        mkdirSync(to, { recursive: true });
        walk(from, to, relPath);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        copyFileSync(from, to);
      }
    }
  };
  walk(src, dest, ROOT_PREFIX);
  return skipped;
}
