// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The latent stage: after Phase-1 compaction, author (or re-validate) the run's
// latent-probe pools. Per-arm mode = one authoring run per arm's session file;
// shared = one run over all files. Existing pools whose recorded summary digests
// still match are REUSED (resume re-validation); a changed digest re-authors.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ArmId } from "../config/types.js";
import type { RateLimitOptions } from "../judge/rate-limit.js";
import type { JsonToolStageSeams } from "../judge/stage-runner.js";
import { log } from "../log.js";
import { activeLatentProbes, type LatentProbe } from "../manifest/latent.js";
import { runLatentAuthoringAgent } from "../manifest/latent-author.js";
import { readArmCompaction } from "../session/compaction-record.js";
import type { LatentPoolFile } from "../storage/latent-pool.js";
import { readLatentPool, staleVerdictArms, summaryDigest, writeLatentPool } from "../storage/latent-pool.js";
import { branchSessionFile } from "../storage/paths.js";
import { listBranches, resetBranch } from "../storage/repo.js";
import type { AskUi } from "../ui/ask.js";

/** One arm's post-compaction input. */
export interface LatentArmInput {
  readonly arm: ArmId;
  readonly sessionPath: string;
}

export interface LatentStageDeps {
  /** Injectable authoring agent (tests fake it; default = the real agent). */
  readonly author?: typeof runLatentAuthoringAgent;
  readonly arms: readonly LatentArmInput[];
  /** runs/<runId> — pools persist beside the run's other artifacts. */
  readonly runPath: string;
  /** Tools cwd (the scenario repo). */
  readonly cwd: string;
  readonly ui: AskUi | null;
  readonly seams: JsonToolStageSeams;
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  readonly rateLimitOptions: RateLimitOptions | null;
}

/** Stage outcome: done carries the per-arm pools (shared mode: the single pool
 *  under every arm key) + which arms' pools were RE-AUTHORED this pass (pool ids
 *  restart at l1 — the caller purges those arms' stale latent probe branches +
 *  session files so resumes cannot replay dead answers); stopped carries the
 *  notify message for the operator. */
export type LatentStageResult =
  | { kind: "done"; pools: Readonly<Partial<Record<ArmId, LatentPoolFile>>>; reAuthored: readonly ArmId[] }
  | { kind: "stopped"; arm: ArmId | null; message: string };

/** The latent stage's stop-and-surface error (the run driver maps it to a stopped
 *  RunResult with phase "latent"). */
export class LatentStageStoppedError extends Error {
  constructor(
    readonly arm: ArmId | null,
    readonly reason: { message: string },
  ) {
    super(reason.message);
    this.name = "LatentStageStoppedError";
  }
}

/** Run the latent stage in per-arm mode. */
export async function runLatentStagePerArm(deps: LatentStageDeps): Promise<LatentStageResult> {
  const author = deps.author ?? runLatentAuthoringAgent;
  const pools: Partial<Record<ArmId, LatentPoolFile>> = {};
  const reAuthored: ArmId[] = [];
  for (const { arm, sessionPath } of deps.arms) {
    const compaction = readArmCompaction(sessionPath);
    if (compaction === null) {
      throw new Error(`latent: arm ${arm} has no compaction record in its session file`);
    }
    const poolPath = join(deps.runPath, `latent-pool-${arm}.json`);
    if (existsSync(poolPath)) {
      const pool = readLatentPool(poolPath);
      const stale = staleVerdictArms(pool, { [arm]: summaryDigest(compaction.summary) });
      if (stale.length === 0 && pool.tailStartsAtEntryId === compaction.firstKeptEntryId) {
        log.info(`latent: arm ${arm} pool valid (summary unchanged) — reuse`);
        pools[arm] = pool;
        continue;
      }
      log.info(`latent: arm ${arm} summary changed — re-authoring`);
      reAuthored.push(arm);
    }
    const result = await author({
      seams: deps.seams,
      cwd: deps.cwd,
      mode: "per-arm",
      arm,
      enabledArms: deps.arms.map((a) => a.arm),
      sessionPaths: [sessionPath],
      tailStartsAtEntryId: compaction.firstKeptEntryId,
      ui: deps.ui,
      signal: deps.signal,
      maxTokens: deps.maxTokens,
      rateLimitOptions: deps.rateLimitOptions,
    });
    if (result.kind === "stopped") {
      return {
        kind: "stopped",
        arm,
        message: `latent: arm ${arm} stopped below minimum (cued ${result.counts.cued}, uncued ${result.counts.uncued}) — run paused, resume to retry`,
      };
    }
    const pool: LatentPoolFile = {
      mode: "per-arm",
      arm,
      tailStartsAtEntryId: compaction.firstKeptEntryId,
      summaryDigests: { [arm]: summaryDigest(compaction.summary) },
      probes: [...result.pool],
    };
    writeLatentPool(poolPath, pool);
    const cued = pool.probes.filter((p) => p.probeClass === "cued").length;
    const uncued = pool.probes.length - cued;
    log.info(`latent: arm ${arm} authored ${pool.probes.length} probes (cued ${cued}, uncued ${uncued}) → ${poolPath}`);
    pools[arm] = pool;
  }
  return { kind: "done", pools, reAuthored };
}

