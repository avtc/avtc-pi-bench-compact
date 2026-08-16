// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Branch-name formatters + the run-config fingerprint (cfgId) for the scenario git layout.
//
// Branch model (every branch holds the project files at the same paths → git diff is
// like-for-like; the session transcript lives outside the repo, in the per-branch sessions store):
//   bench-compact/run-{date}-{id}/{cfgId}/arm-{tool}[-{ver}][-{attemptN}|-probe-{probeId}-{attemptN}]
// where {ver} is OMITTED for the bare-pi arm (no memory tool → no version). {cfgId} = cfg-<6hex> is the
// complete run-condition fingerprint (any model / thinking-level / N / arm-tool-version difference
// ⇒ a different cfgId). The full config is persisted at configs/<cfgId>.json (configs.ts).

import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type ArmId,
  type BackupMode,
  type FastEvalMode,
  type JudgeEnsembleConfig,
  judgeEnsembleFields,
} from "../config/types.js";

/** A resolved memory-tool version for one arm. */
export interface ToolVersion {
  /** Install source — determines how `commit`/`full` are interpreted. */
  source: "git" | "npm";
  /** Short form used in branch names ({ver}) + toolVersions.<arm>.commit: `g<6hex>` (git) or `npm<ver>`. */
  commit: string;
  /** Full hash (git) or version+registry (npm) — toolVersions.<arm>.full. */
  full: string;
}

/** The complete run-condition fingerprint inputs (snapshot at run start). */
export interface RunConfig extends JudgeEnsembleConfig {
  evaluatedModel: string | null;
  evaluatedThinkingLevel: ThinkingLevel;
  N: number;
  compactionBoundary: number;
  armsEnabled: ArmId[];
  omFullReflectionThresholdTokens: number;
  backupMode: BackupMode;
  /** Fast-eval mode (probes-only skips continuations; part of the fingerprint). */
  fastEval: FastEvalMode;
  /** Per-arm resolved tool versions. The bare-pi arm is typically absent (no memory tool). */
  toolVersions: Partial<Record<ArmId, ToolVersion>>;
}

// --- {ver} token formatters ------------------------------------------------
/** Short git version token: `g` + first 6 hex of the commit hash (e.g. `4a2f8e9…` → `g4a2f8e`). */
export function shortGitVersion(fullHash: string): string {
  return `g${fullHash.slice(0, 6)}`;
}
/** Short npm version token: `npm` + version string (e.g. `1.2.3` → `npm1.2.3`). */
export function shortNpmVersion(version: string): string {
  return `npm${version}`;
}

// --- branch builders -------------------------------------------------------
interface BranchBase {
  date: string; // calendar date the bench RUN started (fixed across all arms/attempt)
  id: number; // 1-based, incremented per bench-run started on {date}
  cfgId: string; // cfg-<hex>
  tool: string; // arm tool name (bare-pi · om-default · memkeeper-builder · memkeeper-selector · om-full)
  /** Short tool-version token ({ver}); undefined for the bare-pi arm → omitted from the branch name. */
  ver: string | undefined;
}

/** The arm-segment with the bare-pi ver-omission rule: `arm-{tool}` or `arm-{tool}-{ver}`. */
function armSegment(tool: string, ver: string | undefined): string {
  return ver === undefined ? `arm-${tool}` : `arm-${tool}-${ver}`;
}

/** Arm compacted-base branch (Phase-1 result), branched from main. */
export function buildArmBaseBranch(b: BranchBase): string {
  return `bench-compact/run-${b.date}-${b.id}/${b.cfgId}/${armSegment(b.tool, b.ver)}`;
}

/** Append the `-{attemptN}` suffix to an arm-base branch. Single source for the format. */
export function appendAttempt(baseBranch: string, attemptN: number): string {
  return `${baseBranch}-${attemptN}`;
}

/** Append the `-probe-{probeId}` suffix to an arm-base branch. Single source for the format. */
export function appendProbe(baseBranch: string, probeId: string): string {
  return `${baseBranch}-probe-${probeId}`;
}

/** Append the `-probe-{probeId}-{attemptN}` suffix to an arm-base branch. Direct probes fork
 *  N× per arm (one probe-set per attempt) so each probe answer is an independent sample of
 *  agent-response variance (rate over N); the attempt suffix disambiguates the N forks. */
export function appendProbeAttempt(baseBranch: string, probeId: string, attemptN: number): string {
  return `${appendProbe(baseBranch, probeId)}-${attemptN}`;
}

// --- run-namespace parsing (crash resume) ----------------------------------

/** A run's identity recovered from its branch namespace: the runId + the run-config
 *  fingerprint segment every branch of the run carries. */
export interface RunNamespace {
  /** `<date>-<id>` (e.g. `2026-08-16-4`). */
  readonly runId: string;
  /** The `cfg-<hex>` segment (the run-condition fingerprint at run start). */
  readonly cfgId: string;
}

/** `bench-compact/run-<date>-<id>/cfg-<hex>/<arm-segment>…` — the namespace shape every
 *  run branch carries (arm base, attempt, probe). Dates are strict YYYY-MM-DD; ids are
 *  1+ digits; the cfg segment is `cfg-` + hex. */
const RUN_NAMESPACE_PATTERN = /^bench-compact\/run-(\d{4}-\d{2}-\d{2})-(\d+)\/(cfg-[0-9a-f]+)\/.+$/;

/** Parse a branch name into its run namespace, or null when the branch is not a
 *  bench-compact run branch (main, unrelated branches, malformed names). Pure. */
export function parseRunNamespace(branch: string): RunNamespace | null {
  const match = RUN_NAMESPACE_PATTERN.exec(branch);
  if (match === null) return null;
  const date = match[1] as string;
  const id = match[2] as string;
  const cfgId = match[3] as string;
  return { runId: `${date}-${id}`, cfgId };
}

// --- cfgId (run-condition fingerprint) -------------------------------------
/**
 * Deterministic short id of the FULL run config. Same config ⇒ same cfgId; differing in ANY
 * dimension (model, thinking level, N, OR any arm's tool version) ⇒ different cfgId.
 * `armsEnabled` order is normalized (it's a set); tool-version entries are keyed by arm id.
 */
export function buildCfgId(rc: RunConfig): string {
  // Canonical form: sorted arms, tool-version entries sorted by arm id (key-order independent).
  const canonical = {
    ...judgeEnsembleFields(rc),
    evaluatedModel: rc.evaluatedModel,
    evaluatedThinkingLevel: rc.evaluatedThinkingLevel,
    N: rc.N,
    compactionBoundary: rc.compactionBoundary,
    omFullReflectionThresholdTokens: rc.omFullReflectionThresholdTokens,
    backupMode: rc.backupMode,
    arms: [...rc.armsEnabled].sort(),
    toolVersions: (Object.keys(rc.toolVersions) as ArmId[])
      .sort()
      .map((a) => {
        const v = rc.toolVersions[a];
        return v === undefined ? null : [a, v.source, v.commit, v.full];
      })
      .filter((x): x is [ArmId, string, string, string] => x !== null),
  };
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `cfg-${hash.slice(0, 6)}`;
}
