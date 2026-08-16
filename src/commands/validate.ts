// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Pre-flight validation for `/bench-compact:*` commands. Runs BEFORE any
// work starts; on failure the command refuses with a one-line reason (no run started).
//
// Two layers: (1) the bench CONFIG rules (delegated to `validateBenchConfig` from
// the config rules — ≥1 arm, compactionBoundary ≥20K, OM-full threshold sane) applied to every
// command; (2) per-command arg/path checks (idea-or-path presence, path existence
// via an injectable `exists` checker so the unit is pure-testable).

import { existsSync } from "node:fs";
import type { BenchConfig } from "../config/types.js";
import { validateBenchConfig } from "../config/validate.js";
import type { PrepareArgs, ResultsArgs } from "./parse.js";

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/** The structured args a command carries (union of the parser outputs). */
export type CommandArgs = PrepareArgs | ResultsArgs | { value: string | undefined };

/** Command kinds that run preflight. */
export type CommandKind = "prepare" | "run" | "run-scenario" | "run-session-file" | "results";

/**
 * Validate that a command may proceed.
 *
 * @param cfg — the resolved bench config (config rules: ≥1 arm, boundary, OM-full threshold).
 * @param kind — which command is asking.
 * @param args — the parsed command args.
 * @param exists — path-existence checker (pass null to use `fs.existsSync`; injected for tests).
 */
export function preflight(
  cfg: BenchConfig,
  kind: CommandKind,
  args: CommandArgs,
  exists: ((path: string) => boolean) | null,
): PreflightResult {
  const existsFn = exists ?? existsSync;
  // (1) config rules — every command.
  const cfgResult = validateBenchConfig(cfg);
  if (!cfgResult.ok) return cfgResult;

  // (2) per-command arg/path checks.
  switch (kind) {
    case "prepare":
    case "run": {
      const a = args as PrepareArgs;
      // build / extract / plant-recovery / skip-recovery are mutually exclusive modes.
      const modes = [
        a.idea !== undefined && a.idea.length > 0,
        a.fromSession !== undefined,
        a.plantFrom !== undefined,
        a.skipFrom !== undefined,
        a.reAuthorFrom !== undefined,
      ].filter(Boolean).length;
      if (modes > 1) {
        return {
          ok: false,
          reason:
            "provide exactly one of: a build idea, --from-session <path>, --plant <folder>, --from <folder> (with --skip-topics), or --re-author <folder>",
        };
      }
      if (a.reAuthorFrom !== undefined) {
        if (a.skipTopics !== undefined) return { ok: false, reason: "--re-author does not take --skip-topics" };
        if (!existsFn(a.reAuthorFrom)) return { ok: false, reason: `--re-author folder not found: ${a.reAuthorFrom}` };
        return { ok: true };
      }
      if (a.fromSession !== undefined) {
        if (!existsFn(a.fromSession)) return { ok: false, reason: `--from-session path not found: ${a.fromSession}` };
        return { ok: true };
      }
      if (a.plantFrom !== undefined) {
        if (a.skipTopics !== undefined)
          return { ok: false, reason: "--plant does not take --skip-topics (use --from with --skip-topics)" };
        if (!existsFn(a.plantFrom)) return { ok: false, reason: `--plant folder not found: ${a.plantFrom}` };
        return { ok: true };
      }
      if (a.skipFrom !== undefined) {
        if (a.skipTopics === undefined)
          return { ok: false, reason: "--from <folder> requires --skip-topics <ids> (skip-and-proceed recovery)" };
        if (!existsFn(a.skipFrom)) return { ok: false, reason: `--from folder not found: ${a.skipFrom}` };
        return { ok: true };
      }
      if (a.skipTopics !== undefined) {
        return { ok: false, reason: "--skip-topics requires --from <folder> (skip-and-proceed recovery)" };
      }
      if (a.idea !== undefined && a.idea.length > 0) return { ok: true };
      return {
        ok: false,
        reason: "provide a build idea, --from-session <path>, --plant <folder>, or --from <folder> with --skip-topics",
      };
    }
    case "run-scenario": {
      const folder = (args as { value: string | undefined }).value;
      if (folder === undefined) return { ok: false, reason: "provide a scenario folder path" };
      if (!existsFn(folder)) return { ok: false, reason: `scenario folder not found: ${folder}` };
      return { ok: true };
    }
    case "run-session-file": {
      const path = (args as { value: string | undefined }).value;
      if (path === undefined) return { ok: false, reason: "provide a session file path" };
      if (!existsFn(path)) return { ok: false, reason: `session file not found: ${path}` };
      return { ok: true };
    }
    case "results": {
      const runs = (args as ResultsArgs).runs;
      if (runs.length === 0) return { ok: false, reason: "results requires at least one runId" };
      return { ok: true };
    }
    default:
      // Unknown kinds pass config validation only (defense-in-depth: never return
      // undefined, which would crash the caller's `if (!check.ok)`).
      return { ok: true };
  }
}
