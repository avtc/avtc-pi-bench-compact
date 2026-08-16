// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:prepare-scenario` command. Thin wrapper: parse args,
// preflight, compute the scenario id + paths, then call `prepareScenario`.
// All orchestration lives in prepare.ts for reuse by the `run <idea>` Phase-0 entry point.
//
// The live seam construction (driveAndCapture via SimulatorDriver, trialCompact via
// ctx.compact, author via runAuthoringAgent) is `buildDeps` — injectable so the
// command is testable; registerBenchCommands wires `defaultBuildPrepareDeps`, which
// assembles the seams via `buildLiveSeams` (src/production/live-seams.ts).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import {
  beginPrepare,
  endPrepare,
  getPrepareAbortSignal,
  isPrepareInFlight,
  isRunInFlight,
} from "../orchestrate/run-state.js";
import { SurfaceConditionsError } from "../production/build.js";
import { LANDING_FILE, type LandingState, readLandingState } from "../production/landing-state.js";
import { buildLiveSeams } from "../production/live-seams.js";
import { type PrepareDeps, prepareScenario as prepareScenarioImpl } from "../production/prepare.js";
import { buildPlantInstruction } from "../simulator/condition-topics.js";
import { benchRoot, scenarioDir } from "../storage/paths.js";
import { askOperator } from "../ui/ask.js";
import { getActiveWidget, setActiveWidget, type WidgetPort } from "../widget/active-widget.js";
import { makeTuiWidgetDeps, NO_DETAIL, WidgetController } from "../widget/tracker.js";
import { type PrepareArgs, parsePrepareArgs } from "./parse.js";
import { preflight } from "./validate.js";

/** Compute a deterministic scenario id from the parsed args. */
export function computeScenarioId(parsed: {
  idea?: string;
  fromSession?: string;
  plantFrom?: string;
  skipFrom?: string;
}): string {
  if (parsed.plantFrom ?? parsed.skipFrom) {
    // recovery modes: the scenario folder of the surfaced prepare (its basename).
    return basename(parsed.plantFrom ?? parsed.skipFrom ?? "");
  }
  if (parsed.fromSession) {
    // extract: derive from the session file basename (strip extension).
    return basename(parsed.fromSession).replace(/\.[^.]+$/, "");
  }
  // build: hash the idea (deterministic — same idea → same id → reuse scenario folder).
  return createHash("sha256")
    .update(parsed.idea ?? "")
    .digest("hex")
    .slice(0, 8);
}

/** Injectable deps for {@link makePrepareScenarioHandler}. */
export interface PrepareScenarioHandlerOptions {
  /** The prepare orchestrator (default: the real `prepareScenario`). */
  readonly prepareScenario?: typeof prepareScenarioImpl;
  /** Build the PrepareDeps from the parsed args + ctx (computes paths + seams).
   *  The default (`defaultBuildPrepareDeps`) assembles the live seams via `buildLiveSeams`;
   *  tests inject a fake. (The widget reaches the seams via the active-widget global,
   *  set by the handler before buildDeps runs.) */
  readonly buildDeps: (ctx: unknown, parsed: PrepareArgs, scenarioId: string) => PrepareDeps;
  /** Construct the live-progress widget (default: {@link makePrepareWidget}). Tests inject a capturing widget. */
  readonly makeWidget?: (ctx: unknown) => WidgetPort;
  /** Construct the shorthand path's prepare widget (default: same {@link makePrepareWidget}). */
  readonly makePrepareWidget?: (ctx: unknown) => WidgetPort;
}

/** Construct the prepare-scenario live-progress widget (TUI-only; inert when non-TUI). */
export function makePrepareWidget(ctx: unknown): WidgetPort {
  const c = ctx as {
    mode?: string;
    hasUI?: boolean;
    ui?: { setWidget: (key: string, content: unknown, opts: { placement: string }) => void };
  };
  return new WidgetController(
    makeTuiWidgetDeps({
      mode: c?.mode ?? "",
      hasUI: c?.hasUI ?? false,
      ui: c?.ui as unknown as { setWidget: (key: string, content: unknown, opts: { placement: string }) => void },
    }),
    {},
  );
}

