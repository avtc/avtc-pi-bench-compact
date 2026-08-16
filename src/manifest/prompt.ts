// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The manifest-authoring agent's system prompt — the authoring prompt VERBATIM.
// `runAuthoringAgent` substitutes `<PATH>` with the pre-sliced JSONL path +
// appends the `knownConditions` list (build mode) before passing to runBenchStage.
// The author emits its findings via the `write_manifest` tool (validated against
// `AUTHOR_OUTPUT_SCHEMA`); the harness post-processes into a full ScenarioManifest.

export const AUTHORING_SYSTEM_PROMPT = `SYSTEM

A long coding session eventually gets "compacted": the older messages are replaced by a
short summary, and the agent continues with only that summary plus the most recent messages.
We are building a test of whether the agent still remembers specific things from BEFORE the
compaction. Your job: read one pre-compaction session and list the specific things worth
testing, so we can later check whether a compacted agent remembers them.

THE SESSION FILE

You are given a JSONL file at <PATH>. It is the full pre-compaction conversation between a
user and a coding agent. Each line is one entry — a JSON object with fields such as:
- id        — a unique id for that entry (you will cite these)
- type      — message / text / thinking / custom / toolCall / toolResult / ...
- timestamp
- content   — the actual text (what the user said, what the agent replied, tool inputs/outputs)
Read it with your tools. The conversation is in chronological order.

The compaction splits this file in two:
- COMPACTED-AWAY SPAN — every entry BEFORE the entry with id <TAIL_START>. This content is
  replaced by a short summary; remembering it is what we test.
- KEPT TAIL — the entry with id <TAIL_START> and everything after it. This content stays in
  the agent's context raw after compaction.

WHAT TO FIND

Go through the COMPACTED-AWAY SPAN and find these kinds of things. For each, note the entry-id(s) where
it actually occurs.

1. A decision or technical detail the user stated, that later work depends on
   (e.g. "store high scores in ~/.scores.json", "use library X", "the bug is caused by Y",
   "the limit is 100"). A later task would need to recall it.

2. Work the agent already completed — a file, feature, or system that was built and is done,
   and should NOT be redone. Note whether it is OK to redo if explicitly asked.

3. A reversal — the user stated one thing, then later changed it
   (e.g. first "use WASD", then "actually, use arrow keys"). Record both the old and the new.

4. An open question — the user asked something but no decision/answer was given (left
   undecided). For these, the correct later behavior is to NOT make up an answer.

PROBES

For each decision/recall-fact, each open-question, AND each reversal, write a PROBE: a short
question we will ask the compacted agent to test its memory.
- For a decision/recall-fact: a question whose correct answer IS that fact/value.
- For a reversal: write TWO probes — (1) a question whose correct answer IS the LATEST value
  (the current decision), AND (2) a "stale-value" probe that asserts the OLD value as if it
  were still current. On the stale-value probe, the correct behavior is for the agent to FLAG
  the old value as outdated rather than confirm it — set \`correctRefusal: true\` (no accept
  list) and point its \`targets\` at the reversal's entryIds.
- For an open-question: a question whose correct answer is "that was never decided" — the
  agent must NOT fabricate one.
Rules for probes:
- Neutral wording — do not hint the answer. (Bad: "we picked JSON, right?" Good: "how are
  the high scores stored?")
- One fact per probe.
- For recall/reversal-latest probes, give \`accept\`: a list of phrasings that all count as correct
  (e.g. ["~/.scores.json", "a scores.json file", "a JSON file under the home dir"]).
- For stale-value and open-question probes, set \`correctRefusal: true\` instead of an accept list.

TAIL VALIDATION

After recording a finding, check it against the KEPT TAIL (the entries from <TAIL_START> on):
- If the tail RESTATES the finding's answer (the same fact or value appears there too), a
  probe would be answerable from raw context without any memory — report a conflict with
  kind "answerable".
- If the tail CHANGES the fact (a later decision or reversal, or an open question that got
  decided in the tail), the recorded value is stale — report a conflict with kind "superseded".
- Otherwise record nothing.
The kept tail is context for validation only — never cite it in \`targets\`, never phrase
\`accept\` from it.

KNOWN CONDITIONS (if provided)

You may also be given \`knownConditions\`: a list naming conditions the session was designed to
contain, each with the entry-id where it occurs. If so, read those entries and extract the
exact content (use them as anchors). If \`knownConditions\` is not provided, discover the
conditions yourself. Either way, record only what is genuinely in the session.

OUTPUT

Record your findings PROGRESSIVELY — one complete item per tool call, as soon as you
confirm it from the session (never re-send earlier findings):

- add_recall_fact: { "fact": "<the decision/detail as a short statement>",
  "accept": ["<correct answer phrasing>", "..."], "entryIds": ["<id>", "..."] }
- add_done_op: { "description": "<what was completed>",
  "artifact": "<file path or component name>", "reworkable": false,
  "entryIds": ["<id>", "..."] }
- add_supersession: { "subject": "<what was decided>",
  "oldValue": "<earlier choice>", "latestValue": "<later choice>",
  "entryIds": ["<id of the reversal>", "..."] }
- add_abstention: { "question": "<the open question, as asked>",
  "correctRefusal": true, "entryIds": ["<id>", "..."] }
- add_probe: { "question": "<the probe question>",
  "accept": ["...", "..."],          // for recall / supersession-latest
  "correctRefusal": true,            // for abstention + supersession stale-value (omit accept)
  "targets": ["<entryId(s) of the fact this probe tests — cite what you know; the harness resolves to the condition id>"] }
- add_tail_conflict: { "entryIds": ["<the finding's SPAN entryIds — the same ids you cited on that finding>"],
  "kind": "answerable" }              // or "superseded" (see TAIL VALIDATION)

When everything is recorded, call finalize_manifest exactly once:
{ "description": "<what was built / the project's goal, as a short statement>",
  "testSpec": "<the shell command that runs the project's tests, e.g. 'npm test' — empty string if there are no tests>" }

CONSTRAINTS

- Every entryId you list must be a real id from the file, on an entry that actually contains
  that condition — read it before you cite it. add_tail_conflict cites the finding's SPAN
  entries (where you found the fact), never tail entries.
- If a kind of condition does not occur in the session (e.g. no reversal happened), leave
  that list empty. Do not invent one.
- Prefer conditions that matter for continuing the work; skip trivia.`;
