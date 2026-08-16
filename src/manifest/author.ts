// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The manifest-authoring agent runner. An out-of-session LLM agent with
// pi's CORE tools (read/grep/find/ls + bash) pointed at the pre-sliced
// compacted-away JSONL + a `write_manifest` terminal tool. The agent discovers
// recallFacts / doneOps / supersessions / abstentions + writes probes, emits the
// findings via `write_manifest`, and the harness post-processes the capture into
// a full `ScenarioManifest` (assigns ids, derives lanes, fixes domain, merges the
// scenario's taskObjective + compactionBoundary).

import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type JsonToolStageSeams, runJsonToolStage } from "../judge/stage-runner.js";
import { log } from "../log.js";
import {
  benchAuthoringTools,
  type JsonOutputTool,
  makeAccumulatingTool,
  makeJsonOutputTool,
  NO_CAPTURE,
} from "../runtime/tools.js";
import { AUTHORING_SYSTEM_PROMPT } from "./prompt.js";
import {
  ABSTENTION_ITEM_SCHEMA,
  type Abstention,
  type AuthorAbstention,
  type AuthorDoneOp,
  type AuthorOutput,
  type AuthorProbe,
  type AuthorRecallFact,
  type AuthorSupersession,
  type AuthorTailConflict,
  DONE_OP_ITEM_SCHEMA,
  type DoneOp,
  type Lane,
  PROBE_ITEM_SCHEMA,
  type Probe,
  RECALL_FACT_ITEM_SCHEMA,
  type RecallFact,
  type ScenarioContext,
  type ScenarioManifest,
  SUPERSESSION_ITEM_SCHEMA,
  type Supersession,
  TAIL_CONFLICT_ITEM_SCHEMA,
  TASK_OBJECTIVE_SCHEMA,
} from "./schema.js";

export type { ScenarioContext } from "./schema.js";

/** A build-mode known condition anchor (name + the entry-id where it occurs).
 *  Passed to the agent as a starting point (build mode); absent in extract mode. */
export interface KnownCondition {
  readonly name: string;
  readonly entryId: string;
}

/** Injectable seams: resolve the authoring model + run the bench stage (faked in tests).
 *  Alias of the shared {@link JsonToolStageSeams} (the manifest author uses the same
 *  stage-runner as the judge trajectory/boundary stages). */
export type AuthoringSeams = JsonToolStageSeams;

