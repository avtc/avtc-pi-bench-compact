// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The latent-authoring agent (author #2) — runs AFTER Phase-1 compaction, reading
// the arm session file(s) (span + compaction record + tail, one file per arm) and
// recording probes about conversation-only knowledge the compaction dropped.
// Machinery mirrors author #1 (`author.ts`): progressive per-item tool +
// terminal finalize tool driven by `runJsonToolStage`; texts are VERBATIM approved
// protected text (staged in .featyard/task-plans/2026-08-18-latent-probes-prompts.md).

import { readFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import type { ArmId } from "../config/types.js";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type JsonToolStageSeams, runJsonToolStage } from "../judge/stage-runner.js";
import { benchAuthoringTools } from "../runtime/tools.js";
import { type AskUi, askOperator } from "../ui/ask.js";
import {
  type AuthorLatentProbe,
  LATENT_FINALIZE_SCHEMA,
  LATENT_PROBE_CLASS_CAP,
  LATENT_PROBE_ITEM_SCHEMA,
  type LatentAuthoringMode,
  type LatentProbe,
  validateLatentProbes,
} from "./latent.js";
import { LATENT_PER_ARM_SYSTEM_PROMPT, LATENT_SHARED_SYSTEM_PROMPT } from "./latent-prompt.js";

/** The per-probeClass floor: finalize is rejected below it (the exhausted-facts
 *  path lets the operator accept fewer via the deadlock dialog). */
export const LATENT_MIN_PER_CLASS = 3;
/** The entry types that carry conversation content (the closed list the authoring
 *  agent may cite; everything else is metadata / persistence / compaction). */
const CONTENT_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);
/** The per-probeClass cap: the 11th probe of a class is rejected at add time. */
export const LATENT_CAP_PER_CLASS = LATENT_PROBE_CLASS_CAP;

/** Approved cap rejection (counts interpolated; mode-independent). */
const capRejection = (probeClass: string, otherClass: string): string =>
  `rejected: ${probeClass} cap reached (${LATENT_CAP_PER_CLASS} recorded) — record ${otherClass} probes, or finalize_latent`;

/** Approved below-minimum rejection. */
const belowMinRejection = (cued: number, uncued: number): string =>
  `rejected: below minimum — cued ${cued}/${LATENT_MIN_PER_CLASS}, uncued ${uncued}/${LATENT_MIN_PER_CLASS}. Search the span for more lost details, record them, then call finalize_latent again; if the facts are exhausted, call finalize_latent again unchanged.`;

/** Approved post-retry rejection (the operator chose another attempt). */
const retryRejection = (cued: number, uncued: number): string =>
  `rejected: the operator asked for another attempt — still below minimum (cued ${cued}/${LATENT_MIN_PER_CLASS}, uncued ${uncued}/${LATENT_MIN_PER_CLASS}). Search the span for more lost details; if the facts are exhausted, call finalize_latent again unchanged.`;

// --- deadlock dialog (approved wording; dismissed/unavailable → stop) ---------

const DIALOG_ACCEPT = "accept fewer probes and continue";
const DIALOG_RETRY = "ask the authoring agent to try again";
const DIALOG_STOP = "stop the run";

/** The terminal capture: which way the stage ended. */
export type LatentFinalizeAction = "done" | "accept" | "stop";

export interface LatentFinalizeTool extends AgentTool {
  /** Finalize captures (in call order) — the last one names the ending action. */
  readonly _captured: LatentFinalizeAction[];
}

/** The live per-class counts after each accepted probe (widget signal parity
 *  with author #1's onAdd). */
export interface LatentCounts {
  readonly cued: number;
  readonly uncued: number;
}

/** Compose the latent-authoring tool set: pi read-only tools + bash bound to
 *  `cwd`, the capped `add_latent_probe` per-item tool, and the guarded
 *  `finalize_latent` terminal tool (min-3 rejection, no-progress → operator
 *  dialog, exhausted-facts acceptance). */
