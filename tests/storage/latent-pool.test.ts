// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LatentProbe } from "../../src/manifest/latent.js";
import {
  type LatentPoolFile,
  readLatentPool,
  staleVerdictArms,
  summaryDigest,
  writeLatentPool,
} from "../../src/storage/latent-pool.js";

const probe: LatentProbe = {
  id: "l1",
  question: "why was write-through rejected?",
  accept: ["it serialized writes"],
  entryIds: ["e1"],
  probeClass: "cued",
  note: "cache design rationale",
  arm: "A3",
  verdicts: { A3: "absent" },
};

const pool: LatentPoolFile = {
  mode: "per-arm",
  arm: "A3",
  tailStartsAtEntryId: "cut-1",
  summaryDigests: { A1: "d1", A3: "d3" },
  probes: [probe],
};

describe("latent pool persistence", () => {
  it("round-trips through JSON losslessly", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-pool-"));
    const path = join(dir, "latent-pool.json");
    writeLatentPool(path, pool);
    expect(readLatentPool(path)).toEqual(pool);
  });

  it("throws on a corrupt pool file", () => {
    const dir = mkdtempSync(join(tmpdir(), "latent-pool-"));
    const path = join(dir, "latent-pool.json");
    writeFileSync(path, '{"mode":"per-arm","probes":"not-an-array"}');
    expect(() => readLatentPool(path)).toThrow("corrupt latent pool");
  });

  it("summaryDigest is stable and 16 hex chars", () => {
    expect(summaryDigest("the summary")).toBe(summaryDigest("the summary"));
    expect(summaryDigest("the summary")).toMatch(/^[0-9a-f]{16}$/);
    expect(summaryDigest("the summary")).not.toBe(summaryDigest("the summary v2"));
  });

  it("staleVerdictArms flags changed digests + arms the pool never covered", () => {
    expect(staleVerdictArms(pool, { A1: "d1", A3: "d3" })).toEqual([]);
    expect(staleVerdictArms(pool, { A1: "d1", A3: "changed" })).toEqual(["A3"]);
    // an arm with NO recorded digest (e.g. added on a config-change resume) is stale —
    // otherwise its probes would silently all be inactive under the reused pool
    expect(staleVerdictArms(pool, { A5: "new" })).toEqual(["A5"]);
  });
});
