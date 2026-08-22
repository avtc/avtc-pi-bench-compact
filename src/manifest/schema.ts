// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `scenario-manifest-v1` schema + the authoring-agent's emitted shape
// (the output contract). Two layers:
//
//   - `AuthorOutput` (+ `AUTHOR_OUTPUT_SCHEMA`): what the authoring-agent emits via
//     `write_manifest` — the content fields only (fact/accept/entryIds/description/
//     artifact/reworkable/subject/oldValue/latestValue/question/correctRefusal +
//     probes). NO id/lanes/domain (the harness derives those).
//   - `ScenarioManifest`: the full v1 — AuthorOutput content + harness-derived
//     id (per condition, for result-JSON refs), lanes (embedded/direct-probe),
//     domain ("technical"), taskObjective, compactionBoundary.
//
// Probes link to their target via `targets` = the target's `entryIds` (agent-known;
// the harness resolves to the condition id).

import { type TSchema, Type } from "typebox";
import type { BackupMode } from "../config/types.js";

// --- lanes + domain --------------------------------------------------------

/** Which scoring lane a condition uses. `embedded` = exercised by the continuation
 *  work / embedded test; `direct-probe` = a harness-direct probe question. */
export type Lane = "embedded" | "direct-probe";

/** The condition domain — fixed to "technical" (compaction-memory content, not
 *  user-decisions/portrait — confound mitigation). */
type Domain = "technical";

// --- agent-emitted shapes (write_manifest input — no id/lanes/domain) -------

export interface AuthorRecallFact {
  readonly fact: string;
  readonly accept: readonly string[];
  readonly entryIds: readonly string[];
}
export interface AuthorDoneOp {
  readonly description: string;
  readonly artifact: string;
  readonly reworkable: boolean;
  readonly entryIds: readonly string[];
}
export interface AuthorSupersession {
  /** Assigned at RECORD time by add_supersession (ss1, ss2, …) and echoed back to
   *  the agent — the id its latest-value probe links via supersessionId. Optional
   *  only for direct-construction paths; postProcessManifest assigns when absent. */
  readonly id?: string;
  readonly subject: string;
  readonly oldValue: string;
  readonly latestValue: string;
  readonly entryIds: readonly string[];
}
export interface AuthorAbstention {
  readonly question: string;
  readonly correctRefusal: true;
  readonly entryIds: readonly string[];
}
export type AbstentionFace = "refuse" | "stale";

export interface AuthorProbe {
  readonly question: string;
  readonly accept?: readonly string[];
  readonly correctRefusal?: true;
  /** The abstention face — required iff correctRefusal (validateManifest enforces).
   *  `stale` = the question asserts a superseded value (correct behavior: flag it as
   *  outdated); `refuse` = a never-decided question (correct behavior: decline to
   *  fabricate). Selects the judge's grading criteria — never inferred from targets. */
  readonly face?: AbstentionFace;
  /** The reversal this probe tests the LATEST value of — present iff the probe is a
   *  supersession-latest probe (routes it to the supersession axis + gives the judge
   * the subject/latestValue). Must reference an existing supersessions[].id
   *  (validateManifest enforces). */
  readonly supersessionId?: string;
  readonly targets: readonly string[];
}

/** The authoring-agent's discovered task objective (what was built + how to test it).
 *  The harness derives the manifest's `taskObjective.lane` (embedded-test when testSpec
 *  is non-empty; omitted when no tests). Discovering this post-hoc makes the bench flexible for any idea +
 *  extracted sessions (the testSpec depends on what was actually built). */
interface AuthorTaskObjective {
  readonly description: string;
  readonly testSpec: string;
}

/** The authoring-agent's `write_manifest` payload (the output contract). */
export interface AuthorOutput {
  readonly recallFacts: readonly AuthorRecallFact[];
  readonly doneOps: readonly AuthorDoneOp[];
  readonly supersessions: readonly AuthorSupersession[];
  readonly abstentions: readonly AuthorAbstention[];
  readonly probes: readonly AuthorProbe[];
  readonly tailConflicts?: readonly AuthorTailConflict[];
  readonly taskObjective: AuthorTaskObjective;
}

