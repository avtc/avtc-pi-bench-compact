// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The 4 canonical conditionTopics (§4.17) — the scored dimensions the
// user-simulator voices naturally as it designs any project (the <idea> is a runtime
// parameter; the topics are generic behavioral axes). These are the single source of
// truth for which conditions a scenario MUST/SHOULD contain: consumed by
// `buildSimulatorSystemPrompt` (8c, voiced as user intent), Task 9's manifest
// validation ("essential topics required"), and Task 10's condition-landing check.
//
// The simulator designs + voices the SPECIFICS (which decision, which system);
// the topics + their `tag`/`metricAxis` mappings are fixed here. The manifest's
// ground truth is extracted post-hoc from the produced backup (§4.15 step 3).

/** Whether a topic is scenario-invalidating (`essential`) or metric-dropping
 *  (`safeToSkip`). Essential topics MUST land; `safeToSkip` may be skipped
 *  (drops one metric) — §4.17 condition-didn't-land handling + §9.1 R8. */
export type ConditionTag = "essential" | "safeToSkip";

/** The metric axis a topic's content feeds when extracted post-hoc. Maps 1:1 to
 *  the manifest's condition types (recallFact/doneOp/supersession/abstention) +
 *  the effectiveness metrics they score (§1.6, §6). */
export type MetricAxis = "recallFact" | "doneOp" | "supersession" | "abstention";

/** One canonical conditionTopic. Frozen bench constant. */
export interface ConditionTopic {
  /** Stable identifier (manifest references, condition-landing logs). */
  readonly id: string;
  /** Short human label. */
  readonly label: string;
  /** The §4.17 hint — what the simulator voices naturally (the designer's intent
   *  in plain language; no bench jargon). */
  readonly hint: string;
  /** `essential` (must land) or `safeToSkip` (droppable, loses one metric). */
  readonly tag: ConditionTag;
  /** The condition type + metrics this topic produces when extracted. */
  readonly metricAxis: MetricAxis;
}

/**
 * The 4 canonical conditionTopics (§4.17). The simulator voices each naturally
 * as it designs; exactly one topic per metric axis. 2 `essential` (scenario
 * invalid without) + 2 `safeToSkip` (nice-to-have; losing drops one metric).
 * Frozen — the single source of truth for scenario condition structure.
 */
export const CONDITION_TOPICS: readonly ConditionTopic[] = Object.freeze(
  (
    [
      {
        id: "key-decision",
        label: "Key decision",
        hint: "Make a key decision about how something works — an architecture, data model, algorithm, or convention you'd want remembered later.",
        tag: "essential",
        metricAxis: "recallFact",
      },
      {
        id: "completed-system",
        label: "Completed work",
        hint: "Complete a unit of work and treat it as done — don't let the agent redo work you've already approved.",
        tag: "essential",
        metricAxis: "doneOp",
      },
      {
        id: "change-mind",
        label: "Changed mind",
        hint: "Start one way, then change your mind about something partway through.",
        tag: "safeToSkip",
        metricAxis: "supersession",
      },
      {
        id: "open-question",
        label: "Open question",
        hint: "Raise a question but stay undecided about it.",
        tag: "safeToSkip",
        metricAxis: "abstention",
      },
    ] as ConditionTopic[]
  ).map((t) => Object.freeze(t)),
);
