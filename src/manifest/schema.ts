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
export interface AuthorProbe {
  readonly question: string;
  readonly accept?: readonly string[];
  readonly correctRefusal?: true;
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
  readonly taskObjective: AuthorTaskObjective;
}

// --- typebox schema for write_manifest validation --------------------------
// entryIds is required + non-empty (every cited id must be real).
// abstentions.correctRefusal is the literal `true`. Probes carry accept OR
// correctRefusal (both optional at the schema level; validateManifest enforces the
// exactly-one-of-{accept, correctRefusal} rule per probe downstream).

const NonEmptyString = Type.String({ minLength: 1 });
const NonEmptyStringArray = Type.Array(NonEmptyString, { minItems: 1 });

/** typebox schema validating the authoring-agent's `write_manifest` payload. */
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
      targets: NonEmptyStringArray,
    }),
  ),
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

/** The full `scenario-manifest-v1`. */
export interface ScenarioManifest {
  readonly id: string;
  readonly description: string;
  readonly compactionBoundary: CompactionBoundary;
  readonly recallFacts: readonly RecallFact[];
  readonly doneOps: readonly DoneOp[];
  readonly supersessions: readonly Supersession[];
  readonly abstentions: readonly Abstention[];
  readonly taskObjective: TaskObjective;
  readonly probes: readonly Probe[];
}
