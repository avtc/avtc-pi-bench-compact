// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Temp-dir lifecycle for the suite.
 *
 * `tempDir(prefix)` creates a mkdtemp folder AND registers it; `tests/setup.ts`
 * sweeps the registry in a global `afterEach`. That keeps every test's files
 * alive for exactly its own test (file-local cleanups run first and are
 * force-safe), so full-suite runs stop leaking hundreds of stale dirs into the
 * OS temp folder — accumulated leftovers (git repos, session jsonl) add
 * Windows-compatible churn (defender/indexer scans) that slows the very
 * real-git tests whose budgets are tightest.
 *
 * The sweep retries: Windows can hold a handle briefly (antivirus / file
 * indexer), and an EBUSY/EPERM out of a hook fails the whole file — the exact
 * class of intermittent red this replaces.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every dir this worker created via {@link tempDir} and not yet swept. */
const CREATED: string[] = [];

/** A unique temp dir under os.tmpdir(), registered for the global sweep. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CREATED.push(dir);
  return dir;
}

/** Remove every registered dir (idempotent — `force` swallows the empty set). */
export function sweepTempDirs(): void {
  for (const dir of CREATED.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
