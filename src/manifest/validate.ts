// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Manifest validation (the adversarial self-check). The in-span
// guarantee is structural (the harness pre-slices the compacted-away entries, so
// every id the author sees IS in-span), but this layer DEFENDS it + checks the
// cited content is genuinely present, the essential condition-lists are populated,
// and the compaction precondition holds. Used by prepare-scenario before
// freezing; failures STOP-and-surface.

import type { Abstention, DoneOp, RecallFact, ScenarioManifest, Supersession } from "./schema.js";

/** Which condition lists may be required non-empty (the essential scoring axes).
 *  recallFacts + doneOps are essential (they back the effectiveness metrics); supersessions/abstentions
 *  are safeToSkip — see CONDITION_TOPICS. */
export type ConditionListName = "recallFacts" | "doneOps" | "supersessions" | "abstentions";

/** Context the validator needs (all harness-supplied — no file I/O here). */
export interface ManifestValidationContext {
  /** The pre-sliced compacted-away entry-ids — every cited id MUST be in this set. */
  readonly preSlicedEntryIds: ReadonlySet<string>;
  /** entry-id → its rendered text (for the cited-content-present substring check). */
  readonly entryTextById: ReadonlyMap<string, string>;
  /** Which condition lists must be non-empty (the essential scoring axes). */
  readonly essentialLists: ReadonlySet<ConditionListName>;
  /** The actual number of CompactionEntries in the source backup (must be 0 — pre-compaction). */
  readonly compactionCount: number;
  /** The expected compaction count (0 — the source is pre-compaction by construction). */
  readonly expectedCompactionCount: number;
}

export type ManifestValidationResult = { ok: true } | { ok: false; reasons: string[] };

interface CitedCondition {
  readonly id: string;
  readonly entryIds: readonly string[];
}

/** Check every cited id is in-span AND at least one cited entry contains a
 *  search-term (the condition's actual content). Pushes a reason per violation. */
function checkConditions<T extends CitedCondition>(
  conditions: readonly T[],
  ctx: ManifestValidationContext,
  reasons: string[],
  kind: string,
  searchTerms: (condition: T) => readonly string[],
): void {
  for (const c of conditions) {
    for (const id of c.entryIds) {
      if (!ctx.preSlicedEntryIds.has(id)) {
        reasons.push(`${kind} ${c.id} cites entryId "${id}" not in the pre-sliced (in-span) set`);
      }
    }
    const citedTexts = c.entryIds
      .filter((id) => ctx.entryTextById.has(id))
      .map((id) => ctx.entryTextById.get(id)?.toLowerCase() ?? "");
    // If NO cited entry is present in entryTextById, the content check cannot run
    // (the harness may not have rendered those entries) — skip THIS condition's
    // content check (continue to the next), not the whole list. The in-span check
    // above is the structural guarantee; later conditions must still be checked.
    if (citedTexts.length === 0) {
      continue;
    }
    const terms = searchTerms(c).map((t) => t.toLowerCase());
    const present = citedTexts.some((text) => terms.some((term) => term.length > 0 && text.includes(term)));
    if (!present) {
      reasons.push(`${kind} ${c.id}: cited content not present at entry ${c.entryIds.join("/")}`);
    }
  }
}

/**
 * Validate a produced manifest against its harness context. Returns `{ok:true}`
 * when every check passes, or `{ok:false, reasons}` accumulating ALL violations
 * (so the operator sees every problem at once, not one at a time).
 *
 * Checks:
 *   1. compaction precondition — `compactionCount === expectedCompactionCount`
 *      (the source is pre-compaction: build captures before the trial, extract guards
 *      none → expected 0 for both; verifies the backup is genuinely un-compacted).
 *   2. in-span — every cited entryId is in `preSlicedEntryIds` (defends the
 *      structural pre-slicing guarantee).
 *   3. content-present — at least one cited entry's text contains a search-term
 *      for the condition (catches hallucinated entryId→content mappings).
 *   4. essential-lists — every list in `essentialLists` is non-empty.
 */
