// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Probe-branch lifecycle. A probe fork is ALWAYS created (the agent's response is
// non-deterministic — it may tool-call or edit files even for a "simple" question). After the probe
// settles: if the branch differs from its arm base ONLY by Q&A message entries (no tool-call /
// file-mutating entries), the harness DELETES it (clean Q&A-only branch); otherwise (the agent made
// changes) it is KEPT. Deletion is conservative: only a branch whose diff is exclusively message
// entries is removable; anything unexpected is kept.
//
// The session transcript lives OUTSIDE the repo (in a per-branch sessions store), so the Q&A check
// compares the two session FILES directly (base vs probe) instead of git-diffing session.jsonl.
// pi session JSONL: each line is `{type:"message", message:{role, content:[{type,...}]}}`. Tool
// activity shows up as content blocks of type `toolCall` (pi uses `toolCall`, not `tool_use`) and as
// separate `role:"toolResult"` messages. Project-file edits show up in the git diff (diffNameOnly).

import { readFileSync } from "node:fs";
import { diffNameOnly } from "./repo.js";

/** A minimal view of a session JSONL entry (only the fields the lifecycle cares about). */
interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** True if the entry represents tool/file-mutating activity (NOT a clean Q&A message). */
function isMutatingEntry(entry: SessionEntry): boolean {
  // Conservative: anything that isn't a clean user/assistant text+thinking message is "mutating"
  // (a tool call, a tool result, a custom/compaction entry, or an unexpected shape) → keep the branch.
  if (entry.type !== "message") {
    // EXCEPTION: user-global cache extensions (portrait, user-decisions…) append a
    // `*-cache` custom entry to EVERY forked session — bench-external noise present on
    // every probe branch, not agent activity. Treat those as non-mutating so clean
    // Q&A probe branches still get the delete lifecycle.
    const customType = (entry as { customType?: unknown }).customType;
    if (entry.type === "custom" && typeof customType === "string" && customType.endsWith("-cache")) {
      return false;
    }
    return true;
  }
  const msg = entry.message;
  if (msg === undefined) return true;
  if (msg.role === "toolResult") return true;
  const content = msg.content;
  if (!Array.isArray(content)) return true;
  return content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "toolCall");
}

/**
 * The lines `probeJsonl` adds beyond `baseJsonl` (append-only JSONL). Splits both into
 * non-blank lines, requires the probe to START WITH the base prefix (a clean append),
 * and returns the probe's tail past the base. Throws when the probe is not a clean
 * superset of the base — a removal (probe shorter) or a modification (a base line
 * changed) — so the caller can treat that as "not Q&A-only" (keep the branch).
 *
 * Pure transformation of the two file contents (testable in isolation).
 */
export function addedSessionLines(baseJsonl: string, probeJsonl: string): string[] {
  const base = baseJsonl.split("\n").filter((l) => l.trim().length > 0);
  const probe = probeJsonl.split("\n").filter((l) => l.trim().length > 0);
  if (probe.length < base.length) {
    throw new Error("probe session is shorter than the base — not a clean append (a line was removed)");
  }
  // The probe must START WITH the base (clean append). A modification breaks the prefix.
  for (let i = 0; i < base.length; i++) {
    if (probe[i] !== base[i]) {
      throw new Error("probe session does not start with the base — a line was modified (not a clean append)");
    }
  }
  return probe.slice(base.length);
}

/**
 * True iff `probeBranch` differs from `baseBranch` ONLY by Q&A message entries — safe to delete.
 * False (keep) when any project file changed OR any added session entry is tool-call/file-mutating
 * OR the session was modified (not a clean append). An empty diff (probe changed nothing) is
 * trivially Q&A-only → true.
 *
 * The session transcript is compared by reading `baseSessionFile` + `probeSessionFile` directly
 * (the transcript lives outside the repo, in the per-branch sessions store). The git diff
 * (`diffNameOnly`) guards project-file changes; the transcript never appears in it (the
 * `!== "session.jsonl"` filter is defensive).
 */
export function isQaOnlyBranch(
  repo: string,
  baseBranch: string,
  probeBranch: string,
  baseSessionFile: string,
  probeSessionFile: string,
): boolean {
  // 1. Any non-session.jsonl file changed → file-mutating → not Q&A-only.
  const files = diffNameOnly(repo, baseBranch, probeBranch);
  if (files.some((f) => f !== "session.jsonl")) return false;

  // 2. Compare the two session FILES directly: the added lines are the probe's tail past the
  // base. A non-clean-append (modification/removal) → keep. Any mutating/unparseable added
  // entry → keep. (Conservative: anything unexpected is kept.)
  let added: string[];
  try {
    added = addedSessionLines(readFileSync(baseSessionFile, "utf8"), readFileSync(probeSessionFile, "utf8"));
  } catch {
    return false; // not a clean append (modification/removal) → conservative keep
  }
  for (const json of added) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(json) as SessionEntry;
    } catch {
      return false; // unparseable added line — unexpected → keep
    }
    if (isMutatingEntry(entry)) return false;
  }
  return true;
}
