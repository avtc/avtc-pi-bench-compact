// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The anti-peek prompt. Honest intent + branch-fairness: the benchmark evaluates different
// summarization tools/approaches (one per git branch), so inspecting sibling branches would
// give one approach an unfair view of another's work. The prompt tells the agent this directly
// — it is not the subject of evaluation, the summarization tool is — which removes the incentive
// to peek or over-perform. Injected at each run start (before the agent's first tool-bearing
// turn) by the phase orchestrators + the build drive. Branch-scoped cwd (the agent's repo
// working dir; the session transcript lives outside the repo) is the PRIMARY guard; this
// instruction is secondary.
//
// Exported as a constant so the injecting sites prepend it to the first user message / compact
// preamble verbatim.

export const ANTI_PEEK_PROMPT =
  "We are evaluating different summarization tools and approaches — how they affect your work. Please work in the current branch and do not inspect other git branches, so each summarization tool and approach gets its fair score.";
