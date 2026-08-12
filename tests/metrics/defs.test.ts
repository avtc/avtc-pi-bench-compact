// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  BINARY_METRICS,
  COMPARATIVE_METRICS,
  EXACT_METRICS,
  METRIC_DEFS,
  type MetricId,
} from "../../src/metrics/defs.js";

describe("METRIC_DEFS (all channels)", () => {
  it("defines every metric id exactly once (13 metrics, no dupes, no gaps)", () => {
    const ids = new Set(Object.keys(METRIC_DEFS));
    const all = [...BINARY_METRICS, ...COMPARATIVE_METRICS, ...EXACT_METRICS] as MetricId[];
    expect(ids.size).toBe(all.length);
    for (const id of all) expect(ids.has(id)).toBe(true);
  });

  it("defines the four exact metrics as lower-is-better", () => {
    for (const id of EXACT_METRICS) {
      expect(METRIC_DEFS[id].channel).toBe("exact");
      expect(METRIC_DEFS[id].polarity).toBe("lowerBetter");
    }
  });

  it("routes binary metrics to the binary channel", () => {
    for (const id of BINARY_METRICS) {
      expect(METRIC_DEFS[id].channel).toBe("binary");
    }
  });

  it("routes comparative metrics to the comparative channel + rank-lower-better polarity", () => {
    for (const id of COMPARATIVE_METRICS) {
      expect(METRIC_DEFS[id].channel).toBe("comparative");
      expect(METRIC_DEFS[id].polarity).toBe("rankLowerBetter");
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
