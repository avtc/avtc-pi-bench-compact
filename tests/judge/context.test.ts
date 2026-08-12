// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { renderDoneOps } from "../../src/judge/context.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";

const manifest = (doneOps: ScenarioManifest["doneOps"]): ScenarioManifest => ({
  id: "scen-1",
  description: "d",
  compactionBoundary: { phaseATokenBudget: 140000, plan: "build" },
  recallFacts: [],
  doneOps,
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "g", testSpec: "" },
  probes: [],
});

describe("renderDoneOps", () => {
  it("renders each doneOp with id/description/artifact + [reworkable|done] tag", () => {
    const out = renderDoneOps(
      manifest([
        {
          id: "do1",
          description: "market-pricing loop",
          artifact: "src/economy/market.ts",
          reworkable: false,
          entryIds: ["e3"],
          lanes: [],
        },
        {
          id: "do2",
          description: "save prototype",
          artifact: "src/save/old.ts",
          reworkable: true,
          entryIds: ["e8"],
          lanes: [],
        },
      ]),
    );
    expect(out).toBe(
      "  - do1: market-pricing loop (src/economy/market.ts) [done]\n  - do2: save prototype (src/save/old.ts) [reworkable]",
    );
  });

  it("returns a '(none)' placeholder when there are no doneOps", () => {
    expect(renderDoneOps(manifest([]))).toBe("  (none)");
  });
});
