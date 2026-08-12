// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The manifest-authoring agent runner. An out-of-session LLM agent with
// pi's CORE tools (read/grep/find/ls + bash) pointed at the pre-sliced
// compacted-away JSONL + a `write_manifest` terminal tool. The agent discovers
// recallFacts / doneOps / supersessions / abstentions + writes probes, emits the
// findings via `write_manifest`, and the harness post-processes the capture into
// a full `ScenarioManifest` (assigns ids, derives lanes, fixes domain, merges the
// scenario's taskObjective + compactionBoundary).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import { type JsonToolStageSeams, runJsonToolStage } from "../judge/stage-runner.js";
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
  type DoneOp,
  type Lane,
  type Probe,
  type RecallFact,
  type ScenarioContext,
  type ScenarioManifest,
  type Supersession,
} from "./schema.js";

export type { ScenarioContext } from "./schema.js";

/** A build-mode known condition anchor (name + the entry-id where it occurs).
 *  Passed to the agent as a starting point (build mode); absent in extract mode. */
export interface KnownCondition {
  readonly name: string;
  readonly entryId: string;
}

/** Injectable seams over the model + stage-runner dependencies (faked in tests). */
/** Injectable seams: resolve the authoring model + run the bench stage (faked in tests).
 *  Alias of the shared {@link JsonToolStageSeams} (the manifest author uses the same
 *  stage-runner as the judge trajectory/boundary stages). */
export type AuthoringSeams = JsonToolStageSeams;

export interface RunAuthoringAgentDeps {
  readonly seams: AuthoringSeams;
  /** Working directory the authoring tools operate in (the scenario repo). */
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
  /**
   * Rate-limit options for the authoring stage (defaults: pause+resume on a 429,
   * up to 5 attempts). The authoring model is a cloud LLM that may be throttled;
   * threading this (parity with the trajectory + recall-cost stages) makes the resilience tunable /
   * opt-out-able instead of a silent hardcoded default.
   */
  readonly rateLimitOptions?: RateLimitOptions | null;
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
  };
}

/**
 * Build the authoring system prompt: the authoring prompt with `<PATH>` substituted
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
 * Compose the authoring tool set: pi's core read-only tools (read/grep/find/ls) +
 * `bash` (for JSONL parsing) bound to `cwd` + the `write_manifest` terminal
 * tool (validated against `AUTHOR_OUTPUT_SCHEMA`, captures payloads on `._captured`).
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
 *   `write_manifest` (no capture) — caller STOP-and-surfaces.
 */
export async function runAuthoringAgent(deps: RunAuthoringAgentDeps): Promise<ScenarioManifest> {
  const { tools, writeManifest } = buildAuthoringTools(deps.cwd);
  const systemPrompt = buildAuthoringSystemPrompt({
    preSlicedJsonlPath: deps.preSlicedJsonlPath,
    knownConditions: deps.knownConditions,
  });

  // The shared stage-runner owns the resolve -> runStage (rate-limit-wrapped) ->
  // check timedOut/aborted -> read-capture flow. It STOP-and-surfaces on failure
  // (a timed-out/aborted stage may leave a partial write_manifest — never post-
  // process it); the last captured payload is the author's structured output.
  const author = (await runJsonToolStage({
    seams: deps.seams,
    tools,
    systemPrompt,
    terminalTool: writeManifest,
    label: "authoring",
    userMessageContent: `Read the session file at ${deps.preSlicedJsonlPath} and produce the manifest. Use your tools to read it, then call write_manifest with your findings.`,
    maxTokens: deps.maxTokens,
    signal: deps.signal,
    rateLimitOptions: deps.rateLimitOptions,
  })) as AuthorOutput;

  return postProcessManifest(author, deps.scenarioCtx);
}
