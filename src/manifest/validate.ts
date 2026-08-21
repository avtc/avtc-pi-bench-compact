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

/** Light STRUCTURAL check of a parsed frozen manifest (no session context needed —
 *  the semantic in-span/content checks live in {@link validateManifest}). Guards
 *  load-time use (run-scenario / prepare-then-run): a hand-edited or corrupted
 *  manifest fails here with one actionable line instead of deep in scoring.
 *  Returns the first violation as a message, or null when structurally sound. */
export function manifestStructureError(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null) {
    return "manifest is not an object";
  }
  const m = manifest as Record<string, unknown>;

  const taskObjective = m.taskObjective;
  if (
    typeof taskObjective !== "object" ||
    taskObjective === null ||
    !nonEmptyString((taskObjective as Record<string, unknown>).description)
  ) {
    return "taskObjective.description missing or empty";
  }
  // testSpec may be "" (no embedded test) but MUST be a string — the done-snapshot
  // judge slice dereferences `.testSpec.length` unguarded.
  if (typeof (taskObjective as Record<string, unknown>).testSpec !== "string") {
    return "taskObjective.testSpec must be a string (empty = no embedded test)";
  }

  const boundary = m.compactionBoundary;
  if (
    typeof boundary !== "object" ||
    boundary === null ||
    !nonEmptyString((boundary as Record<string, unknown>).plan) ||
    typeof (boundary as Record<string, unknown>).phaseATokenBudget !== "number"
  ) {
    return "compactionBoundary.plan (non-empty string) + phaseATokenBudget (number) required";
  }

  if (!nonEmptyString(m.id) || !nonEmptyString(m.description)) {
    return "id + description must be non-empty strings";
  }

  for (const list of ["recallFacts", "doneOps"] as const) {
    if (!Array.isArray(m[list]) || (m[list] as unknown[]).length === 0) {
      return `condition list "${list}" missing or empty`;
    }
  }
  for (const list of ["supersessions", "abstentions"] as const) {
    if (!Array.isArray(m[list])) {
      return `condition list "${list}" missing (must be an array)`;
    }
  }

  const recallFacts = m.recallFacts as unknown[];
  for (const rf of recallFacts) {
    const c = fieldsOf(rf);
    if (
      c === null ||
      !nonEmptyString(c.id) ||
      !nonEmptyString(c.fact) ||
      !nonEmptyStringArray(c.accept) ||
      !nonEmptyStringArray(c.entryIds)
    ) {
      return "recallFacts item: id/fact (strings) + accept/entryIds (non-empty string arrays) required";
    }
  }
  const doneOps = m.doneOps as unknown[];
  for (const op of doneOps) {
    const c = fieldsOf(op);
    if (
      c === null ||
      !nonEmptyString(c.id) ||
      !nonEmptyString(c.description) ||
      !nonEmptyString(c.artifact) ||
      !nonEmptyStringArray(c.entryIds)
    ) {
      return "doneOps item: id/description/artifact (strings) + entryIds (non-empty string array) required";
    }
  }
  const supersessions = m.supersessions as unknown[];
  for (const sup of supersessions) {
    const c = fieldsOf(sup);
    if (c === null || !nonEmptyStringArray(c.entryIds)) {
      return "supersessions item: entryIds (non-empty string array) required";
    }
  }

  const probes = m.probes;
  if (!Array.isArray(probes)) {
    return 'condition list "probes" missing';
  }
  for (const probe of probes) {
    if (typeof probe !== "object" || probe === null) {
      return "probe is not an object";
    }
    const q = (probe as Record<string, unknown>).question;
    if (!nonEmptyString(q)) {
      return "probe.question missing or empty";
    }
    const accept = (probe as Record<string, unknown>).accept;
    const refusal = (probe as Record<string, unknown>).correctRefusal;
    const hasAccept = Array.isArray(accept) && accept.length > 0;
    const hasRefusal = refusal === true;
    if (hasAccept === hasRefusal) {
      return `probe "${q}": must have exactly one of accept or correctRefusal`;
    }
    const targets = (probe as Record<string, unknown>).targets;
    if (!nonEmptyStringArray(targets)) {
      return `probe "${q}": targets missing or empty`;
    }
    const supersessionId = (probe as Record<string, unknown>).supersessionId;
    if (supersessionId !== undefined) {
      if (typeof supersessionId !== "string" || supersessionId === "") {
        return `probe "${q}": supersessionId must be a non-empty string`;
      }
      const supersessionIds = new Set(
        (m.supersessions as unknown[]).flatMap((s) => {
          const fields = fieldsOf(s);
          return fields !== null && nonEmptyString(fields.id) ? [fields.id as string] : [];
        }),
      );
      if (!supersessionIds.has(supersessionId)) {
        return `probe "${q}": supersessionId "${supersessionId}" references no supersession`;
      }
    }
  }
  return null;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

function nonEmptyStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((el) => typeof el === "string" && el !== "");
}

function fieldsOf(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Join separator for the cited-entries text union (named constant). */
const CITED_TEXT_JOIN = "\n";

/** Common English glue words — never distinctive evidence of a citation. */
const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "their",
  "there",
  "these",
  "those",
  "which",
  "while",
  "would",
  "could",
  "should",
  "shall",
  "your",
  "yours",
  "with",
  "this",
  "that",
  "from",
  "have",
  "been",
  "were",
  "will",
  "when",
  "what",
  "where",
  "then",
  "than",
  "them",
  "they",
  "into",
  "only",
  "over",
  "also",
  "just",
  "like",
  "some",
  "such",
  "more",
  "most",
  "other",
  "using",
  "used",
  "user",
  "must",
  "does",
  "done",
]);

/** Distinctive lowercase tokens (length >= 4, not stopword) across all terms —
 *  the paraphrase-tolerant presence signal for cited-content validation. */
function distinctiveTokens(terms: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const term of terms) {
    for (const tok of term.split(/[^a-z0-9]+/)) {
      if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
    }
  }
  return [...out];
}

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
    // Presence = verbatim term OR distinctive-token overlap. The authoring agent
    // PARAPHRASES what it read (its fact/description sentences are summaries, not
    // verbatim quotes), so a verbatim-only check rejects every real authored
    // manifest; the token overlap keeps the guard's meaning (the cited entries
    // must actually relate to the claim) while tolerating paraphrase.
    const citedUnion = citedTexts.join(CITED_TEXT_JOIN);
    const verbatim = terms.some((term) => term.length > 0 && citedUnion.includes(term));
    const tokens = distinctiveTokens(terms);
    const matched = tokens.filter((tok) => citedUnion.includes(tok)).length;
    const present = verbatim || (tokens.length > 0 && matched >= Math.min(2, tokens.length));
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
    // The abstention face is authored, never inferred: a correctRefusal probe MUST
    // name which face it grades, and an accept probe MUST NOT carry one.
    if (hasRefusal && p.face === undefined) {
      reasons.push(`probe "${p.question}": correctRefusal requires face "refuse" or "stale"`);
    }
    if (!hasRefusal && p.face !== undefined) {
      reasons.push(`probe "${p.question}": face is only valid with correctRefusal`);
    }
    // The explicit probe↔supersession link must resolve: a supersessionId naming
    // no recorded supersession would route the probe to the supersession axis
    // with nothing to grade against.
    if (p.supersessionId !== undefined) {
      if (p.supersessionId === "") {
        reasons.push(`probe "${p.question}": supersessionId must be a non-empty string`);
      } else if (!manifest.supersessions.some((s) => s.id === p.supersessionId)) {
        reasons.push(`probe "${p.question}": supersessionId "${p.supersessionId}" references no supersession`);
      }
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
      const hasStale = targeting.some((p) => p.face === "stale");
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
