// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Condition-landing classification + action decision (§4.17). After the trial
// compaction finds `firstKeptEntryId`, each manifest condition is checked: did it
// land in the compacted-away span (before the cut), sit in the kept tail (needs
// auto-continue to slide into the span), or never materialize (needs user decision)?
//
// The decision: all-landed → proceed; any tail (no missing) → continue; any missing
// → surface (skip offered only when ALL missing topics are safeToSkip — essential
// missing omits skip). The actual continue/surface execution is the caller's job
// (build.ts orchestrates the re-capture/re-trial/re-author loop; prepare.ts surfaces).

import type { ScenarioManifest } from "../manifest/schema.js";
import type { ConditionTopic } from "../simulator/condition-topics.js";

/** Per-topic landing status. */
export type LandingStatus = "landed" | "tail" | "missing";

/** A topic's landing outcome (with its conditions' individual statuses). */
export interface TopicLanding {
  readonly topic: ConditionTopic;
  readonly status: LandingStatus;
}

/** What the harness should do after classifying landing. */
export type LandingAction =
  | { readonly kind: "proceed" }
  | { readonly kind: "continue" }
  | { readonly kind: "surface"; readonly skipOffered: boolean };

/** Build an entry-id → chronological-index map from the backup's entries (in order). */
export function buildEntryOrder(entries: readonly { id: string }[]): Map<string, number> {
  const order = new Map<string, number>();
  entries.forEach((e, i) => {
    order.set(e.id, i);
  });
  return order;
}

/** The manifest list name for a topic's metricAxis (recallFact→recallFacts, etc.). */
function listKey(metricAxis: string): keyof ScenarioManifest {
  return `${metricAxis}s` as keyof ScenarioManifest;
}

/** A condition with entryIds (the common shape across condition types). */
interface CitedCondition {
  readonly entryIds: readonly string[];
}

/** Classify each topic's landing against the trial cut. Pure.
 *  `tailContentTopics` (default empty): topic-ids whose content the harness detected in
 *  the KEPT TAIL (not the span the author saw). A topic with no authored condition is
 *  "tail" (auto-continue) when in this set, else "missing" (surface). This resolves the
 *  pre-slice-vs-tail tension: the author sees only the span, so the harness's separate
 *  tail-check (Task 19 wiring) distinguishes content-in-tail from never-materialized. */
export function classifyLanding(
  manifest: ScenarioManifest,
  firstKeptEntryId: string,
  entryOrder: Map<string, number>,
  topics: readonly ConditionTopic[],
  tailContentTopics: ReadonlySet<string> | null,
): TopicLanding[] {
  const tail = tailContentTopics ?? new Set<string>();
  const cutIndex = entryOrder.get(firstKeptEntryId);
  return topics.map((topic) => {
    const conditions = manifest[listKey(topic.metricAxis)] as readonly CitedCondition[];
    if (conditions.length === 0) {
      // No condition authored (the author found nothing in the span). The harness's
      // tail-check decides: content-in-tail → auto-continue; else → surface.
      return { topic, status: tail.has(topic.id) ? ("tail" as const) : ("missing" as const) };
    }
    // tail if ANY condition cites an entry at/after the cut (in the kept tail).
    const hasTail = conditions.some((c) =>
      c.entryIds.some((id) => {
        const idx = entryOrder.get(id);
        return idx === undefined || (cutIndex !== undefined && idx >= cutIndex);
      }),
    );
    return { topic, status: hasTail ? ("tail" as const) : ("landed" as const) };
  });
}

/** Decide the harness action from the classification. Pure.
 *  Priority: missing → surface (skip only if all-missing-are-safeToSkip); else tail → continue; else proceed. */
export function decideLandingAction(classification: readonly TopicLanding[]): LandingAction {
  const missing = classification.filter((c) => c.status === "missing");
  if (missing.length > 0) {
    const allMissingSafeToSkip = missing.every((c) => c.topic.tag === "safeToSkip");
    return { kind: "surface", skipOffered: allMissingSafeToSkip };
  }
  if (classification.some((c) => c.status === "tail")) {
    return { kind: "continue" };
  }
  return { kind: "proceed" };
}
