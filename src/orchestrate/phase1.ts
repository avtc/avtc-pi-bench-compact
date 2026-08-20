// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-1 orchestration: compact the frozen pre-compaction backup ONCE PER ARM,
// producing each arm's compacted base branch (the Phase-2 fork point).
//
// configure-API model: each arm is isolated in-place via
// `configureArm` — write the arm's observational-memory + memkeeper config, call
// each extension proxy's `reloadConfig()`, and set the tool allowlist. NO
// `ctx.reload()`, so the command ctx stays valid across the whole inline for-loop
// (reload would invalidate it with no `withSession`, breaking a per-arm loop). One
// process runs every arm; only the per-arm config + active tool set change.
//
// Per arm: configureArm → fork main→arm-base → checkout → loadSession(inject
// ANTI_PEEK + re-set the allowlist after the switch + triggerCompact) → commit. The
// compaction's `usage` (every arm patched to emit per-stage usage; the bare-pi arm
// emits natively) + bench-timed `wallMs` flow into the run's compaction-cost record.
//
// Stop-and-surface: an arm-cancel (CompactionCancelledError) or a degenerate empty
// summary HALTS the run — the operator inspects + decides. No auto-retry, no silent
// skip. Surfaced via {@link Phase1StoppedError}; the run driver catches + notifies.

import { existsSync } from "node:fs";
import type { CompactionEntry, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ARM_DEFS } from "../arms/definitions.js";
import { isolateArmOrStop } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, resolveToolVersion, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { judgeEnsembleFields } from "../config/types.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { appendUserEntry } from "../production/live-seams.js";
import { CompactionCancelledError, triggerCompact } from "../session/compact.js";
import { copySessionFork } from "../session/fork.js";
import { loadSession } from "../session/switch.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { buildArmBaseBranch, type RunConfig, type ToolVersion } from "../storage/branches.js";
import { branchSessionFile } from "../storage/paths.js";
import type { Phase1Walls } from "../storage/phase1-walls.js";
import { writePhase1Walls } from "../storage/phase1-walls.js";
import {
  branchExists,
  checkout,
  commitAll,
  commitCountAhead,
  forkBranch,
  newestBranches,
  resetBranch,
} from "../storage/repo.js";
import type { WidgetPort } from "../widget/active-widget.js";
import { NO_DETAIL } from "../widget/tracker.js";
import { getBenchPi } from "./bench-ctx.js";
import { getRunState, updateRunState } from "./run-state.js";

/** One arm's compacted base (Phase-1 result). Consumed by Phase-2 forking. */
export interface ArmBase {
  arm: ArmId;
  /** Branch-name `{tool}` token: `bare-pi` · `om-default` · … */
  tool: string;
  /** Short tool-version token (`g<6hex>`/`npm<ver>`); `undefined` for the bare-pi arm (omitted from branch name). */
  ver: string | undefined;
  /** The run-config fingerprint `cfg-<hex>` (shared across all arms of this run). */
  cfgId: string;
  /** The arm compacted-base branch (Phase-2 fork point). */
  branch: string;
  /** Bench-timed compaction wall-clock (ms). Carried into the compaction-cost metric (the JSONL has no duration). */
  wallMs: number;
  /** Per-stage LLM usage from the compaction; `undefined` only if the arm emitted none. */
  usage: CompactionEntry["usage"];
}

/** Why Phase-1 halted on an arm (stop-and-surface). */
export type Phase1StopReason = "cancelled" | "empty-summary" | "config-failed" | "branch-conflict";

/** Thrown/recorded when Phase-1 must stop-and-surface. The run driver catches it,
 *  records `lastStopReason`, notifies the operator, and yields — never auto-retries. */
export class Phase1StoppedError extends Error {
  readonly arm: ArmId;
  readonly reason: Phase1StopReason;
  constructor(arm: ArmId, reason: Phase1StopReason, message: string) {
    super(message);
    this.name = "Phase1StoppedError";
    this.arm = arm;
    this.reason = reason;
  }
}

/** Injectable operations — the I/O / non-deterministic seams. `configureArm` is NOT
 *  here: it is imported + always real (a pure write+reload+setActiveTools the tests
 *  exercise directly). Defaults are the real implementations; tests inject fakes. */
