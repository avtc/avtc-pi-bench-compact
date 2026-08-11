// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Extract a pre-compaction backup from a REAL session (extract mode). The
// session must be UN-compacted (no CompactionEntry) and coherent with the current
// working directory (header.cwd === cwd — the codebase on disk IS the project
// files, CR-4). Memory-extension custom entries (memkeeper.* / om.*) are stripped
// so the bench re-runs compaction fresh with its own memory arm; renderable raw
// types (message/text/thinking/custom_message/branch_summary + non-memory customs)
// are kept.
//
// The header `cwd` is NOT rewritten here — freeze (Task 10c) owns that for BOTH
// modes (CR-3: SessionManager.open reads header.cwd; ctx.switchSession has no
// cwdOverride). This keeps the rewrite in one place (DRY).

import { readFileSync, writeFileSync } from "node:fs";

/** Custom-entry-type prefixes belonging to memory extensions (stripped on extract). */
const DEFAULT_MEMORY_CUSTOM_TYPE_PREFIXES = ["memkeeper.", "om."] as const;

/** A minimal entry shape (enough for guard + strip decisions). */
interface EntryLike {
  readonly type: string;
  readonly id: string;
  readonly cwd?: string;
  readonly customType?: string;
}

/** Thrown when a real session is unusable for extract (compacted or cwd-incoherent). */
export class ExtractError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ExtractError";
  }
}

/** Input to {@link extractBackup}. */
export interface ExtractOptions {
  /** Path to the real session JSONL to extract from. */
  readonly fromSessionPath: string;
  /** Where to write the cleaned backup JSONL. */
  readonly outputPath: string;
  /** The required working directory (header.cwd must match). Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Memory custom-type prefixes to strip (defaults to memkeeper. + om.). */
  readonly memoryCustomTypePrefixes?: readonly string[];
}

/** Result of {@link extractBackup}. */
export interface ExtractResult {
  /** The cleaned backup JSONL path (= options.outputPath). */
  readonly backupPath: string;
  /** The coherent codebase cwd (project files live here; freeze commits them). */
  readonly sourceCwd: string;
}

/**
 * Extract a clean pre-compaction backup from a real session.
 *
 * @throws {ExtractError} when the session has a CompactionEntry (not pre-compacted)
 *   or header.cwd !== cwd (codebase not present — CR-4 cwd-coherence).
 */
export function extractBackup(opts: ExtractOptions): ExtractResult {
  const cwd = opts.cwd ?? process.cwd();
  const prefixes = opts.memoryCustomTypePrefixes ?? DEFAULT_MEMORY_CUSTOM_TYPE_PREFIXES;
  const lines = readFileSync(opts.fromSessionPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const entries = lines.map((l) => JSON.parse(l) as EntryLike);

  // Guard 1: no CompactionEntry anywhere (the session must be pre-compacted — the
  // bench performs the first compaction at compactionBoundary, symmetric with build).
  if (entries.some((e) => e.type === "compaction")) {
    throw new ExtractError(
      "extract requires a pre-compacted session (no CompactionEntry) — the session already has a compaction",
    );
  }

  // Guard 2: cwd-coherence (CR-4). The header is the first entry (type:"session");
  // its cwd must match the working dir so the codebase on disk is the project files.
  const header = entries.find((e) => e.type === "session");
  if (!header || header.cwd !== cwd) {
    throw new ExtractError(
      `extract cwd-coherence failed: session header cwd "${header?.cwd ?? "<missing>"}" !== working dir "${cwd}" — run from the session's original codebase`,
    );
  }

  // Strip memory-extension custom/custom_message entries; keep everything else.
  const cleaned = entries.filter((e) => {
    if (e.type !== "custom" && e.type !== "custom_message") return true;
    const ct = e.customType ?? "";
    return !prefixes.some((p) => ct.startsWith(p));
  });

  writeFileSync(opts.outputPath, cleaned.map((e) => JSON.stringify(e)).join("\n"));
  return { backupPath: opts.outputPath, sourceCwd: cwd };
}
