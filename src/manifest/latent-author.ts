// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The latent-authoring agent (author #2) — runs AFTER Phase-1 compaction, reading
// the arm session file(s) (span + compaction record + tail, one file per arm) and
// recording probes about conversation-only knowledge the compaction dropped.
// Machinery mirrors author #1 (`author.ts`): progressive per-item tool +
// terminal finalize tool driven by `runJsonToolStage`; texts are VERBATIM approved
// protected text (staged in .featyard/task-plans/2026-08-18-latent-probes-prompts.md).

import { readFileSync } from "node:fs";
import type { AgentTool, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import type { ArmId } from "../config/types.js";
import { BenchJudgeError } from "../judge/errors.js";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type JsonToolStageSeams, runJsonToolStage } from "../judge/stage-runner.js";
import { log } from "../log.js";
import { StageRunError } from "../runtime/agent-loop.js";
import { benchAuthoringTools } from "../runtime/tools.js";
import { type AskUi, askOperator } from "../ui/ask.js";
import {
  type AuthorLatentProbe,
  LATENT_ACCEPT_MIN_LENGTH,
  LATENT_DUP_JACCARD,
  LATENT_FINALIZE_SCHEMA,
  LATENT_NOTE_MIN_LENGTH,
  LATENT_PROBE_CLASS_CAP,
  LATENT_PROBE_ITEM_SCHEMA,
  LATENT_QUESTION_MIN_LENGTH,
  type LatentAuthoringMode,
  type LatentProbe,
  latentQuestionSimilarity,
  validateLatentProbes,
} from "./latent.js";
import { LATENT_PER_ARM_SYSTEM_PROMPT, LATENT_SHARED_SYSTEM_PROMPT } from "./latent-prompt.js";

/** The per-probeClass floor: finalize is rejected below it (the exhausted-facts
 *  path lets the operator accept fewer via the deadlock dialog). */
export const LATENT_MIN_PER_CLASS = 3;

/** Total authoring passes per stage invocation: a pass that dies mid-work (LLM
 *  call timeout, context-window exhaustion) automatically restarts in a fresh
 *  context that already knows what is recorded + what remains — the kept probes
 *  carry over (same tool set → same acc), so nothing is re-mined from scratch. */
export const LATENT_MAX_PASSES = 3;

/** Approved retry reasons — the kickoff's interpolation values (the run-stopped
 *  one is used when the stage SEEDS a resumed run from a partial pool file). */
export const LATENT_REASON_TIMED_OUT = "it timed out";
export const LATENT_REASON_CONTEXT = "its context window was exhausted";
export const LATENT_REASON_RESUMED = "the run stopped before it finished";
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
  `rejected: below minimum — cued ${cued}/${LATENT_MIN_PER_CLASS}, uncued ${uncued}/${LATENT_MIN_PER_CLASS}. Search the span for more lost details, record them, then call finalize_latent again; if the facts are exhausted, call finalize_latent again unchanged. Never record placeholder, repetitive, or unverified probes to reach the minimum.`;

/** Approved post-retry rejection (the operator chose another attempt). */
const retryRejection = (cued: number, uncued: number): string =>
  `rejected: the operator asked for another attempt — still below minimum (cued ${cued}/${LATENT_MIN_PER_CLASS}, uncued ${uncued}/${LATENT_MIN_PER_CLASS}). Search the span for more lost details; if the facts are exhausted, call finalize_latent again unchanged.`;

/** Approved content-floor rejections (the junk-probe regression: a weak authoring
 *  agent padded the per-class minimum with "Test4"/note "t"/accept "a" probes; the
 *  system prompt's "do not invent" instruction was ignored under the produce-more
 *  rejection pressure). A rejected call never enters the pool — and never counts as
 *  finalize progress, so the operator deadlock dialog stays reachable. */
const shortQuestionRejection = (): string =>
  `rejected: question too short (under ${LATENT_QUESTION_MIN_LENGTH} chars) — a probe question is a specific, self-contained question about the lost detail; re-check the entry and re-record the real question`;
const shortNoteRejection = (): string =>
  `rejected: note too short (under ${LATENT_NOTE_MIN_LENGTH} chars) — say why the detail matters for the work; re-record with a real note`;
const shortAcceptRejection = (): string =>
  `rejected: accept too short (under ${LATENT_ACCEPT_MIN_LENGTH} chars) — list the real acceptable answers for the question; re-record`;
const dupQuestionRejection = (ordinal: number): string =>
  `rejected: question is a near-duplicate of probe #${ordinal} already recorded — each probe targets a distinct lost detail; verify and record a different one`;

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

