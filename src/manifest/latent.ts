// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The latent-probe layer — a PER-RUN artifact, not scenario-manifest content.
// Authoring agent #2 (run after Phase-1 compaction) proposes questions whose
// answers are visible in the pre-slice span but LOST from an arm's
// post-compaction context (summary + kept tail). One discriminator drives
// everything downstream: `probeClass` —
//   - "cued":   the arm's summary mentions the TOPIC but not the detail
//               (recall-accuracy-from-summary);
//   - "uncued": no trace of subject or answer in summary + tail
//               (recall-accuracy-absent-in-summary).
//
// Two layers, mirroring the scenario-manifest split:
//   - `AuthorLatentProbe` (+ `LATENT_PROBE_ITEM_SCHEMA`): the add_latent_probe
//     tool payload (content fields only — no id/arm/verdicts).
//   - `LatentProbe`: the pool record — harness-derived id (l1..lN), the owning
//     arm (per-arm mode only), and per-arm absence verdicts. The verdicts double
//     as the re-validation cache: when an arm re-compacts, its summary changes
//     and the pool is re-checked instead of re-authored.

import { type TSchema, Type } from "typebox";
import type { ArmId } from "../config/types.js";

/** The single discriminator. The axis router derives the metric line from it. */
export type LatentProbeClass = "cued" | "uncued";

/** Authoring mode for the latent stage (`off` never reaches this layer). */
export type LatentAuthoringMode = "per-arm" | "shared";

/** The per-arm absence verdict recorded at authoring (and re-checked on resume):
 *  `absent` = survived the author's check against that arm's summary + tail;
 *  `answerable` = rejected for that arm (the answer leaked into its context). */
export type LatentVerdict = "absent" | "answerable";

const NonEmptyString = Type.String({ minLength: 1 });
/** Content floors for a real latent probe (the junk-probe regression of
 *  run-2026-08-18-1: the authoring agent padded the per-class minimum with
 *  "Test4"-grade probes — question 4–5 chars, note "t", accept "a"). A real
 *  probe is a specific sentence (question), a work-relevance line (note), and
 *  the real acceptable answers (accept); every observed real pool sits far
 *  above these floors (min 91/94/100 chars). Enforced at add time (specific
 *  per-field tool rejections) and re-checked at pool validation (reuse path). */
export const LATENT_QUESTION_MIN_LENGTH = 12;
export const LATENT_NOTE_MIN_LENGTH = 8;
export const LATENT_ACCEPT_MIN_LENGTH = 10;
/** Near-duplicate questions above this token-Jaccard are the same fact re-recorded
 *  (an observed byte-identical duplicate pair, and a 0.90 near-dup pair) — real distinct probes about
 *  adjacent facts measure ≈0.70. Enforced at add time + pool validation. */
export const LATENT_DUP_JACCARD = 0.85;
const NonEmptyStringArray = Type.Array(NonEmptyString, { minItems: 1 });

/** What authoring agent #2 emits per item (the `add_latent_probe` payload). */
export interface AuthorLatentProbe {
  readonly question: string;
  readonly accept: readonly string[];
  /** Evidence entries — MUST be pre-slice span entries (tail entries would make
   *  the probe answerable from the kept context by construction). */
  readonly entryIds: readonly string[];
  readonly probeClass: LatentProbeClass;
  /** One line on why the detail is work-relevant (the anti-trivia rubric). */
  readonly note: string;
}

export const LATENT_PROBE_ITEM_SCHEMA: TSchema = Type.Object({
  question: NonEmptyString,
  accept: NonEmptyStringArray,
  entryIds: NonEmptyStringArray,
  probeClass: Type.Union([Type.Literal("cued"), Type.Literal("uncued")]),
  note: NonEmptyString,
});

/** The finalize_latent payload: it takes no arguments. */
export const LATENT_FINALIZE_SCHEMA: TSchema = Type.Object({});

/** A pool record: the author item + harness-derived identity and verdicts. */
export interface LatentProbe extends AuthorLatentProbe {
  readonly id: string;
  /** Present iff per-arm mode — the arm whose post-compaction context the probe
   *  was validated against (its only applicable arm). Forbidden in shared mode. */
  readonly arm?: ArmId;
  /** Per-arm absence verdicts (the re-validation cache; shared mode records
   *  every enabled arm, per-arm mode records the owner only). */
  readonly verdicts: Readonly<Partial<Record<ArmId, LatentVerdict>>>;
}

/** The per-class cap enforced at add-time (and defended here on pool loads). */
export const LATENT_PROBE_CLASS_CAP = 10;

export interface LatentValidationContext {
  readonly mode: LatentAuthoringMode;
  readonly spanEntryIds: ReadonlySet<string>;
  readonly enabledArms: readonly ArmId[];
}

/** Content-word tokens of a question (lowercased, split on non-alphanumerics) —
 *  the near-duplicate comparison basis (order- and punctuation-insensitive). */
