// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:prepare-scenario` command. Thin wrapper: parse args,
// preflight, compute the scenario id + paths, then call `prepareScenario` (Task 10g).
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
import { buildLiveSeams } from "../production/live-seams.js";
import { type PrepareDeps, prepareScenario as prepareScenarioImpl } from "../production/prepare.js";
import { benchRoot, scenarioDir, scenarioManifest, scenarioRepo } from "../storage/paths.js";
import { getActiveWidget, setActiveWidget, type WidgetPort } from "../widget/active-widget.js";
import { makeTuiWidgetDeps, WidgetController } from "../widget/tracker.js";
import { type PrepareArgs, parsePrepareArgs } from "./parse.js";
import { preflight } from "./validate.js";

/** Compute a deterministic scenario id from the parsed args. */
export function computeScenarioId(parsed: { idea?: string; fromSession?: string }): string {
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
    const notify = (msg: string, level: "info" | "warning" | "error"): void => {
      ctxTyped?.ui?.notify(msg, level);
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

    // Construct + show the live-progress widget (TUI-only; inert when non-TUI).
    const widget = (opts.makeWidget ?? makePrepareWidget)(ctx);
    setActiveWidget(widget);
    widget.show();

    const scenarioId = computeScenarioId(parsed);
    try {
      const deps = opts.buildDeps(ctx, parsed, scenarioId);
      const result = await prepare(deps);
      widget.setStatus("prepared", `/bench-compact:run-scenario ${result.repoPath}`);
      notify(`prepared scenario ${scenarioId}: ${result.repoPath}`, "info");
    } catch (err) {
      widget.setStatus("stopped", "/bench-compact:resume");
      const msg = err instanceof Error ? err.message : String(err);
      notify(`prepare failed: ${msg}`, "error");
    }
  };
}

/** The default buildDeps for registerBenchCommands — computes paths from the bench
 *  root + assembles the live BuildSeams (driveAndCapture via SimulatorDriver,
 *  trialCompact via ctx.compact, author via runAuthoringAgent) bound to the command
 *  ctx. Extract mode reuses trialCompact + author (driveAndCapture unused). */
export function defaultBuildPrepareDeps(ctx: unknown, parsed: PrepareArgs, scenarioId: string): PrepareDeps {
  const config = getBenchConfig();
  const root = benchRoot(config.outputDir);
  const repo = scenarioRepo(root, scenarioId);
  const manifestPath = scenarioManifest(root, scenarioId);
  const preSliceDir = join(scenarioDir(root, scenarioId), PRE_SLICE_DIR_NAME);
  mkdirSync(repo, { recursive: true });
  mkdirSync(preSliceDir, { recursive: true });

  const cmdCtx = ctx as ExtensionCommandContext;
  const compactionPlan = parsed.fromSession !== undefined ? EXTRACT_PLAN : BUILD_PLAN;
  const scenarioDescription = parsed.idea ?? scenarioId;
  // The handler sets the active widget before buildDeps; the seams read it for build/extract ctx/tok.
  const widget = getActiveWidget();
  const seams = buildLiveSeams({
    cmdCtx,
    config,
    repoPath: repo,
    preSliceDir,
    scenarioId,
    scenarioDescription,
    compactionPlan,
    widget,
    signal: PREPARE_SIGNAL,
  });

  const deps: PrepareDeps = {
    compactionBoundary: config.compactionBoundary,
    repoPath: repo,
    manifestPath,
    preSliceDir,
    seams,
    force: parsed.force,
    ...(parsed.fromSession !== undefined
      ? {
          fromSessionPath: parsed.fromSession,
          extractOutputPath: join(preSliceDir, EXTRACT_BACKUP_NAME),
          extractCwd: process.cwd(),
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
/** A never-aborting signal for the prepare flow (no run-level abort wired yet). */
const PREPARE_SIGNAL = new AbortController().signal;

/** Register the prepare-scenario command on `pi`. */
export function registerPrepareScenarioCommand(pi: ExtensionAPI): void {
  pi.registerCommand("bench-compact:prepare-scenario", {
    description: "Prepare a scenario (build from <idea> or extract --from-session).",
    handler: makePrepareScenarioHandler({ buildDeps: defaultBuildPrepareDeps }),
  });
}