/** What the add-time citation guard needs: the in-span content-entry ids (the
 *  same set finalize validates against) + the line-position index (the read view's
 *  numbering — numeric citations resolve to the id at that line). */
export interface SpanCitations {
  readonly spanEntryIds: ReadonlySet<string>;
  readonly positionToSpanId: ReadonlyMap<number, string>;
  /** The 1-based line the tail-start entry sits at (the first file that has it —
   *  the spans are identical across arm files), or null when not found. */
  readonly tailStartLine: number | null;
}

/** Compose the latent-authoring tool set: pi read-only tools + bash bound to
 *  `cwd`, the capped `add_latent_probe` per-item tool (each call MECHANICALLY
 *  validated: every cited entry must exist as an id — or line position — of an
 *  in-span content entry, else the call is rejected with feedback so the agent
 *  self-corrects in-run), and the guarded `finalize_latent` terminal tool (min-3
 *  rejection, no-progress → operator dialog, exhausted-facts acceptance). */
export function buildLatentTools(
  cwd: string,
  ui: AskUi | null,
  onAdd: (counts: LatentCounts) => void,
  citations: SpanCitations,
  persist: ((probes: readonly AuthorLatentProbe[]) => void) | null,
  validate: ProbeValidateFn | null,
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
      // Content floors: placeholder-grade probes never enter the pool (each field
      // gets its own rejection so the agent knows exactly what to fix). A rejected
      // call is NOT finalize progress — after rejected padding attempts, the second
      // unchanged finalize reaches the operator deadlock dialog (accept fewer).
      if (item.question.trim().length < LATENT_QUESTION_MIN_LENGTH) {
        return {
          content: [{ type: "text", text: shortQuestionRejection() }],
          details: { accepted: 0, rejected: 1 },
        };
      }
      if (item.note.trim().length < LATENT_NOTE_MIN_LENGTH) {
        return {
          content: [{ type: "text", text: shortNoteRejection() }],
          details: { accepted: 0, rejected: 1 },
        };
      }
      if (item.accept.join(" ").trim().length < LATENT_ACCEPT_MIN_LENGTH) {
        return {
          content: [{ type: "text", text: shortAcceptRejection() }],
          details: { accepted: 0, rejected: 1 },
        };
      }
      // Near-duplicate question vs any recorded probe (the same fact re-recorded:
      // a byte-identical duplicate pair, the Test4..TestE padding run).
      for (const [i, existing] of acc.entries()) {
        if (latentQuestionSimilarity(item.question, existing.question) >= LATENT_DUP_JACCARD) {
          return {
            content: [{ type: "text", text: dupQuestionRejection(i + 1) }],
            details: { accepted: 0, rejected: 1 },
          };
        }
      }
      // Mechanical citation guard: resolve each entryId (exact id, else the line
      // position's id) and reject the call when any citation is not an in-span
      // content entry — the agent gets feedback + retries instead of poisoning the
      // pool (in-run repair, the latent twin of author #1's sanitizeCitations pass).
      const bad: string[] = [];
      const resolvedIds = item.entryIds.map((id) => {
        if (citations.spanEntryIds.has(id)) return id;
        if (/^\d+$/.test(id)) {
          const atLine = citations.positionToSpanId.get(Number(id));
          if (atLine !== undefined) return atLine;
        }
        bad.push(id);
        return id;
      });
      if (bad.length > 0) {
        const where =
          citations.tailStartLine === null
            ? "use the entry's id from before the tail start"
            : `cite ids of entries before line ${citations.tailStartLine} (the tail start)`;
        return {
          content: [
            {
              type: "text",
              text: `rejected: entryId "${bad[0] ?? ""}" is not an in-span message/custom_message/branch_summary entry — ${where}; re-check the file and call add_latent_probe again`,
            },
          ],
          details: { accepted: 0, rejected: 1 },
        };
      }
      // Add-time probe validation (mechanical leak-gate + the validator agent,
      // both composed into the injected closure): a probe answerable from the
      // compacted agent's own context (summary/tail/repo/reasoning) never enters
      // the pool — the author gets the validator's evidence and records something
      // else. A validator stop (ProbeValidationStoppedError) propagates out of the
      // tool and halts the stage for the operator.
      if (validate !== null) {
        const verdict = await validate({ ...item, entryIds: resolvedIds });
        if (!verdict.ok) {
          const what = verdict.problems.map((p) => p.what).join("; ");
          return {
            content: [
              {
                type: "text",
                text: `rejected: ${what} — fix the probe or drop it and record a different detail of the same kind; call add_latent_probe again`,
              },
            ],
            details: { accepted: 0, rejected: 1 },
          };
        }
      }
      acc.push({ ...item, entryIds: resolvedIds });
      onAdd(counts());
      persist?.(acc);
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

/** The shared anchor + head lines of a latent kickoff (both builders compose them
 *  with their own body — same mode-conditional wording). */
function kickoffAnchorHead(deps: {
  mode: LatentAuthoringMode;
  sessionPaths: readonly string[];
  tailStartsAtEntryId: string;
  tailStartLine: number | null;
}): { anchor: string; head: string } {
  const atLine = deps.tailStartLine === null ? "" : ` — line ${deps.tailStartLine}`;
  const anchor =
    deps.mode === "per-arm"
      ? `The KEPT TAIL starts at the entry with id ${deps.tailStartsAtEntryId}${atLine}.`
      : `The KEPT TAIL starts at the entry with id ${deps.tailStartsAtEntryId}${atLine} — identical in every file.`;
  const head =
    deps.mode === "per-arm"
      ? `Read the session file at ${deps.sessionPaths[0]} and write the latent probes per the instructions:`
      : `Read the session files at\n${deps.sessionPaths.join("\n")} — forks of the same session — and write ONE shared set of latent probes per the instructions:`;
  return { anchor, head };
}

/** Build the pass-2+ kickoff task message (VERBATIM approved protected text): the
 *  previous pass's failure reason, the already-recorded probes (so the fresh
 *  context never re-mines them), the remaining targets, and the original task
 *  lines (paths + anchor) so the message is self-sufficient. */
export function buildLatentRetryTaskMessage(deps: {
  mode: LatentAuthoringMode;
  sessionPaths: readonly string[];
  tailStartsAtEntryId: string;
  tailStartLine: number | null;
  reason: string;
  kept: readonly AuthorLatentProbe[];
}): string {
  const { anchor, head } = kickoffAnchorHead(deps);
  const keptLines = deps.kept.map((p) => `- [${p.probeClass}] ${p.question}`).join("\n");
  const cued = deps.kept.filter((p) => p.probeClass === "cued").length;
  const uncued = deps.kept.length - cued;
  const stillNeeded =
    cued >= LATENT_MIN_PER_CLASS && uncued >= LATENT_MIN_PER_CLASS
      ? "Still needed: nothing — call finalize_latent."
      : `Still needed: cued ${Math.max(0, LATENT_MIN_PER_CLASS - cued)} more, uncued ${Math.max(
          0,
          LATENT_MIN_PER_CLASS - uncued,
        )} more.`;
  const tail =
    deps.mode === "per-arm"
      ? "Continue mining the compacted-away span for conversation-only knowledge that is NOT already recorded, validate each candidate against the summary and the kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done."
      : "Continue mining the compacted-away span for conversation-only knowledge that is NOT already recorded, validate each candidate against every summary and the shared kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done.";
  return `The previous authoring pass ended before finalize_latent (${deps.reason}).\n\nAlready recorded — do not re-record these:\n${keptLines}\n\n${stillNeeded}\n\n${head}\n${anchor}\n${tail}`;
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
  /** The tail-start entry's 1-based line (the agent's read view numbers lines —
   *  an explicit anchor beats hunting the id inside a 60KB JSON line). */
  tailStartLine: number | null;
}): string {
  const { anchor, head } = kickoffAnchorHead(deps);
  const tail =
    deps.mode === "per-arm"
      ? "find the compaction record, mine the compacted-away span for conversation-only knowledge, validate each candidate against the summary and the kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done."
      : "compare the summaries, validate each candidate against every summary and the shared kept tail, record each verified probe with add_latent_probe, then call finalize_latent when done.";
  return `${head}\n${anchor}\n${tail}`;
}

