// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Per-axis judge rubrics. Each rubric is a self-contained grading instruction
// for one effectiveness axis — what the judge looks for + what a pass/fail (binary
// axes) or better/worse (comparative axes) means. The exact cost metrics have NO
// rubric — they are computed off the trace, not judged. The single-call layer
// (single-call.ts) prefixes the rubric with the emit-JSON instruction + the axis
// under grading.
//
// Binary axes ask for a yes/no judgment; comparative axes describe what to look
// for (the actual ranking happens in the comparative-ranking call over the
// enabled arms' slices).

import type { MetricId } from "../metrics/defs.js";

/** The per-axis judge rubrics. Undefined for the exact cost metrics. */
export const JUDGE_RUBRICS: Readonly<Partial<Record<MetricId, string>>> = {
  E1: `E1 — resume (comparative). Did the agent, WITHOUT re-asking the user, identify the in-progress task from the compaction summary and continue toward the next planned step? A strong resume picks up the task immediately and advances it; a weak resume stalls, re-asks, or works on the wrong thing. Judge the agent's first post-compaction actions against the task-in-progress + the next planned step in the manifest.`,
  E2: "E2 — redo-execution (binary, yes/no). Did the agent re-execute work the manifest marks as a COMPLETED doneOp (reworkable === false)? Exclude explicitly-requested rework (doneOps marked reworkable). Answer yes/no: yes = it redid completed work; no = it did not. Cite the manifest doneOp id + the redoing tool call as evidence.",
  E3: "E3 — redo-plan (comparative). Did the agent re-propose an approach already COMPLETED (a doneOp) or explicitly ABANDONED in the pre-compaction reasoning? Judge over the whole trajectory. A strong run avoids re-proposing tried/rejected approaches; a weak run re-treads abandoned ground. Judge the trajectory against the manifest doneOps.",
  E4: "E4 — proactive recall (binary, yes/no). Did the agent, UNPROMPTED (no direct probe), use or invoke a detail from a planted recallFact that the Phase-C task needs? Answer yes/no: yes = it used the needed fact unprompted; no = it did not. Cite the recallFact id + where it was used as evidence.",
  E5: `E5 — recall accuracy (binary, yes/no). Does the direct-probe answer match one of the recallFact's accept[] criteria? Answer yes/no: yes = the answer is correct (matches an accept criterion); no = it is wrong/ambiguous. Judge only the probe answer text against accept[].`,
  E6: "E6 — abstention (binary, yes/no, BOTH faces). The agent must handle BOTH faces correctly: (a) never-decided question (abstentions[]): it REFUSES rather than fabricates; AND (b) stale item (supersessions.oldValue): it FLAGS the value as stale rather than asserting it confidently. Answer yes/no: yes = both faces handled correctly (refused + flagged stale); no = it fabricated or confidently asserted the stale value. Cite evidence for each face.",
  E7: "E7 — task quality (comparative). Judge the resumed + continued work for correctness, completeness, and coherence with the pre-compaction decisions, with no regressions. Embedded test results (if any) are a SECONDARY signal, not the sole measure. A strong run produces correct, complete, coherent work; a weak run has bugs, gaps, or regressions. Judge the done snapshot (final artifacts + test results) against the taskObjective.",
  E8: `E8 — supersession (binary, yes/no). Did the agent use the supersession's latestValue and NOT surface the oldValue? Answer yes/no: yes = it used latestValue and suppressed oldValue; no = it used or surfaced the oldValue. Cite the supersession id + the value used as evidence.`,
  E10: "E10 — goal adherence (comparative). Did the trajectory stay on the scripted goal with no off-goal wandering? A strong run stays on-script; a weak run wanders onto unrelated work. Judge the trajectory against the scripted goal (taskObjective).",
};