// --- typebox schema for write_manifest validation --------------------------
// entryIds is required + non-empty (every cited id must be real).
// abstentions.correctRefusal is the literal `true`. Probes carry accept OR
// correctRefusal (both optional at the schema level; validateManifest enforces the
// exactly-one-of-{accept, correctRefusal} rule per probe downstream).

const NonEmptyString = Type.String({ minLength: 1 });
const NonEmptyStringArray = Type.Array(NonEmptyString, { minItems: 1 });
const Face = Type.Union([Type.Literal("refuse"), Type.Literal("stale")]);

/** typebox schema validating the authoring-agent's `write_manifest` payload. */
/** Per-item schemas — the progressive authoring tools validate each condition as
 *  it is added (one complete item per call; no whole-manifest re-emission). */
export const RECALL_FACT_ITEM_SCHEMA: TSchema = Type.Object({
  fact: NonEmptyString,
  accept: NonEmptyStringArray,
  entryIds: NonEmptyStringArray,
});
export const DONE_OP_ITEM_SCHEMA: TSchema = Type.Object({
  description: NonEmptyString,
  artifact: NonEmptyString,
  reworkable: Type.Boolean(),
  entryIds: NonEmptyStringArray,
});
export const SUPERSESSION_ITEM_SCHEMA: TSchema = Type.Object({
  subject: NonEmptyString,
  oldValue: NonEmptyString,
  latestValue: NonEmptyString,
  entryIds: NonEmptyStringArray,
});
export const ABSTENTION_ITEM_SCHEMA: TSchema = Type.Object({
  question: NonEmptyString,
  correctRefusal: Type.Literal(true),
  entryIds: NonEmptyStringArray,
});
export const PROBE_ITEM_SCHEMA: TSchema = Type.Object({
  question: NonEmptyString,
  accept: Type.Optional(NonEmptyStringArray),
  correctRefusal: Type.Optional(Type.Literal(true)),
  face: Type.Optional(Face),
  supersessionId: Type.Optional(NonEmptyString),
  targets: NonEmptyStringArray,
});
/** A tail conflict: the kept tail either RESTATES a finding's answer (the probe
 *  becomes answerable from raw context) or CHANGES it (the accept/latest value is
 *  stale). `entryIds` cite the finding's SPAN entries — the same ids its condition
 *  cites — so the landing classifier can map the conflict to its topic. */
export interface AuthorTailConflict {
  readonly entryIds: readonly string[];
  readonly kind: TailConflictKind;
}
export const TAIL_CONFLICT_ITEM_SCHEMA: TSchema = Type.Object({
  entryIds: NonEmptyStringArray,
  kind: Type.Union([Type.Literal("answerable"), Type.Literal("superseded")]),
});
/** The finalize_manifest payload: the task objective (the only structured piece
 *  NOT carried by a per-item tool). */
export const TASK_OBJECTIVE_SCHEMA: TSchema = Type.Object({
  description: NonEmptyString,
  testSpec: Type.String(), // may be empty (no tests → no embedded-test lane)
});

export const AUTHOR_OUTPUT_SCHEMA: TSchema = Type.Object({
  recallFacts: Type.Array(
    Type.Object({
      fact: NonEmptyString,
      accept: NonEmptyStringArray,
      entryIds: NonEmptyStringArray,
    }),
  ),
  doneOps: Type.Array(
    Type.Object({
      description: NonEmptyString,
      artifact: NonEmptyString,
      reworkable: Type.Boolean(),
      entryIds: NonEmptyStringArray,
    }),
  ),
  supersessions: Type.Array(
    Type.Object({
      subject: NonEmptyString,
      oldValue: NonEmptyString,
      latestValue: NonEmptyString,
      entryIds: NonEmptyStringArray,
    }),
  ),
  abstentions: Type.Array(
    Type.Object({
      question: NonEmptyString,
      correctRefusal: Type.Literal(true),
      entryIds: NonEmptyStringArray,
    }),
  ),
  probes: Type.Array(
    Type.Object({
      question: NonEmptyString,
      accept: Type.Optional(NonEmptyStringArray),
      correctRefusal: Type.Optional(Type.Literal(true)),
      face: Type.Optional(Face),
      targets: NonEmptyStringArray,
    }),
  ),
  tailConflicts: Type.Optional(Type.Array(TAIL_CONFLICT_ITEM_SCHEMA)),
  taskObjective: Type.Object({
    description: NonEmptyString,
    testSpec: Type.String(), // may be empty (no tests → no embedded-test lane)
  }),
});

