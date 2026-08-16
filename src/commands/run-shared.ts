// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared logic for the three run commands (`run` / `run-scenario` / `run-session-file`):
// resolve the scenario repo + manifest from an operator-supplied folder, load the
// manifest, and the common run tail (`executeRun`) that builds the live-progress
// widget + StartRunDeps and drives `startRun` to completion, notifying the operator
// of the outcome (done → results path; stopped → reason + the resume hint).
//
// The command handlers are thin: parse → preflight → (prepare?) → resolve + load →
// executeRun. The prepare live-seams (build/extract) are shared with the
// `prepare-scenario` command via its `buildDeps` seam.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import type { BenchConfig } from "../config/types.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { manifestStructureError } from "../manifest/validate.js";
import type { RunResult, StartRunDeps } from "../orchestrate/run.js";
import { startRun as startRunImpl } from "../orchestrate/run.js";
import { beginPrepare, endPrepare, isPrepareInFlight, isRunInFlight } from "../orchestrate/run-state.js";
import { SurfaceConditionsError } from "../production/build.js";
import type { PrepareDeps } from "../production/prepare.js";
import { prepareScenario as prepareScenarioImpl } from "../production/prepare.js";
import { benchRoot, scenarioDir } from "../storage/paths.js";
import { getActiveWidget, setActiveWidget } from "../widget/active-widget.js";
import { makeTuiWidgetDeps, WidgetController } from "../widget/tracker.js";
import type { PrepareArgs } from "./parse.js";
import {
  askRecoveryChoice,
  computeScenarioId,
  defaultBuildPrepareDeps,
  makePrepareWidget,
  surfaceConditionsMessage,
  surfaceRecoveryArgs,
} from "./prepare-scenario.js";
import type { CommandArgs, CommandKind } from "./validate.js";
import { preflight } from "./validate.js";

/** A resolved scenario layout: where the git repo + manifest live for a folder. */
export type ScenarioLayout =
  | { readonly ok: true; readonly repoPath: string; readonly manifestPath: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the scenario git-repo path + manifest path from an operator-supplied
 * folder. The folder may be either the scenario directory (holds `manifest.json` +
 * `repo/`) or the repo itself (the path `prepare-scenario` prints — `manifest.json`
 * then lives in the parent). Prefers the scenario-dir interpretation when both
 * candidates exist. Verifies the resolved repo path exists too (a malformed scenario
 * — manifest present but `repo/` missing — fails loudly here, not opaquely deep in the run).
 */
export function resolveScenarioLayout(folder: string, exists: (path: string) => boolean): ScenarioLayout {
  const dirManifest = join(folder, "manifest.json");
  if (exists(dirManifest)) {
    const repoPath = join(folder, "repo");
    if (!exists(repoPath)) {
      return { ok: false, reason: `scenario dir ${folder} has manifest.json but no repo/ subdirectory` };
    }
    return { ok: true, repoPath, manifestPath: dirManifest };
  }
  const parentManifest = join(dirname(folder), "manifest.json");
  if (exists(parentManifest)) {
    // `folder` IS the repo — its existence is the preflight's job; trust it here.
    return { ok: true, repoPath: folder, manifestPath: parentManifest };
  }
  return {
    ok: false,
    reason: `no manifest.json found for scenario folder ${folder} (looked at ${dirManifest} and ${parentManifest})`,
  };
}

/** Read + parse a frozen scenario manifest from disk. Throws on invalid JSON or
 *  when the parsed manifest fails the structural check (one-line refusal). */
export function loadManifestFile(
  manifestPath: string,
  read: (path: string, opts: { encoding: "utf-8" }) => string,
): ScenarioManifest {
  const text = read(manifestPath, { encoding: "utf-8" });
  const parsed = JSON.parse(text) as ScenarioManifest;
  const structureError = manifestStructureError(parsed);
  if (structureError !== null) {
    throw new Error(`manifest ${manifestPath} failed structural validation: ${structureError}`);
  }
  return parsed;
}

/** The narrow surface executeRun needs from the command context. {@link
 *  ExtensionCommandContext} satisfies this (it has ui/mode/hasUI + switchSession). */
export interface RunHandlerContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setWidget: (key: string, content: unknown, opts: { placement: string }) => void;
  };
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: unknown) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
}

