// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Tests for the durable Phase-1 walls store (runs/<runId>/phase1-walls.json):
// absent/corrupt files degrade to {}, writes merge per arm.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPhase1Walls, writePhase1Walls } from "../../src/storage/phase1-walls.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-walls-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("phase1-walls store", () => {
  it("reads {} when the file is absent, corrupt, or non-object", () => {
    expect(readPhase1Walls(join(dir, "walls.json"))).toEqual({});
    writeFileSync(join(dir, "corrupt.json"), "{oops");
    expect(readPhase1Walls(join(dir, "corrupt.json"))).toEqual({});
    writeFileSync(join(dir, "arr.json"), "[1]");
    expect(readPhase1Walls(join(dir, "arr.json"))).toEqual({});
  });

  it("reads only finite number entries (anything else dropped)", () => {
    writeFileSync(join(dir, "walls.json"), JSON.stringify({ A1: 1000, A2: "x", A3: null }));
    expect(readPhase1Walls(join(dir, "walls.json"))).toEqual({ A1: 1000 });
  });

  it("write merges per arm (a resume re-compacting one arm updates just it)", () => {
    const path = join(dir, "walls.json");
    writePhase1Walls(path, { A1: 155_180, A3: 345_474 });
    writePhase1Walls(path, { A3: 789_579 });
    expect(readPhase1Walls(path)).toEqual({ A1: 155_180, A3: 789_579 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ A1: 155_180, A3: 789_579 });
  });
});
