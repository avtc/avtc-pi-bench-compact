// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run driver: owns run identity (date/id/cfgId), sets the run-state
// eagerly (so the live-progress widget can show it), persists the run-config
// snapshot, dispatches Phase-1, and applies stop-and-surface on a Phase-1 halt.
//
// Tasks 13a/13b append Phase-2 (continuation + probes) + Phase-3 (scoring) calls
// after Phase-1 succeeds. This module is the single entry point for a bench run.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SwitchContext } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import { buildCfgId } from "../storage/branches.js";
import { writeRunConfig } from "../storage/configs.js";
import { benchRoot } from "../storage/paths.js";
import {
  type ArmBase,
  buildRunConfig,
  type Phase1Ops,
  Phase1StoppedError,
  type Phase1StopReason,
  runPhase1,
} from "./phase1.js";
import { setRunState, updateRunState } from "./run-state.js";

/** Inputs to {@link startRun}. `now`/`phase1`/`notify` are injectable seams for testing. */
export interface StartRunDeps {
  pi: ExtensionAPI;
  cmdCtx: ExtensionCommandContext;
  switchCtx: SwitchContext;
  config: BenchConfig;
  /** The prepared scenario repo path (Phase-0 frozen backup + project files on `main`). */
  scenarioRepo: string;
  /** Bench root override (default = `benchRoot(config.outputDir)`). */
  root?: string;
  /** Clock seam (default real). The run's calendar date is derived from this. */
  now?: () => Date;
  /** Operator-attention channel (e.g. `ctx.ui.notify`). Invoked on stop-and-surface. */
  notify?: (message: string) => void;
  /** Injectable Phase-1 (default = real {@link runPhase1}). Tests stub it. */
  phase1?: typeof runPhase1;
  /** Phase-1 ops seams (passed through to the real `runPhase1`). */
  ops?: Partial<Phase1Ops>;
  /** Tool-version resolver (default = real filesystem resolution). Tests inject a fake. */
  versionResolver?: VersionResolver;
}

/** Discriminated result of a run. Phase-2/3 (Tasks 13a/13b) extend the done branch. */
export type RunResult =
  | { kind: "phase1-done"; bases: ArmBase[]; runId: string; cfgId: string }
  | { kind: "stopped"; arm: ArmId; reason: Phase1StopReason; message: string; runId: string };

/** UTC calendar date as `YYYY-MM-DD` (fixed across all arms/attempts of a run). */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Next 1-based run id for `date`: counts existing run dirs under `<root>/runs/` whose
 * name starts with `${date}-`. The bench is TUI-primary (one run at a time), so there
 * is no concurrent-run race. Run dirs are created by reporting (Task 17) + Phase-2
 * forking (Task 13a); a first run on a date with no prior dirs yields id 1.
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
 * the run-state to `phase-1`, runs Phase-1, and on success advances to `phase-2`
 * (Tasks 13a/13b continue from there). On a Phase-1 stop, records the reason, notifies
 * the operator, and returns `{ kind: "stopped" }` — never auto-retries (§3.8).
 */
export async function startRun(deps: StartRunDeps): Promise<RunResult> {
  const root = deps.root ?? benchRoot(deps.config.outputDir);
  const now = deps.now ?? (() => new Date());
  const date = utcDate(now());
  const id = nextRunId(root, date);
  const runId = `${date}-${id}`;

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
  try {
    const bases = await phase1({
      pi: deps.pi,
      cmdCtx: deps.cmdCtx,
      switchCtx: deps.switchCtx,
      config: deps.config,
      scenarioRepo: deps.scenarioRepo,
      date,
      id,
      cfgId,
      toolVersions: runConfig.toolVersions,
      ops: deps.ops,
    });
    // Phase-2 (continuation + probes) + Phase-3 (scoring) are appended by Tasks 13a/13b.
    updateRunState({ phase: "phase-2" });
    return { kind: "phase1-done", bases, runId, cfgId };
  } catch (err) {
    if (err instanceof Phase1StoppedError) {
      const { arm, reason, message } = err;
      updateRunState({ lastStopReason: message });
      deps.notify?.(`bench-compact stopped (arm ${arm}): ${message}`);
      log.warn(`run ${runId} stopped: arm ${arm} ${reason} — ${message}`);
      return { kind: "stopped", arm, reason, message, runId };
    }
    throw err;
  }
}
