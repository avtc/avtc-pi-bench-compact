// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench-compact storage layout. All paths derive from a single root:
//   root = outputDir ?? ~/.pi/bench-compact/
// Under root:
//   scenarios/<id>/repo/                — the scenario git repo (ONLY project files)        [AGENT-VISIBLE]
//   scenarios/<id>/sessions/<branch>.jsonl — the per-branch session transcript             [agent-hidden]
//   scenarios/<id>/manifest.json         — the scenario manifest                          [agent-hidden]
//   runs/<runId>/                        — judge/, results.json, report.md                 [agent-hidden]
//   configs/<cfgId>.json                 — full run config (source of truth)               [agent-hidden]
//
// The session transcript lives OUTSIDE the repo (in sessions/): pi appends to it
// mid-run, so keeping it in the repo would dirty the git tree + it must stay
// agent-invisible (anti-peek). The repo tracks ONLY project files the agent works on.
//
// The contamination rule: bench artifacts (sessions/manifest/results/judge/configs) are
// NEVER written into a scenario repo's working dir (the agent's cwd) — enforced by `assertNotInRepo`.

import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_ROOT = path.join(homedir(), ".pi", "bench-compact");

/** Resolve the bench root from the Task-2 `outputDir` config knob (null/undefined → default). */
export function benchRoot(outputDir: string | null | undefined): string {
  return outputDir ?? DEFAULT_ROOT;
}

// --- scenario layout -------------------------------------------------------
function assertChildPath(parent: string, child: string, kind: string): string {
  // path.join normalizes separators + "..", so a malicious id (e.g. "../scenarios/s1/repo/evil")
  // could escape its subdir into a sibling (a scenario repo — the agent's cwd). Enforce the
  // invariant at the sink: the resolved path must stay strictly under `parent`.
  const resolved = path.join(parent, child);
  const rel = path.relative(parent, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `unsafe ${kind} id ${JSON.stringify(child)}: resolves to ${resolved}, escaping ${parent} (contamination / traversal guard)`,
    );
  }
  return resolved;
}

export function scenarioDir(root: string, scenarioId: string): string {
  return assertChildPath(path.join(root, "scenarios"), scenarioId, "scenario");
}
/** The scenario git repo working dir (the agent's cwd; tracks ONLY project files — the session transcript lives in {@link scenarioSessionsDir}). */
export function scenarioRepo(root: string, scenarioId: string): string {
  return path.join(scenarioDir(root, scenarioId), "repo");
}
/** The per-branch session-transcript store (SIBLING of `repo/` under scenarios/<id>/;
 *  agent-invisible). Each branch's `session.jsonl` lives at {@link branchSessionFile}. */
export function scenarioSessionsDir(root: string, scenarioId: string): string {
  return assertChildPath(scenarioDir(root, scenarioId), "sessions", "scenario sessions");
}
/** The deterministic session-transcript file for `branch` under `sessionsDir`.
 *  Git branch names contain `/` (illegal in a filename), so non-`[a-zA-Z0-9._-]` chars
 *  are replaced with `-` — same branch always maps to the same file. */
export function branchSessionFile(sessionsDir: string, branch: string): string {
  const sanitized = branch.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(sessionsDir, `${sanitized}.jsonl`);
}
/** The scenario manifest (scenario-level, reusable; NEVER committed to the repo). */
export function scenarioManifest(root: string, scenarioId: string): string {
  return path.join(scenarioDir(root, scenarioId), "manifest.json");
}

// --- run / config layout -------------------------------------------------
export function runDir(root: string, runId: string): string {
  return assertChildPath(path.join(root, "runs"), runId, "run");
}
/** The full run-config file (source of truth for the run-condition fingerprint). */
export function configPath(root: string, cfgId: string): string {
  return assertChildPath(path.join(root, "configs"), `${cfgId}.json`, "cfgId");
}

// --- contamination rule ----------------------------------------------------
/** True iff `target` is strictly inside `repo` (a descendant, not the repo root itself). */
export function isInsideRepo(target: string, repo: string): boolean {
  const rel = path.relative(repo, target);
  // rel === ""  → target IS the repo root (not "inside").
  // rel starts with ".." → target is outside the repo.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Assert `target` is NOT inside the agent-visible `repo` working dir (contamination rule).
 *  Throws on violation (a bench artifact about to be written into the agent's cwd). */
export function assertNotInRepo(target: string, repo: string): void {
  if (isInsideRepo(target, repo)) {
    throw new Error(
      `contamination: ${target} is inside the agent-visible repo working dir ${repo} ` +
        "(bench artifacts must live outside the repo)",
    );
  }
}