export function buildLatentTools(
  cwd: string,
  ui: AskUi | null,
  onAdd: (counts: LatentCounts) => void,
): { tools: AgentTool[]; finalizeLatent: LatentFinalizeTool; acc: AuthorLatentProbe[] } {
  const acc: AuthorLatentProbe[] = [];
  let lastRejectCount = 0;

  const counts = (): LatentCounts => ({
    cued: acc.filter((p) => p.probeClass === "cued").length,
    uncued: acc.filter((p) => p.probeClass === "uncued").length,
  });

  const addLatentProbe: AgentTool = {
    name: "add_latent_probe",
    label: "add_latent_probe",
    // VERBATIM approved protected text.
    description:
      "Record ONE latent probe: a question about a detail you verified is lost — probeClass 'cued' (a summary names the topic but not the answer) or 'uncued' (no trace of either in the summary or the kept tail). Call as soon as you verify the absence; call again per probe.",
    parameters: LATENT_PROBE_ITEM_SCHEMA,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ accepted: number; rejected: number }>> {
      if (!Value.Check(LATENT_PROBE_ITEM_SCHEMA, params)) {
        return {
          content: [
            {
              type: "text",
              text: "rejected: arguments did not match the add_latent_probe schema; fix and call add_latent_probe again",
            },
          ],
          details: { accepted: 0, rejected: 1 },
        };
      }
      const item = params as unknown as AuthorLatentProbe;
      const classCount = item.probeClass === "cued" ? counts().cued : counts().uncued;
      if (classCount >= LATENT_CAP_PER_CLASS) {
        const other = item.probeClass === "cued" ? "uncued" : "cued";
        return {
          content: [{ type: "text", text: capRejection(item.probeClass, other) }],
          details: { accepted: 0, rejected: 1 },
        };
      }
      acc.push(item);
      onAdd(counts());
      return {
        content: [{ type: "text", text: "recorded add_latent_probe; keep going" }],
        details: { accepted: 1, rejected: 0 },
      };
    },
  };

  const captured: LatentFinalizeAction[] = [];
  const stopOrTerminate = (action: LatentFinalizeAction): AgentToolResult<{ accepted: number; rejected: number }> => {
    captured.push(action);
    return {
      content: [{ type: "text", text: "recorded finalize_latent; stop calling tools and reply Done" }],
      details: { accepted: 1, rejected: 0 },
      terminate: true,
    };
  };
  const finalizeLatent: LatentFinalizeTool = {
    name: "finalize_latent",
    label: "finalize_latent",
    // VERBATIM approved protected text.
    description:
      "Finalize the latent probes. Call ONCE when you have recorded everything — this ends the latent authoring; it takes no arguments.",
    parameters: LATENT_FINALIZE_SCHEMA,
    async execute(): Promise<AgentToolResult<{ accepted: number; rejected: number }>> {
      const { cued, uncued } = counts();
      const minMet = cued >= LATENT_MIN_PER_CLASS && uncued >= LATENT_MIN_PER_CLASS;
      if (minMet) return stopOrTerminate("done");

      // Progress since the last rejection → the normal produce-more rejection.
      if (acc.length > lastRejectCount) {
        lastRejectCount = acc.length;
        return {
          content: [{ type: "text", text: belowMinRejection(cued, uncued) }],
          details: { accepted: 0, rejected: 1 },
        };
      }

      // No progress: the facts may be exhausted — the operator decides. No dialog
      // surface (non-TUI) → stop, the agreed safe default.
      if (ui === null) return stopOrTerminate("stop");
      const choice = await askOperator(ui, {
        source: "bench-compact",
        detail: `latent authoring stalled: no new probes since last attempt (cued ${cued}/${LATENT_MIN_PER_CLASS}, uncued ${uncued}/${LATENT_MIN_PER_CLASS})`,
        title: "latent probes below minimum — accept fewer?",
        options: [DIALOG_ACCEPT, DIALOG_RETRY, DIALOG_STOP],
      });
      if (choice === DIALOG_ACCEPT) return stopOrTerminate("accept");
      if (choice === DIALOG_RETRY) {
        return {
          content: [{ type: "text", text: retryRejection(cued, uncued) }],
          details: { accepted: 0, rejected: 1 },
        };
      }
      return stopOrTerminate("stop"); // "stop the run" or dismissed
    },
    get _captured(): LatentFinalizeAction[] {
      return captured.slice();
    },
  };

  const tools: AgentTool[] = [...benchAuthoringTools(cwd), addLatentProbe, finalizeLatent];
  return { tools, finalizeLatent, acc };
}