export interface Phase1Ops {
  trigger: typeof triggerCompact;
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  commit: typeof commitAll;
  /** Check whether a branch already exists (foreign-branch conflict detection). Injectable
   *  for testing; default is the real implementation. */
  branchExists: typeof branchExists;
  /** How many commits a branch has beyond its fork point — the crash-resume completion
   *  discriminator (a committed arm base finished; a bare fork crashed mid-arm). */
  commitCountAhead: typeof commitCountAhead;
  /** Delete a branch ref (crash-resume: discard an uncommitted leftover before re-fork). */
  deleteBranch: typeof resetBranch;
  /** Path-existence checker (crash-resume: the arm's session file must exist to skip). */
  exists: (path: string) => boolean;
  /** Branch matches for a glob, newest-commit first (the --reuse-bases fallback
   *  scans older-version base candidates; the caller shape-filters base branches). */
  newestBranches: typeof newestBranches;
  /** Seed a branch's session file by copying its parent's (parallel to forking the git branch). */
  copySeed: (src: string, dest: string) => void;
  /** Append the anti-peek user entry to the arm session file (post-copy, pre-load —
   *  NO agent turn fires, so the entry stays LAST and inside the compaction tail). */
  appendAntiPeek: (sessionPath: string, text: string) => void;
}

const DEFAULT_OPS: Phase1Ops = {
  trigger: triggerCompact,
  loadSession,
  fork: forkBranch,
  checkout,
  commit: commitAll,
  branchExists,
  commitCountAhead,
  deleteBranch: resetBranch,
  exists: existsSync,
  newestBranches,
  copySeed: copySessionFork,
  appendAntiPeek: (sessionPath, text) => appendUserEntry(sessionPath, text, {}),
};

/** Inputs to {@link runPhase1}. `cfgId` is pre-computed by the run driver
 *  ({@link buildRunConfig} + `buildCfgId`) so run-state can be set eagerly.
 *
 *  The fresh `pi` + memory proxies are NOT passed in — `switchSession` invalidates
 *  the command-handler `pi`/ctx, so `runPhase1` reads the FRESH `pi` + proxies from
 *  `globalThis` (stashed by `activate`, refreshed on each re-activation) INSIDE each
 *  `withSession` callback (see `bench-ctx.ts`). Only the starting `cmdCtx` is passed
 *  (the first arm's `switchSession`); subsequent arms use the fresh ctx threaded
 *  from each `withSession`. */
export interface Phase1Deps {
  /** The command context that starts the inline loop (the first arm's `switchSession`).
   *  Each arm's `switchSession` invalidates the prior ctx, so `runPhase1` threads the
   *  fresh ctx from each `withSession` callback into the next arm's `switchSession`. */
  cmdCtx: ExtensionCommandContext;
  /** The scenario repo path (holds `main` + per-arm branches; tracks ONLY project files — the
   *  session transcript lives in {@link Phase1Deps.sessionsDir}. Agent cwd = repo). */
  scenarioRepo: string;
  /** The per-branch session-transcript store (sibling of the repo; agent-invisible). Each
   *  arm's session file is seeded from `main`'s + compacted in place by {@link runPhase1}. */
  sessionsDir: string;
  /** Calendar date the run started (UTC YYYY-MM-DD; fixed across arms). */
  date: string;
  /** 1-based run id for `date`. */
  id: number;
  /** Pre-computed run-config fingerprint (`cfg-<hex>`) — shared across all arms of this run. */
  cfgId: string;
  /** Per-arm resolved tool versions (from {@link buildRunConfig}; the bare-pi arm is absent). */
  toolVersions: Partial<Record<ArmId, ToolVersion>>;
  /** OM-full arm's threshold value (from bench config). */
  omFullReflectionThresholdTokens: number;
  /** The operator's global memkeeper settings, merged under the arm pins at every
   *  configureArm (read once by the run driver; absent → pins only). */
  memkeeperGlobalSettings?: Record<string, unknown>;
  /** Enabled arms in processing order. */
  armsEnabled: ArmId[];
  /** Crash resume: an arm whose base branch is committed + session file exists is
   *  SKIPPED (the base entry reconstructed from the branch) instead of treated as a
   *  foreign-branch conflict. Uncommitted leftovers are deleted + re-compacted. */
  resume?: boolean;
  /** The run's previously-persisted Phase-1 walls (`runs/<runId>/phase1-walls.json`,
   *  read by the run driver) — reconstructed bases recover their compaction wall
   *  (without it the compaction-cost metric renders 0s after a resume). */
  priorWalls?: Phase1Walls;
  /** The walls file's path — each arm's compaction wall is merge-written HERE the
   *  moment the arm finishes (crash durability: a crash mid-phase must not strand an
   *  already-compacted arm's wall in the dying process's memory). */
  wallsPath: string;
  /** --reuse-bases: also reuse a committed base built under an OLDER tool version
   *  when the current version's base branch is absent (skip re-compaction after a
   *  tool fix that did not change compaction behavior). */
  reuseBases?: boolean;
  /** The live-progress widget (TUI-only; null/absent → no-op). */
  widget?: WidgetPort | null;
  /** Injectable seams (defaults = real implementations). */
  ops?: Partial<Phase1Ops>;
}