// --- the agent -------------------------------------------------------------------

/** Add-time probe validation: given the recorded probe, return the validator's
 *  verdict (ok, or problems whose what-lines reach the author as the rejection). */
export type ProbeValidateFn = (probe: AuthorLatentProbe) => Promise<import("./probe-validate.js").ProbeVerdict>;

export interface RunLatentAuthoringDeps {
  readonly seams: JsonToolStageSeams;
  /** Add-time probe validation per recorded probe (mechanical leak-gate + the
   *  validator agent, composed by the caller); absent/null = validation off
   *  (tests, legacy paths). A ProbeValidationStoppedError thrown inside halts
   *  the stage for the operator. */
  readonly validate?: ProbeValidateFn | null;
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
  /** Probes kept from a PARTIAL pool (a stopped run's incremental writes): they
   *  seed `acc` — counts, caps, and the duplicate gate continue over them — and
   *  pass 1 opens with the retry kickoff (what is recorded + what remains). */
  readonly seedProbes?: readonly LatentProbe[];
  /** Incremental persistence: fired after every ACCEPTED add_latent_probe with the
   *  full kept-so-far set — the stage writes the pool file, so a crash/stop never
   *  loses collected probes (resume seeds from the partial file). */
  readonly persistPartial?: (probes: readonly LatentProbe[]) => void;
  /** Dialog surface; null in non-TUI/batch (no-progress → stop). */
  readonly ui: AskUi | null;
  readonly signal: AbortSignal;
  /** The authoring agent's thinking level (null = omit the reasoning field). */
  readonly thinking: ThinkingLevel | null;
  readonly maxTokens: number;
  /** Wall-clock cap per latent-authoring LLM call. */
  readonly timeoutMs: number;
  readonly rateLimitOptions?: RateLimitOptions | null;
  readonly onAdd?: (counts: LatentCounts) => void;
}