/** Injectable inputs for {@link executeRun} (tests inject a fake `startRun`). */
export interface ExecuteRunOptions {
  /** The command context (widget + notify + the starting switchSession). */
  readonly ctx: RunHandlerContext;
  readonly config: BenchConfig;
  /** The prepared scenario repo path (frozen backup + project files on `main`). */
  readonly scenarioRepo: string;
  /** The loaded scenario manifest. */
  readonly manifest: ScenarioManifest;
  /** Override the run driver (tests inject a fake; default = real `startRun`). */
  readonly startRun?: (deps: StartRunDeps) => Promise<RunResult>;
}

/** The shared prepare → run tail for `run` + `run-session-file`: compute the scenario
 *  id, build the prepare deps, run prepare, load the manifest, then executeRun. Both
 *  one-shot shorthands reuse this; they differ only in how they parse + preflight the
 *  operator's arg (build idea vs session path) — by the time they reach this tail the
 *  arg is a uniform `PrepareArgs`.
 *
 *  Failures surface via notify (prepare fault → error; manifest load fault → error). */
interface PrepareThenRunOptions {
  readonly ctx: RunHandlerContext;
  readonly config: BenchConfig;
  /** The parsed args (build idea set, or fromSession set — drives buildDeps + the id). */
  readonly parsed: PrepareArgs;
  /** Build the PrepareDeps from ctx + parsed + id (default = prepare-scenario's). */
  readonly buildDeps: (ctx: unknown, parsed: PrepareArgs, scenarioId: string) => PrepareDeps;
  readonly prepareScenario?: typeof prepareScenarioImpl;
  readonly readManifest?: (path: string, opts: { encoding: "utf-8" }) => string;
  readonly executeRun?: (opts: ExecuteRunOptions) => Promise<unknown>;
}

