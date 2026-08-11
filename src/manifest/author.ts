// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The manifest-authoring agent runner (§4.18). An out-of-session LLM agent with
// pi's CORE read-only tools (read/grep/find/ls) pointed at the pre-sliced
// compacted-away JSONL + a `write_manifest` terminal tool. The agent discovers
// recallFacts / doneOps / supersessions / abstentions + writes probes, emits the
// findings via `write_manifest`, and the harness post-processes the capture into
// a full `ScenarioManifest` (assigns ids, derives lanes, fixes domain, merges the
// scenario's taskObjective + compactionBoundary).

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  NO_TURN_LIMIT,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../runtime/model.js";
import { benchAuthoringTools, type JsonOutputTool, makeJsonOutputTool } from "../runtime/tools.js";
import { AUTHORING_SYSTEM_PROMPT } from "./prompt.js";
import {
  type Abstention,
  AUTHOR_OUTPUT_SCHEMA,
  type AuthorAbstention,
  type AuthorDoneOp,
  type AuthorOutput,
  type AuthorProbe,
  type AuthorRecallFact,
  type AuthorSupersession,
  type CompactionBoundary,
  type DoneOp,
  type Lane,
  type Probe,
  type RecallFact,
  type ScenarioManifest,
  type Supersession,
  type TaskObjective,
} from "./schema.js";

/** The scenario context the harness merges into every manifest (id, description,
 *  the planned compaction boundary, the embedded task objective). None of this
 *  is emitted by the authoring agent — it is harness-authoritative. */
export interface ScenarioContext {
  readonly id: string;
  readonly description: string;
  readonly compactionBoundary: CompactionBoundary;
  readonly taskObjective: TaskObjective;
}

/** A build-mode known condition anchor (name + the entry-id where it occurs).
 *  Passed to the agent as a starting point (build mode); absent in extract mode. */
export interface KnownCondition {
  readonly name: string;
  readonly entryId: string;
}

/** Injectable seams over the model + stage-runner dependencies (faked in tests). */
export interface AuthoringSeams {
  /** Resolve the authoring model (`resolveBenchModel`). */
  resolveModel(): Promise<ResolvedBenchModel>;
  /** Run the multi-turn authoring stage (`runBenchStage`). Faked in tests. */
  runStage(input: StageRunInput): Promise<StageRunResult>;
}

export interface RunAuthoringAgentDeps {
  readonly seams: AuthoringSeams;
  /** Working directory the read-only tools operate in (the scenario repo). */
  readonly cwd: string;
  /** Path to the pre-sliced compacted-away JSONL the agent reads. */
  readonly preSlicedJsonlPath: string;
  /** Build-mode anchors, or omit for extract mode (open discovery). */
  readonly knownConditions?: readonly KnownCondition[];
  /** Harness-authoritative scenario context (id/description/boundary/objective). */
  readonly scenarioCtx: ScenarioContext;
  /** Cooperative-abort signal (the run signal). */
  readonly signal: AbortSignal;
  /** Per-call output-token cap for the authoring `runBenchStage`. */
  readonly maxTokens: number;
}

/** The `write_manifest` tool's description — the agent calls it once when done. */
const WRITE_MANIFEST_DESCRIPTION =
  "Write the scenario manifest: the recallFacts, doneOps, supersessions, abstentions, and probes you found in the session. Call this ONCE when you are done reading the session.";

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
export function postProcessManifest(author: AuthorOutput, ctx: ScenarioContext): ScenarioManifest {
  const hasEmbedded = ctx.taskObjective.testSpec.length > 0;
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
    taskObjective: ctx.taskObjective,
    recallFacts,
    doneOps,
    supersessions,
    abstentions,
    probes,
  };
}

/**
 * Build the authoring system prompt: the §4.18 prompt with `<PATH>` substituted
 * by the pre-sliced JSONL path, plus the `knownConditions` list appended when the
 * session was designed with anchors (build mode). Extract mode omits the data.
 */
