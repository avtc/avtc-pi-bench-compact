// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Incremental scoring verdict store — the crash-resume checkpoint for the score
// phase. Judge calls are the slow, non-deterministic part of scoring; everything
// else (exact metrics, aggregation, serialization) is pure and instant. Each
// COMPLETED judged unit (a probe slice, a boundary set, a trajectory grade, a
// comparative ranking) is appended to `runs/<runId>/judge/verdicts.jsonl` as one
// line, so a power loss / crash mid-scoring costs only the in-flight unit: on the
// next score run the journal replays settled verdicts and judges only the rest.
//
// Validity binding: verdicts are only reusable under the SAME scoring conditions.
// The journal's first line carries a fingerprint (manifest + judge ensemble +
// budgets + probesOnly + slice thresholds); a mismatch (re-authored manifest,
// changed judges, changed budget) invalidates the whole file — it is restarted,
// because mixing verdicts across ensembles is unsound.
//
// Crash-safety: append-only JSONL, one fsync-less append per unit. A torn final
// line (power loss mid-append) is tolerated — loading stops at the first
// unparseable line and drops the tail.

import { createHash } from "node:crypto";

/** The store surface the scoring routes see. `null` payload values are invalid. */
export interface VerdictStore {
  /** Whether a verdict exists for the key (and its payload parses). */
  has(key: string): boolean;
  /** The stored payload, or undefined when absent/torn. */
  get(key: string): unknown;
  /** Persist one unit's verdict (append + in-memory update). */
  put(key: string, payload: unknown): void;
}

/** fs seams (tests inject fakes; production passes the node:fs functions). */
export interface VerdictFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  appendFileSync(path: string, data: string): void;
  writeFileSync(path: string, data: string): void;
}

/** The journal file's first line (the validity binding). */
interface VerdictHeader {
  readonly kind: "bench-compact.verdicts";
  readonly v: 1;
  readonly fingerprint: string;
}

/** One appended verdict line. */
interface VerdictLine {
  readonly key: string;
  readonly payload: unknown;
}

/** The marker constant (kept structural: `kind` discriminates the header line). */
const HEADER_KIND = "bench-compact.verdicts";

/**
 * Compute the scoring fingerprint: verdicts are reusable only when every
 * judged-input dimension is unchanged — the manifest (re-author ⇒ new questions),
 * the judge ensemble (models/thinking levels/count), the per-call token budget,
 * the probes-only gate (changes which lanes run), the slice-shaping threshold, the
 * latent pool, and the ground-truth excerpts rendered into probe slices.
 * Pure.
 */
export function scoringFingerprint(input: {
  readonly manifestJson: string;
  readonly judgeEnsembleFields: unknown;
  readonly maxTokens: number;
  readonly probesOnly: boolean;
  readonly e2LongThreshold: number;
  /** Digest of the run's active latent probes (null when none) — a pool change
   *  (re-author, mode switch, activation flip) must restart the journal: latent
   *  probe ids restart at l1, so old verdicts would otherwise be replayed for
   *  questions that were never asked. */
  readonly latent: string | null;
  /** Digest of the ground-truth excerpt map fed into probe slices (null when
   *  none) — a change in the excerpts the judges see must restart the journal,
   *  else pre-change verdicts replay beside post-change ones. */
  readonly groundTruth: string | null;
}): string {
  const canonical = JSON.stringify({
    manifest: input.manifestJson,
    judges: input.judgeEnsembleFields,
    maxTokens: input.maxTokens,
    probesOnly: input.probesOnly,
    e2LongThreshold: input.e2LongThreshold,
    latent: input.latent,
    groundTruth: input.groundTruth,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Open (or start) the verdict journal at `path`. When the file exists and its
 * header fingerprint matches, prior verdicts load; when it is absent a fresh
 * header is written; when the fingerprint differs the file RESTARTS (the old
 * verdicts are invalid under the new scoring conditions). A torn tail line is
 * dropped. Pure aside from the injected fs seams.
 */
export function openVerdictJournal(opts: {
  readonly path: string;
  readonly fingerprint: string;
  readonly fs: VerdictFs;
  readonly onRestart?: (path: string) => void;
}): VerdictStore {
  const header: VerdictHeader = { kind: HEADER_KIND, v: 1, fingerprint: opts.fingerprint };
  const entries = new Map<string, unknown>();
  let fresh = true;
  if (opts.fs.existsSync(opts.path)) {
    const lines = opts.fs
      .readFileSync(opts.path)
      .split("\n")
      .filter((l) => l.trim().length > 0);
    let headerOk = false;
    for (const [i, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        break; // torn tail — everything from here on is untrusted
      }
      if (i === 0) {
        const h = parsed as VerdictHeader;
        if (h.kind !== HEADER_KIND || h.fingerprint !== opts.fingerprint) break;
        headerOk = true;
        fresh = false;
        continue;
      }
      if (!headerOk) break;
      const rec = parsed as VerdictLine;
      if (typeof rec.key !== "string") break;
      entries.set(rec.key, rec.payload);
    }
  }
  if (fresh) {
    opts.fs.writeFileSync(opts.path, `${JSON.stringify(header)}\n`);
    opts.onRestart?.(opts.path);
  }
  return {
    has(key: string): boolean {
      return entries.has(key);
    },
    get(key: string): unknown {
      return entries.get(key);
    },
    put(key: string, payload: unknown): void {
      entries.set(key, payload);
      opts.fs.appendFileSync(opts.path, `${JSON.stringify({ key, payload } satisfies VerdictLine)}\n`);
    },
  };
}
