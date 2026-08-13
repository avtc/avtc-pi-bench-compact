// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureTrace, type RunTrace } from "../../src/orchestrate/trace.js";

type Usage = NonNullable<CompactionEntry["usage"]>;

function makeUsage(input: number, output: number): Usage {
  const total = input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: input * 0.000001, output: output * 0.000001, cacheRead: 0, cacheWrite: 0, total: total * 0.000001 },
  };
}

function eBase(id: string, parentId: string | null) {
  return { id, parentId, timestamp: "2026-08-11T00:00:00.000Z" };
}

function msgEntry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry {
  return {
    type: "message",
    ...eBase(id, parentId),
    message: { role, content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, parentId: string | null, summary: string, usage: Usage): CompactionEntry {
  return {
    type: "compaction",
    ...eBase(id, parentId),
    summary,
    firstKeptEntryId: "kept-1",
    tokensBefore: 150000,
    usage,
    fromHook: true,
  } as CompactionEntry;
}

function writeJsonl(file: string, entries: object[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(file, lines, "utf8");
}

describe("captureTrace", () => {
  let dir: string;
  let sessionFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-trace-"));
    sessionFile = join(dir, "main.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the branch session file → entries + compactions paired with bench wallMs", () => {
    const c1 = compactionEntry("c1", null, "first compaction summary", makeUsage(1000, 500));
    const c2 = compactionEntry("c2", "m1", "second compaction summary", makeUsage(2000, 800));
    writeJsonl(sessionFile, [
      msgEntry("m0", null, "user", "build the game"),
      c1,
      msgEntry("m1", "c1", "assistant", "continued work"),
      c2,
      msgEntry("m2", "c2", "assistant", "more work"),
    ]);
    const wallMs = new Map<string, number>([
      ["c1", 4200],
      ["c2", 9800],
    ]);

    const trace = captureTrace(sessionFile, "bench-compact/run-x/cfg-y/arm-bare-pi-1", wallMs);

    expect(trace.branch).toBe("bench-compact/run-x/cfg-y/arm-bare-pi-1");
    expect(trace.tracePath).toBe(sessionFile);
    // entries carry every SessionEntry (messages + compactions), in file order.
    expect(trace.entries.map((e) => e.id)).toEqual(["m0", "c1", "m1", "c2", "m2"]);
    // compactions are the CompactionEntrys with usage, paired with bench wallMs.
    expect(trace.compactions).toHaveLength(2);
    const [p1, p2] = trace.compactions;
    expect(p1.entry.id).toBe("c1");
    expect(p1.entry.summary).toBe("first compaction summary");
    expect(p1.entry.usage).toEqual(makeUsage(1000, 500));
    expect(p1.wallMs).toBe(4200);
    expect(p2.entry.id).toBe("c2");
    expect(p2.entry.usage).toEqual(makeUsage(2000, 800));
    expect(p2.wallMs).toBe(9800);
  });

  it("a compaction with no bench-captured wallMs pairs with wallMs 0 (graceful)", () => {
    const c1 = compactionEntry("c1", null, "summary", makeUsage(100, 50));
    writeJsonl(sessionFile, [c1]);
    const trace = captureTrace(sessionFile, "branch-x", new Map());

    expect(trace.compactions).toHaveLength(1);
    expect(trace.compactions[0]?.entry.id).toBe("c1");
    expect(trace.compactions[0]?.wallMs).toBe(0);
  });

  it("a compaction whose usage is absent still appears (usage undefined, not dropped)", () => {
    const noUsage = { ...compactionEntry("c0", null, "no-usage summary", makeUsage(0, 0)), usage: undefined };
    writeJsonl(sessionFile, [noUsage]);
    const trace = captureTrace(sessionFile, "branch-x", new Map([["c0", 100]]));

    expect(trace.compactions).toHaveLength(1);
    expect(trace.compactions[0]?.entry.usage).toBeUndefined();
    expect(trace.compactions[0]?.wallMs).toBe(100);
  });

  it("a branch with no compactions yields an empty compactions array", () => {
    writeJsonl(sessionFile, [msgEntry("m0", null, "user", "hi"), msgEntry("m1", "m0", "assistant", "hello")]);
    const trace = captureTrace(sessionFile, "branch-x", new Map());
    expect(trace.compactions).toEqual([]);
    expect(trace.entries.map((e) => e.id)).toEqual(["m0", "m1"]);
  });

  it("RunTrace shape is the structured trace (entries + compactions + branch + tracePath)", () => {
    const c1 = compactionEntry("c1", null, "s", makeUsage(1, 1));
    writeJsonl(sessionFile, [c1]);
    const trace: RunTrace = captureTrace(sessionFile, "branch-x", new Map([["c1", 7]]));
    // static shape check — compactions carry the CompactionEntry + wallMs pair.
    const pair = trace.compactions[0];
    expect(pair).toBeDefined();
    if (pair === undefined) return;
    expect(pair.entry.type).toBe("compaction");
    expect(typeof pair.wallMs).toBe("number");
  });
});
