// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Durable storage for a run's latent-probe pool (runs/<runId>/latent-pool.json).
// The record doubles as the resume re-validation cache: `summaryDigests` pins the
// exact compaction summaries the absence verdicts were checked against — when an
// arm re-compacts, its digest changes and only that arm's verdicts are stale.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { ArmId } from "../config/types.js";
import type { LatentAuthoringMode, LatentProbe } from "../manifest/latent.js";

/** The persisted pool: the probes + everything re-validation needs. */
export interface LatentPoolFile {
  readonly mode: LatentAuthoringMode;
  /** Per-arm mode only: the arm this pool authors for. */
  readonly arm: ArmId | null;
  /** The tail anchor the pool was authored against. */
  readonly tailStartsAtEntryId: string;
  /** sha256 of each arm's compaction summary at authoring time, keyed by arm. */
  readonly summaryDigests: Readonly<Record<string, string>>;
  readonly probes: readonly LatentProbe[];
}

/** sha256 of a compaction summary (hex, first 16 chars — a change detector, not a
 *  security artifact). */
export function summaryDigest(summary: string): string {
  return createHash("sha256").update(summary).digest("hex").slice(0, 16);
}

/** Write the pool as JSON (pretty — it is an operator-inspectable run artifact). */
export function writeLatentPool(path: string, pool: LatentPoolFile): void {
  writeFileSync(path, `${JSON.stringify(pool, null, 2)}\n`);
}

/** Read a persisted pool. Throws on missing/corrupt files — the caller surfaces. */
export function readLatentPool(path: string): LatentPoolFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LatentPoolFile;
  if (typeof parsed.mode !== "string" || !Array.isArray(parsed.probes)) {
    throw new Error(`corrupt latent pool: ${path}`);
  }
  return parsed;
}

/** Which arms' verdicts are stale after (potential) re-compactions: an arm whose
 *  current summary digest no longer matches the pool's recorded digest. */
export function staleVerdictArms(pool: LatentPoolFile, currentDigests: Readonly<Record<string, string>>): ArmId[] {
  const stale: ArmId[] = [];
  for (const [arm, digest] of Object.entries(currentDigests)) {
    if (pool.summaryDigests[arm] !== undefined && pool.summaryDigests[arm] !== digest) {
      stale.push(arm as ArmId);
    }
  }
  return stale;
}
