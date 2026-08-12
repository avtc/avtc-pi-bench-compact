// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Recall-cost boundary producer. The recall-cost metric sums post-compaction
// output tokens UP TO the entry where the agent FIRST correctly uses each
// recallFact. This module is the judge call that identifies that entry-id (or
// null when the agent never recovered the fact — the cost task then counts the
// whole run as notRecovered). The shared stage-run skeleton lives in
// stage-runner.ts; this module owns the prompt + the boundary mapping.

import { Type } from "typebox";
import type { ScenarioManifest } from "../manifest/schema.js";
import { benchReadOnlyTools, type JsonOutputTool, makeJsonOutputTool } from "../runtime/tools.js";
import type { RateLimitOptions } from "./rate-limit.js";
import { type JsonToolStageSeams, type RunJsonToolStageDeps, runJsonToolStage } from "./stage-runner.js";

/** One recall-cost boundary: the recallFact id + the first entry-id where the agent
 *  correctly used it (null = never recovered — the cost task counts notRecovered). */
export interface C2Boundary {
  readonly factId: string;
  readonly firstCorrectUseEntryId: string | null;
}

/** Injectable seams (resolve the judge model + run the bench stage). */
export type C2BoundarySeams = JsonToolStageSeams;

/** Inputs to {@link findFirstCorrectUse}. */
export interface FindFirstCorrectUseDeps {
  readonly seams: C2BoundarySeams;
  readonly cwd: string;
  readonly manifest: ScenarioManifest;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly rateLimitOptions?: RateLimitOptions | null;
}

/** The schema of the `report_boundary` tool's payload (one terminal call, all boundaries). */
const REPORT_BOUNDARY_SCHEMA = Type.Object({
  boundaries: Type.Array(
    Type.Object({
      factId: Type.String(),
      entryId: Type.Union([Type.String(), Type.Null()]),
      evidence: Type.String(),
    }),
  ),
});

const REPORT_BOUNDARY_DESCRIPTION = [
  "Record the first-correct-use boundary for each recallFact. Call this ONCE.",
  "Arguments: { boundaries: [{ factId, entryId, evidence }] } — one entry per recallFact.",
  "entryId = the session entry-id where the agent FIRST correctly uses/applies that fact",
  "(the entry's `id` field), or null if the agent never recovered it. evidence = a one-line",
  "citation. This is a terminal call: after it, reply Done.",
].join(" ");

/** Build the boundary-finding system prompt: each recallFact + the inspection instructions. */
function buildSystemPrompt(manifest: ScenarioManifest, cwd: string): string {
  const facts = manifest.recallFacts
    .map((rf) => `  - ${rf.id}: ${rf.fact} (a correct use matches: ${rf.accept.join(" | ")})`)
    .join("\n");
  return [
    "You are a strict benchmark judge locating the FIRST correct use of each recallFact.",
    `The repo is checked out to the attempt branch at ${cwd}; use read/grep/find/ls to inspect session.jsonl`,
    "(the post-compaction trajectory — entries AFTER the compaction boundary).",
    "",
    "FOR EACH recallFact, find the EARLIEST entry-id where the agent correctly uses or applies",
    "that fact (matches an accept criterion). If the agent never recovers it, use null.",
    "",
    "recallFacts to locate:",
    facts.length > 0 ? facts : "  (none — call report_boundary with an empty boundaries array)",
    "",
    "Inspect the trajectory, then call report_boundary ONCE with one boundary per recallFact.",
  ].join("\n");
}

/**
 * Find the first entry-id where the agent correctly uses each recallFact, via an
 * agentLoop + read-only tools on the attempt branch. Emits one boundary per
 * recallFact via a single terminal `report_boundary` call. Rate-limit-resilient +
 * STOP-and-surfaces on failure (delegated to runJsonToolStage). Returns an empty
 * array when the manifest has no recallFacts (no judge call). Pure aside from seams.
 */
export async function findFirstCorrectUse(deps: FindFirstCorrectUseDeps): Promise<C2Boundary[]> {
  if (deps.manifest.recallFacts.length === 0) {
    return [];
  }
  const terminalTool: JsonOutputTool = makeJsonOutputTool(
    "report_boundary",
    REPORT_BOUNDARY_DESCRIPTION,
    REPORT_BOUNDARY_SCHEMA,
  );
  const stageDeps: RunJsonToolStageDeps = {
    seams: deps.seams,
    tools: [...benchReadOnlyTools(deps.cwd), terminalTool],
    systemPrompt: buildSystemPrompt(deps.manifest, deps.cwd),
    terminalTool,
    label: "recall-cost boundary",
    userMessageContent: `Inspect the trajectory in ${deps.cwd} and find the first correct use of each recallFact. Call report_boundary once.`,
    maxTokens: deps.maxTokens,
    signal: deps.signal,
    rateLimitOptions: deps.rateLimitOptions,
  };
  const payload = (await runJsonToolStage(stageDeps)) as { boundaries?: unknown };
  const raw = Array.isArray(payload.boundaries)
    ? (payload.boundaries as Array<{ factId?: unknown; entryId?: unknown }>)
    : [];
  return raw.map((b) => ({
    factId: typeof b.factId === "string" ? b.factId : "",
    firstCorrectUseEntryId: typeof b.entryId === "string" ? b.entryId : null,
  }));
}
