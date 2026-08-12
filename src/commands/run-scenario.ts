// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The `/bench-compact:run-scenario <folder>` command. Runs every enabled arm from
// a prepared scenario folder (no prepare step — the repo is already frozen on
// `main`). Resolves the scenario layout (repo + manifest) from the folder, loads
// the manifest, then runs the common tail (`executeRun`).
//
// The folder may be the scenario directory (holds `manifest.json` + `repo/`) or the
// repo path itself (what `prepare-scenario` prints). `resolveScenarioLayout` handles
// both.

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { parsePositional } from "./parse.js";
import {
  type ExecuteRunOptions,
  executeRun,
  guardPreflight,
  loadManifestFile,
  notifyOf,
  type RunHandlerContext,
  registerHandler,
  resolveScenarioLayout,
} from "./run-shared.js";

/** Injectable inputs for {@link makeRunScenarioHandler} (tests inject fakes). */
export interface RunScenarioHandlerOptions {
  /** Override the run tail (tests inject a fake; default = real `executeRun`). */
  readonly executeRun?: (opts: ExecuteRunOptions) => Promise<unknown>;
  /** Path-existence checker (default = fs.existsSync). */
  readonly exists?: (path: string) => boolean;
  /** Manifest reader (default = fs.readFileSync). */
  readonly readManifest?: (path: string, opts: { encoding: "utf-8" }) => string;
}

/** Build the handler for `/bench-compact:run-scenario`. */
export function makeRunScenarioHandler(opts: RunScenarioHandlerOptions) {
  const exists = opts.exists ?? existsSync;
  const readManifest = opts.readManifest ?? readFileSync;
  const run = opts.executeRun ?? executeRun;
  return async (args: string, ctx: unknown): Promise<void> => {
    const handlerCtx = ctx as RunHandlerContext;
    const notify = notifyOf(handlerCtx);

    const parsed = parsePositional(args);
    if (!guardPreflight(handlerCtx, "run-scenario", { value: parsed.value }, exists)) return;
    const folder = parsed.value ?? ""; // preflight rejected undefined above

    const layout = resolveScenarioLayout(folder, exists);
    if (!layout.ok) {
      notify(layout.reason, "warning");
      return;
    }

    let manifest: ScenarioManifest;
    try {
      manifest = loadManifestFile(layout.manifestPath, readManifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`failed to load manifest ${layout.manifestPath}: ${msg}`, "error");
      return;
    }

    await run({
      ctx: handlerCtx,
      config: getBenchConfig(),
      scenarioRepo: layout.repoPath,
      manifest,
    });
  };
}

/** Register the run-scenario command on `pi`. */
export function registerRunScenarioCommand(pi: ExtensionAPI): void {
  registerHandler(
    pi,
    "bench-compact:run-scenario",
    "Run every enabled arm from a prepared scenario folder.",
    makeRunScenarioHandler({}),
  );
}