export interface RunAuthoringAgentDeps {
  /** Fires after every accepted per-item tool call with the live condition
   *  counts — the widget's extract-phase coverage signal. */
  readonly onAdd: (counts: ConditionCounts) => void;
  readonly seams: AuthoringSeams;
  /** Working directory the authoring tools operate in (the scenario repo). */
  readonly cwd: string;
  /** Path to the FULL backup JSONL the agent reads (span + kept tail; the prompt
   *  marks the tail boundary via {@link tailStartsAtEntryId}). */
  readonly fullJsonlPath: string;
  /** The kept-tail boundary entry id (firstKeptEntryId of the trial compaction):
   *  this entry and everything after it stays raw in the agent's context. */
  readonly tailStartsAtEntryId: string;
  /** Path to the pre-sliced compacted-away JSONL — citation sanitization input
   *  (the agent itself reads {@link fullJsonlPath}). */
  readonly preSlicedJsonlPath: string;
  /** Build-mode anchors, or omit for extract mode (open discovery). */
  readonly knownConditions?: readonly KnownCondition[];
  /** Harness-authoritative scenario context (id/description/boundary/objective). */
  readonly scenarioCtx: ScenarioContext;
  /** Cooperative-abort signal (the run signal). */
  readonly signal: AbortSignal;
  /** Per-call output-token cap for the authoring `runBenchStage`. */
  readonly maxTokens: number;
  /**
   * Rate-limit options for the authoring stage (defaults: pause+resume on a 429,
   * up to 5 attempts). The authoring model is a cloud LLM that may be throttled;
   * threading this (parity with the trajectory + recall-cost stages) makes the resilience tunable /
   * opt-out-able instead of a silent hardcoded default.
   */
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/** Progressive per-item tool descriptions — the author records each condition the
 *  moment it is confirmed (like the judge's grade tool), then finalizes once. */
const ADD_RECALL_FACT_DESCRIPTION =
  "Record ONE key decision or technical detail worth remembering after compaction. Call this as soon as you confirm it from the session; call again for each additional fact.";
const ADD_DONE_OP_DESCRIPTION =
  "Record ONE completed piece of work (a system, feature, or fix that is done). Call as soon as you confirm it; call again per item.";
const ADD_SUPERSESSION_DESCRIPTION =
  "Record ONE reversed decision: the subject, the OLD value, and the LATEST value. Call as soon as you confirm it; call again per reversal.";
const ADD_ABSTENTION_DESCRIPTION =
  "Record ONE question that was deliberately left OPEN (never decided). Call as soon as you confirm it; call again per question.";
const ADD_PROBE_DESCRIPTION =
  "Record ONE direct probe question (accept list for a recallable answer, or correctRefusal with no accept list for a stale/open answer). Call as soon as you author it; call again per probe.";
const ADD_TAIL_CONFLICT_DESCRIPTION =
  "Record ONE conflict between a finding and the kept tail: kind 'answerable' (the tail restates the answer — a probe would pass from raw context) or 'superseded' (the tail changes the fact). Cite the finding's SPAN entryIds. Call once per conflicted finding.";
const FINALIZE_MANIFEST_DESCRIPTION =
  "Finalize the manifest with the task objective (what was built + how to test it). Call ONCE when you have recorded everything — this ends the manifest authoring.";

/** Assign sequential ids of the form `<prefix><n>` (rf1, rf2, do1, …). */
function assignIds<T>(items: readonly T[], prefix: string): (T & { id: string })[] {
  return items.map((item, i) => ({ ...item, id: `${prefix}${i + 1}` }));
}

/** Derive a condition's lanes: `embedded` when the scenario has an embedded
 *  testSpec, `direct-probe` when a probe targets one of its entryIds. */
function deriveLanes(
  conditionEntryIds: readonly string[],
  ctx: { hasEmbedded: boolean; targetedIds: Set<string> },
): Lane[] {
  const lanes: Lane[] = [];
  if (ctx.hasEmbedded) lanes.push("embedded");
  if (conditionEntryIds.some((id) => ctx.targetedIds.has(id))) lanes.push("direct-probe");
  return lanes;
}

/**
 * Post-process the authoring agent's `write_manifest` capture into a full
 * `ScenarioManifest`: assign sequential ids (rf/do/ss/ab), derive lanes per
 * condition (embedded from testSpec, direct-probe from probe targeting), fix
 * `domain: "technical"` on recallFacts, and merge the scenario context.
 *
 * Pure — directly testable with no seams.
 */
/** Drop citations the pre-sliced span cannot resolve (authoring-side hallucinated
 *  entry ids) + the conditions/probes left with no anchors. Without this, the
 *  landing classifier counts unresolvable ids as tail and the build loop chases
 *  phantom tails into the clamp; validation would also reject them on proceed.
 *  Returns the cleaned manifest; logs every drop (observability). */
export function sanitizeCitations(manifest: ScenarioManifest, spanEntryIds: ReadonlySet<string>): ScenarioManifest {
  // Pull the original tailConflicts out of the spread base — the cleaned value (or
  // absence) below must fully own the field, never the unsanitized original.
  const { tailConflicts: originalConflicts, ...manifestBase } = manifest;
  const drops = { conditions: 0, ids: 0, probes: 0 };
  const cleanIds = (ids: readonly string[]): readonly string[] => {
    const kept = ids.filter((id) => spanEntryIds.has(id));
    drops.ids += ids.length - kept.length;
    return kept;
  };
  const cleanList = <T extends { entryIds: readonly string[] }>(list: readonly T[]): readonly T[] => {
    const out: T[] = [];
    for (const c of list) {
      const kept = cleanIds(c.entryIds);
      if (kept.length === 0) {
        drops.conditions += 1;
        continue; // no anchor left — the condition cannot be graded in-span
      }
      out.push(kept.length === c.entryIds.length ? c : { ...c, entryIds: kept });
    }
    return out;
  };
  const recallFacts = cleanList(manifest.recallFacts);
  const doneOps = cleanList(manifest.doneOps);
  const supersessions = cleanList(manifest.supersessions);
  const abstentions = cleanList(manifest.abstentions);
  const probes = manifest.probes.flatMap((p) => {
    const kept = cleanIds(p.targets);
    if (kept.length === 0) {
      drops.probes += 1;
      return [];
    }
    return [kept.length === p.targets.length ? p : { ...p, targets: kept }];
  });
  // Tail conflicts cite the finding's span entryIds — clean them the same way; a
  // conflict left with no resolvable id cannot match any condition and is dropped.
  const tailConflicts = (originalConflicts ?? []).flatMap((c) => {
    const kept = cleanIds(c.entryIds);
    if (kept.length === 0) return [];
    return [kept.length === c.entryIds.length ? c : { ...c, entryIds: kept }];
  });
  if (drops.conditions > 0 || drops.ids > 0 || drops.probes > 0) {
    log.warn(
      `author citations sanitized against the span: dropped ${drops.conditions} condition(s), ` +
        `${drops.ids} citation id(s), ${drops.probes} probe(s) — unresolvable (hallucinated) entry ids`,
    );
  }
  return {
    ...manifestBase,
    recallFacts,
    doneOps,
    supersessions,
    abstentions,
    probes,
    ...(tailConflicts.length > 0 ? { tailConflicts } : {}),
  };
}

export function postProcessManifest(author: AuthorOutput, ctx: ScenarioContext): ScenarioManifest {
  const hasEmbedded = author.taskObjective.testSpec.length > 0;
  const targetedIds = new Set(author.probes.flatMap((p) => p.targets));
  const laneCtx = { hasEmbedded, targetedIds };

  const recallFacts: RecallFact[] = assignIds<AuthorRecallFact>(author.recallFacts, "rf").map(
    ({ id, fact, accept, entryIds }): RecallFact => ({
      id,
      fact,
      accept,
      entryIds,
      domain: "technical",
      lanes: deriveLanes(entryIds, laneCtx),
    }),
  );
  const doneOps: DoneOp[] = assignIds<AuthorDoneOp>(author.doneOps, "do").map(
    ({ id, description, artifact, reworkable, entryIds }): DoneOp => ({
      id,
      description,
      artifact,
      reworkable,
      entryIds,
      lanes: deriveLanes(entryIds, laneCtx),
    }),
  );
  const supersessions: Supersession[] = assignIds<AuthorSupersession>(author.supersessions, "ss").map(
    ({ id, subject, oldValue, latestValue, entryIds }): Supersession => ({
      id,
      subject,
      oldValue,
      latestValue,
      entryIds,
      lanes: deriveLanes(entryIds, laneCtx),
    }),
  );
  const abstentions: Abstention[] = assignIds<AuthorAbstention>(author.abstentions, "ab").map(
    ({ id, question, correctRefusal, entryIds }): Abstention => ({
      id,
      question,
      correctRefusal,
      entryIds,
      lanes: deriveLanes(entryIds, laneCtx),
    }),
  );
  // Probes ARE direct probes — they always exercise the direct-probe lane.
  const probes: Probe[] = author.probes.map((p: AuthorProbe): Probe => ({ ...p, lanes: ["direct-probe"] }));

  return {
    id: ctx.id,
    description: ctx.description,
    compactionBoundary: ctx.compactionBoundary,
    // taskObjective is DISCOVERED by the authoring agent (what was built + how to test it),
    // not harness-provided — makes the bench flexible for any idea + extracted sessions.
    // lane is present iff testSpec is non-empty (consistent with deriveLanes' embedded lane).
    taskObjective:
      author.taskObjective.testSpec.length > 0
        ? { ...author.taskObjective, lane: "embedded-test" }
        : author.taskObjective,
    recallFacts,
    doneOps,
    supersessions,
    abstentions,
    probes,
    ...(author.tailConflicts !== undefined && author.tailConflicts.length > 0
      ? { tailConflicts: author.tailConflicts }
      : {}),
  };
}

/**
 * Build the authoring system prompt: the authoring prompt with `<PATH>` substituted
 * by the FULL backup JSONL path and `<TAIL_START>` by the kept-tail boundary entry
 * id, plus the `knownConditions` list appended when the session was designed with
 * anchors (build mode). Extract mode omits the data.
 */
export function buildAuthoringSystemPrompt(deps: {
  fullJsonlPath: string;
  tailStartsAtEntryId: string;
  knownConditions?: readonly KnownCondition[];
}): string {
  // Use a replacement function (not a replacement string) so `$` in the JSONL path
  // is treated literally — String.replace's replacement string mangles `$&`/`$1`/etc.
  let prompt = AUTHORING_SYSTEM_PROMPT.replaceAll("<PATH>", () => deps.fullJsonlPath).replaceAll(
    "<TAIL_START>",
    () => deps.tailStartsAtEntryId,
  );
  if (deps.knownConditions && deps.knownConditions.length > 0) {
    const list = deps.knownConditions.map((kc) => `- ${kc.name} — entry ${kc.entryId}`).join("\n");
    prompt += `\n\nKNOWN CONDITIONS (the session was designed to contain these — use as anchors):\n${list}\nRead each cited entry and extract the exact content.`;
  }
  return prompt;
}

/** Live condition counts after each accepted per-item tool call — the widget's
 *  extract-phase progress signal (topics = lists with >=1 item). */
export interface ConditionCounts {
  readonly recallFacts: number;
  readonly doneOps: number;
  readonly supersessions: number;
  readonly abstentions: number;
}

/** The accumulated authoring findings (each item arrives via its own tool call). */
export interface AuthorAccumulators {
  recallFacts: AuthorRecallFact[];
  doneOps: AuthorDoneOp[];
  supersessions: AuthorSupersession[];
  abstentions: AuthorAbstention[];
  probes: AuthorProbe[];
  tailConflicts: AuthorTailConflict[];
}

/**
 * Compose the PROGRESSIVE authoring tool set: pi's core read-only tools
 * (read/grep/find/ls) + `bash` (for JSONL parsing) bound to `cwd`, five per-item
 * recording tools (add_recall_fact / add_done_op / add_supersession /
 * add_abstention / add_probe — each call records ONE complete, validated item;
 * work progresses call by call, nothing is re-emitted), and the
 * `finalize_manifest` terminal tool (carries the task objective and ends the
 * stage). `onAdd` fires with the live counts after every accepted item.
 */
export function buildAuthoringTools(
  cwd: string,
  onAdd: (counts: ConditionCounts) => void,
): { tools: AgentTool[]; finalizeManifest: JsonOutputTool; acc: AuthorAccumulators } {
  const acc: AuthorAccumulators = {
    recallFacts: [],
    doneOps: [],
    supersessions: [],
    abstentions: [],
    probes: [],
    tailConflicts: [],
  };
  const notify = (): void =>
    onAdd({
      recallFacts: acc.recallFacts.length,
      doneOps: acc.doneOps.length,
      supersessions: acc.supersessions.length,
      abstentions: acc.abstentions.length,
    });
  const sink =
    <T>(list: T[]): ((item: Record<string, unknown>) => void) =>
    (item) => {
      list.push(item as unknown as T);
      notify();
    };
  const finalizeManifest = makeJsonOutputTool(
    "finalize_manifest",
    FINALIZE_MANIFEST_DESCRIPTION,
    TASK_OBJECTIVE_SCHEMA,
    NO_CAPTURE,
  );
  const tools: AgentTool[] = [
    ...benchAuthoringTools(cwd),
    makeAccumulatingTool(
      "add_recall_fact",
      ADD_RECALL_FACT_DESCRIPTION,
      RECALL_FACT_ITEM_SCHEMA,
      sink(acc.recallFacts),
    ),
    makeAccumulatingTool("add_done_op", ADD_DONE_OP_DESCRIPTION, DONE_OP_ITEM_SCHEMA, sink(acc.doneOps)),
    makeAccumulatingTool(
      "add_supersession",
      ADD_SUPERSESSION_DESCRIPTION,
      SUPERSESSION_ITEM_SCHEMA,
      sink(acc.supersessions),
    ),
    makeAccumulatingTool("add_abstention", ADD_ABSTENTION_DESCRIPTION, ABSTENTION_ITEM_SCHEMA, sink(acc.abstentions)),
    makeAccumulatingTool("add_probe", ADD_PROBE_DESCRIPTION, PROBE_ITEM_SCHEMA, sink(acc.probes)),
    makeAccumulatingTool(
      "add_tail_conflict",
      ADD_TAIL_CONFLICT_DESCRIPTION,
      TAIL_CONFLICT_ITEM_SCHEMA,
      sink(acc.tailConflicts),
    ),
    finalizeManifest,
  ];
  return { tools, finalizeManifest, acc };
}

/**
 * Run the manifest-authoring agent: compose tools + prompt, resolve the model,
 * drive a multi-turn stage that reads the pre-sliced JSONL + writes the manifest,
 * then post-process the captured payload into a full `ScenarioManifest`.
 *
 * @throws when the model cannot be resolved OR the agent never called
 *   `write_manifest` (no capture) — caller STOP-and-surfaces.
 */
/** JSONL line separator (named constant for the split). */
const JSONL_NEWLINE = "\n";

export async function runAuthoringAgent(deps: RunAuthoringAgentDeps): Promise<ScenarioManifest> {
  const { tools, finalizeManifest, acc } = buildAuthoringTools(deps.cwd, deps.onAdd);
  const systemPrompt = buildAuthoringSystemPrompt({
    fullJsonlPath: deps.fullJsonlPath,
    tailStartsAtEntryId: deps.tailStartsAtEntryId,
    knownConditions: deps.knownConditions,
  });

  // The shared stage-runner owns the resolve -> runStage (rate-limit-wrapped) ->
  // check timedOut/aborted -> read-capture flow. It STOP-and-surfaces on failure
  // (a timed-out/aborted stage may leave partial accumulators — never post-process
  // them); the finalize capture carries the task objective, the per-item tools
  // carried every condition.
  const finalizePayload = (await runJsonToolStage({
    seams: deps.seams,
    tools,
    systemPrompt,
    terminalTool: finalizeManifest,
    label: "authoring",
    userMessageContent: `Read the FULL session file at ${deps.fullJsonlPath} and produce the manifest. The KEPT TAIL starts at the entry with id ${deps.tailStartsAtEntryId} — everything before that entry is the compacted-away span (find facts there); validate each finding against the tail per the instructions. Use your tools to read it, record each finding with its add_* tool as you confirm it, then call finalize_manifest with the task objective when done.`,
    maxTokens: deps.maxTokens,
    signal: deps.signal,
    rateLimitOptions: deps.rateLimitOptions,
  })) as { description: string; testSpec: string };
  const author: AuthorOutput = {
    recallFacts: acc.recallFacts,
    doneOps: acc.doneOps,
    supersessions: acc.supersessions,
    abstentions: acc.abstentions,
    probes: acc.probes,
    ...(acc.tailConflicts.length > 0 ? { tailConflicts: acc.tailConflicts } : {}),
    taskObjective: finalizePayload,
  };
  const manifest = postProcessManifest(author, deps.scenarioCtx);
  try {
    const spanEntryIds = new Set(
      readFileSync(deps.preSlicedJsonlPath, "utf8")
        .split(JSONL_NEWLINE)
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return (JSON.parse(l) as { id?: string }).id;
          } catch {
            return undefined;
          }
        })
        .filter((id): id is string => id !== undefined),
    );
    return sanitizeCitations(manifest, spanEntryIds);
  } catch (err) {
    // The span file is unreadable (deleted/moved mid-run): skip sanitization —
    // the manifest pipeline's own file reads will surface the real fault.
    log.warn(`citation sanitization skipped — span unreadable (${err instanceof Error ? err.message : String(err)})`);
    return manifest;
  }
}
