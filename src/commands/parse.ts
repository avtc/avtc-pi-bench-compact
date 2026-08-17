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
  /** Plant-and-continue recovery: the scenario folder of a FAILED prepare whose
   *  missing condition topics should be steered in (`--plant <folder>`). */
  plantFrom: string | undefined;
  /** Skip-and-proceed recovery: the scenario folder of a FAILED prepare
   *  (`--from <folder>`, pairs with `--skip-topics`). */
  skipFrom: string | undefined;
  /** Re-author an EXISTING scenario's manifest in place from its frozen backup
   *  (`--re-author <folder>`): trial-compact → author (with tail validation) →
   *  validate → replace manifest.json. The backup, repo, and committed arm bases
   *  are untouched. */
  reAuthorFrom: string | undefined;
  /** Condition-topic ids to drop (`--skip-topics a,b`, comma-separated). */
  skipTopics: string[] | undefined;
  /** `--force`: re-prepare over an existing scenario folder. */
  force: boolean;
  /** Set when a flag is malformed (e.g. `--from-session` with no path). */
  error: string | undefined;
}

/** Parse prepare/run args: `--from-session <path>`, `--plant <folder>`,
 *  `--skip-topics <ids>`, `--from <folder>`, `--force`, else the build idea.
 *  Mode mutual-exclusion + completeness are preflight's job (validate.ts). */
export function parsePrepareArgs(args: string): PrepareArgs {
  const tokens = tokenize(args);
  const positionals: string[] = [];
  let fromSession: string | undefined;
  let plantFrom: string | undefined;
  let skipFrom: string | undefined;
  let reAuthorFrom: string | undefined;
  let skipTopics: string[] | undefined;
  let force = false;
  let error: string | undefined;

  const readValue = (flag: string, i: number): { value: string; next: number } | { error: string } => {
    const next = tokens[i + 1];
    if (next === undefined) return { error: `${flag} requires a value` };
    if (next.startsWith("--")) return { error: `${flag} requires a value (got another flag)` };
    return { value: next, next: i + 1 };
  };

  /** `--flag=value` inline form (empty value = error, mirroring readValue). Returns
   *  the same shape — `next` is `i` (the value was inline; no extra token consumed). */
  const eqValue = (flagEq: string, tok: string, i: number): { value: string; next: number } | { error: string } => {
    const val = tok.slice(flagEq.length);
    if (val.length === 0) return { error: `${flagEq} requires a non-empty value` };
    return { value: val, next: i };
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--from-session") {
      const r = readValue(tok, i);
      if ("error" in r) {
        error = r.error;
        break;
      }
      fromSession = r.value;
      i = r.next;
    } else if (tok === "--plant" || tok.startsWith(PLANT_EQ)) {
      const r = tok.startsWith(PLANT_EQ) ? eqValue(PLANT_EQ, tok, i) : readValue(tok, i);
      if ("error" in r) {
        error = r.error;
        break;
      }
      plantFrom = r.value;
      i = r.next;
    } else if (tok === "--from" || tok.startsWith(FROM_EQ)) {
      const r = tok.startsWith(FROM_EQ) ? eqValue(FROM_EQ, tok, i) : readValue(tok, i);
      if ("error" in r) {
        error = r.error;
        break;
      }
      skipFrom = r.value;
      i = r.next;
    } else if (tok === "--re-author" || tok.startsWith(RE_AUTHOR_EQ)) {
      const r = tok.startsWith(RE_AUTHOR_EQ) ? eqValue(RE_AUTHOR_EQ, tok, i) : readValue(tok, i);
      if ("error" in r) {
        error = r.error;
        break;
      }
      reAuthorFrom = r.value;
      i = r.next;
    } else if (tok === SKIP_TOPICS_FLAG || tok.startsWith(SKIP_TOPICS_EQ)) {
      const raw = tok.startsWith(SKIP_TOPICS_EQ) ? tok.slice(SKIP_TOPICS_EQ.length) : undefined;
      let list: string;
      if (raw !== undefined) {
        if (raw.length === 0) {
          error = "--skip-topics= requires a non-empty comma-separated id list";
          break;
        }
        list = raw;
      } else {
        const r = readValue(tok, i);
        if ("error" in r) {
          error = r.error;
          break;
        }
        list = r.value;
        i = r.next;
      }
      const pieces = list.split(",").map((s) => s.trim());
      if (pieces.some((s) => s.length === 0)) {
        error = "--skip-topics ids are comma-separated with no empty entries";
        break;
      }
      skipTopics = pieces;
    } else if (tok === "--force") {
      force = true;
    } else if (tok.startsWith(FROM_SESSION_EQ)) {
      const r = eqValue(FROM_SESSION_EQ, tok, i);
      if ("error" in r) {
        error = r.error;
        break;
      }
      fromSession = r.value;
    } else if (tok.startsWith("--")) {
      // An unrecognized --token is a mistyped/misused flag, not idea text — say so
      // instead of silently driving a garbage scenario titled "--forc".
      error = `unknown flag "${tok}"`;
      break;
    } else {
      positionals.push(tok);
    }
  }

  return {
    idea: positionals.length > 0 ? positionals.join(" ") : undefined,
    fromSession,
    plantFrom,
    skipFrom,
    reAuthorFrom,
    skipTopics,
    force,
    error,
  };
}