// --- prompt + kickoff composition ---------------------------------------------

/** Build the mode's system prompt with the file path(s) + tail anchor substituted
 *  (function replacers — $-bearing paths must not be mangled). */
export function buildLatentSystemPrompt(deps: {
  mode: LatentAuthoringMode;
  sessionPaths: readonly string[];
  tailStartsAtEntryId: string;
}): string {
  const base = deps.mode === "per-arm" ? LATENT_PER_ARM_SYSTEM_PROMPT : LATENT_SHARED_SYSTEM_PROMPT;
  return base
    .replaceAll("<PATH>", () => deps.sessionPaths[0])
    .replaceAll("<PATHS>", () => deps.sessionPaths.join("\n"))
    .replaceAll("<TAIL_START>", () => deps.tailStartsAtEntryId);
}

/** Build the mode's kickoff task message (VERBATIM approved protected text). */
export function buildLatentTaskMessage(deps: {
  mode: LatentAuthoringMode;
  sessionPaths: readonly string[];
  tailStartsAtEntryId: string;
}): string {
  const anchor =
    deps.mode === "per-arm"
      ? `The KEPT TAIL starts at the entry with id ${deps.tailStartsAtEntryId}.`
      : `The KEPT TAIL starts at the entry with id ${deps.tailStartsAtEntryId} — identical in every file.`;
  const head =
    deps.mode === "per-arm"
      ? `Read the session file at ${deps.sessionPaths[0]} and write the latent probes per the instructions:`
      : `Read the session files at\n${deps.sessionPaths.join("\n")} — forks of the same session — and write ONE shared set of latent probes per the instructions:`;
  const tail =
    deps.mode === "per-arm"
      ? "find the compaction record, mine the compacted-away span for conversation-only knowledge, validate each candidate against the summary and the kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done."
      : "compare the summaries, validate each candidate against every summary and the shared kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done.";
  return `${head}\n${anchor}\n${tail}`;
}

// --- the agent -------------------------------------------------------------------

export interface RunLatentAuthoringDeps {
  readonly seams: JsonToolStageSeams;
  /** Working directory the authoring tools operate in (the scenario repo). */
  readonly cwd: string;
  readonly mode: LatentAuthoringMode;
  /** Per-arm mode: the arm this run authors for (stamped on every pool record). */
  readonly arm: ArmId;
  /** Shared mode: every enabled arm (verdicts stamped for all). Per-arm: [arm]. */
  readonly enabledArms: readonly ArmId[];
  /** The arm session file(s): per-arm = one; shared = one per enabled arm. */
  readonly sessionPaths: readonly string[];
  /** First kept entry id — the injected tail anchor. */
  readonly tailStartsAtEntryId: string;
  /** Dialog surface; null in non-TUI/batch (no-progress → stop). */
  readonly ui: AskUi | null;
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  readonly rateLimitOptions?: RateLimitOptions | null;
  readonly onAdd?: (counts: LatentCounts) => void;
}

/** Discriminated outcome: completed pools are validated; stopped = the operator
 *  (or the absent dialog surface) ended the stage below minimum — the caller
 *  surfaces it through its stop path. */
export type LatentAuthoringResult =
  | { kind: "completed"; pool: readonly LatentProbe[] }
  | { kind: "stopped"; counts: LatentCounts };

/** Run the latent-authoring agent for one stage (one arm in per-arm mode; the
 *  shared set across all arms in shared mode). Throws on model/stage failure and
 *  on pool validation failure (defense: out-of-span or non-content citations). */