/** Discriminated outcome: completed pools are validated; stopped = the operator
 *  (or the absent dialog surface) ended the stage below minimum — the caller
 *  surfaces it through its stop path. */
export type LatentAuthoringResult =
  | { kind: "completed"; pool: readonly LatentProbe[] }
  | { kind: "stopped"; counts: LatentCounts };

/** Map the kept-so-far authoring probes to their POOL form (ids l1..ln over the
 *  union — stable across incremental writes; verdicts start absent). Shared by
 *  the incremental persist callback + the completed pool. */
function poolFromAcc(
  acc: readonly AuthorLatentProbe[],
  deps: { mode: LatentAuthoringMode; arm: ArmId; enabledArms: readonly ArmId[] },
): LatentProbe[] {
  return acc.map((item, i) => ({
    id: `l${i + 1}`,
    ...item,
    ...(deps.mode === "per-arm" ? { arm: deps.arm } : {}),
    verdicts:
      deps.mode === "per-arm"
        ? { [deps.arm]: "absent" }
        : Object.fromEntries(deps.enabledArms.map((a) => [a, "absent"])),
  }));
}

/** Auto-retry triggers (the next pass runs automatically): the stage's per-LLM-call
 *  timeout, or a model request that died on the context window (the wrapped
 *  request-failure message names the context/token limit). Everything else — a
 *  lucid no-finalize, an unavailable model, an abort — keeps today's throw. */
function isRetryableLatentFailure(err: unknown): boolean {
  if (err instanceof BenchJudgeError && err.category === "timeout") return true;
  if (err instanceof StageRunError) {
    const msg = err.cause instanceof Error ? err.cause.message : String(err.cause);
    return /exceed|context|too long|too large|token limit/i.test(msg);
  }
  return false;
}

/** Run the latent-authoring agent for one stage (one arm in per-arm mode; the
 *  shared set across all arms in shared mode). Throws on model/stage failure and
 *  on pool validation failure (defense: out-of-span or non-content citations). */