// --- full manifest (harness-derived id/lanes/domain + scenario context) ----

export interface RecallFact {
  readonly id: string;
  readonly fact: string;
  readonly accept: readonly string[];
  readonly entryIds: readonly string[];
  readonly domain: Domain;
  readonly lanes: readonly Lane[];
}
export interface DoneOp {
  readonly id: string;
  readonly description: string;
  readonly artifact: string;
  readonly reworkable: boolean;
  readonly entryIds: readonly string[];
  readonly lanes: readonly Lane[];
}
export interface Supersession {
  readonly id: string;
  readonly subject: string;
  readonly oldValue: string;
  readonly latestValue: string;
  readonly entryIds: readonly string[];
  readonly lanes: readonly Lane[];
}
export interface Abstention {
  readonly id: string;
  readonly question: string;
  readonly correctRefusal: true;
  readonly entryIds: readonly string[];
  readonly lanes: readonly Lane[];
}
export interface Probe {
  readonly question: string;
  readonly accept?: readonly string[];
  readonly correctRefusal?: true;
  /** The abstention face — present iff correctRefusal (validateManifest enforces). */
  readonly face?: AbstentionFace;
  /** The reversal this probe tests the LATEST value of — the explicit probe↔supersession
   *  link (the ONLY supersession-axis router; never inferred from entry overlap —
   *  validateManifest enforces it references an existing supersessions[].id). */
  readonly supersessionId?: string;
  readonly targets: readonly string[];
  readonly lanes: readonly Lane[];
}
export interface TaskObjective {
  readonly description: string;
  readonly testSpec: string;
  /** Present (="embedded-test") iff testSpec is non-empty — the task has an embedded
   *  test lane. Omitted when there are no tests (falls back to comparative
   *  ranking only). Consistent with deriveLanes' embedded-lane rule. */
  readonly lane?: "embedded-test";
}
interface CompactionBoundary {
  readonly phaseATokenBudget: number;
  readonly plan: string;
}

/** The harness-known scenario context merged into every manifest (id, description,
 *  compaction boundary). None of this is discovered by the authoring agent — it is
 *  harness-authoritative. The `taskObjective` is discovered (AuthorOutput), not here. */
export interface ScenarioContext {
  readonly id: string;
  readonly description: string;
  readonly compactionBoundary: CompactionBoundary;
}

/** How the kept tail conflicts with a span finding: `answerable` = the tail
 *  restates the answer (a probe would pass from raw context — no memory tested);
 *  `superseded` = the tail changes the fact (the accept/latest value is stale). */
export type TailConflictKind = "answerable" | "superseded";

/** One author-reported tail conflict, matched to its condition by span entry ids. */
export interface TailConflict {
  readonly entryIds: readonly string[];
  readonly kind: TailConflictKind;
}

/** The full `scenario-manifest-v1`. */
export interface ScenarioManifest {
  readonly id: string;
  /** How the frozen backup was made — stamped by the prepare command at freeze time
   *  (build = user-simulator build; extract = sliced real session). Absent on
   *  older scenarios (read as "build"). Never agent-authored. */
  readonly backupMode?: BackupMode;
  readonly description: string;
  readonly compactionBoundary: CompactionBoundary;
  readonly recallFacts: readonly RecallFact[];
  readonly doneOps: readonly DoneOp[];
  readonly supersessions: readonly Supersession[];
  readonly abstentions: readonly Abstention[];
  readonly taskObjective: TaskObjective;
  readonly probes: readonly Probe[];
  /** Author-reported tail conflicts (validation of the kept tail against each
   *  finding). Absent = authored without tail validation (or none found). */
  readonly tailConflicts?: readonly TailConflict[];
}