export function buildAuthoringSystemPrompt(deps: {
  preSlicedJsonlPath: string;
  knownConditions?: readonly KnownCondition[];
}): string {
  // Use a replacement function (not a replacement string) so `$` in the JSONL path
  // is treated literally — String.replace's replacement string mangles `$&`/`$1`/etc.
  let prompt = AUTHORING_SYSTEM_PROMPT.replaceAll("<PATH>", () => deps.preSlicedJsonlPath);
  if (deps.knownConditions && deps.knownConditions.length > 0) {
    const list = deps.knownConditions.map((kc) => `- ${kc.name} — entry ${kc.entryId}`).join("\n");
    prompt += `\n\nKNOWN CONDITIONS (the session was designed to contain these — use as anchors):\n${list}\nRead each cited entry and extract the exact content.`;
  }
  return prompt;
}

/**
 * Compose the authoring tool set: pi's core read-only tools (read/grep/find/ls)
 * bound to `cwd` + the `write_manifest` terminal tool (validated against
 * `AUTHOR_OUTPUT_SCHEMA`, captures payloads on `._captured`).
 */
export function buildAuthoringTools(cwd: string): { tools: AgentTool[]; writeManifest: JsonOutputTool } {
  const writeManifest = makeJsonOutputTool("write_manifest", WRITE_MANIFEST_DESCRIPTION, AUTHOR_OUTPUT_SCHEMA);
  const tools: AgentTool[] = [...benchAuthoringTools(cwd), writeManifest];
  return { tools, writeManifest };
}

/**
 * Run the manifest-authoring agent: compose tools + prompt, resolve the model,
 * drive a multi-turn stage that reads the pre-sliced JSONL + writes the manifest,
 * then post-process the captured payload into a full `ScenarioManifest`.
 *
 * @throws when the model cannot be resolved OR the agent never called
 *   `write_manifest` (no capture) — caller STOP-and-surfaces (§3.8).
 */
export async function runAuthoringAgent(deps: RunAuthoringAgentDeps): Promise<ScenarioManifest> {
  const { tools, writeManifest } = buildAuthoringTools(deps.cwd);
  const systemPrompt = buildAuthoringSystemPrompt({
    preSlicedJsonlPath: deps.preSlicedJsonlPath,
    knownConditions: deps.knownConditions,
  });

  const resolved = await deps.seams.resolveModel();
  if (!resolved.ok) {
    throw new Error(`authoring model not available: ${resolved.error}`);
  }

  const userMessage: AgentMessage = {
    role: "user",
    content: `Read the session file at ${deps.preSlicedJsonlPath} and produce the manifest. Use your tools to read it, then call write_manifest with your findings.`,
    timestamp: Date.now(),
  };

  const result = await deps.seams.runStage({
    systemPrompt,
    messages: [userMessage],
    tools,
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal: deps.signal,
    reasoning: NO_REASONING,
    maxTurns: NO_TURN_LIMIT, // multi-turn: read entries, then write_manifest
    maxTokens: deps.maxTokens,
    timeoutMs: null, // tool-bearing stage may run slow reads/greps
    onEvent: NO_EVENT_SINK,
    onStageEnd: NO_STAGE_END_HOOK,
    loopFn: NO_LOOP_OVERRIDE,
  });

  // A timed-out / aborted stage may have left a partial `write_manifest` capture —
  // do NOT silently post-process it; surface the failure (§3.8 stop-and-surface).
  if (result.timedOut) {
    throw new Error("authoring stage timed out before completing the manifest");
  }
  if (result.aborted) {
    throw new Error("authoring stage was aborted before completing the manifest");
  }

  const captured = writeManifest._captured;
  if (captured.length === 0) {
    throw new Error("authoring agent did not call write_manifest — no manifest captured");
  }
  const author = captured[captured.length - 1] as AuthorOutput;
  return postProcessManifest(author, deps.scenarioCtx);
}