export async function runLatentAuthoringAgent(deps: RunLatentAuthoringDeps): Promise<LatentAuthoringResult> {
  const { tools, finalizeLatent, acc } = buildLatentTools(deps.cwd, deps.ui, deps.onAdd ?? (() => {}));
  const action = (await runJsonToolStage({
    seams: deps.seams,
    tools,
    systemPrompt: buildLatentSystemPrompt(deps),
    terminalTool: finalizeLatent,
    label: "latent authoring",
    userMessageContent: buildLatentTaskMessage(deps),
    maxTokens: deps.maxTokens,
    signal: deps.signal,
    rateLimitOptions: deps.rateLimitOptions,
  })) as LatentFinalizeAction;

  const counts: LatentCounts = {
    cued: acc.filter((p) => p.probeClass === "cued").length,
    uncued: acc.filter((p) => p.probeClass === "uncued").length,
  };
  if (action === "stop") return { kind: "stopped", counts };

  const pool: LatentProbe[] = acc.map((item, i) => ({
    id: `l${i + 1}`,
    ...item,
    ...(deps.mode === "per-arm" ? { arm: deps.arm } : {}),
    verdicts:
      deps.mode === "per-arm"
        ? { [deps.arm]: "absent" }
        : Object.fromEntries(deps.enabledArms.map((a) => [a, "absent"])),
  }));
  const spanEntryIds = spanContentEntryIds(deps.sessionPaths, deps.tailStartsAtEntryId);
  // The author reads the JSONL through a line-numbered view and sometimes cites the
  // LINE POSITION as the entry id. Resolve numeric citations against the id at that
  // line (exact real-id matches always win; unresolvable citations pass through and
  // the validation below rejects them with its message).
  const citations = spanCitationIndex(deps.sessionPaths, deps.tailStartsAtEntryId);
  const normalized: LatentProbe[] = pool.map((p) => ({
    ...p,
    entryIds: p.entryIds.map((id) => {
      if (spanEntryIds.has(id)) return id;
      if (!/^\d+$/.test(id)) return id;
      const atLine = citations.positionToSpanId.get(Number(id));
      return atLine ?? id;
    }),
  }));
  const validation = validateLatentProbes(normalized, {
    mode: deps.mode,
    spanEntryIds,
    enabledArms: deps.enabledArms,
  });
  if (!validation.ok) {
    throw new Error(`latent pool validation failed: ${validation.reasons.join("; ")}`);
  }
  return { kind: "completed", pool: normalized };
}

/** A parsed session line: its 1-based position (what a line-numbered read view
 *  shows) + the entry object. Torn trailing lines (crash mid-append) are skipped,
 *  like readArmCompaction. */
function parsedLines(path: string): readonly { position: number; entry: { id?: string; type?: string } }[] {
  const out: { position: number; entry: { id?: string; type?: string } }[] = [];
  let position = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    position += 1;
    if (line.trim().length === 0) continue;
    try {
      out.push({ position, entry: JSON.parse(line) as { id?: string; type?: string } });
    } catch {
      continue;
    }
  }
  return out;
}

/** A 1-based line-position → span-entry-id index for citation normalization: the
 *  authoring agent reads the JSONL through a line-numbered view and may cite the
 *  position instead of the id. Positions are per file; a position resolves only if
 *  the entry it points at is a CONTENT entry inside the compacted-away span (tail
 *  and post-compaction positions deliberately do not resolve). */
export function spanCitationIndex(
  sessionPaths: readonly string[],
  tailStartsAtEntryId: string,
): { positionToSpanId: ReadonlyMap<number, string> } {
  const positionToSpanId = new Map<number, string>();
  for (const path of sessionPaths) {
    for (const { position, entry } of parsedLines(path)) {
      if (entry.id === tailStartsAtEntryId) break; // tail begins — positions past it must not resolve
      if (entry.id !== undefined && entry.type !== undefined && CONTENT_ENTRY_TYPES.has(entry.type)) {
        positionToSpanId.set(position, entry.id);
      }
    }
  }
  return { positionToSpanId };
}

/** The span's CONTENT entry ids (message / custom_message / branch_summary — the
 *  closed list the compacted agent actually saw), for every file intersected:
 *  shared-mode files share the session, so a citation valid everywhere must be in
 *  the intersection. Validation against this set enforces both in-span AND
 *  content-type constraints (persistence-record ids are never in it). */
export function spanContentEntryIds(sessionPaths: readonly string[], tailStartsAtEntryId: string): Set<string> {
  let span: Set<string> | null = null;
  for (const path of sessionPaths) {
    const ids = new Set<string>();
    for (const { entry } of parsedLines(path)) {
      if (entry.id === tailStartsAtEntryId) break; // tail begins — span done
      if (entry.id !== undefined && entry.type !== undefined && CONTENT_ENTRY_TYPES.has(entry.type)) {
        ids.add(entry.id);
      }
    }
    span = span === null ? ids : new Set([...span].filter((id: string) => ids.has(id)));
  }
  return span ?? new Set<string>();
}