/** Build the handler for `/bench-compact:prepare-scenario`. */
export function makePrepareScenarioHandler(opts: PrepareScenarioHandlerOptions) {
  const prepare = opts.prepareScenario ?? prepareScenarioImpl;
  return async (args: string, ctx: unknown): Promise<void> => {
    const ctxTyped = ctx as {
      mode?: string;
      hasUI?: boolean;
      ui?: { notify: (m: string, l: string) => void };
    };
    // Capture the UI surface EAGERLY: prepare's build/extract work switchSessions
    // (driveAndCapture, trialCompact, author), which invalidates the command ctx's
    // guarded getters — a lazy ctx.ui read at notify time would throw "stale".
    // The uiContext OBJECT itself is host-level + stays live across session switches.
    const ui = ctxTyped?.ui;
    const notify = (msg: string, level: "info" | "warning" | "error"): void => {
      ui?.notify(msg, level);
    };

    const parsed = parsePrepareArgs(args);
    if (parsed.error !== undefined) {
      notify(parsed.error, "warning");
      return;
    }
    const check = preflight(getBenchConfig(), "prepare", parsed, existsSync);
    if (!check.ok) {
      notify(check.reason, "warning");
      return;
    }
    // Same concurrency rule as the run commands: prepare's drive/extract switchSessions
    // the ONE main pi session — refuse while a bench run OR another prepare is
    // in-flight (interleaved switchSessions + git would corrupt both).
    if (isRunInFlight()) {
      notify(
        "a bench run is already active — /bench-compact:status shows it; /bench-compact:abort stops it",
        "warning",
      );
      return;
    }
    if (isPrepareInFlight()) {
      notify("a bench prepare is already active — /bench-compact:abort stops it", "warning");
      return;
    }

    // Construct + show the live-progress widget (TUI-only; inert when non-TUI).
    const widget = (opts.makeWidget ?? makePrepareWidget)(ctx);
    setActiveWidget(widget);
    // Extract mode skips the build drive (session provided) → start at 'extract' BEFORE show
    // so the first paint is ■◧□□□□ extract (build already ■), not a brief build flash.
    if (parsed.fromSession !== undefined) widget.startPhase("extract", NO_DETAIL);
    widget.show();

    const scenarioId = computeScenarioId(parsed);
    // Guard the WHOLE prepare window (the run-state only appears later, inside
    // startRun): every exit path clears the flag — surface, failure, success. The
    // window's abort signal is threaded into the build seams, so /bench-compact:abort
    // genuinely stops a live prepare (its finally clears the guard).
    beginPrepare(); // registers the window's abort controller (read by defaultBuildPrepareDeps)
    try {
      let current = parsed;
      for (let round = 0; round < MAX_SURFACE_ROUNDS; round += 1) {
        try {
          const deps = opts.buildDeps(ctx, current, scenarioId);
          const result = await prepare(deps);
          widget.setStatus("prepared", `/bench-compact:run-scenario ${result.repoPath}`);
          notify(`prepared scenario ${scenarioId}: ${result.repoPath}`, "info");
          return;
        } catch (err) {
          if (!(err instanceof SurfaceConditionsError)) throw err;
          widget.setStatus("stopped", "/bench-compact:prepare-scenario");
          const choice = await askRecoveryChoice(ctxTyped, err);
          if (choice === null || choice === "start-over") {
            // dismissed / start over: the notify is best-effort context (pi's notify
            // slot is ephemeral); landing.json + the log carry the durable state.
            const folder = scenarioDir(benchRoot(getBenchConfig().outputDir), scenarioId);
            notify(surfaceConditionsMessage(err, folder), "error");
            return;
          }
          current = surfaceRecoveryArgs(current, scenarioId, err, choice);
        }
      }
      notify("prepare stopped — too many recovery rounds; see the log", "error");
    } catch (err) {
      widget.setStatus("stopped", "/bench-compact:prepare-scenario");
      const msg = err instanceof Error ? err.message : String(err);
      notify(`prepare failed: ${msg}`, "error");
    } finally {
      endPrepare();
    }
  };
}

/** Ask the recovery choice with graceful degradation: the modal dialog when the ctx
 *  has a select surface (TUI), else the plain notify (non-TUI modes). */