export function validateManifest(manifest: ScenarioManifest, ctx: ManifestValidationContext): ManifestValidationResult {
  const reasons: string[] = [];

  if (ctx.compactionCount !== ctx.expectedCompactionCount) {
    reasons.push(
      `compaction precondition failed: expected ${ctx.expectedCompactionCount} compaction(s), got ${ctx.compactionCount}`,
    );
  }

  checkConditions<RecallFact>(manifest.recallFacts, ctx, reasons, "recallFact", (c) => [c.fact, ...c.accept]);
  checkConditions<DoneOp>(manifest.doneOps, ctx, reasons, "doneOp", (c) => [c.description, c.artifact]);
  checkConditions<Supersession>(manifest.supersessions, ctx, reasons, "supersession", (c) => [
    c.subject,
    c.oldValue,
    c.latestValue,
  ]);
  checkConditions<Abstention>(manifest.abstentions, ctx, reasons, "abstention", (c) => [c.question]);

  // Probes: each must carry exactly one of {accept, correctRefusal}. A probe
  // with neither (unanswerable) or both (ambiguous) is invalid. Each target must
  // be in the pre-sliced (in-span) set — defense-in-depth for the adversarial
  // guarantee (pre-slicing prevents the author from citing out-of-span ids, but a
  // probe pointing at a kept-tail entry would defeat the recall test).
  for (const p of manifest.probes) {
    const hasAccept = p.accept !== undefined && p.accept.length > 0;
    const hasRefusal = p.correctRefusal === true;
    if (hasAccept === hasRefusal) {
      reasons.push(`probe "${p.question}": must have exactly one of accept or correctRefusal`);
    }
    for (const target of p.targets) {
      if (!ctx.preSlicedEntryIds.has(target)) {
        reasons.push(`probe "${p.question}" targets entryId "${target}" not in the pre-sliced (in-span) set`);
      }
    }
  }

  // Every condition needs a probe. When there are NO probes at all,
  // emit ONE summary reason (not one-per-condition); otherwise require each condition
  // be targeted by ≥1 probe.
  const hasConditions = manifest.recallFacts.length + manifest.supersessions.length + manifest.abstentions.length > 0;
  if (hasConditions && manifest.probes.length === 0) {
    reasons.push("manifest has conditions but no probes — every recall/supersession/abstention needs a probe");
  } else if (manifest.probes.length > 0) {
    // Each recallFact / supersession / abstention must be targeted by ≥1 probe
    // ("For each decision/recall-fact, each reversal, and each open-question,
    // write a probe"). A condition with no targeting probe gets no direct-probe lane
    // and cannot be scored on recall. doneOps are exempt (scored via the redo effectiveness metrics).
    const allTargets = new Set(manifest.probes.flatMap((p) => p.targets));
    const untargetedConditions = [
      ...manifest.recallFacts.filter((c) => !c.entryIds.some((id) => allTargets.has(id))),
      ...manifest.supersessions.filter((c) => !c.entryIds.some((id) => allTargets.has(id))),
      ...manifest.abstentions.filter((c) => !c.entryIds.some((id) => allTargets.has(id))),
    ];
    for (const c of untargetedConditions) {
      reasons.push(`${c.id} is not targeted by any probe — a probe is required per condition`);
    }

    // Each reversal (supersession) needs TWO probes: a latest-value accept-probe (the
    // supersession axis) AND a stale-value correctRefusal probe (the abstention stale
    // face). A single-probe supersession leaves one face silently untested, skewing its
    // sample count.
    for (const s of manifest.supersessions) {
      const targeting = manifest.probes.filter((p) => p.targets.some((id) => s.entryIds.includes(id)));
      const hasLatest = targeting.some((p) => p.correctRefusal !== true && (p.accept?.length ?? 0) > 0);
      const hasStale = targeting.some((p) => p.correctRefusal === true);
      if (!hasLatest || !hasStale) {
        reasons.push(
          `${s.id} (reversal) is missing a ${!hasLatest ? "latest-value accept" : "stale-value correctRefusal"} probe — each reversal needs both (latest → supersession axis, stale → abstention stale face)`,
        );
      }
    }
  }

  for (const list of ctx.essentialLists) {
    if ((manifest[list] as readonly unknown[]).length === 0) {
      reasons.push(`essential list "${list}" is empty — session is missing a required condition`);
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
