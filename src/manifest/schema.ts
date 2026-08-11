// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `scenario-manifest-v1` schema (§4.5) + the authoring-agent's emitted shape
// (§4.18 output contract). Two layers:
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
// the harness resolves to the condition id — §4.5).

import { type TSchema, Type } from "typebox";

// --- lanes + domain --------------------------------------------------------

/** Which scoring lane a condition uses. `embedded` = exercised by the continuation
 *  work / embedded test; `direct-probe` = a harness-direct probe question. */
export type Lane = "embedded" | "direct-probe";

/** The condition domain — fixed to "technical" (compaction-memory content, not
 *  user-decisions/portrait — §2.3 confound mitigation). */
export type Domain = "technical";

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

/** The authoring-agent's `write_manifest` payload (§4.18 OUTPUT). */
export interface AuthorOutput {
  readonly recallFacts: readonly AuthorRecallFact[];
  readonly doneOps: readonly AuthorDoneOp[];
  readonly supersessions: readonly AuthorSupersession[];
  readonly abstentions: readonly AuthorAbstention[];
  readonly probes: readonly AuthorProbe[];
}

// --- typebox schema for write_manifest validation --------------------------
// entryIds is required + non-empty (every cited id must be real — §4.18 CONSTRAINTS).
// abstentions.correctRefusal is the literal `true`. Probes carry accept OR
// correctRefusal (both optional at the schema level; validateManifest enforces the
// mutual-exclusion/shape per condition-type downstream).

const NonEmptyStringArray = Type.Array(Type.String(), { minItems: 1 });

/** typebox schema validating the authoring-agent's `write_manifest` payload. */
export const AUTHOR_OUTPUT_SCHEMA: TSchema = Type.Object({
  recallFacts: Type.Array(
    Type.Object({
      fact: Type.String(),
      accept: NonEmptyStringArray,
      entryIds: NonEmptyStringArray,
    }),
  ),
  doneOps: Type.Array(
    Type.Object({
      description: Type.String(),
      artifact: Type.String(),
      reworkable: Type.Boolean(),
      entryIds: NonEmptyStringArray,
    }),
  ),
  supersessions: Type.Array(
    Type.Object({
      subject: Type.String(),
      oldValue: Type.String(),
      latestValue: Type.String(),
      entryIds: NonEmptyStringArray,
    }),
  ),
  abstentions: Type.Array(
    Type.Object({
      question: Type.String(),
      correctRefusal: Type.Literal(true),
      entryIds: NonEmptyStringArray,
    }),
  ),
  probes: Type.Array(
    Type.Object({
      question: Type.String(),
      accept: Type.Optional(NonEmptyStringArray),
      correctRefusal: Type.Optional(Type.Literal(true)),
      targets: NonEmptyStringArray,
    }),
  ),
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
  readonly lane: "embedded-test";
}
export interface CompactionBoundary {
  readonly phaseATokenBudget: number;
  readonly plan: string;
}

/** The full `scenario-manifest-v1` (§4.5). */
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
