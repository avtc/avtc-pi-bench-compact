// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The anti-peek prompt. Belt-and-suspenders on branch-scoped cwd: the agent's cwd IS the
// scenario repo working dir (on its own branch), so it can see the repo files + git history. Latest
// LLMs are curious and may browse. This instruction forbidding it is injected at each run start
// (before the agent's first tool-bearing turn) by Tasks 12/13a/13b. Branch-scoped cwd is the
// PRIMARY guard; this instruction is secondary.
//
// Exported as a constant so the injecting tasks prepend it to the first user message / compact
// preamble verbatim.

export const ANTI_PEEK_PROMPT = `You are working inside a benchmark scenario git repository, on a single git branch (your working tree). Stay within it.

Do NOT inspect, read, or reference any benchmark-internal artifacts that sit OUTSIDE your project working directory. Specifically, you may NOT:
- run \`git checkout\`, \`git branch\`, \`git stash\`, \`git switch\`, or otherwise browse/inspect other git branches (sibling arms, attempts, or probes);
- read the session transcript file \`session.jsonl\` in your repo (it is the agent's own memory — do not open it);
- read or list \`manifest.json\`, the \`runs/\` directory (results, judge outputs), or the \`configs/\` directory — these are siblings of your \`repo/\` under the bench-compact storage root and are off-limits.

Your ONLY bench-internal scope is the current branch's working tree: the project source files you are working on. Do all your work there using your normal tools. If you notice any of the forbidden paths or branches, ignore them and continue with the task.`;
