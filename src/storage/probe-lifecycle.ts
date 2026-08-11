// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Probe-branch lifecycle. A probe fork is ALWAYS created (the agent's response is
// non-deterministic — it may tool-call or edit files even for a "simple" question). After the probe
// settles: if the branch differs from its arm base ONLY by Q&A message entries (no tool-call /
// file-mutating entries), the harness DELETES it (clean Q&A-only branch); otherwise (the agent made
// changes) it is KEPT. Deletion is conservative: only a branch whose diff is exclusively message
// entries is removable; anything unexpected is kept.
//
// pi session JSONL: each line is `{type:"message", message:{role, content:[{type,...}]}}`. Tool
// activity shows up as content blocks of type `toolCall` (pi uses `toolCall`, not `tool_use`) and as
// separate `role:"toolResult"` messages. File edits show up as non-session.jsonl path changes.

import { diffFile, diffNameOnly } from "./repo.js";

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
  if (entry.type !== "message") return true;
  const msg = entry.message;
  if (msg === undefined) return true;
  if (msg.role === "toolResult") return true;
  const content = msg.content;
  if (!Array.isArray(content)) return true;
  return content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "toolCall");
}

/**
 * True iff `probeBranch` differs from `baseBranch` ONLY by Q&A message entries — safe to delete.
 * False (keep) when any project file changed OR any added session entry is tool-call/file-mutating.
 * An empty diff (probe changed nothing) is trivially Q&A-only → true.
 */
export function isQaOnlyBranch(repo: string, baseBranch: string, probeBranch: string): boolean {
  // 1. Any non-session.jsonl file changed → file-mutating → not Q&A-only.
  const files = diffNameOnly(repo, baseBranch, probeBranch);
  if (files.some((f) => f !== "session.jsonl")) return false;

  // 2. Parse the ADDED session.jsonl lines; any mutating entry → not Q&A-only. ALSO: any
  // `-` line (a removal/modification — session JSONL is append-only, so a removal is
  // unexpected) or any unparseable `+` line → conservative keep (anything
  // unexpected is kept).
  const diff = diffFile(repo, baseBranch, probeBranch, "session.jsonl");
  for (const line of diff.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) return false; // unexpected removal/modification
    if (!line.startsWith("+") || line.startsWith("+++")) continue; // skip context/hunk headers
    const json = line.slice(1).trim();
    if (json.length === 0) continue;
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
