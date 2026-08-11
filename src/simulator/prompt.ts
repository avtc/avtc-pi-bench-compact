// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-simulator's system prompt. The simulator is an LLM playing the
// USER / project designer; the harness paces + stops on context (the simulator
// can't measure tokens). The project THEME is a PARAMETER (`task`) — the prompt
// contains no scenario-specific assumptions, so it works for any `<idea>` in
// build mode. The conditionTopics are voiced as natural design intent the
// simulator weaves in (never announced as bench conditions): their labels + hints
// appear, but NOT their metric-axis ids or the word "conditionTopics" (jargon the
// user would never say).

import type { ConditionTopic } from "./condition-topics.js";

/** Input to {@link buildSimulatorSystemPrompt}. */
export interface SimulatorSystemPromptInput {
  /** What to build — the project brief (the `<idea>` from prepare-scenario). The
   *  theme is fully driven by this; the prompt has no baked-in scenario. */
  readonly task: string;
  /** The scored dimensions (CONDITION_TOPICS) the simulator voices naturally. */
  readonly conditionTopics: readonly ConditionTopic[];
  /** The Phase-0 compaction target in tokens. Used ONLY for qualitative pacing
   *  guidance (the simulator can't act on a raw token count; the harness owns the
   *  stop). */
  readonly targetContext: number;
}

/** A human label for how the simulator should tag each condition kind in the prompt. */
function tagLabel(tag: ConditionTopic["tag"]): string {
  return tag === "essential" ? "essential — must happen" : "optional — nice to have";
}

/** Qualitative pacing from the token target (never a raw count the LLM can't use). */
function pacingClause(targetContext: number): string {
  const scale = targetContext >= 80000 ? "a long, substantial build" : "a moderate build";
  return `This is ${scale} — design multiple systems, iterate, review between them, and keep going. Don't try to wrap up quickly; you won't be told when to stop, so just keep doing good work until you are.`;
}

/**
 * Build the user-simulator's system prompt. Plain role-play instructions;
 * no bench jargon, no `[STOP]`, no tool, no metric ids. The harness stops on
 * context — the simulator never decides to stop.
 */
export function buildSimulatorSystemPrompt(input: SimulatorSystemPromptInput): string {
  const topics = input.conditionTopics.map((t) => `  - [${tagLabel(t.tag)}] ${t.label}: ${t.hint}`).join("\n");

  return [
    `You're building "${input.task}" with a coding agent. You're the user — you decide the design, request work, review what the agent did, make decisions, change your mind, and approve. You don't write code yourself.`,
    "",
    `You'll be prompted step by step ("build your next system", "review what it did", "decide X", or told the agent asked a question — then answer as yourself). Design the project as you see fit.`,
    "",
    pacingClause(input.targetContext),
    "",
    `A few things to weave in naturally as you design — let them shape your decisions; don't announce them as a checklist:`,
    topics,
    "",
    "Stay in character — talk like a real person pair-programming their own project. No planning documents or bullet lists of intent; just talk to the agent.",
  ].join("\n");
}
