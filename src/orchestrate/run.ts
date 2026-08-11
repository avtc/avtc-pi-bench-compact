// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run driver: owns run identity (date/id/cfgId), sets the run-state
// eagerly (so the live-progress widget can show it), persists the run-config
// snapshot, dispatches Phase-1 (inline — no cross-reload driver), and applies
// stop-and-surface on a Phase-1 halt.
//
// configure-API model: the proxies (observational-memory + memkeeper) are cached
// at activate (proxies.ts) and threaded into Phase-1, which reconfigures each arm
// in-place (no `ctx.reload()`). startRun awaits Phase-1 and returns the bases (or
// a stopped result). Tasks 13a/13b append Phase-2 (continuation + probes) + Phase-3
// (scoring) after Phase-1 succeeds.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_VERSION_RESOLVER, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { buildCfgId } from "../storage/branches.js";
import { writeRunConfig } from "../storage/configs.js";
import { benchRoot, runDir } from "../storage/paths.js";
import {
  type ArmBase,
  buildRunConfig,
  type Phase1Ops,
  Phase1StoppedError,
  type Phase1StopReason,
  runPhase1,
} from "./phase1.js";
import { Phase2StoppedError, type Phase2StopReason, runContinuations } from "./phase2.js";
import { setRunState, updateRunState } from "./run-state.js";
import type { RunTrace } from "./trace.js";

/** Inputs to {@link startRun}. `now`/`notify`/`phase1`/`continuations`/`ops` are injectable seams for testing. */
export interface StartRunDeps {
  /** The run command's context (the first arm's `switchSession`). `runPhase1` threads
   *  the fresh ctx from each `withSession` across arms — `switchSession` invalidates
   *  the prior ctx the same way `reload` does, so only the FIRST arm's ctx comes from
   *  the command handler; the rest come from the re-activation. The fresh `pi` +
   *  memory proxies are read from `globalThis` inside each `withSession` (bench-ctx.ts). */
  cmdCtx: ExtensionCommandContext;
  config: BenchConfig;
  /** The prepared scenario repo path (Phase-0 frozen backup + project files on `main`). */
  scenarioRepo: string;
  /** The scenario manifest (seeds the Phase-2 simulator's system prompt). */
  manifest: ScenarioManifest;
  /** Bench root override (default = `benchRoot(config.outputDir)`). */
  root?: string;
  /** Clock seam (default real). The run's calendar date is derived from this. */
  now?: () => Date;
  /** Operator-attention channel (e.g. `ctx.ui.notify`). Invoked on stop-and-surface. */
  notify?: (message: string) => void;
  /** Injectable Phase-1 (default = real {@link runPhase1}). Tests stub it. */
  phase1?: typeof runPhase1;
  /** Injectable Phase-2 continuations (default = real {@link runContinuations}). Tests stub it. */
  continuations?: typeof runContinuations;
  /** Phase-1 ops seams (passed through to the real `runPhase1`). */
  ops?: Partial<Phase1Ops>;
  /** Tool-version resolver (default = real filesystem resolution). Tests inject a fake. */
  versionResolver?: VersionResolver;
}

/** Why a run halted (stop-and-surface), across phases. */
export type RunStopReason = Phase1StopReason | Phase2StopReason;

/** Discriminated result of a run. The done branch is Phase-2 (Phase-1 always
 *  proceeds to continuations on success); the stopped branch carries the phase
 *  (attempt is null for a Phase-1 stop, the attempt number for a Phase-2 stop). */
export type RunResult =
  | { kind: "phase2-done"; bases: ArmBase[]; traces: RunTrace[]; runId: string; cfgId: string }
  | {
      kind: "stopped";
      arm: ArmId;
      /** The Phase-2 attempt index, or null for a Phase-1 stop. */
      attempt: number | null;
      reason: RunStopReason;
      message: string;
      runId: string;
    };

/** UTC calendar date as `YYYY-MM-DD` (fixed across all arms/attempts of a run). */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Next 1-based run id for `date`: counts existing run dirs under `<root>/runs/` whose
 * name starts with `${date}-`. The bench is TUI-primary (one run at a time), so there
 * is no concurrent-run race.
 */
