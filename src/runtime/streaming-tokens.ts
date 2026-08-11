// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Two-tier streaming-output-token extraction primitives, shared by the
// agent-loop run accumulator (final count) and the live-progress widget (live
// counter). Both read the same event stream; the EXTRACTION of usage + delta text
// is identical here, while each caller owns its own ACCUMULATE strategy (the run
// sums per-message_end output for the final ledger; the tracker keeps a running
// max of mid-stream message_update output for the live widget, falling back to
// chars/4 over deltas when the provider reports no usage).
//
// Copied from avtc-pi-memkeeper's `runtime/streaming-tokens.ts` and EXTENDED:
// `MessageUsage` carries `cacheWrite` (memkeeper lacks it) so the bench's C4
// compaction-cost breakdown can attribute cache-write tokens + $ per arm. The
// chars/4 token estimate is inlined here (single source — Task-14's C1 metric
// reuses `estimateContentTokens`).

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

/** chars-per-token estimate (the fallback-tier unit + the C1 tokenizer). */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Estimate the token count for a content/summary string (chars/4). Shared by the
 *  fallback output tier and the C1 footprint metric (Task 14). */
export function estimateContentTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Per-message-end usage slice (only assistant messages carry usage; prompt /
 *  steering messages have none — callers treat absence as zero). `totalTokens`
 *  is the agent's context-window consumption for that message (the per-agent
 *  context-usage figure the widget surfaces). */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Prompt-cache WRITE tokens (cache-fill). Memkeeper's slice lacks this; the
   *  bench's C4 cost breakdown attributes cacheWrite $ per arm. */
  cacheWrite: number;
  cost: number;
  totalTokens: number;
}

/** Read cumulative usage off a `message_end` message. Returns null when the
 *  message carries no usage (prompt/steering messages); callers decide whether
 *  to treat that as zero. */
export function messageEndUsage(message: AgentMessage): MessageUsage | null {
  const u = (
    message as {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
        totalTokens?: number;
      };
    }
  ).usage;
  if (u === undefined) return null;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cost: u.cost?.total ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
}

/** Read the streamed cumulative output-token count off a `message_update` when
 *  the provider reports usage mid-stream. Returns null when not present. */
export function streamedOutputUsage(ev: AgentEvent): number | null {
  if (ev.type !== "message_update") return null;
  const usage = (ev as { message?: { usage?: { output?: number } } }).message?.usage;
  const output = usage?.output;
  return typeof output === "number" ? output : null;
}

/** Extract the delta string from a streamed assistant-message event (fallback
 *  tier — chars/4 over text/thinking/toolcall deltas). Returns null otherwise. */
export function deltaTextOf(ev: AgentEvent): string | null {
  if (ev.type !== "message_update") return null;
  const inner = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
  if (inner?.type === "text_delta" || inner?.type === "thinking_delta" || inner?.type === "toolcall_delta") {
    return inner.delta ?? null;
  }
  return null;
}

/** chars/4 estimate of a delta string (the fallback-tier unit). */
export function deltaTokens(delta: string): number {
  return estimateContentTokens(delta);
}
