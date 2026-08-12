// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Branch-name formatters + the run-config fingerprint (cfgId) for the scenario git layout.
//
// Branch model (every branch holds session.jsonl + project files at the same paths → git diff is
// like-for-like):
//   bench-compact/run-{date}-{id}/{cfgId}/arm-{tool}[-{ver}][-{attemptN}|-probe-{probeId}]
// where {ver} is OMITTED for the bare-pi arm (no memory tool → no version). {cfgId} = cfg-<6hex> is the
// complete run-condition fingerprint (any model / thinking-level / N / arm-tool-version difference
// ⇒ a different cfgId). The full config is persisted at configs/<cfgId>.json (configs.ts).

import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ArmId, BackupMode } from "../config/types.js";

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
export interface RunConfig {
  evaluatedModel: string | null;
  evaluatedThinkingLevel: ThinkingLevel;
  judgeModel: string | null;
  judgeThinkingLevel: ThinkingLevel;
  N: number;
  compactionBoundary: number;
  armsEnabled: ArmId[];
  omFullReflectionThresholdTokens: number;
  backupMode: BackupMode;
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

/** Phase-2 continuation branch (attemptN = 1..N), branched from the arm base. */
export function buildAttemptBranch(b: BranchBase & { attemptN: number }): string {
  return appendAttempt(buildArmBaseBranch(b), b.attemptN);
}

/** Append the `-probe-{probeId}` suffix to an arm-base branch. Single source for the format. */
export function appendProbe(baseBranch: string, probeId: string): string {
  return `${baseBranch}-probe-${probeId}`;
}

/** Direct-probe branch, branched from the arm base. */
export function buildProbeBranch(b: BranchBase & { probeId: string }): string {
  return appendProbe(buildArmBaseBranch(b), b.probeId);
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
    evaluatedModel: rc.evaluatedModel,
    evaluatedThinkingLevel: rc.evaluatedThinkingLevel,
    judgeModel: rc.judgeModel,
    judgeThinkingLevel: rc.judgeThinkingLevel,
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