function nextRunId(root: string, date: string): number {
  const runsDir = join(root, "runs");
  if (!existsSync(runsDir)) return 1;
  const prefix = `${date}-`;
  let count = 0;
  for (const entry of readdirSync(runsDir)) {
    if (entry.startsWith(prefix)) count++;
  }
  return count + 1;
}

/**
 * Start a bench run. Resolves the run identity, persists the run-config snapshot, sets
 * the run-state to `phase-1`, runs Phase-1 (inline — awaits it), and on success
 *  advances to `phase-2` + runs the Phase-2 continuations. On a Phase-1 or Phase-2
 *  stop, records the reason, notifies the operator, and returns `{ kind: "stopped" }`
 *  — never auto-retries. Phase 2b probes + Phase 3 scoring are appended by later tasks.
 */
export async function startRun(deps: StartRunDeps): Promise<RunResult> {
  const root = deps.root ?? benchRoot(deps.config.outputDir);
  const now = deps.now ?? (() => new Date());
  const date = utcDate(now());
  const id = nextRunId(root, date);
  const runId = `${date}-${id}`;

  // Reserve the run dir immediately: a Phase-1 stop creates no result yet, but the
  // identity is taken — so a same-day retry/scan sees this run + picks the next id.
  mkdirSync(runDir(root, runId), { recursive: true });

  // Resolve the full run config (every arm's tool version) + its fingerprint, ONCE.
  const runConfig = buildRunConfig(deps.config, deps.versionResolver ?? DEFAULT_VERSION_RESOLVER);
  const cfgId = buildCfgId(runConfig);
  writeRunConfig(cfgId, runConfig, root);

  // Set run-state eagerly — the widget + /status reflect it from here on.
  setRunState({
    runId,
    date,
    id,
    cfgId,
    scenarioRepo: deps.scenarioRepo,
    phase: "phase-1",
    currentArm: null,
    currentAttempt: null,
    lastStopReason: null,
  });
  log.info(`run ${runId} started: cfg ${cfgId}, arms [${deps.config.armsEnabled.join(", ")}]`);

  const phase1 = deps.phase1 ?? runPhase1;
  const continuations = deps.continuations ?? runContinuations;
  try {
    const bases = await phase1({
      cmdCtx: deps.cmdCtx,
      scenarioRepo: deps.scenarioRepo,
      date,
      id,
      cfgId,
      toolVersions: runConfig.toolVersions,
      omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
      armsEnabled: deps.config.armsEnabled,
      ops: deps.ops,
    });
    // Phase-1 done → advance to Phase-2 + run the N continuation attempts per arm.
    updateRunState({ phase: "phase-2", currentArm: null, currentAttempt: null });
    const traces = await continuations({
      cmdCtx: deps.cmdCtx,
      armBases: bases,
      config: deps.config,
      manifest: deps.manifest,
      repo: deps.scenarioRepo,
      N: deps.config.N,
    });
    // Phase 2b probes + Phase 3 scoring are appended by later tasks.
    return { kind: "phase2-done", bases, traces, runId, cfgId };
  } catch (err) {
    if (err instanceof Phase1StoppedError) {
      const { arm, reason, message } = err;
      updateRunState({ lastStopReason: message });
      deps.notify?.(`bench-compact stopped (arm ${arm}): ${message}`);
      log.warn(`run ${runId} stopped: arm ${arm} ${reason} — ${message}`);
      return { kind: "stopped", arm, attempt: null, reason, message, runId };
    }
    if (err instanceof Phase2StoppedError) {
      const { arm, attempt, reason, message } = err;
      updateRunState({ lastStopReason: message });
      deps.notify?.(`bench-compact stopped (arm ${arm} attempt ${attempt}): ${message}`);
      log.warn(`run ${runId} stopped: arm ${arm} attempt ${attempt} ${reason} — ${message}`);
      return { kind: "stopped", arm, attempt, reason, message, runId };
    }
    throw err;
  }
}
