// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Preserved-run source selection: for each enabled arm, find the newest previous
// run's artifacts that make the arm's compaction + latent-probe pool reusable
// VERBATIM — a committed base branch (with its session file, whose compaction
// record IS the memory state) plus that run's latent pool whose recorded summary
// digest + tail anchor still match. `run-scenario` reuses these instead of
// re-compacting and re-authoring (hours of validated probe authoring), then asks
// the probes again — only the answering model varies.
//
// Newest-per-arm: candidates are scanned newest-commit-first (newestBranches),
// shape-filtered to TRUE base branches (attempt `-N` / probe `-probe-*` branches
// never qualify), and the first candidate whose run also carries a valid pool
// wins. `from` pins the source run id (explicit provenance); arms with no valid
// pair fall back to a fresh phase-1 compaction + latent authoring.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { ARM_DEFS } from "../arms/definitions.js";
import type { ArmId } from "../config/types.js";
import { validateLatentProbes } from "../manifest/latent.js";
import { spanContentEntryIds } from "../manifest/latent-author.js";
import { readArmCompaction } from "../session/compaction-record.js";
import { copySessionFork, type SessionRuntimePins } from "../session/fork.js";
import { buildArmBaseBranch } from "./branches.js";
import { readLatentPool, staleVerdictArms, summaryDigest } from "./latent-pool.js";
import { branchSessionFile, runDir } from "./paths.js";
import { readPhase1Walls } from "./phase1-walls.js";
import { branchExists, commitCountAhead, forkBranch, newestBranches, resetBranch } from "./repo.js";

/** One arm's reusable pair: the source run's committed base + its latent pool. */
export interface PreservedArmSource {
  readonly arm: ArmId;
  /** Branch-name `{tool}` token (from the branch segment). */
  readonly tool: string;
  /** Short tool-version token from the branch segment; undefined for unversioned. */
  readonly ver: string | undefined;
  /** The source run's committed base branch (`bench-compact/run-<id>/<cfg>/arm-…`). */
  readonly sourceBranch: string;
  /** The source run id parsed from the branch (`<date>-<n>`). */
  readonly sourceRunId: string;
  /** The source base's session file (compaction record inside — the memory state). */
  readonly sessionPath: string;
  /** The source run's pool file (`runs/<sourceRunId>/latent-pool-<arm>.json`). */
  readonly poolPath: string;
}

/** Why an arm cannot be preserved (it falls back to fresh compaction + authoring). */
export interface PreservedArmMiss {
  readonly arm: ArmId;
  readonly reason: string;
}

export interface PreserveSelection {
  readonly found: readonly PreservedArmSource[];
  readonly misses: readonly PreservedArmMiss[];
}

/** Injectable fs/git seams (tests fake them; defaults = the real ones). */
export interface PreserveOps {
  newestBranches: typeof newestBranches;
  commitCountAhead: typeof commitCountAhead;
  exists: (path: string) => boolean;
}

const DEFAULT_OPS: PreserveOps = { newestBranches, commitCountAhead, exists: existsSync };

export interface PreserveSelectDeps {
  /** The scenario repo (holds every run's bench-compact/* branches). */
  readonly repo: string;
  /** The per-branch session-transcript store (sibling of the repo). */
  readonly sessionsDir: string;
  /** The runs root (`benchRoot(outputDir)`) — source pools live under it. */
  readonly runsRoot: string;
  readonly armsEnabled: readonly ArmId[];
  /** Pin the source run id (`--from=<runId>`); null = newest valid pair per arm. */
  readonly from: string | null;
  readonly ops?: Partial<PreserveOps>;
}

/** `arm-<tool>` / `arm-<tool>-g<hex>` / `arm-<tool>-npm<ver>` — a TRUE base branch
 *  segment (same shape contract as phase-1's --reuse-bases candidate filter). */
function baseSegmentShape(tool: string): RegExp {
  return new RegExp(`^arm-${tool}(-g[0-9a-f]+|-npm[0-9][w.]*)?$`);
}

interface ArmPick {
  readonly source: PreservedArmSource | null;
  readonly reason: string;
}

