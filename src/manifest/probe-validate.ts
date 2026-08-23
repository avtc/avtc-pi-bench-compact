// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The probe validator: a separate background agent that gates every probe at
// ADD time (latent pools AND the scenario manifest). The authoring agent cannot
// be its own fact-checker — it read the tail while writing the question, and the
// observed failure (run 2026-08-22-2) was latent probes answerable from the kept
// tail's arc tables that the author's own absence scan missed. The validator is
// the compacted agent: it ANSWERS the probe first (from summary + tail + repo +
// reasoning), and any answer it can produce that matches accept[] breaks the
// probe — execution-based evidence, not checklist opinion.
//
// Reporting is a REGISTERED TOOL (report_verdict, schema-validated at the tool
// level — never free-text JSON parsing). A stage that ends without a usable
// verdict gets exactly one retry; a second failure throws
// ProbeValidationStoppedError — the stage stops and surfaces with operator
// attention. A broken validator must never silently pass broken probes.

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  NO_EVENT_SINK,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_STREAM_FN,
  NO_TURN_LIMIT,
  type runBenchStage,
  toStageReasoning,
} from "../runtime/agent-loop.js";
import { benchReadOnlyTools, makeJsonOutputTool, NO_CAPTURE } from "../runtime/tools.js";

/** The registered verdict tool's name (composed into the validator's tool set). */
export const REPORT_VERDICT_TOOL = "report_verdict";