export function latentQuestionTokens(question: string): ReadonlySet<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Token-Jaccard similarity of two questions (1.0 = identical content words). */
export function latentQuestionSimilarity(a: string, b: string): number {
  const ta = latentQuestionTokens(a);
  const tb = latentQuestionTokens(b);
  if (ta.size === 0 || tb.size === 0) return a === b ? 1 : 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface LatentValidationResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/** Validate pool records (shape + reference integrity + mode shape + caps).
 *  Mirrors `validateManifest`'s adversarial self-check role: the authoring tool
 *  schema already guards most of this at record time — this defends pool LOADS
 *  (resume re-validation, cross-session artifacts). */
export function validateLatentProbes(
  probes: readonly LatentProbe[],
  ctx: LatentValidationContext,
): LatentValidationResult {
  const reasons: string[] = [];

  const perArmClassCount = new Map<string, number>();
  for (const p of probes) {
    if (p.question === "") reasons.push(`latent probe ${p.id}: empty question`);
    if (p.question.trim().length < LATENT_QUESTION_MIN_LENGTH) {
      reasons.push(
        `latent probe ${p.id}: question shorter than ${LATENT_QUESTION_MIN_LENGTH} chars (placeholder-grade — re-author)`,
      );
    }
    if (p.note.trim().length < LATENT_NOTE_MIN_LENGTH) {
      reasons.push(
        `latent probe ${p.id}: note shorter than ${LATENT_NOTE_MIN_LENGTH} chars (placeholder-grade — re-author)`,
      );
    }
    if (p.accept.join(" ").trim().length < LATENT_ACCEPT_MIN_LENGTH) {
      reasons.push(
        `latent probe ${p.id}: accept shorter than ${LATENT_ACCEPT_MIN_LENGTH} chars (placeholder-grade — re-author)`,
      );
    }
    if (p.accept.length === 0) reasons.push(`latent probe ${p.id}: empty accept list`);
    if (p.probeClass !== "cued" && p.probeClass !== "uncued") {
      reasons.push(`latent probe ${p.id}: unknown probe class "${p.probeClass}"`);
    }
    for (const id of p.entryIds) {
      if (!ctx.spanEntryIds.has(id)) {
        reasons.push(`latent probe ${p.id} cites entryId "${id}" not in the pre-sliced (in-span) set`);
      }
    }

    if (ctx.mode === "per-arm") {
      if (p.arm === undefined) {
        reasons.push(`latent probe ${p.id}: per-arm mode requires arm`);
      } else {
        if (!ctx.enabledArms.includes(p.arm)) {
          reasons.push(`latent probe ${p.id}: arm "${p.arm}" is not enabled`);
        }
        if (p.verdicts[p.arm] !== "absent") {
          reasons.push(`latent probe ${p.id}: verdict for its arm "${p.arm}" must be "absent"`);
        }
        const key = `${p.arm}:${p.probeClass}`;
        perArmClassCount.set(key, (perArmClassCount.get(key) ?? 0) + 1);
      }
    } else {
      if (p.arm !== undefined) {
        reasons.push(`latent probe ${p.id}: must not pin an arm in shared mode`);
      }
      for (const arm of ctx.enabledArms) {
        if (p.verdicts[arm] === undefined) {
          reasons.push(`latent probe ${p.id}: missing verdict for arm "${arm}"`);
        }
      }
    }
  }

  // Near-duplicate questions: the same fact re-recorded (a byte-identical exact pair;
  // same-class padding runs like Test4..TestE). Reported once per colliding pair.
  for (let i = 0; i < probes.length; i++) {
    for (let j = i + 1; j < probes.length; j++) {
      if (latentQuestionSimilarity(probes[i].question, probes[j].question) >= LATENT_DUP_JACCARD) {
        reasons.push(
          `latent probes ${probes[i].id} and ${probes[j].id}: near-duplicate questions (one fact recorded twice — re-author)`,
        );
      }
    }
  }

  for (const [key, count] of perArmClassCount) {
    if (count > LATENT_PROBE_CLASS_CAP) {
      reasons.push(
        `latent ${key.split(":")[1]} probes for arm ${key.split(":")[0]} exceed the cap (${count} > ${LATENT_PROBE_CLASS_CAP})`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** The probes an arm actually runs: the owning/per-arm filter, then the arm's own
 *  verdict. Uniform across modes — per-arm authoring records the owner's verdict
 *  only; shared records every arm's. A flipped verdict (re-validation after a
 *  re-compact) deactivates the probe for that arm without touching the others. */
export function activeLatentProbes(
  probes: readonly LatentProbe[],
  mode: LatentAuthoringMode,
  arm: ArmId,
): readonly LatentProbe[] {
  return probes.filter((p) => {
    if (mode === "per-arm" && p.arm !== arm) return false;
    return p.verdicts[arm] === "absent";
  });
}
