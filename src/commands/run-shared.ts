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
import type { RunResult, StartRunDeps } from "../orchestrate/run.js";
import { startRun as startRunImpl } from "../orchestrate/run.js";
import type { PrepareDeps } from "../production/prepare.js";
import { prepareScenario as prepareScenarioImpl } from "../production/prepare.js";
import { setActiveWidget } from "../widget/active-widget.js";

/** Named null for {@link setActiveWidget} (no-bare-literals). */
const NO_ACTIVE_WIDGET: null = null;

import { makeTuiWidgetDeps, WidgetController } from "../widget/tracker.js";
import type { PrepareArgs } from "./parse.js";
import { computeScenarioId, defaultBuildPrepareDeps } from "./prepare-scenario.js";
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

/** Read + parse a frozen scenario manifest from disk. Throws on invalid JSON. */
export function loadManifestFile(
  manifestPath: string,
  read: (path: string, opts: { encoding: "utf-8" }) => string,
): ScenarioManifest {
  const text = read(manifestPath, { encoding: "utf-8" });
  return JSON.parse(text) as ScenarioManifest;
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
  // Clear any stale active widget so the prepare seams (which read getActiveWidget)
  // don't re-animate a prior command's terminal widget. executeRun sets the run widget
  // after prepare; the shorthand's prepare phase is intentionally widget-less.
  setActiveWidget(NO_ACTIVE_WIDGET);
  const notify = (msg: string, level: "info" | "warning" | "error"): void => {
    opts.ctx.ui.notify(msg, level);
  };
  const scenarioId = computeScenarioId(opts.parsed);

  let repoPath: string;
  let manifestPath: string;
  try {
    const deps = opts.buildDeps(opts.ctx, opts.parsed, scenarioId);
    const result = await (opts.prepareScenario ?? prepareScenarioImpl)(deps);
    repoPath = result.repoPath;
    manifestPath = result.manifestPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`prepare failed: ${msg}`, "error");
    return;
  }

  let manifest: ScenarioManifest;
  try {
    manifest = loadManifestFile(manifestPath, opts.readManifest ?? readFileSync);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`failed to load manifest ${manifestPath}: ${msg}`, "error");
    return;
  }

  await (opts.executeRun ?? executeRun)({
    ctx: opts.ctx,
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
  return true;
}

/** The common run tail: build the widget + StartRunDeps, drive the run, notify the
 *  operator of the outcome. Returns the run result (for the handler to surface). */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunResult> {
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
      opts.ctx.ui.notify(message, "warning");
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
    opts.ctx.ui.notify(`run failed: ${msg}`, "error");
    throw err;
  }
  if (result.kind === "done") {
    opts.ctx.ui.notify(`run ${result.runId} done: ${result.resultsPath}`, "info");
  }
  // stopped: startRun already notified the detailed stop message via deps.notify
  // (arm/attempt/phase + message) — do NOT double-notify. The live-progress widget
  // also shows the resume hint (setStatus stopped).
  return result;
}
