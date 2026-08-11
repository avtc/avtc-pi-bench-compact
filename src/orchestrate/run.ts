// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The bench run driver: owns run identity (date/id/cfgId), sets the run-state + the
// phase-1 cursor eagerly (the cursor lives on globalThis + survives the per-arm reloads),
// persists the run-config snapshot, and triggers the FIRST arm's isolation (switchArm →
// reload). Phase-1 then drives itself across reloads via the session_start{reload}
// listener ({@link registerPhase1Driver} in phase1.ts) — startRun does NOT await it.
//
// This is the CR-R1-1 resolution: switchArm's reload invalidates the ctx, so the run
// cannot loop over arms in one synchronous call. Instead the progress lives on globalThis
// + each reload's fresh ctx advances one arm. startRun returns `{ kind: "phase1-started" }`;
// completion is observed via run-state (widget/status) + the cursor's `onDone` hook.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type SwitchContext, switchArm } from "../arms/switch.js";
import { DEFAULT_VERSION_RESOLVER, type VersionResolver } from "../arms/version.js";
import type { ArmId, BenchConfig } from "../config/types.js";
import { log } from "../log.js";
import { buildCfgId } from "../storage/branches.js";
import { writeRunConfig } from "../storage/configs.js";
import { benchRoot, runDir } from "../storage/paths.js";
import {
  type ArmBase,
  buildRunConfig,
  DEFAULT_OPS,
  type Phase1Ops,
  type Phase1RunDeps,
  setPhase1Cursor,
} from "./phase1.js";
import { setRunState } from "./run-state.js";

/** Inputs to {@link startRun}. `now`/`notify`/`onDone`/`ops` are injectable seams for testing. */
export interface StartRunDeps {
  /** The command context for the FIRST arm's switchArm (the original, pre-reload ctx). */
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
  /** Completion hook — Phase-2 (Task 13a) wires its start here; tests resolve a deferred. */
  onDone?: (bases: ArmBase[]) => void;
  /** Phase-1 ops seams (default = real implementations). */
  ops?: Partial<Phase1Ops>;
  /** Tool-version resolver (default = real filesystem resolution). Tests inject a fake. */
  versionResolver?: VersionResolver;
}

/** Discriminated result of a run start. Phase-1 completes asynchronously (across reloads);
 *  observe completion via run-state (`phase-2`) or the `onDone` hook — NOT this return. */
export type RunResult =
  | { kind: "phase1-started"; runId: string; cfgId: string }
  | { kind: "stopped"; arm: ArmId; reason: "switchArm-failed"; message: string; runId: string };

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
 * the run-state to `phase-1`, installs the phase-1 cursor on globalThis, and triggers the
 * FIRST arm's isolation (switchArm → reload). Phase-1 then drives itself across reloads;
 * this function returns `{ kind: "phase1-started" }` immediately. The only synchronous
 * failure mode is the first switchArm throwing before its reload (e.g. a settings write
 * error) — surfaced as `{ kind: "stopped" }`; everything after the first reload is driven
 * + surfaced by the phase-1 driver.
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

  // Install the phase-1 cursor on globalThis (survives the per-arm reloads). The driver
  // (session_start{reload} listener) reads this on each reload to advance one arm.
  const ops: Phase1Ops = { ...DEFAULT_OPS, ...deps.ops };
  const runDeps: Phase1RunDeps = {
    scenarioRepo: deps.scenarioRepo,
    date,
    id,
    cfgId,
    toolVersions: runConfig.toolVersions,
    omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
    ops,
    notify: deps.notify,
    onDone: deps.onDone,
  };
  const arms = deps.config.armsEnabled;
  setPhase1Cursor({ arms: [...arms], nextArmIndex: 0, bases: [], deps: runDeps });
  log.info(`run ${runId} started: cfg ${cfgId}, arms [${arms.join(", ")}]`);

  // Trigger the FIRST arm's isolation. switchArm writes settings + reload() → emits
  // session_start{reload} → the driver compacts arm[0] with the fresh ctx + advances.
  // Fire-and-forget: the driver owns the rest; a pre-reload throw is the only sync failure.
  try {
    await ops.switchArm(deps.switchCtx, arms[0], deps.scenarioRepo, {
      omFullReflectionThresholdTokens: deps.config.omFullReflectionThresholdTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`run ${runId} stopped: first switchArm(arm ${arms[0]}) failed — ${message}`);
    return { kind: "stopped", arm: arms[0], reason: "switchArm-failed", message, runId };
  }

  return { kind: "phase1-started", runId, cfgId };
}
