// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Argument parsing for the `/bench-compact:*` commands. Pure functions —
// no I/O, no config. Each parser extracts structured args + sets `error` on a
// malformed flag/value (completeness — e.g. a missing idea/path — is preflight's
// job in validate.ts, not the parser's).

import { ARM_IDS, type ArmId } from "../config/types.js";

/** Parsed `prepare-scenario` / `run` / `run-session-file` args. */
export interface PrepareArgs {
  /** Build-mode task idea (the user-simulator's brief). Undefined for extract mode. */
  idea: string | undefined;
  /** Extract-mode source session path (`--from-session <path>`). */
  fromSession: string | undefined;
  /** `--force`: re-prepare over an existing scenario folder. */
  force: boolean;
  /** Set when a flag is malformed (e.g. `--from-session` with no path). */
  error: string | undefined;
}

/** Parse prepare/run args: `--from-session <path>`, `--force`, else the build idea. */
export function parsePrepareArgs(args: string): PrepareArgs {
  const tokens = tokenize(args);
  const positionals: string[] = [];
  let fromSession: string | undefined;
  let force = false;
  let error: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--from-session") {
      const next = tokens[i + 1];
      if (next === undefined) {
        error = "--from-session requires a session file path";
        break;
      }
      if (next.startsWith("--")) {
        error = "--from-session requires a session file path (got another flag)";
        break;
      }
      fromSession = next;
      i += 1;
    } else if (tok === "--force") {
      force = true;
    } else if (tok.startsWith("--from-session=")) {
      const val = tok.slice("--from-session=".length);
      if (val.length === 0) {
        error = "--from-session= requires a non-empty session file path";
        break;
      }
      fromSession = val;
    } else {
      positionals.push(tok);
    }
  }

  return {
    idea: positionals.length > 0 ? positionals.join(" ") : undefined,
    fromSession,
    force,
    error,
  };
}

/** A single results run reference: a runId + optional arm subset (`:<armids>` — comma-separated). */
export interface RunRef {
  runId: string;
  /** Arm subset (comma-separated arm ids); undefined = all arms of that run. */
  arms?: ArmId[];
}

export interface ResultsArgs {
  runs: RunRef[];
  error: string | undefined;
}

const VALID_ARMS = new Set<string>(ARM_IDS);

/** Split raw args into non-empty whitespace tokens (shared by the parsers). */
function tokenize(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Parse results args: one or more `<runId>[:arms]` tokens (whitespace-separated).
 *  `:arms` is a comma-separated subset of the five arm ids. */
export function parseResultsArgs(args: string): ResultsArgs {
  const tokens = tokenize(args);
  if (tokens.length === 0) {
    return { runs: [], error: "results requires at least one runId" };
  }
  const runs: RunRef[] = [];
  for (const tok of tokens) {
    const colon = tok.indexOf(":");
    let runId: string;
    let arms: ArmId[] | undefined;
    if (colon === -1) {
      runId = tok;
    } else {
      runId = tok.slice(0, colon);
      const armsStr = tok.slice(colon + 1);
      // A trailing comma signals the user put a space where a comma belonged — e.g.
      // `run1:<arm>, <arm>` tokenizes to `run1:<arm>,` + `<arm>`. Whitespace SEPARATES runs, so
      // :arms must be space-free; reject the mis-parse instead of silently splitting one
      // run+arm-subset into two runs. (Each `tok` is already space-free via tokenize, so the
      // arm pieces need no trimming.)
      if (armsStr.endsWith(",")) {
        return {
          runs: [],
          error: `trailing comma in ":arms" of "${tok}" — arms are comma-separated with no spaces (whitespace separates runs)`,
        };
      }
      const pieces = armsStr.split(",");
      // A leading or internal double comma leaves an empty entry — same silent-misparse
      // class as the trailing comma. Reject rather than drop the empty piece.
      if (pieces.some((s) => s.length === 0)) {
        return {
          runs: [],
          error: `empty arm in ":arms" of "${tok}" — arms are comma-separated with no empty entries (leading/internal double comma)`,
        };
      }
      const armList = pieces;
      if (armList.length === 0) {
        return { runs: [], error: `":arms" is empty in "${tok}" — specify arms (e.g. :A1,A3) or drop the colon` };
      }
      for (const a of armList) {
        if (!VALID_ARMS.has(a)) {
          return { runs: [], error: `"${a}" is not a valid arm id (expected one of ${ARM_IDS.join(",")})` };
        }
      }
      arms = armList as ArmId[];
    }
    if (runId.length === 0) {
      return { runs: [], error: `runId is empty in "${tok}"` };
    }
    runs.push({ runId, arms });
  }
  return { runs, error: undefined };
}

/** Parse a single positional value (a scenario folder path or a session file path).
 *  Returns the trimmed arg VERBATIM — internal whitespace is preserved (e.g. paths
 *  with spaces). The whole arg is one positional; there is no token-joining. */
export function parsePositional(args: string): { value: string | undefined; error: undefined } {
  const value = args.trim().length > 0 ? args.trim() : undefined;
  return { value, error: undefined };
}
