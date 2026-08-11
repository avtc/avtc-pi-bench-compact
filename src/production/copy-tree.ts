// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Copy a real session's codebase (extract mode, §4.16 step 2) into the scenario repo
// so the project files are committed to `main` alongside `session.jsonl` (CR-4). The
// codebase at `session.cwd` IS the project files; this makes them repo-resident so the
// agent resumes work on them in the repo cwd (§3.14).
//
// `.git` is excluded (the repo has its own) + `node_modules` is excluded (bloat — the
// operator reinstalls deps in the repo before Phase 2 if tests need them). Everything
// else is copied verbatim.

import { cpSync } from "node:fs";
import path from "node:path";

/** Directories never copied (would conflict with the repo's own .git, or bloat it). */
const EXCLUDE = new Set([".git", "node_modules"]);

/** Recursively copy the project tree from `src` to `dest`, excluding .git + node_modules.
 *  Throws if `dest` is inside `src` (would recurse into itself). */
export function copyProjectTree(src: string, dest: string): void {
  const rel = path.relative(src, dest);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`copyProjectTree: dest "${dest}" is inside src "${src}" (would recurse into itself)`);
  }
  // node:fs cpSync with a recursive + filter fn — the cleanest built-in recursive copy.
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      // `source` is the path being considered (file or dir). Exclude top-level .git /
      // node_modules by basename — cpSync calls filter for each entry under src.
      const base = path.basename(source);
      return !EXCLUDE.has(base);
    },
  });
}
