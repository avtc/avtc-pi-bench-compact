// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Probe-branch lifecycle. A probe fork is ALWAYS created (the agent's response is
// non-deterministic — it may tool-call or edit files even for a "simple" question), and
// ALWAYS pruned after settle: no judge or scoring path consumes probe branches — the
// per-branch SESSION FILE (outside the repo) is the single durable artifact (question,
// tool calls/results, answer). `isQaOnlyBranch` decides the informational `kept` trace
// flag — did the agent go beyond a clean Q&A (any tool call / file mutation / anything
// unexpected)? — and the caller logs the changed-file list for kept probes. Conservative:
// anything unexpected reads as kept (flagged), never silently clean.
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
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
}

/** The probe-answer effort: token quadruple + dollars (from the assistant message
 *  usage) + wall-clock (first→last added-entry timestamp) of the probe's tail. */
export interface ProbeUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly dollars: number;
  readonly wallMs: number;
  /** Memory-recall tool usage inside the tail (absent when no recall calls). */
  readonly recall?: RecallToolUsage;
}

/** Recall-family tool usage (the memory-lookup overhead): how many lookup calls the
 *  agent made, the tokens those results injected into context (ESTIMATE — result
 *  chars / 4), and the wall spent inside the tool itself (call→result span). */
export interface RecallToolUsage {
  readonly calls: number;
  readonly tokensInjected: number;
  readonly wallMs: number;
}

/** The tool names that constitute a memory recall (observational-memory + memkeeper). */
const RECALL_TOOL_NAMES = new Set(["recall", "mk_recall"]);

/** Sum the probe-tail (added past the base) assistant-message usage + wall-clock.
 *  Pure transformation of the two file contents (testable in isolation). Returns
 *  null when the tail is not a clean append (usage unknowable). */
export function probeUsageFromSession(baseJsonl: string, probeJsonl: string): ProbeUsage | null {
  let added: string[];
  try {
    added = addedSessionLines(baseJsonl, probeJsonl);
  } catch {
    return null;
  }
  const usage: {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    dollars: number;
    wallMs: number;
  } = {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    dollars: 0,
    wallMs: 0,
  };
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  // Recall-family tool accounting: toolCall id → calling assistant-message timestamp;
  // the matching toolResult closes the span (wall) and contributes its payload size.
  const recallCallTs = new Map<string, number>();
  const recall: { calls: number; tokensInjected: number; wallMs: number } = {
    calls: 0,
    tokensInjected: 0,
    wallMs: 0,
  };
  for (const json of added) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(json) as SessionEntry;
    } catch {
      continue;
    }
    const ts = entry.timestamp !== undefined ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const u = entry.message.usage;
      if (u !== undefined) {
        usage.tokensIn += u.input ?? 0;
        usage.tokensOut += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.dollars += u.cost?.total ?? 0;
      }
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; id?: string; name?: string }[]) {
          if (
            block.type === "toolCall" &&
            typeof block.name === "string" &&
            RECALL_TOOL_NAMES.has(block.name) &&
            typeof block.id === "string"
          ) {
            recallCallTs.set(block.id, Number.isNaN(ts) ? -1 : ts);
          }
        }
      }
    }
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const msg = entry.message as { toolCallId?: string; toolName?: string; content?: unknown };
      if (typeof msg.toolCallId === "string" && recallCallTs.has(msg.toolCallId)) {
        const callTs = recallCallTs.get(msg.toolCallId) ?? -1;
        recall.calls += 1;
        recall.tokensInjected += Math.ceil(toolResultTextLength(msg.content) / 4);
        if (callTs >= 0 && !Number.isNaN(ts)) recall.wallMs += Math.max(0, ts - callTs);
      }
    }
  }
  usage.wallMs = firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : 0;
  if (recall.calls > 0) return { ...usage, recall };
  return usage;
}

/** Character length of a tool result's text payload (string, or content blocks
 *  holding `text` fields). 0 for unexpected shapes. */
function toolResultTextLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let len = 0;
    for (const block of content as { text?: unknown }[]) {
      if (typeof block?.text === "string") len += block.text.length;
    }
    return len;
  }
  return 0;
}

/** True if the entry represents tool/file-mutating activity (NOT a clean Q&A message). */
function isMutatingEntry(entry: SessionEntry): boolean {
  // Conservative: anything that isn't a clean user/assistant text+thinking message is "mutating"
  // (a tool call, a tool result, a compaction entry, or an unexpected shape) → keep the branch.
  if (entry.type !== "message") {
    // EXCEPTION: `custom` entries are extension bookkeeping, never agent activity —
    // user-global extensions (portrait, user-decisions, …) append their own custom
    // entry types to EVERY forked session, so treating customs as mutating would keep
    // every clean Q&A probe branch. Tool calls/results live in message entries; file
    // changes are caught by the git-diff check.
    return entry.type !== "custom";
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
/** True iff the line is the session-identity header (`type:"session"`). The
 *  fork assigns every probe session a FRESH id (re-key), so the header legitimately
 *  differs between a base and its fork — identity metadata, not transcript content.
 *  Append-cleanliness is therefore judged over the ENTRY lines only. */
function isSessionHeader(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === "session";
  } catch {
    return false;
  }
}

export function addedSessionLines(baseJsonl: string, probeJsonl: string): string[] {
  const baseLines = baseJsonl.split("\n").filter((l) => l.trim().length > 0);
  const probeLines = probeJsonl.split("\n").filter((l) => l.trim().length > 0);
  // Drop the identity header from both sides when present (see isSessionHeader).
  const base = baseLines.length > 0 && isSessionHeader(baseLines[0] as string) ? baseLines.slice(1) : baseLines;
  const probe = probeLines.length > 0 && isSessionHeader(probeLines[0] as string) ? probeLines.slice(1) : probeLines;
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