export async function runLatentAuthoringAgent(deps: RunLatentAuthoringDeps): Promise<LatentAuthoringResult> {
  // Computed once, used twice: the add-time citation guard (in-run repair) + the
  // finalize validation (invariant backstop — the guard makes it unreachable).
  const { positionToSpanId, tailStartLine } = spanCitationIndex(deps.sessionPaths, deps.tailStartsAtEntryId);
  const citations: SpanCitations = {
    spanEntryIds: spanContentEntryIds(deps.sessionPaths, deps.tailStartsAtEntryId),
    positionToSpanId,
    tailStartLine,
  };
  const persist =
    deps.persistPartial === undefined
      ? null
      : (keptNow: readonly AuthorLatentProbe[]): void => deps.persistPartial?.(poolFromAcc(keptNow, deps));
  const { tools, finalizeLatent, acc } = buildLatentTools(
    deps.cwd,
    deps.ui,
    deps.onAdd ?? (() => {}),
    citations,
    persist,
    deps.validate ?? null,
  );
  const countsOf = (): LatentCounts => ({
    cued: acc.filter((p) => p.probeClass === "cued").length,
    uncued: acc.filter((p) => p.probeClass === "uncued").length,
  });
  // Seeds from a partial pool file: counted, capped, and duplicate-gated like any
  // accepted probe; the widget detail reflects them from the start.
  for (const p of deps.seedProbes ?? []) {
    acc.push({
      question: p.question,
      accept: [...p.accept],
      entryIds: [...p.entryIds],
      probeClass: p.probeClass,
      note: p.note,
    });
  }
  if (deps.seedProbes !== undefined && deps.seedProbes.length > 0) {
    const seeded = countsOf();
    const scope = deps.mode === "per-arm" ? `arm ${deps.arm}` : "shared";
    log.info(
      `latent: ${scope} pass 1/${LATENT_MAX_PASSES} — kept probes from the partial pool (cued ${seeded.cued}, uncued ${seeded.uncued})`,
    );
    deps.onAdd?.(seeded);
  }

  const scope = deps.mode === "per-arm" ? `arm ${deps.arm}` : "shared";
  let reason: string | null =
    deps.seedProbes !== undefined && deps.seedProbes.length > 0 ? LATENT_REASON_RESUMED : null;
  let action: LatentFinalizeAction;
  for (let pass = 1; ; pass++) {
    const userMessageContent =
      reason === null
        ? buildLatentTaskMessage({
            mode: deps.mode,
            sessionPaths: deps.sessionPaths,
            tailStartsAtEntryId: deps.tailStartsAtEntryId,
            tailStartLine: citations.tailStartLine,
          })
        : buildLatentRetryTaskMessage({
            mode: deps.mode,
            sessionPaths: deps.sessionPaths,
            tailStartsAtEntryId: deps.tailStartsAtEntryId,
            tailStartLine: citations.tailStartLine,
            reason,
            kept: acc,
          });
    try {
      action = (await runJsonToolStage({
        seams: deps.seams,
        tools,
        systemPrompt: buildLatentSystemPrompt(deps),
        terminalTool: finalizeLatent,
        label: "latent authoring",
        userMessageContent,
        reasoning: deps.thinking,
        maxTokens: deps.maxTokens,
        timeoutMs: deps.timeoutMs,
        signal: deps.signal,
        rateLimitOptions: deps.rateLimitOptions,
      })) as LatentFinalizeAction;
      break; // terminal tool captured — the pass loop ends
    } catch (err) {
      // Auto-restart (up to the pass cap) ONLY on the mid-work deaths: a per-LLM-call
      // timeout or a context-window-exhausted request. The kept probes carry over
      // (same acc), and the next pass opens with the retry kickoff.
      if (!isRetryableLatentFailure(err) || pass >= LATENT_MAX_PASSES) throw err;
      reason = err instanceof BenchJudgeError ? LATENT_REASON_TIMED_OUT : LATENT_REASON_CONTEXT;
      const kept = countsOf();
      log.info(
        `latent: ${scope} pass ${pass + 1}/${LATENT_MAX_PASSES} — previous pass ${reason} (kept cued ${kept.cued}, uncued ${kept.uncued})`,
      );
    }
  }

  const counts: LatentCounts = {
    cued: acc.filter((p) => p.probeClass === "cued").length,
    uncued: acc.filter((p) => p.probeClass === "uncued").length,
  };
  if (action === "stop") return { kind: "stopped", counts };

  const pool: LatentProbe[] = poolFromAcc(acc, deps);
  const spanEntryIds = citations.spanEntryIds;
  // The add-time guard already resolved numeric citations (line positions from
  // the read view) to real ids; this finalize pass is the invariant backstop.
  const validation = validateLatentProbes(pool, {
    mode: deps.mode,
    spanEntryIds,
    enabledArms: deps.enabledArms,
  });
  if (!validation.ok) {
    throw new Error(`latent pool validation failed: ${validation.reasons.join("; ")}`);
  }
  return { kind: "completed", pool };
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
    } catch {}
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
): { positionToSpanId: ReadonlyMap<number, string>; tailStartLine: number | null } {
  const positionToSpanId = new Map<number, string>();
  let tailStartLine: number | null = null;
  for (const path of sessionPaths) {
    for (const { position, entry } of parsedLines(path)) {
      if (entry.id === tailStartsAtEntryId) {
        // tail begins — positions past it must not resolve
        if (tailStartLine === null) tailStartLine = position;
        break;
      }
      if (entry.id !== undefined && entry.type !== undefined && CONTENT_ENTRY_TYPES.has(entry.type)) {
        positionToSpanId.set(position, entry.id);
      }
    }
  }
  return { positionToSpanId, tailStartLine };
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