/** Run the latent stage in shared mode (one authoring run, one pool). */
export async function runLatentStageShared(deps: LatentStageDeps): Promise<LatentStageResult> {
  const author = deps.author ?? runLatentAuthoringAgent;
  const compactions = deps.arms.map((a) => ({ arm: a.arm, path: a.sessionPath, c: readArmCompaction(a.sessionPath) }));
  for (const { arm, c } of compactions) {
    if (c === null) throw new Error(`latent: arm ${arm} has no compaction record in its session file`);
  }
  const anchors = new Set(compactions.map((x) => x.c?.firstKeptEntryId));
  if (anchors.size > 1) {
    return {
      kind: "stopped",
      arm: null,
      message: "latent: arms disagree on the tail anchor — cannot author a shared set",
    };
  }
  const anchor = compactions[0]?.c?.firstKeptEntryId;
  if (anchor === undefined) throw new Error("latent: no arms enabled");

  const poolPath = join(deps.runPath, "latent-pool.json");
  if (existsSync(poolPath)) {
    const pool = readLatentPool(poolPath);
    const current: Record<string, string> = {};
    for (const { arm, c } of compactions) current[arm] = summaryDigest(c?.summary ?? "");
    const stale = staleVerdictArms(pool, current);
    if (stale.length === 0 && pool.tailStartsAtEntryId === anchor) {
      log.info("latent: shared pool valid (summaries unchanged) — reuse");
      const pools: Partial<Record<ArmId, LatentPoolFile>> = {};
      for (const { arm } of compactions) pools[arm] = pool;
      return { kind: "done", pools, reAuthored: [] };
    }
    log.info("latent: shared summary changed — re-authoring");
  }

  const result = await author({
    seams: deps.seams,
    cwd: deps.cwd,
    mode: "shared",
    arm: deps.arms[0].arm,
    enabledArms: deps.arms.map((a) => a.arm),
    sessionPaths: deps.arms.map((a) => a.sessionPath),
    tailStartsAtEntryId: anchor,
    ui: deps.ui,
    signal: deps.signal,
    maxTokens: deps.maxTokens,
    rateLimitOptions: deps.rateLimitOptions,
  });
  if (result.kind === "stopped") {
    return {
      kind: "stopped",
      arm: deps.arms[0].arm,
      message: `latent: arm ${deps.arms[0].arm} stopped below minimum (cued ${result.counts.cued}, uncued ${result.counts.uncued}) — run paused, resume to retry`,
    };
  }
  const summaryDigests: Record<string, string> = {};
  for (const { arm, c } of compactions) summaryDigests[arm] = summaryDigest(c?.summary ?? "");
  const pool: LatentPoolFile = {
    mode: "shared",
    arm: null,
    tailStartsAtEntryId: anchor,
    summaryDigests,
    probes: [...result.pool],
  };
  writeLatentPool(poolPath, pool);
  log.info(`latent: shared set authored — ${pool.probes.length} probes → ${poolPath}`);
  const pools: Partial<Record<ArmId, LatentPoolFile>> = {};
  for (const { arm } of compactions) pools[arm] = pool;
  return { kind: "done", pools, reAuthored: compactions.map((c) => c.arm) };
}

/** The stage entry: dispatch by mode ("off" is handled by the caller). */
export function runLatentStage(deps: LatentStageDeps, mode: "per-arm" | "shared"): Promise<LatentStageResult> {
  return mode === "per-arm" ? runLatentStagePerArm(deps) : runLatentStageShared(deps);
}

/** The arm's ACTIVE latent probes from the persisted pools (the probe + scoring
 *  phases read them from disk — [] when off or no pool exists). */
export function activeLatentForArm(
  runPath: string,
  mode: "off" | "per-arm" | "shared",
  arm: ArmId,
): readonly LatentProbe[] {
  if (mode === "off") return [];
  const path = mode === "per-arm" ? join(runPath, `latent-pool-${arm}.json`) : join(runPath, "latent-pool.json");
  if (!existsSync(path)) return [];
  return activeLatentProbes(readLatentPool(path).probes, mode === "per-arm" ? "per-arm" : "shared", arm);
}

/** A digest of the run's ACTIVE latent probes (scored-arm-keyed). Part of the
 *  verdict-journal fingerprint: any pool change (re-author, mode switch, activation
 *  flip) restarts the journal so stale probe verdicts are never replayed. null when
 *  the map is empty (off mode / all probes inactive) — no latent samples exist. */
export function latentProbesDigest(latent: ReadonlyMap<string, LatentProbe>): string | null {
  if (latent.size === 0) return null;
  const canonical = [...latent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, p]) => `${key}\u0000${p.id}\u0000${p.probeClass}\u0000${p.accept.join("\u0001")}\u0000${p.question}`)
    .join("\u0002");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Delete an arm's latent probe branches + session files after its pool was
 *  re-authored: pool ids restart at l1, so the OLD l-branches/sessions would
 *  otherwise be mistaken for the new probes' on resume (stale answers replayed for
 *  questions that were never asked). The `-probe-l` name segment matches ONLY
 *  latent probe artifacts (manifest probes are positional numbers). */
export function purgeLatentProbeArtifacts(
  repo: string,
  sessionsDir: string,
  arms: readonly { arm: ArmId; branch: string }[],
): void {
  for (const { branch } of arms) {
    // The session file name is the sanitized branch (see branchSessionFile) — derive
    // the prefix from it so the purge matches exactly what runProbes wrote.
    const sanitized = basename(branchSessionFile(sessionsDir, branch)).replace(/\.jsonl$/, "");
    const prefix = `${sanitized}-probe-l`;
    for (const b of listBranches(repo, `${branch}-probe-l*`)) {
      resetBranch(repo, b);
    }
    for (const f of readdirSync(sessionsDir)) {
      if (f.startsWith(`${prefix}`) && f.endsWith(".jsonl")) {
        rmSync(join(sessionsDir, f));
        log.info(`latent: purged stale probe session ${f}`);
      }
    }
  }
}
