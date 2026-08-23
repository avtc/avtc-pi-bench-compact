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
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { benchRoot, runDir } from "../storage/paths.js";
import { listBranches } from "../storage/repo.js";
import { detectLatestIncompleteRun, findRunNamespace, type ResumeTarget } from "../storage/resume.js";
import { parseRunScenarioArgs } from "./parse.js";
import {
  type ExecuteRunOptions,
  executeRun,
  guardPreflight,
  loadManifestFile,
  notifyOf,
  type RunHandlerContext,
  registerHandler,
  resolveDefaultScenarioFolder,
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
  /** Branch lister for --resume resolution (default = real `listBranches`). */
  readonly listBranches?: (repo: string, pattern: string) => string[];
  /** The configured default scenario folder (default = the `scenario` setting,
   *  resolved as path-or-id; null = no default — the folder argument is required). */
  readonly defaultScenarioFolder?: () => string | null;
}

/** Build the handler for `/bench-compact:run-scenario`. */
export function makeRunScenarioHandler(opts: RunScenarioHandlerOptions) {
  const exists = opts.exists ?? existsSync;
  const readManifest = opts.readManifest ?? readFileSync;
  const run = opts.executeRun ?? executeRun;
  const branchList = opts.listBranches ?? listBranches;
  const defaultScenarioFolder =
    opts.defaultScenarioFolder ??
    (() => {
      const config = getBenchConfig();
      return resolveDefaultScenarioFolder(config.scenario, benchRoot(config.outputDir), existsSync);
    });
  return async (args: string, ctx: unknown): Promise<void> => {
    const handlerCtx = ctx as RunHandlerContext;
    const notify = notifyOf(handlerCtx);

    const parsed = parseRunScenarioArgs(args);
    if (parsed.error !== undefined) {
      notify(parsed.error, "warning");
      return;
    }
    if (
      !guardPreflight(
        handlerCtx,
        "run-scenario",
        { value: parsed.folder ?? defaultScenarioFolder() ?? undefined },
        exists,
      )
    )
      return;
    const folder = parsed.folder ?? defaultScenarioFolder() ?? ""; // preflight rejected undefined above

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

    // --resume: resolve WHICH crashed run to continue from the scenario repo's
    // bench-compact/* branches (the committed phase artifacts ARE the resume state).
    // Bare --resume auto-detects the latest run with branches but no results.json;
    // --resume=<runId> names one explicitly (refused when already complete or unknown).
    // The cfgId mismatch + malformed-id guards live in the run driver (startRun) and
    // surface through executeRun's run-fault path.
    let resume: ResumeTarget | undefined;
    if (parsed.resume !== undefined) {
      const config = getBenchConfig();
      const resultsExist = (runId: string): boolean =>
        exists(join(runDir(benchRoot(config.outputDir), runId), "results.json"));
      const branches = branchList(layout.repoPath, "bench-compact/run-*");
      if (parsed.resume === true) {
        // Bare --resume: the latest run with branches but no results.json.
        const target = detectLatestIncompleteRun(branches, resultsExist);
        if (target === null) {
          notify(`no incomplete bench run found in ${layout.repoPath} — nothing to resume`, "warning");
          return;
        }
        resume = target;
      } else {
        // Explicit runId: refuse an already-complete run unless --rescore (re-run
        // scoring on the completed run), then resolve its namespace.
        if (resultsExist(parsed.resume) && parsed.rescore !== true) {
          notify(
            `run ${parsed.resume} is already complete (results.json exists) — nothing to resume (use --rescore to re-run scoring)`,
            "warning",
          );
          return;
        }
        const target = findRunNamespace(branches, parsed.resume);
        if (target === null) {
          notify(
            `no bench-compact branches found for run ${parsed.resume} in ${layout.repoPath} — cannot resume`,
            "warning",
          );
          return;
        }
        resume = target;
      }
      if (parsed.allowConfigChange || parsed.reuseBases || parsed.rescore) {
        resume = {
          ...resume,
          ...(parsed.allowConfigChange ? { allowConfigChange: true } : {}),
          ...(parsed.reuseBases ? { reuseBases: true } : {}),
          ...(parsed.rescore ? { rescore: true } : {}),
        };
      }
      notify(
        `resuming run ${resume.runId} (cfg ${resume.cfgId}) — completed arms, attempts, and probes are skipped`,
        "info",
      );
    }

    await run({
      ctx: handlerCtx,
      config: getBenchConfig(),
      scenarioRepo: layout.repoPath,
      manifest,
      resume,
      // Preserved runs are the DEFAULT for a fresh invocation: reuse a previous
      // run's compaction + latent pools per arm and start at the probes. Off on
      // --fresh (forced full run) and --resume (the resume path owns the run).
      preserve: parsed.fresh || resume !== undefined ? undefined : { from: parsed.from ?? null },
    });
  };
}

/** Register the run-scenario command on `pi`. */
export function registerRunScenarioCommand(pi: ExtensionAPI): void {
  registerHandler(
    pi,
    "bench-compact:run-scenario",
    "Run every enabled arm from a prepared scenario folder — reuses a previous run's compaction + latent probes per arm (run-scenario --fresh forces a full run; --resume [runId] continues an interrupted run).",
    makeRunScenarioHandler({}),
  );
}
