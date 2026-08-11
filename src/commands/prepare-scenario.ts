// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:prepare-scenario` command (§3.13). Thin wrapper: parse args,
// preflight, compute the scenario id + paths, then call `prepareScenario` (Task 10g).
// All orchestration lives in prepare.ts for reuse by Task 19's `run <idea>` Phase-0.
//
// The live seam construction (driveAndCapture via SimulatorDriver, trialCompact via
// ctx.compact, author via runAuthoringAgent) is `buildDeps` — injectable so the
// command is testable; registerBenchCommands wires a default that computes paths +
// defers live-seam construction to Task 19.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { type PrepareDeps, prepareScenario as prepareScenarioImpl } from "../production/prepare.js";
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
   *  The default live-wiring is Task 19; tests inject a fake. */
  readonly buildDeps: (ctx: unknown, parsed: PrepareArgs, scenarioId: string) => PrepareDeps;
}

/** Build the handler for `/bench-compact:prepare-scenario`. */
export function makePrepareScenarioHandler(opts: PrepareScenarioHandlerOptions) {
  const prepare = opts.prepareScenario ?? prepareScenarioImpl;
  return async (args: string, ctx: unknown): Promise<void> => {
    const ctxNotify = (ctx as { ui?: { notify: (m: string, l: string) => void } }).ui;
    const notify = (msg: string, level: "info" | "warning" | "error"): void => {
      ctxNotify?.notify(msg, level);
    };

    const parsed = parsePrepareArgs(args);
    if (parsed.error !== undefined) {
      notify(parsed.error, "warning");
      return;
    }
    const check = preflight(getBenchConfig(), "prepare", parsed);
    if (!check.ok) {
      notify(check.reason, "warning");
      return;
    }

    const scenarioId = computeScenarioId(parsed);
    try {
      const deps = opts.buildDeps(ctx, parsed, scenarioId);
      const result = await prepare(deps);
      notify(`prepared scenario ${scenarioId}: ${result.repoPath}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`prepare failed: ${msg}`, "error");
    }
  };
}

/** The default buildDeps for registerBenchCommands — computes paths; live seam
 *  construction (SimulatorDriver/ctx.compact/runAuthoringAgent) is Task 19. Exported
 *  so Task 19 can replace it with the fully-wired version. */
export function defaultBuildPrepareDeps(_ctx: unknown, parsed: PrepareArgs, scenarioId: string): PrepareDeps {
  // Paths are computed from the bench root (outputDir ?? ~/.pi/bench-compact/) + scenarioId.
  // The live seams (driveAndCapture/trialCompact/author) require ctx.compact + SimulatorDriver
  // + runAuthoringAgent wiring — Task 19. Until then, surface a clear NotImplemented.
  throw new Error(
    `prepare-scenario live wiring is Task 19 (scenarioId=${scenarioId}, mode=${parsed.fromSession ? "extract" : "build"}); paths + seams not yet constructed`,
  );
}

/** Register the prepare-scenario command on `pi`. */
export function registerPrepareScenarioCommand(pi: ExtensionAPI): void {
  pi.registerCommand("bench-compact:prepare-scenario", {
    description: "Prepare a scenario (build from <idea> or extract --from-session).",
    handler: makePrepareScenarioHandler({ buildDeps: defaultBuildPrepareDeps }),
  });
}