/**
 * Assemble the run-config snapshot (resolving every enabled arm's tool version; the bare-pi arm → null).
 * Pure transformation of {@link BenchConfig} + a {@link VersionResolver} + the frozen
 * {@link ScenarioManifest}. The run driver calls this once to compute `cfgId`
 * (`buildCfgId(rc)`) + persist the snapshot, then passes `cfgId` + `rc.toolVersions`
 * into {@link runPhase1}.
 */
export function buildRunConfig(
  config: BenchConfig,
  resolver: VersionResolver | null,
  manifest: ScenarioManifest,
): RunConfig {
  const r = resolver ?? DEFAULT_VERSION_RESOLVER;
  const toolVersions: Partial<Record<ArmId, ToolVersion>> = {};
  for (const arm of config.armsEnabled) {
    const tv = resolveToolVersion(arm, r);
    if (tv) toolVersions[arm] = tv;
  }
  return {
    ...judgeEnsembleFields(config),
    evaluatedModel: config.evaluatedModel,
    evaluatedThinkingLevel: config.evaluatedThinkingLevel,
    N: config.N,
    compactionBoundary: config.compactionBoundary,
    armsEnabled: [...config.armsEnabled],
    omFullReflectionThresholdTokens: config.omFullReflectionThresholdTokens,
    backupMode: manifest.backupMode ?? "build", // provenance stamped at freeze time (older scenarios: build)
    fastEval: config.fastEval,
    latentProbes: config.latentProbes,
    toolVersions,
  };
}

/**
 * Run Phase-1: compact the frozen backup once per enabled arm. Returns each arm's
 * compacted base. Throws {@link Phase1StoppedError} on arm-cancel, empty summary, or
 * config-failure; the caller stops + surfaces, never auto-retries.
 *
 * The fresh `pi` + memory proxies are read from `globalThis` INSIDE each `withSession`
 * callback — `switchSession` invalidates the command-handler `pi`/ctx, but its
 * `createRuntime` RE-ACTIVATES the extension (`activate(freshPi)` runs again, stashing
 * the fresh `pi` + proxies via `bench-ctx.ts`/`proxies.ts`). The fresh command ctx from
 * each `withSession` is threaded into the next arm's `switchSession` (switchSession
 * invalidates the ctx it's called on, the same way `reload` does).
 */
