// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { METRIC_DEFS } from "../../src/metrics/defs.js";

describe("METRIC_DEFS (exact-cost channel)", () => {
  it("defines the four exact metrics as lower-is-better", () => {
    const exactIds = Object.keys(METRIC_DEFS).sort();
    expect(exactIds).toEqual(["C1", "C2", "C3", "C4"]);
    for (const id of exactIds) {
      expect(METRIC_DEFS[id].channel).toBe("exact");
      expect(METRIC_DEFS[id].polarity).toBe("lowerBetter");
    }
  });

  it("pins the footprint description to the shared chars-per-token estimate", () => {
    const desc = METRIC_DEFS.C1.desc.toLowerCase();
    // The description must name the token-estimate convention so the footprint
    // number is comparable across arms + runs.
    expect(desc).toContain("chars");
    expect(desc).toContain("token");
  });
});