/** Prepare (build/extract) then run. See {@link PrepareThenRunOptions}. */
async function prepareThenRun(opts: PrepareThenRunOptions): Promise<void> {
  // Set a FRESH prepare widget (replacing any stale terminal widget from a prior
  // command — never re-animating it) so the shorthand's build/extract drive shows
  // live progress exactly like /bench-compact:prepare-scenario does. The build/extract
  // seams read it via getActiveWidget for ctx/tok; executeRun replaces it with the run
  // widget once prepare succeeds.
  setActiveWidget(makePrepareWidget(opts.ctx));
  // Capture the UI surface EAGERLY: prepare's build/extract work switchSessions, which
  // invalidates the command ctx's guarded getters — the catch-path notifies below fire
  // AFTER those switches, so a lazy ctx.ui read would throw "stale" (the uiContext
  // object itself is host-level + stays live).
  const ui = opts.ctx.ui;
  const notify = (msg: string, level: "info" | "warning" | "error"): void => {
    ui.notify(msg, level);
  };
  const scenarioId = computeScenarioId(opts.parsed);

  let repoPath = "";
  let manifestPath = "";
  let liveCtx: { readonly current: unknown } | undefined;
  // Guard the prepare window (same rule as the prepare handler): the run-state only
  // appears later, inside startRun — the flag is cleared BEFORE executeRun hands
  // over (startRun sets the run-state immediately after). The window registers a
  // real abort controller (/bench-compact:abort stops a live prepare).
  const MAX_SURFACE_ROUNDS = 3;
  let surfaceRounds = 0;
  beginPrepare();
  try {
    let current = opts.parsed;
    let retry = true;
    while (retry) {
      retry = false;
      try {
        const deps = opts.buildDeps(opts.ctx, current, scenarioId);
        const result = await (opts.prepareScenario ?? prepareScenarioImpl)(deps);
        repoPath = result.repoPath;
        manifestPath = result.manifestPath;
        liveCtx = result.liveCtx;
      } catch (err) {
        if (!(err instanceof SurfaceConditionsError)) throw err;
        // A surfaced prepare ASKS the operator (modal dialog + attention ping when
        // the TUI select surface exists; pi's single-slot notify is ephemeral and
        // gets overwritten by pi's own banners while the prepare unwinds).
        const choice = await askRecoveryChoice(opts.ctx as { mode?: string; ui?: Record<string, unknown> }, err);
        if (choice === null || choice === "start-over") {
          const folder = scenarioDir(benchRoot(getBenchConfig().outputDir), scenarioId);
          notify(surfaceConditionsMessage(err, folder), "error");
          getActiveWidget()?.setStatus("stopped", "/bench-compact:prepare-scenario");
          return;
        }
        surfaceRounds += 1;
        if (surfaceRounds > MAX_SURFACE_ROUNDS) {
          notify("prepare stopped — too many recovery rounds; see the log", "error");
          getActiveWidget()?.setStatus("stopped", "/bench-compact:prepare-scenario");
          return;
        }
        current = surfaceRecoveryArgs(current, scenarioId, err, choice);
        retry = true;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`prepare failed: ${msg}`, "error");
    getActiveWidget()?.setStatus("stopped", "/bench-compact:prepare-scenario");
    return;
  } finally {
    endPrepare();
  }

  let manifest: ScenarioManifest;
  try {
    manifest = loadManifestFile(manifestPath, opts.readManifest ?? readFileSync);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`failed to load manifest ${manifestPath}: ${msg}`, "error");
    getActiveWidget()?.setStatus("stopped", "/bench-compact:prepare-scenario");
    return;
  }

  // Prepare's switchSessions invalidated the ORIGINAL command ctx — hand executeRun
  // the prepare holder's FINAL fresh ctx (mode/hasUI/ui read at executeRun entry are
  // valid on it, and Phase-1's first switchSession needs a live ctx). Falls back to
  // the command ctx when no build seam ran (pure extract/skip + test fakes — no
  // switchSession happened, so it is still live).
  const runCtx = (liveCtx?.current ?? opts.ctx) as RunHandlerContext;
  await (opts.executeRun ?? executeRun)({
    ctx: runCtx,
    config: opts.config,
    scenarioRepo: repoPath,
    manifest,
  });
}

/** Shared injectable options for the `run` + `run-session-file` one-shot shorthands
 *  (both chain prepare → executeRun; they differ only in how they parse + preflight
 *  the operator's arg). */
export interface RunShorthandOptions {
  readonly buildDeps?: (ctx: unknown, parsed: PrepareArgs, scenarioId: string) => PrepareDeps;
  readonly prepareScenario?: typeof prepareScenarioImpl;
  readonly executeRun?: (opts: ExecuteRunOptions) => Promise<unknown>;
  readonly readManifest?: (path: string, opts: { encoding: "utf-8" }) => string;
  /** Path-existence checker for preflight (default = fs.existsSync). */
  readonly exists?: (path: string) => boolean;
}

/** Resolve the shorthand defaults + run the prepare→run tail. Shared by `run` +
 *  `run-session-file` (collapses the identical prepareThenRun invocation). */
export async function invokeShorthand(
  ctx: RunHandlerContext,
  parsed: PrepareArgs,
  opts: RunShorthandOptions,
): Promise<void> {
  await prepareThenRun({
    ctx,
    config: getBenchConfig(),
    parsed,
    buildDeps: opts.buildDeps ?? defaultBuildPrepareDeps,
    prepareScenario: opts.prepareScenario,
    readManifest: opts.readManifest,
    executeRun: opts.executeRun ?? executeRun,
  });
}

