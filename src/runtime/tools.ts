// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tool composition for the bench's out-of-session agent stages.
//
//  - `benchReadOnlyTools(cwd)` / `benchCodingTools(cwd)` thin-wrap pi's core tool
//    factories so the manifest-authoring agent and the judge agentLoop
//    operate on a real session JSONL / repo with the SAME tools a live
//    coding agent uses (read/grep/find/ls [+ bash/edit/write]).
//  - `makeJsonOutputTool(name, description, schema)` builds an `AgentTool` whose
//    `execute` validates the agent's arguments against a typebox schema and
//    accumulates the emitted JSON on `tool._captured`. This is the template the
//    manifest-authoring agent's `write_manifest` and the judge's `grade` tools
//    build on: one terminal JSON tool per stage whose captured
//    value is the stage's structured output.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBashTool, createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Read-only core tools (read/grep/find/ls) bound to a working directory. Used by
 *  the judge agentLoop when it must not mutate files. */
export function benchReadOnlyTools(cwd: string): AgentTool[] {
  return createReadOnlyTools(cwd);
}

/** Authoring tool set: read-only core tools (read/grep/find/ls) + `bash`
 *  (for JSONL parsing via jq) + the stage's terminal JSON tool is added by the
 *  caller. Used by the manifest-authoring agent on the pre-sliced session JSONL. */
export function benchAuthoringTools(cwd: string): AgentTool[] {
  return [...createReadOnlyTools(cwd), createBashTool(cwd)];
}

/** Full coding tool set (read/grep/find/ls + bash/edit/write) bound to a cwd. */
export function benchCodingTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd);
}

/** An `AgentTool` that also exposes the JSON objects it has validated + captured
 *  across `execute` calls. Callers (manifest authoring, judge) read `._captured`
 *  as the stage's structured terminal output. */
export interface JsonOutputTool<TParameters extends TSchema = TSchema> extends AgentTool<TParameters> {
  /** Validated JSON objects the agent emitted via this tool (in call order). */
  readonly _captured: unknown[];
}

/** Build a JSON-output tool: the agent calls it once (or more) with structured
 *  arguments validated against `paramSchema`; validated objects accumulate on
 *  `tool._captured` and the agent is acked. Invalid arguments are rejected with
 *  an error text (nothing accumulated). */
export function makeJsonOutputTool<TParameters extends TSchema>(
  name: string,
  description: string,
  paramSchema: TParameters,
): JsonOutputTool<TParameters> {
  const captured: unknown[] = [];
  const tool: JsonOutputTool<TParameters> = {
    name,
    label: name,
    description,
    parameters: paramSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<{ accepted: number; rejected: number }>> {
      if (!Value.Check(paramSchema, params)) {
        return {
          content: [
            { type: "text", text: `rejected: arguments did not match the ${name} schema; fix and call ${name} again` },
          ],
          details: { accepted: 0, rejected: 1 },
        };
      }
      captured.push(params);
      return {
        content: [{ type: "text", text: `recorded ${name}; stop calling tools and reply Done` }],
        details: { accepted: 1, rejected: 0 },
        terminate: true,
      };
    },
    // expose the accumulator (defensive copy each read — callers cannot mutate
    // the internal state via the returned array) on the tool object
    get _captured(): unknown[] {
      return captured.slice();
    },
  };
  return tool;
}

/** Re-export `Type` so tool-schema authors import schema-building from the same
 *  module that builds the tool (one import surface for the manifest/judge tools). */
export { Type };