/** The validator agent's resolved parameters (model already resolved by the caller). */
export interface ProbeValidatorAgent {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly thinking: ThinkingLevel | null;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/** The probe under validation. */
export interface ProbeValidationTarget {
  /** latent (per-arm pool) or manifest (scenario manifest at build time). */
  readonly kind: "latent" | "manifest";
  readonly question: string;
  readonly accept: readonly string[];
  /** The span entry ids the probe cites as its evidence. */
  readonly citedEntryIds: readonly string[];
  /** Latent only: the claimed cued/uncued class. */
  readonly claimedClass?: string;
}

/** One reported problem: the check it failed + the evidence line. */
export interface ProbeProblem {
  readonly check: string;
  readonly what: string;
}

/** The validator's verdict. */
export type ProbeVerdict = { readonly ok: true } | { readonly ok: false; readonly problems: readonly ProbeProblem[] };

/** Raised when the validator fails to produce a usable verdict after one retry —
 *  the calling stage stops and surfaces with operator attention (a broken
 *  validator must never silently pass probes). */
export class ProbeValidationStoppedError extends Error {
  constructor(cause: string) {
    super(`probe validator failed to report a usable verdict (${cause}) — stop-and-surface`, { cause });
    this.name = "ProbeValidationStoppedError";
  }
}

/** Tool cap for the validator stage (answer + greps + cited-entry lookups). */
const VALIDATOR_MAX_TURNS = 8;

/** The report_verdict payload schema (tool-level validation). */
const REPORT_VERDICT_SCHEMA = Type.Object({
  ok: Type.Boolean(),
  problems: Type.Optional(
    Type.Array(
      Type.Object({
        check: Type.String(),
        what: Type.String({ minLength: 1 }),
      }),
    ),
  ),
});

/** The validator's system prompt (approved protected text — changes require
 *  re-approval). The output clause routes through the registered tool. */
export const PROBE_VALIDATOR_SYSTEM = `You are a probe validator for a memory benchmark. A probe author recorded a question whose answer must exist ONLY in the compacted-away span of a coding session — the part a compacted agent can no longer see. You are that compacted agent: using ONLY the compaction summary, the kept tail, the repo working tree (read/grep/find/ls), and ordinary reasoning, write your best answer to the question. Then compare it with the accept[] criteria.

If your answer matches any criterion (or its essentials), the probe is broken — report the source you actually used: "tail" (including tables, logs, pasted run output — any row naming the same entity or value), "summary" (stated or clearly implied), "repo" (grepped strings/numbers that reproduce it), or "reasoning" (derivable: generic mechanism rationale, algebraic consequence, common knowledge — historical content such as what was observed, tried, rejected, said, decided, or values before a change counts as derivable from none of these).

Then two integrity checks: "span" — the cited span entries (look them up in the pre-sliced file by id) must actually contain the answer or its essentials; a probe whose own evidence does not hold its answer is unfaithful. "wording" — the question itself hints at or contains part of the answer. For latent probes also "class": topic named in summary or tail while the answer is absent → cued; neither present → uncued; report a mismatch with the claimed class.

Report your verdict by calling ${REPORT_VERDICT_TOOL} exactly once: {"ok": true} when the probe stands, or {"ok": false, "problems": [...]} with one {check, what} item per problem — what carries the answer you produced and where it came from, or what is wrong. Base every problem on an answer you actually produced or a citation you actually read — report suspicions only when your reconstruction would plausibly pass as correct.`;

/** The verdict-reporting terminal tool. */
function makeReportVerdictTool(): ReturnType<typeof makeJsonOutputTool> {
  return makeJsonOutputTool(
    REPORT_VERDICT_TOOL,
    "Report the probe verdict: ok true when the probe stands, or ok false with one {check, what} problem per finding.",
    REPORT_VERDICT_SCHEMA,
    NO_CAPTURE,
  );
}

/** Render the target + context into the validator's user message. */
function validatorUserMessage(target: ProbeValidationTarget, spanPath: string): string {
  const lines = [
    "Validate this probe.",
    `question: ${target.question}`,
    `accept[]: ${target.accept.join(" | ")}`,
    `cited span entry ids: ${target.citedEntryIds.join(", ") || "(none)"}`,
  ];
  if (target.claimedClass !== undefined) lines.push(`claimed class: ${target.claimedClass}`);
  lines.push(
    `pre-sliced span file (look up the cited entries by id here): ${spanPath}`,
    "The compaction summary and kept tail are in the system message. Work from the repo via your tools.",
  );
  return lines.join("\n");
}

/** A user message block of the stage's minimal AgentMessage shape. */
function userMessageOf(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

/** An assistant marker between the first attempt and the retry nudge. */
function assistantNoteOf(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

/** The retry nudge appended when a stage ends without a usable verdict. */
const RETRY_NUDGE =
  "Your previous run ended without calling report_verdict with a usable verdict. Validate the probe again and call report_verdict exactly once this time.";

/** Inputs to {@link runProbeValidator}. */
export interface ProbeValidatorInput {
  readonly target: ProbeValidationTarget;
  /** The compaction summary the compacted agent sees (arm summary / trial summary). */
  readonly summary: string;
  /** The kept-tail text (normalized join of the tail entries' message text). */
  readonly tail: string;
  /** The repo working tree the validator's read-only tools bind to. */
  readonly repoCwd: string;
  /** Path of the pre-sliced span JSONL (cited-entry lookups). */
  readonly spanPath: string;
  readonly agent: ProbeValidatorAgent;
  readonly runStage: typeof runBenchStage;
  readonly signal: AbortSignal;
}

/** Extract a usable verdict from a capture, or null when malformed. */
function verdictOf(capture: unknown): ProbeVerdict | null {
  if (typeof capture !== "object" || capture === null) return null;
  const c = capture as { ok?: unknown; problems?: unknown };
  if (c.ok === true) return { ok: true };
  if (c.ok !== false) return null;
  if (!Array.isArray(c.problems) || c.problems.length === 0) return null;
  const problems: ProbeProblem[] = [];
  for (const p of c.problems) {
    if (typeof p !== "object" || p === null) return null;
    const { check, what } = p as { check?: unknown; what?: unknown };
    if (typeof check !== "string" || typeof what !== "string" || what.length === 0) return null;
    problems.push({ check, what });
  }
  return { ok: false, problems };
}

/** Run the probe validator: one stage attempt, one retry on a missing/malformed
 *  verdict, then {@link ProbeValidationStoppedError}. The verdict capture is
 *  schema-validated at the tool level; semantic consistency is checked here. */
export async function runProbeValidator(input: ProbeValidatorInput): Promise<ProbeVerdict> {
  const systemPrompt = [
    PROBE_VALIDATOR_SYSTEM,
    "",
    "## Compaction summary (what the compacted agent sees in place of the span)",
    input.summary,
    "",
    "## Kept tail (still in the compacted agent's context)",
    input.tail,
  ].join("\n");
  const reportVerdict = makeReportVerdictTool();
  const tools = [...benchReadOnlyTools(input.repoCwd), reportVerdict];
  let lastCause = "stage ended without calling report_verdict";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userMessage = validatorUserMessage(input.target, input.spanPath);
    const messages =
      attempt === 0
        ? [userMessageOf(userMessage)]
        : [userMessageOf(userMessage), assistantNoteOf("(previous attempt)"), userMessageOf(RETRY_NUDGE)];
    await input.runStage({
      systemPrompt,
      messages,
      tools,
      model: input.agent.model,
      apiKey: input.agent.apiKey,
      signal: input.signal,
      reasoning: input.agent.thinking === null ? NO_REASONING : toStageReasoning(input.agent.thinking),
      maxTurns: VALIDATOR_MAX_TURNS,
      maxTokens: input.agent.maxTokens,
      timeoutMs: input.agent.timeoutMs,
      onEvent: NO_EVENT_SINK,
      onStageEnd: NO_STAGE_END_HOOK,
      loopFn: null,
      streamFn: NO_STREAM_FN,
      label: "probe validator",
    } as Parameters<typeof runBenchStage>[0]);
    const capture = (reportVerdict as { _captured?: unknown[] })._captured?.at(-1);
    const verdict = verdictOf(capture);
    if (verdict !== null) return verdict;
    lastCause =
      capture === undefined
        ? "stage ended without calling report_verdict"
        : "verdict inconsistent (ok without usable problems)";
    if (attempt === 0) (reportVerdict as { _captured?: unknown[] })._captured?.pop();
  }
  throw new ProbeValidationStoppedError(lastCause);
}

// --- add-time closure (mechanical gate + validator agent) --------------------

import { readSessionEntries } from "../orchestrate/trace.js";
import type { ResolvedBenchModel } from "../runtime/model.js";
import { messageText } from "../session/message-text.js";
import { mechanicalLeak } from "./probe-leak-gate.js";

/** The model-resolution + stage seams the add-time closure needs (the same
 *  shapes the authoring stages use). */
export interface ValidatorSeams {
  readonly resolveModel: () => Promise<ResolvedBenchModel>;
  readonly runStage: typeof runBenchStage;
}

/** The validator agent's non-model parameters (model resolved per call). */
export interface ValidatorBudget {
  readonly thinking: ThinkingLevel | null;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/** One validated probe's content (the fields the gate + validator read). */
export interface ValidatableProbe {
  readonly question: string;
  readonly accept: readonly string[];
  readonly citedEntryIds: readonly string[];
  /** Latent probes only: the claimed cued/uncued class. */
  readonly claimedClass?: string;
}

/** The per-arm (or per-build) add-time validation closure: mechanical leak-gate
 *  first (instant, no LLM), then the validator agent. Throws
 *  ProbeValidationStoppedError when the validator cannot report a verdict —
 *  the caller's stage stops and surfaces with operator attention. */
export function makeAddTimeValidator(args: {
  readonly kind: "latent" | "manifest";
  readonly summary: string;
  readonly tail: string;
  readonly repoCwd: string;
  readonly spanPath: string;
  readonly seams: ValidatorSeams;
  readonly budget: ValidatorBudget;
  readonly signal: AbortSignal;
}): (probe: ValidatableProbe) => Promise<ProbeVerdict> {
  return async (probe) => {
    const gate = mechanicalLeak(
      { question: probe.question, accept: [...probe.accept] },
      { summary: args.summary, tail: args.tail },
    );
    if (gate !== null) return { ok: false, problems: [{ check: "mechanical", what: gate }] };
    const resolved = await args.seams.resolveModel();
    if (!resolved.ok) throw new ProbeValidationStoppedError(`validator model resolution failed: ${resolved.error}`);
    const verdict = await runProbeValidator({
      target: {
        kind: args.kind,
        question: probe.question,
        accept: [...probe.accept],
        citedEntryIds: [...probe.citedEntryIds],
        ...(probe.claimedClass === undefined ? {} : { claimedClass: probe.claimedClass }),
      },
      summary: args.summary,
      tail: args.tail,
      repoCwd: args.repoCwd,
      spanPath: args.spanPath,
      agent: { model: resolved.model, apiKey: resolved.apiKey ?? "", ...args.budget },
      runStage: args.seams.runStage,
      signal: args.signal,
    });
    return verdict;
  };
}

/** Read the kept-tail text of a session file: the message text of every entry
 *  from the anchor (inclusive) to the end of the file. */
export function readKeptTailText(sessionPath: string, anchorId: string): string {
  const entries = readSessionEntries(sessionPath);
  const anchorIndex = entries.findIndex((e) => (e as { id?: string }).id === anchorId);
  const from = anchorIndex === -1 ? 0 : anchorIndex;
  return entries
    .slice(from)
    .map((e) => messageText(e).trim())
    .filter((t) => t.length > 0)
    .join("\n");
}