/** Build the leveled-notify closure for a handler context (shared by the command
 *  handlers — they all warn on parse/preflight faults + error on load/prepare faults). */
export function notifyOf(ctx: RunHandlerContext): (msg: string, level: "info" | "warning" | "error") => void {
  return (msg, level): void => {
    ctx.ui.notify(msg, level);
  };
}

/** Register a command handler on `pi` (shared registerCommand boilerplate). */
export function registerHandler(
  pi: ExtensionAPI,
  name: string,
  description: string,
  handler: (args: string, ctx: unknown) => Promise<void>,
): void {
  pi.registerCommand(name, { description, handler });
}

/** Run preflight + notify on failure. Returns true if the command may proceed, false
 *  (after notifying the reason as a warning) if it should abort. Shared by the run
 *  handlers (collapses the preflight + guard + notify block). */
export function guardPreflight(
  ctx: RunHandlerContext,
  kind: CommandKind,
  args: CommandArgs,
  exists: (path: string) => boolean,
): boolean {
  const check = preflight(getBenchConfig(), kind, args, exists);
  if (!check.ok) {
    notifyOf(ctx)(check.reason, "warning");
    return false;
  }
  // One bench run drives the ONE main pi session (+ the shared scenario repo) — a
  // second concurrent run/prepare would clobber the run-state + abort holder and
  // interleave git. Refuse while a run is in-flight (done clears the state; stop +
  // unexpected-error exits record lastStopReason, so follow-ups are allowed).
  if (isRunInFlight()) {
    notifyOf(ctx)(
      "a bench run is already active — /bench-compact:status shows it; /bench-compact:abort stops it",
      "warning",
    );
    return false;
  }
  if (isPrepareInFlight()) {
    notifyOf(ctx)("a bench prepare is already active — /bench-compact:abort stops it", "warning");
    return false;
  }
  return true;
}

/** The common run tail: build the widget + StartRunDeps, drive the run, notify the
 *  operator of the outcome. Returns the run result (for the handler to surface). */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunResult> {
  // Capture the UI surface EAGERLY: the run switchSessions (Phase-1 loads each arm),
  // which invalidates the command ctx's guarded getters (ctx.ui would throw "stale"
  // at notify time). The uiContext OBJECT itself is host-level and stays live across
  // session switches — same eager-capture makeTuiWidgetDeps already does below.
  const ui = opts.ctx.ui;
  const widgetDeps = makeTuiWidgetDeps({
    mode: opts.ctx.mode,
    hasUI: opts.ctx.hasUI,
    ui: opts.ctx.ui,
  });
  const widget = new WidgetController(widgetDeps, {});
  widget.show();
  setActiveWidget(widget);

  const deps: StartRunDeps = {
    cmdCtx: opts.ctx as unknown as ExtensionCommandContext,
    config: opts.config,
    scenarioRepo: opts.scenarioRepo,
    manifest: opts.manifest,
    widget,
    notify: (message: string): void => {
      ui.notify(message, "warning");
    },
  };
  const run = opts.startRun ?? startRunImpl;
  let result: RunResult;
  try {
    result = await run(deps);
  } catch (err) {
    // Unexpected error (startRun setup fault, uncaught throw) — surface it so the
    // operator sees the run halted, then rethrow (pi's command runner handles the
    // rejection). The notify is the stop-and-surface channel (failure handling).
    const msg = err instanceof Error ? err.message : String(err);
    ui.notify(`run failed: ${msg}`, "error");
    throw err;
  }
  if (result.kind === "done") {
    ui.notify(`run ${result.runId} done: ${result.resultsPath}`, "info");
  }
  // stopped: startRun already notified the detailed stop message via deps.notify
  // (arm/attempt/phase + message) — do NOT double-notify. The live-progress widget
  // also shows the resume hint (setStatus stopped).
  return result;
}
