// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Crash-resume target detection. Resume state is DERIVED from git — a run's
// branches under `bench-compact/run-<runId>/<cfgId>/…` ARE the artifacts — plus
// the one completion marker the branches cannot express: `runs/<runId>/results.json`
// exists ⟺ the run completed Phase 3. No parallel state file (it would drift).
//
// Pure functions over a branch-name list + a results-existence callback, so the
// command layer injects the git/fs side (listBranches + existsSync) and tests
// stay pure. See `parseRunNamespace` (branches.ts) for the namespace shape.

import { parseRunNamespace, type RunNamespace } from "./branches.js";

/** A resumable run target: the runId to continue + the cfgId the run started with
 *  (the hard cfgId guard in the run driver compares it against the CURRENT config).
 *  `allowConfigChange` (`--allow-config-change`) overrides that guard: the run keeps
 *  its original namespace, and arms whose tool version changed re-compact under the
 *  new version (branch names embed the version). `reuseBases` (`--reuse-bases`)
 *  additionally reuses committed arm bases built under OLDER tool versions (for tool
 *  fixes that did not change compaction behavior). */
export interface ResumeTarget extends RunNamespace {
  readonly allowConfigChange?: boolean;
  readonly reuseBases?: boolean;
  /** --rescore: resume an already-complete run (results.json exists) to re-run
   *  scoring — every phase replays from durable artifacts. */
  readonly rescore?: boolean;
}

/** Group a branch list into unique namespaces keyed by runId. One runId normally
 *  maps to one cfgId (the runId increments on every start); if a repo somehow
 *  carries two cfgs under one runId, the cfg with MORE branches wins (the run's
 *  real namespace — the minority is leftover debris) — deterministic either way. */
function groupByRunId(branches: readonly string[]): Map<string, ResumeTarget> {
  const byRunId = new Map<string, Map<string, number>>();
  for (const branch of branches) {
    const ns = parseRunNamespace(branch);
    if (ns === null) continue;
    let cfgCounts = byRunId.get(ns.runId);
    if (cfgCounts === undefined) {
      cfgCounts = new Map<string, number>();
      byRunId.set(ns.runId, cfgCounts);
    }
    cfgCounts.set(ns.cfgId, (cfgCounts.get(ns.cfgId) ?? 0) + 1);
  }
  const out = new Map<string, ResumeTarget>();
  for (const [runId, cfgCounts] of byRunId) {
    let best: { cfgId: string; count: number } | null = null;
    for (const [cfgId, count] of cfgCounts) {
      if (best === null || count > best.count) best = { cfgId, count };
    }
    if (best !== null) out.set(runId, { runId, cfgId: best.cfgId });
  }
  return out;
}

/** Compare two runIds (`<date>-<id>`) by recency: date is the major key, id minor. */
function byRecency(a: string, b: string): number {
  const [dateA, idA] = splitRunId(a);
  const [dateB, idB] = splitRunId(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return idA - idB;
}

function splitRunId(runId: string): [string, number] {
  const dash = runId.lastIndexOf("-");
  return [runId.slice(0, dash), Number.parseInt(runId.slice(dash + 1), 10)];
}

/** The latest incomplete run in a branch list: max by (date, id) among runs whose
 *  `resultsExist(runId)` is false (a run is complete once results.json exists).
 *  Null when every run is complete or no bench branches exist. */
export function detectLatestIncompleteRun(
  branches: readonly string[],
  resultsExist: (runId: string) => boolean,
): ResumeTarget | null {
  const byRunId = groupByRunId(branches);
  let latest: ResumeTarget | null = null;
  for (const [runId, ns] of byRunId) {
    if (resultsExist(runId)) continue;
    if (latest === null || byRecency(runId, latest.runId) > 0) latest = ns;
  }
  return latest;
}

/** The namespace of an explicit runId (null when the repo has no branches for it). */
export function findRunNamespace(branches: readonly string[], runId: string): ResumeTarget | null {
  return groupByRunId(branches).get(runId) ?? null;
}

/** The run-identity shape the run driver needs: the UTC date + the 1-based id. */
export interface RunIdentity {
  readonly date: string;
  readonly id: number;
}

/** The strict runId shape: `<YYYY-MM-DD>-<1+ digits>`. */
const RUN_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d+)$/;

/** Parse a runId into its date + numeric id. Throws (with the operator-facing refusal)
 *  on a malformed id — the run driver surfaces it via its setup-fault path. */
export function parseResumeRunId(runId: string): RunIdentity {
  const match = RUN_ID_PATTERN.exec(runId);
  if (match === null) {
    throw new Error(`cannot resume: "${runId}" is not a run id (expected YYYY-MM-DD-N)`);
  }
  return { date: match[1] as string, id: Number.parseInt(match[2] as string, 10) };
}
