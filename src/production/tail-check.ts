// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The tail check: which condition-topics' content lives in the KEPT TAIL (entries at/
// after the trial cut) of a build backup. Topics WITH authored manifest conditions
// never reach this — their tail position is detected mechanically (condition entryIds
// vs the cut). This check fires only for topics the author found NOTHING for (zero
// authored conditions — no manifest facts exist for them by definition), so it is
// kind-level: one single-call stage, the approved prompt, a JSON object of booleans.
// Malformed output is CONSERVATIVE (treated as not-in-tail → the topic classifies
// missing → surface) — a flaky format must never loop auto-continue forever.

import { log } from "../log.js";

/** The approved tail-check system prompt (verbatim). */
export const TAIL_CHECK_SYSTEM_PROMPT = `You inspect the KEPT TAIL of a coding session — the recent messages that will stay
un-compacted when older messages are summarized away. Content that lives only in this
tail is invisible to a summary written from the older part, so we need to know which
kinds of noteworthy content the tail contains.

For each kind below, answer whether this tail contains a clear instance of it:
- key-decision: a decision or technical detail the user stated that later work depends on
- completed-work: a system or feature the agent completed
- reversal: the user changing an earlier decision (old way → new way)
- open-question: a question the user explicitly left open or deferred

Respond with ONLY a JSON object mapping each kind to true or false, for example:
{"key-decision": true, "completed-work": false, "reversal": false, "open-question": true}`;

/** Prompt kind → condition-topic id (completed-work/completed-system + reversal/change-mind
 *  are the two name pairs). */
const KIND_TO_TOPIC: Readonly<Record<string, string>> = {
  "key-decision": "key-decision",
  "completed-work": "completed-system",
  reversal: "change-mind",
  "open-question": "open-question",
};

/** Parse the tail-check reply → the set of TOPIC IDS judged present in the tail.
 *  Unknown keys are ignored; anything malformed returns an EMPTY set (conservative —
 *  the caller classifies those topics missing → surface, never infinite-continue). */
export function parseTailCheckResponse(text: string): ReadonlySet<string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    log.warn(`tail check: no JSON object in reply (treating tail as empty) — ${text.slice(0, 200)}`);
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    log.warn(`tail check: malformed JSON in reply (treating tail as empty) — ${text.slice(0, 200)}`);
    return new Set();
  }
  if (typeof parsed !== "object" || parsed === null) {
    log.warn("tail check: reply is not an object (treating tail as empty)");
    return new Set();
  }
  const present = new Set<string>();
  for (const [kind, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== true) continue; // false / non-boolean → not present
    const topicId = KIND_TO_TOPIC[kind];
    if (topicId !== undefined) present.add(topicId);
  }
  return present;
}

/** Render cap for the tail text (chars). Tails are bounded by keepRecentTokens; the
 *  cap is a safety net against pathological sessions, keeping the head. */
export const TAIL_TEXT_CAP = 120_000;

/** Render the tail entries as role-labeled text blocks (assistant/user voice carries
 *  the decisions; tool plumbing is skipped — it is not user-voiced content). */
export function renderTailText(entries: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const e of entries) {
    const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m === undefined || typeof m.role !== "string" || !Array.isArray(m.content)) continue;
    const text = (m.content as { type?: string; text?: string }[])
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join(" ")
      .trim();
    if (text !== "") blocks.push(`[${m.role}] ${text}`);
  }
  const joined = blocks.join("\n\n");
  return joined.length > TAIL_TEXT_CAP ? joined.slice(0, TAIL_TEXT_CAP) : joined;
}