export async function runPhase1(deps: Phase1Deps): Promise<Phase1Result> {
  const ops = { ...DEFAULT_OPS, ...deps.ops };
  const {
    cmdCtx,
    scenarioRepo,
    sessionsDir,
    date,
    id,
    cfgId,
    toolVersions,
    omFullReflectionThresholdTokens,
    memkeeperGlobalSettings,
    armsEnabled,
    resume,
    reuseBases,
  } = deps;
  log.info(`phase-1: run ${date}-${id} cfg ${cfgId} arms [${armsEnabled.join(", ")}]`);

  // Thread the command ctx: each arm's switchSession invalidates the ctx it's called
  // on, so the next arm must use the FRESH ctx threaded from this arm's withSession.
  let currentCtx: ExtensionCommandContext = cmdCtx;
  const bases: ArmBase[] = [];
  for (const arm of armsEnabled) {
    const def = ARM_DEFS[arm];
    deps.widget?.setArm(armsEnabled.indexOf(arm) + 1, armsEnabled.length, def.tool);
    deps.widget?.setDetail(NO_DETAIL);
    const tv = toolVersions[arm] ?? null;
    const ver = tv?.commit;
    const branch = buildArmBaseBranch({ date, id, cfgId, tool: def.tool, ver });

    // Crash resume: a committed base branch + its session file = the arm's Phase-1
    // artifact SURVIVED the crash. Reconstruct the base entry from the branch (the
    // compaction's wallMs/usage live in the crashed process — the boundary data is
    // re-read from the session file by Phase-2 trace capture, so 0/undefined here
    // degrades nothing the metrics read) and skip fork/compact/commit. An
    // UNcommitted branch (or a missing session file) is a half-finished arm —
    // delete the leftover + fall through to the normal compact path.
    const preexisting = ops.branchExists(scenarioRepo, branch);
    if (preexisting && resume === true) {
      const sessionPath = branchSessionFile(sessionsDir, branch);
      if (ops.commitCountAhead(scenarioRepo, branch, "main") > 0 && ops.exists(sessionPath)) {
        bases.push({ arm, tool: def.tool, ver, cfgId, branch, wallMs: deps.priorWalls?.[arm] ?? 0, usage: undefined });
        log.info(`phase-1: arm ${arm} already compacted (resumed) — skip ${branch}`);
        continue;
      }
      ops.deleteBranch(scenarioRepo, branch);
      log.info(`phase-1: arm ${arm} branch ${branch} exists but is not committed — deleted, re-compacting`);
    }

    // --reuse-bases fallback: the CURRENT version's base is absent (the tool version
    // changed since the base was built), but an OLDER-version base for the same arm
    // is committed in this run's namespace — reuse it instead of re-compacting. For
    // tool fixes that did not change compaction behavior the old base is a draw from
    // the same distribution; the reused branch name keeps recording the version it
    // was actually built under. Candidates are newest-commit-first; the shape check
    // keeps only true base branches (attempt `-N` and probe `-probe-N-M` suffixed
    // branches carry later committer dates than their base and must never qualify).
    if (resume === true && reuseBases === true) {
      const baseShape = new RegExp(`^arm-${def.tool}(-g[0-9a-f]+|-npm[0-9][w.]*)?$`);
      const candidates = ops.newestBranches(scenarioRepo, `bench-compact/run-${date}-${id}/${cfgId}/arm-${def.tool}*`);
      const reusable = candidates.find((c) => baseShape.test(c.split("/").pop() ?? ""));
      if (reusable !== undefined) {
        const segment = reusable.split("/").pop() ?? "";
        const reusableVer =
          segment === `arm-${def.tool}` ? undefined : (segment.slice(`arm-${def.tool}-`.length) as string);
        const reusableSession = branchSessionFile(sessionsDir, reusable);
        if (ops.commitCountAhead(scenarioRepo, reusable, "main") > 0 && ops.exists(reusableSession)) {
          bases.push({
            arm,
            tool: def.tool,
            ver: reusableVer,
            cfgId,
            branch: reusable,
            wallMs: deps.priorWalls?.[arm] ?? 0,
            usage: undefined,
          });
          log.info(
            `phase-1: arm ${arm} reusing base ${reusable} (built under ${reusableVer ?? "unversioned"}) — skip compaction`,
          );
          continue;
        }
      }
    }

    // Fork main → arm-base. A pre-existing branch of this name (on a non-resume
    // path — resume deleted its leftover above) is a CONFLICT, not a
    // reusable artifact: branch names embed the runId, and a fresh run never reuses
    // a runId within an output root — an existing branch means a DIFFERENT run
    // derived the same id against this shared scenario repo (e.g. an outputDir
    // change reset the same-day id counter). Stop+surface: silently re-seeding the
    // session + stacking commits on foreign work would corrupt both runs' traces.
    if (preexisting && resume !== true) {
      throw new Phase1StoppedError(
        arm,
        "branch-conflict",
        `branch ${branch} already exists — runId collision with a prior run on this scenario repo. ` +
          `Inspect the repo's bench-compact/* branches or point outputDir at the earlier root.`,
      );
    }
    ops.fork(scenarioRepo, "main", branch);
    ops.checkout(scenarioRepo, branch);
    // Seed this arm's session file from `main`'s (parallel to forking the git branch):
    // the transcript lives in the sessions store (outside the repo), so each arm gets
    // its OWN file, compacted in place by loadSession below.
    const sessionPath = branchSessionFile(sessionsDir, branch);
    ops.copySeed(branchSessionFile(sessionsDir, "main"), sessionPath);
    // Anti-peek as a FILE entry, not a sendUserMessage: sending fires an agent turn
    // whose response lands AFTER the message and can push it out of the compaction
    // tail window (plus a wasted turn of tokens per arm). Appended pre-load, the
    // entry is the session's LAST message — guaranteed inside the kept tail — and
    // the compaction summarizer still reads it.
    ops.appendAntiPeek(sessionPath, ANTI_PEEK_PROMPT);
    if (getRunState() !== null) updateRunState({ currentArm: arm });

    // Load the frozen backup in-place + compact it. switchSession RE-ACTIVATES the
    // extension (fresh pi + proxies stashed in globalThis by activate) AND invalidates
    // the prior ctx — so ALL per-arm work runs INSIDE withSession using the fresh
    // pi/proxies (read from globalThis) + the fresh ctx (the withSession arg). The
    // fresh ctx is threaded into currentCtx for the next arm's switchSession.
    // The anti-peek entry was appended to the file BEFORE this load (last message,
    // inside the tail window). An arm-cancel / config-failure surfaces as a stop —
    // no fallback, no retry.
    let compactionEntry: CompactionEntry;
    let wallMs: number;
    try {
      ({ compactionEntry, wallMs } = await ops.loadSession(currentCtx, sessionPath, async (sessionCtx) => {
        currentCtx = sessionCtx;
        const pi = getBenchPi();
        // Isolate the arm IN-PLACE: write OM+memkeeper config → reloadConfig ×2 (fresh
        // proxies) → setActiveTools (fresh pi). NO ctx.reload().
        isolateArmOrStop(
          pi,
          arm,
          scenarioRepo,
          { omFullReflectionThresholdTokens, memkeeperGlobal: memkeeperGlobalSettings ?? {} },
          `arm ${arm}`,
          (msg) => new Phase1StoppedError(arm, "config-failed", msg),
        );
        return ops.trigger(pi, sessionCtx, {});
      }));
    } catch (err) {
      if (err instanceof Phase1StoppedError) throw err;
      if (err instanceof CompactionCancelledError) {
        throw new Phase1StoppedError(
          arm,
          "cancelled",
          `arm ${arm} compaction was cancelled (${err.message}) — the arm produced no memory. Inspect branch ${branch} and resume or re-prepare.`,
        );
      }
      throw err;
    }

    // Stop-and-surface: degenerate empty summary = the arm produced no usable memory.
    if (compactionEntry.summary.trim().length === 0) {
      throw new Phase1StoppedError(
        arm,
        "empty-summary",
        `arm ${arm} compaction produced an empty/degenerate summary — no usable memory. Inspect branch ${branch} and resume or re-prepare.`,
      );
    }

    // Commit the arm base. Compaction modifies the arm's session file (in the sessions
    // store, outside the repo), so the repo working tree is unchanged — this is an empty
    // `--allow-empty` boundary commit recording the arm-base fork point.
    ops.commit(scenarioRepo, `phase-1: compacted base for arm ${arm} (${def.tool})`);

    // Persist the wall NOW (merge): a crash/resume mid-phase must not strand this
    // arm's wall in the dying process — the durable file is the only wall record
    // (the tokens/$ live on in the compaction entry; the wall has no other home).
    writePhase1Walls(deps.wallsPath, { [arm]: wallMs });

    bases.push({ arm, tool: def.tool, ver, cfgId, branch, wallMs, usage: compactionEntry.usage });
    log.info(`phase-1: arm ${arm} compacted (${wallMs}ms) → ${branch}`);
  }

  return { bases, finalCtx: currentCtx };
}

/** {@link runPhase1} result: the arm bases + the FINAL fresh command ctx (threaded through
 * the last arm's `withSession`). The run driver threads `finalCtx` into Phase-2 so the
 * first continuation's `switchSession` doesn't throw "stale after session replacement"
 * (Phase-1's first arm already invalidated the original `cmdCtx`). */
export interface Phase1Result {
  readonly bases: ArmBase[];
  readonly finalCtx: ExtensionCommandContext;
}