/** Pick one arm's newest valid source pair. */
function pickArm(deps: PreserveSelectDeps, ops: PreserveOps, arm: ArmId): ArmPick {
  const tool = ARM_DEFS[arm].tool;
  const candidates = ops
    .newestBranches(deps.repo, `bench-compact/run-*/*/arm-${tool}*`)
    .filter((b) => baseSegmentShape(tool).test(b.split("/").pop() ?? ""));
  if (candidates.length === 0) {
    return { source: null, reason: `no committed base branch for arm ${arm} (arm-${tool}) in this scenario repo` };
  }
  let firstReason = "";
  for (const branch of candidates) {
    const parts = branch.split("/");
    const runId = parts.length === 4 ? parts[1]?.slice("run-".length) : undefined;
    if (runId === undefined || runId === "") continue; // foreign shape — not a run branch
    if (deps.from !== null && runId !== deps.from) continue; // pinned to another run
    const segment = parts[3] ?? "";
    const ver = segment === `arm-${tool}` ? undefined : segment.slice(`arm-${tool}-`.length);
    const skip = (reason: string): ArmPick => {
      if (firstReason === "") firstReason = reason;
      return { source: null, reason };
    };
    if (ops.commitCountAhead(deps.repo, branch, "main") <= 0) {
      skip(`newest base ${branch} is not committed`);
      continue;
    }
    const sessionPath = branchSessionFile(deps.sessionsDir, branch);
    if (!ops.exists(sessionPath)) {
      skip(`base ${branch} has no session file (${sessionPath})`);
      continue;
    }
    const poolPath = join(runDir(deps.runsRoot, runId), `latent-pool-${arm}.json`);
    if (!ops.exists(poolPath)) {
      return skip(`run ${runId} has no latent pool for arm ${arm} (${poolPath})`);
    }
    const compaction = readArmCompaction(sessionPath);
    if (compaction === null) {
      return skip(`base ${branch} session has no compaction record`);
    }
    let pool: ReturnType<typeof readLatentPool> | undefined;
    try {
      pool = readLatentPool(poolPath);
    } catch (err) {
      return skip(`latent pool unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (pool === undefined || pool.mode !== "per-arm" || pool.arm !== arm) {
      return skip(`latent pool ${poolPath} is not a per-arm pool for ${arm}`);
    }
    if (staleVerdictArms(pool, { [arm]: summaryDigest(compaction.summary) }).length > 0) {
      return skip(`pool summary digest does not match the base session's compaction (${poolPath})`);
    }
    if (pool.tailStartsAtEntryId !== compaction.firstKeptEntryId) {
      return skip(`pool tail anchor ${pool.tailStartsAtEntryId} != session anchor ${compaction.firstKeptEntryId}`);
    }
    const validation = validateLatentProbes(pool.probes, {
      mode: "per-arm",
      spanEntryIds: spanContentEntryIds([sessionPath], compaction.firstKeptEntryId),
      enabledArms: deps.armsEnabled,
    });
    if (!validation.ok) {
      return skip(`span validation failed: ${validation.reasons[0] ?? "invalid probes"}`);
    }
    return { source: { arm, tool, ver, sourceBranch: branch, sourceRunId: runId, sessionPath, poolPath }, reason: "" };
  }
  return { source: null, reason: firstReason !== "" ? firstReason : `no valid source run for arm ${arm}` };
}

/** Select every enabled arm's preserved source pair (newest per arm). */
export function findPreservedArms(deps: PreserveSelectDeps): PreserveSelection {
  const ops = { ...DEFAULT_OPS, ...(deps.ops ?? {}) };
  const found: PreservedArmSource[] = [];
  const misses: PreservedArmMiss[] = [];
  for (const arm of deps.armsEnabled) {
    const pick = pickArm(deps, ops, arm);
    if (pick.source !== null) found.push(pick.source);
    else misses.push({ arm, reason: pick.reason });
  }
  return { found, misses };
}

// --- materialization: install a source pair into the NEW run's namespace ----

/** A preserved arm's phase-1-equivalent base entry (+ provenance). */
export interface PreservedBase {
  readonly arm: ArmId;
  readonly tool: string;
  readonly ver: string | undefined;
  readonly cfgId: string;
  readonly branch: string;
  readonly wallMs: number;
  readonly usage: CompactionEntry["usage"];
  /** The source run the base + pool were preserved from. */
  readonly sourceRunId: string;
}

/** Injectable git/fs seams for materialization (tests fake fork/branchExists). */
export interface MaterializeOps {
  fork: typeof forkBranch;
  branchExists: typeof branchExists;
  /** Delete a branch ref (half-materialized cleanup — see materializePreservedArm). */
  resetBranch: typeof resetBranch;
  copySeed: (src: string, dest: string, pins: SessionRuntimePins | null) => void;
}

const DEFAULT_MATERIALIZE_OPS: MaterializeOps = {
  fork: forkBranch,
  branchExists,
  resetBranch,
  copySeed: copySessionFork,
};

export interface PreservedMaterializeDeps {
  readonly repo: string;
  readonly sessionsDir: string;
  /** The NEW run's artifacts dir (runs/<newRunId>) — the pool lands beside its siblings. */
  readonly runPath: string;
  readonly date: string;
  readonly id: number;
  readonly cfgId: string;
  /** The new run's runtime pins (evaluated model + thinking) — applied on the copied session. */
  readonly runtimePins: SessionRuntimePins | null;
  readonly ops?: Partial<MaterializeOps>;
}

/** Install a selected source pair as the new run's arm base: fork the source base
 *  branch into the new run's namespace, copy its session (fresh session id + the
 *  new run's runtime pins), copy the latent pool verbatim into the new run dir
 *  (its digests still match the VERBATIM session), and carry the source run's
 *  compaction wall time. The returned entry is drop-in equivalent to a phase-1
 *  ArmBase — phase-2/probes fork from it exactly like a compacted base. */
export function materializePreservedArm(deps: PreservedMaterializeDeps, source: PreservedArmSource): PreservedBase {
  const ops = { ...DEFAULT_MATERIALIZE_OPS, ...(deps.ops ?? {}) };
  const branch = buildArmBaseBranch({
    date: deps.date,
    id: deps.id,
    cfgId: deps.cfgId,
    tool: source.tool,
    ver: source.ver,
  });
  // A pre-existing branch of this name is a runId collision with foreign work —
  // stop and surface (same contract as phase-1's branch-conflict), never stack.
  if (ops.branchExists(deps.repo, branch)) {
    throw new Error(
      `branch ${branch} already exists — runId collision while preserving arm ${source.arm} from run ${source.sourceRunId}`,
    );
  }
  ops.fork(deps.repo, source.sourceBranch, branch);
  try {
    ops.copySeed(source.sessionPath, branchSessionFile(deps.sessionsDir, branch), deps.runtimePins);
    mkdirSync(deps.runPath, { recursive: true });
    copyFileSync(source.poolPath, join(deps.runPath, `latent-pool-${source.arm}.json`));
  } catch (err) {
    // A half-materialized base (forked branch, missing session/pool) would collide
    // with the fresh phase-1 pass that follows — drop the leftover branch, rethrow.
    try {
      ops.resetBranch(deps.repo, branch);
    } catch {
      // best-effort cleanup — the operator-visible error is the original one
    }
    throw err;
  }
  const walls = readPhase1Walls(join(dirname(source.poolPath), "phase1-walls.json"));
  return {
    arm: source.arm,
    tool: source.tool,
    ver: source.ver,
    cfgId: deps.cfgId,
    branch,
    wallMs: walls[source.arm] ?? 0,
    usage: undefined,
    sourceRunId: source.sourceRunId,
  };
}

// --- run-level resolution: select + materialize every preservable arm ----------

/** The run-level preserve result: materialized bases + provenance + operator log lines. */
export interface PreserveRunResult {
  readonly bases: readonly PreservedBase[];
  /** arm → source run id (drives phase-1/latent subsetting + the preserved.json artifact). */
  readonly preservedFrom: Readonly<Partial<Record<ArmId, string>>>;
  /** One log.info line per arm (reuse or fall-fresh reason). */
  readonly logLines: readonly string[];
}

export interface PreserveRunDeps {
  readonly repo: string;
  readonly sessionsDir: string;
  /** The bench root — source pools + walls live under runs/<sourceRunId>/. */
  readonly runsRoot: string;
  /** The NEW run's artifacts dir (runs/<newRunId>) — pools land beside their siblings. */
  readonly runPath: string;
  readonly date: string;
  readonly id: number;
  readonly cfgId: string;
  /** The new run's runtime pins (evaluated model + thinking). */
  readonly runtimePins: SessionRuntimePins | null;
  readonly armsEnabled: readonly ArmId[];
  /** Pin the source run id; null = newest valid pair per arm. */
  readonly from: string | null;
  readonly selectOps?: Partial<PreserveOps>;
  readonly materializeOps?: Partial<MaterializeOps>;
}

/** Resolve preservation for a fresh run: select each enabled arm's newest valid
 *  source pair and materialize it into the new run's namespace. Arms that fail
 *  selection (or materialization) fall back to a fresh phase-1 compaction — the
 *  caller shrinks the phase-1/latent arm lists accordingly. */
export function preserveArmsForRun(deps: PreserveRunDeps): PreserveRunResult {
  const selection = findPreservedArms({
    repo: deps.repo,
    sessionsDir: deps.sessionsDir,
    runsRoot: deps.runsRoot,
    armsEnabled: deps.armsEnabled,
    from: deps.from,
    ops: deps.selectOps,
  });
  const bases: PreservedBase[] = [];
  const logLines: string[] = [];
  for (const miss of selection.misses) {
    logLines.push(`preserve: arm ${miss.arm} falls fresh — ${miss.reason}`);
  }
  for (const source of selection.found) {
    try {
      const base = materializePreservedArm(
        {
          repo: deps.repo,
          sessionsDir: deps.sessionsDir,
          runPath: deps.runPath,
          date: deps.date,
          id: deps.id,
          cfgId: deps.cfgId,
          runtimePins: deps.runtimePins,
          ops: deps.materializeOps,
        },
        source,
      );
      bases.push(base);
      logLines.push(`preserve: arm ${source.arm} reused run ${source.sourceRunId} (${source.sourceBranch})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLines.push(`preserve: arm ${source.arm} failed to materialize — ${msg} — falls fresh`);
    }
  }
  const preservedFrom: Partial<Record<ArmId, string>> = {};
  for (const base of bases) preservedFrom[base.arm] = base.sourceRunId;
  return { bases, preservedFrom, logLines };
}