/** A single results run reference: a runId + optional arm subset (`:<armids>` — comma-separated). */
interface RunRef {
  runId: string;
  /** Arm subset (comma-separated arm ids); undefined = all arms of that run. */
  arms?: ArmId[];
}

export interface ResultsArgs {
  runs: RunRef[];
  error: string | undefined;
}

const VALID_ARMS = new Set<string>(ARM_IDS);

/** The recovery/option flag names (hoisted so the arg-parsing lines stay string-free). */
const SKIP_TOPICS_FLAG = "--skip-topics";
const SKIP_TOPICS_EQ = "--skip-topics=";
const PLANT_EQ = "--plant=";
const FROM_EQ = "--from=";
const RE_AUTHOR_EQ = "--re-author=";
const FROM_SESSION_EQ = "--from-session=";

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

/** Parsed `run-scenario` args: one scenario folder + optional crash-resume flags. */
export interface RunScenarioArgs {
  /** The scenario folder path (the one positional). */
  folder: string | undefined;
  /** `--resume` crash recovery: true = auto-detect the latest incomplete run;
   *  a string = the explicit runId (from `--resume=<runId>`). */
  resume: string | true | undefined;
  /** `--allow-config-change`: proceed with a resumed run whose config fingerprint
   *  changed since the crash (arms whose tool version changed re-compact). */
  allowConfigChange: boolean;
  /** `--reuse-bases`: on resume, reuse a committed arm base built under an OLDER
   *  tool version when the current version's base is absent (skip re-compaction
   *  after a tool fix that did not change compaction behavior). */
  reuseBases: boolean;
  /** `--rescore`: on an explicit `--resume=<runId>`, bypass the complete-run
   *  refusal — every phase replays from its durable artifacts and scoring re-runs
   *  (the verdict journal replays unchanged slices). */
  rescore: boolean;
  /** Set when a flag is malformed (e.g. `--resume=` with no id). */
  error: string | undefined;
}

/** The `--resume` flag names (bare + inline-value forms — hoisted like the prepare flags). */
const RESUME_FLAG = "--resume";
const RESUME_EQ = "--resume=";
const ALLOW_CONFIG_CHANGE_FLAG = "--allow-config-change";
const REUSE_BASES_FLAG = "--reuse-bases";
const RESCORE_FLAG = "--rescore";

/** Parse `run-scenario` args: one positional scenario folder + `--resume` (bare —
 *  auto-detect the latest incomplete run) or `--resume=<runId>` (explicit). The
 *  explicit id uses the inline `=` form ONLY (a separate-token id would be ambiguous
 *  with the folder positional). `--allow-config-change` overrides the resume cfg
 *  guard (only meaningful alongside --resume). Completeness (folder present) is
 *  preflight's job. */
export function parseRunScenarioArgs(args: string): RunScenarioArgs {
  const tokens = tokenize(args);
  const positionals: string[] = [];
  let resume: string | true | undefined;
  let allowConfigChange = false;
  let reuseBases = false;
  let rescore = false;
  let error: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === RESUME_FLAG) {
      resume = true;
    } else if (tok.startsWith(RESUME_EQ)) {
      const raw = tok.slice(RESUME_EQ.length);
      // Accept the branch-name style too (`--resume=run-2026-08-16-4`) — run branch
      // paths carry a `run-` prefix while runIds (run dirs, results) do not; normalize
      // so the explicit-id lookup cannot silently miss on the prefixed form.
      const runId = raw.startsWith("run-") ? raw.slice("run-".length) : raw;
      if (runId.length === 0) {
        error = "--resume= requires a non-empty runId";
        break;
      }
      resume = runId;
    } else if (tok === ALLOW_CONFIG_CHANGE_FLAG) {
      allowConfigChange = true;
    } else if (tok === REUSE_BASES_FLAG) {
      reuseBases = true;
    } else if (tok === RESCORE_FLAG) {
      rescore = true;
    } else if (tok.startsWith("--")) {
      error = `unknown flag "${tok}"`;
      break;
    } else {
      positionals.push(tok);
    }
  }

  if (error === undefined && positionals.length > 1) {
    error = `expected one scenario folder path, got ${positionals.length} tokens`;
  }
  if (error === undefined && allowConfigChange && resume === undefined) {
    error = "--allow-config-change requires --resume";
  }
  if (error === undefined && reuseBases && resume === undefined) {
    error = "--reuse-bases requires --resume";
  }
  if (error === undefined && rescore && (resume === undefined || resume === true)) {
    error = "--rescore requires an explicit --resume=<runId>";
  }

  return {
    folder: positionals.length === 1 ? positionals[0] : undefined,
    resume,
    allowConfigChange,
    reuseBases,
    rescore,
    error,
  };
}
