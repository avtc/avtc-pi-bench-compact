// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { openVerdictJournal, scoringFingerprint, type VerdictFs } from "../../src/judge/verdict-journal.js";

/** In-memory fs fake (single file). */
function fakeFs(initial: string | null): VerdictFs & { content(): string } {
  let file: string | null = initial;
  return {
    existsSync: () => file !== null,
    readFileSync: () => {
      if (file === null) throw new Error("ENOENT");
      return file;
    },
    appendFileSync: (_p, data) => {
      if (file === null) throw new Error("ENOENT");
      file += data;
    },
    writeFileSync: (_p, data) => {
      file = data;
    },
    content: () => file ?? "",
  };
}

const FP = "abc123";
const headerLine = `{"kind":"bench-compact.verdicts","v":1,"fingerprint":"${FP}"}`;

describe("openVerdictJournal", () => {
  it("starts a fresh journal (header written) when the file is absent", () => {
    const fs = fakeFs(null);
    const j = openVerdictJournal({ path: "/v.jsonl", fingerprint: FP, fs });
    expect(fs.content()).toBe(`${headerLine}\n`);
    expect(j.has("k")).toBe(false);
  });

  it("round-trips put → has/get and appends one line per put", () => {
    const fs = fakeFs(null);
    const j = openVerdictJournal({ path: "/v.jsonl", fingerprint: FP, fs });
    j.put("probe:A1:1:3", { axis: "E5", judgePasses: [true, true, false] });
    expect(j.has("probe:A1:1:3")).toBe(true);
    expect(j.get("probe:A1:1:3")).toEqual({ axis: "E5", judgePasses: [true, true, false] });
    expect(fs.content().split("\n").filter(Boolean)).toHaveLength(2); // header + 1 verdict
  });

  it("reloads prior verdicts on reopen with the SAME fingerprint", () => {
    const fs = fakeFs(`${headerLine}\n{"key":"k1","payload":{"a":1}}\n`);
    const j = openVerdictJournal({ path: "/v.jsonl", fingerprint: FP, fs });
    expect(j.get("k1")).toEqual({ a: 1 });
  });

  it("restarts (header rewritten, verdicts dropped) on a fingerprint mismatch", () => {
    const fs = fakeFs(`${headerLine}\n{"key":"k1","payload":1}\n`);
    let restarted = false;
    const j = openVerdictJournal({
      path: "/v.jsonl",
      fingerprint: "different",
      fs,
      onRestart: () => {
        restarted = true;
      },
    });
    expect(restarted).toBe(true);
    expect(j.has("k1")).toBe(false);
    expect(fs.content()).toBe(`{"kind":"bench-compact.verdicts","v":1,"fingerprint":"different"}\n`);
  });

  it("drops a torn tail line (power loss mid-append) and keeps earlier verdicts", () => {
    const fs = fakeFs(`${headerLine}\n{"key":"k1","payload":1}\n{"key":"k2","payl`);
    const j = openVerdictJournal({ path: "/v.jsonl", fingerprint: FP, fs });
    expect(j.has("k1")).toBe(true);
    expect(j.has("k2")).toBe(false);
  });

  it("treats a non-header first line as invalid (restart)", () => {
    const fs = fakeFs(`{"key":"k1","payload":1}\n`);
    const j = openVerdictJournal({ path: "/v.jsonl", fingerprint: FP, fs });
    expect(j.has("k1")).toBe(false);
    expect(fs.content().startsWith(headerLine)).toBe(true);
  });
});

describe("scoringFingerprint", () => {
  const base = {
    manifestJson: '{"id":"m"}',
    judgeEnsembleFields: { judgeModel: "x" },
    maxTokens: 4096,
    probesOnly: true,
    e2LongThreshold: 40,
  };
  it("is deterministic for identical inputs and stable-length", () => {
    expect(scoringFingerprint(base)).toBe(scoringFingerprint(base));
    expect(scoringFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("changes when any scored-input dimension changes", () => {
    const fp = scoringFingerprint(base);
    expect(scoringFingerprint({ ...base, manifestJson: '{"id":"m2"}' })).not.toBe(fp);
    expect(scoringFingerprint({ ...base, judgeEnsembleFields: { judgeModel: "y" } })).not.toBe(fp);
    expect(scoringFingerprint({ ...base, maxTokens: 8192 })).not.toBe(fp);
    expect(scoringFingerprint({ ...base, probesOnly: false })).not.toBe(fp);
    expect(scoringFingerprint({ ...base, e2LongThreshold: 41 })).not.toBe(fp);
  });
});