export async function askRecoveryChoice(
  ctx: { mode?: string; ui?: Record<string, unknown> },
  err: SurfaceConditionsError,
): Promise<SurfaceChoice | null> {
  const select = ctx?.ui?.select as
    | ((title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>)
    | undefined;
  if (ctx?.mode === "tui" && typeof select === "function") {
    return askSurfaceAction({ select }, err);
  }
  return null;
}

/** Recovery rounds per prepare invocation (each surface may plant or skip once —
 *  bounded so a pathological loop cannot chain recoveries forever). */
const MAX_SURFACE_ROUNDS = 3;

/** The operator's choice when a prepare surfaces missing condition topics. */
export type SurfaceChoice = "plant" | "skip" | "start-over";

/** Dialog labels (protected text). */
const SURFACE_CHOICE_PLANT = "plant + continue";
const SURFACE_CHOICE_SKIP = "skip safe-to-skip topics";
const SURFACE_CHOICE_START_OVER = "start over";

/** Ask the operator how to recover a surfaced prepare — an interactive MODAL dialog
 *  (coordinated via the dialog queue + attention-pinged via pi-notification), NOT a
 *  notify: pi's notify slot is single-message and gets overwritten by pi's own
 *  banners (e.g. "Resumed session" fires while the prepare unwinds). Resolves with
 *  the choice, or `null` when dismissed / the dialog surface is unavailable. */
export async function askSurfaceAction(
  ui: { select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined> },
  err: SurfaceConditionsError,
): Promise<SurfaceChoice | null> {
  const labels = err.action.missing.map((t) => t.label).join(", ");
  const options = [SURFACE_CHOICE_PLANT];
  if (err.action.skipOffered) options.push(SURFACE_CHOICE_SKIP);
  options.push(SURFACE_CHOICE_START_OVER);
  const choice = await askOperator(ui, {
    source: "bench-compact",
    detail: `condition topics missing: ${labels}`,
    title: `prepare stopped — missing topics: ${labels}`,
    options,
  });
  if (choice === SURFACE_CHOICE_PLANT) return "plant";
  if (choice === SURFACE_CHOICE_SKIP) return "skip";
  if (choice === SURFACE_CHOICE_START_OVER) return "start-over";
  return null; // dismissed or unavailable
}

/** Build the recovery PrepareArgs from a surfaced choice (plant → resume + steer the
 *  missing topics in; skip → drop the safeToSkip topics + freeze without re-build). */
export function surfaceRecoveryArgs(
  parsed: PrepareArgs,
  scenarioId: string,
  err: SurfaceConditionsError,
  choice: SurfaceChoice,
): PrepareArgs {
  const folder = scenarioDir(benchRoot(getBenchConfig().outputDir), scenarioId);
  if (choice === "plant") return { ...parsed, plantFrom: folder };
  const safeIds = err.action.missing.filter((t) => t.tag === "safeToSkip").map((t) => t.id);
  return { ...parsed, skipFrom: folder, skipTopics: safeIds };
}

/** The recovery-notify for a surfaced prepare: names the missing topics + the three
 *  options (plant + continue / start over / skip safeToSkip only). */
export function surfaceConditionsMessage(err: SurfaceConditionsError, scenarioFolder: string): string {
  const labels = err.action.missing.map((t) => t.label).join(", ");
  const safeLabels = err.action.missing
    .filter((t) => t.tag === "safeToSkip")
    .map((t) => t.label)
    .join(", ");
  const safeIds = err.action.missing
    .filter((t) => t.tag === "safeToSkip")
    .map((t) => t.id)
    .join(",");
  const opening = err.action.skipOffered
    ? `prepare stopped — only safe-to-skip topics are missing: ${labels}.`
    : `prepare stopped — essential condition topics did not land in the compacted-away span: ${labels}.`;
  const skipClause =
    safeIds.length > 0
      ? `(c) skip — /bench-compact:prepare-scenario --skip-topics ${safeIds} --from ${scenarioFolder} (safe-to-skip only: ${safeLabels}).`
      : "(c) skip — not available (no safe-to-skip topics among the missing).";
  return `${opening} Options: (a) plant + continue — /bench-compact:prepare-scenario --plant ${scenarioFolder}; (b) start over — re-run /bench-compact:prepare-scenario <idea>; ${skipClause}`;
}

/** The default buildDeps for registerBenchCommands — computes paths from the bench
 *  root + assembles the live BuildSeams (driveAndCapture via SimulatorDriver,
 *  trialCompact via ctx.compact, author via runAuthoringAgent) bound to the command
 *  ctx. Extract mode reuses trialCompact + author (driveAndCapture unused). */
/** The plant-resume restarts one attempt PAST the surfaced one (pacing must
 *  see headroom above the usage the surfaced attempt already reached). */
const RESUME_ATTEMPT_OFFSET = 1;

export function defaultBuildPrepareDeps(ctx: unknown, parsed: PrepareArgs, scenarioId: string): PrepareDeps {
  const config = getBenchConfig();
  const root = benchRoot(config.outputDir);
  // Recovery modes (--plant <folder> / --from <folder>) target an EXISTING scenario
  // folder written by the surfaced prepare — derive every path from that folder (same
  // layout the fresh flow created). Fresh modes derive from benchRoot + scenarioId.
  const recoveryFolder = parsed.plantFrom ?? parsed.skipFrom;
  const scenarioFolder = recoveryFolder ?? scenarioDir(root, scenarioId);
  const repo = join(scenarioFolder, "repo");
  const sessionsDir = join(scenarioFolder, "sessions");
  const manifestPath = join(scenarioFolder, "manifest.json");
  const preSliceDir = join(scenarioFolder, PRE_SLICE_DIR_NAME);
  mkdirSync(repo, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(preSliceDir, { recursive: true });

  const cmdCtx = ctx as ExtensionCommandContext;
  const compactionPlan = parsed.fromSession !== undefined ? EXTRACT_PLAN : BUILD_PLAN;
  const plantState =
    parsed.plantFrom !== undefined ? readLandingState(join(parsed.plantFrom, LANDING_FILE)) : undefined;
  const skipState = parsed.skipFrom !== undefined ? readLandingState(join(parsed.skipFrom, LANDING_FILE)) : undefined;
  const scenarioDescription = plantState?.scenario ?? parsed.idea ?? scenarioId;
  // The handler sets the active widget before buildDeps; the seams read it for build/extract ctx/tok.
  const widget = getActiveWidget();
  const { holder, ...seams } = buildLiveSeams({
    cmdCtx,
    config,
    repoPath: repo,
    preSliceDir,
    scenarioId,
    scenarioDescription,
    compactionPlan,
    widget,
    signal: getPrepareAbortSignal(),
  });

  const deps: PrepareDeps = {
    compactionBoundary: config.compactionBoundary,
    repoPath: repo,
    sessionsDir,
    manifestPath,
    preSliceDir,
    seams,
    liveCtx: holder,
    force: parsed.force,
    ...(parsed.fromSession !== undefined
      ? {
          fromSessionPath: parsed.fromSession,
          extractOutputPath: join(preSliceDir, EXTRACT_BACKUP_NAME),
          extractCwd: process.cwd(),
        }
      : plantState !== undefined
        ? {
            scenario: plantState.scenario,
            resume: {
              // ONE PAST the surfaced attempt: the surfaced drive stopped because the
              // session's usage crossed attempt N's pacing target — restarting at N
              // would pace-stop immediately (before the plant instruction is ever
              // consulted); N+1 grows the target one continue-step above the reached
              // usage, so the first resumed cycle continues + plants.
              attempt: plantState.attempt + RESUME_ATTEMPT_OFFSET,
              plantInstruction: buildPlantInstruction(plantState.missingTopics.map((t) => t.id)),
            },
          }
        : parsed.skipFrom !== undefined
          ? {
              scenario: skipState?.scenario,
              skipRecovery: { topics: parsed.skipTopics ?? [], state: skipState as LandingState },
            }
          : { scenario: parsed.idea }),
  };
  return deps;
}

/** Sub-directory under the scenario dir for the pre-slice temp files (OUTSIDE the repo). */
const PRE_SLICE_DIR_NAME = "pre-slice";
/** Manifest compaction-boundary plan tag for build mode. */
const BUILD_PLAN = "build";
/** Manifest compaction-boundary plan tag for extract mode. */
const EXTRACT_PLAN = "extract";
/** Filename for the extract-mode cleaned backup (under preSliceDir). */
const EXTRACT_BACKUP_NAME = "extract-backup.jsonl";

/** Register the prepare-scenario command on `pi`. */
export function registerPrepareScenarioCommand(pi: ExtensionAPI): void {
  pi.registerCommand("bench-compact:prepare-scenario", {
    description: "Prepare a scenario (build from <idea> or extract --from-session).",
    handler: makePrepareScenarioHandler({ buildDeps: defaultBuildPrepareDeps }),
  });
}
