// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  appendAttempt,
  appendProbe,
  appendProbeAttempt,
  buildArmBaseBranch,
  buildCfgId,
  type RunConfig,
  shortGitVersion,
  shortNpmVersion,
} from "../../src/storage/branches.js";

describe("version-token formatters", () => {
  it("shortGitVersion = 'g' + first 6 hex of the commit (e.g. g4a2f8e)", () => {
    expect(shortGitVersion("4a2f8e9abcdef0123")).toBe("g4a2f8e");
    expect(shortGitVersion("abcdef0")).toBe("gabcdef");
  });
  it("shortNpmVersion = 'npm' + version", () => {
    expect(shortNpmVersion("1.2.3")).toBe("npm1.2.3");
    expect(shortNpmVersion("0.4.1-beta.0")).toBe("npm0.4.1-beta.0");
  });
});

describe("branch naming", () => {
  const common = { date: "2026-08-10", id: 1, cfgId: "cfg-a3f2c1" };

  it("buildArmBaseBranch: arm-{tool}-{ver}", () => {
    expect(buildArmBaseBranch({ ...common, tool: "memkeeper-builder", ver: "g4a2f8e" })).toBe(
      "bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-memkeeper-builder-g4a2f8e",
    );
  });
  it("A1 (bare-pi) OMITS {ver} (no tool version)", () => {
    expect(buildArmBaseBranch({ ...common, tool: "bare-pi", ver: undefined })).toBe(
      "bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-bare-pi",
    );
  });
  it("appendAttempt: appends the -{attemptN} suffix to any base branch (single source)", () => {
    expect(appendAttempt("bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c", 7)).toBe(
      "bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c-7",
    );
  });
  it("appendProbe: appends the -probe-{probeId} suffix to any base branch (single source)", () => {
    expect(appendProbe("bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c", "p2")).toBe(
      "bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c-probe-p2",
    );
  });
  it("appendProbeAttempt: appends the -probe-{probeId}-{attemptN} suffix (probes fork N× per arm)", () => {
    expect(appendProbeAttempt("bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c", "p2", 3)).toBe(
      "bench-compact/run-2026-08-10-1/cfg-a3f2c1/arm-om-default-g1a2b3c-probe-p2-3",
    );
  });
});

describe("buildCfgId (run-condition fingerprint)", () => {
  const base: RunConfig = {
    evaluatedModel: "zai/glm-5.1",
    evaluatedThinkingLevel: "high",
    judgeModel: "anthropic/claude-sonnet-4",
    judgeThinkingLevel: "high",
    judgesNumber: 1,
    judge2Model: null,
    judge2ThinkingLevel: "high",
    judge3Model: null,
    judge3ThinkingLevel: "high",
    N: 10,
    compactionBoundary: 140000,
    armsEnabled: ["A1", "A2", "A3", "A4", "A5"],
    omFullReflectionThresholdTokens: 4000,
    backupMode: "build",
    fastEval: "off",
    latentProbes: "off",
    toolVersions: {
      A2: { source: "git", commit: "g1a2b3c", full: "1a2b3c4d5e6f" },
      A3: { source: "git", commit: "g4a2f8e", full: "4a2f8e9abcdef" },
      A4: { source: "git", commit: "g9z8y7x", full: "9z8y7x6w5v4u" },
      A5: { source: "git", commit: "g0f1e2d", full: "0f1e2d3c4b5a" },
    },
  };

  it("is deterministic: same config ⇒ same cfgId", () => {
    expect(buildCfgId(base)).toBe(buildCfgId(structuredClone(base)));
  });

  it("format is cfg-<6 hex>", () => {
    expect(buildCfgId(base)).toMatch(/^cfg-[0-9a-f]{6}$/);
  });

  it("differs when an arm's tool version differs", () => {
    const changed = structuredClone(base);
    changed.toolVersions.A3 = { source: "git", commit: "gNEW123", full: "newhash123456" };
    expect(buildCfgId(changed)).not.toBe(buildCfgId(base));
  });

  it("differs when a scalar (N) differs", () => {
    const changed = { ...base, N: 5 };
    expect(buildCfgId(changed)).not.toBe(buildCfgId(base));
  });

  it("differs when a judge-ensemble field differs (judgesNumber)", () => {
    const changed = { ...base, judgesNumber: 3 };
    expect(buildCfgId(changed)).not.toBe(buildCfgId(base));
  });

  it("differs when a judge-2/3 model is set", () => {
    const changed = { ...base, judge2Model: "zai/glm-4.6", judge3Model: "anthropic/claude" };
    expect(buildCfgId(changed)).not.toBe(buildCfgId(base));
  });

  it("armsEnabled order does NOT change the cfgId (same set)", () => {
    const reordered = { ...base, armsEnabled: [...base.armsEnabled].reverse() };
    expect(buildCfgId(reordered)).toBe(buildCfgId(base));
  });

  it("A1 (bare-pi, no toolVersions entry) is fingerprinted too (its absence is stable)", () => {
    // base already omits A1 from toolVersions — re-run is stable
    expect(buildCfgId(base)).toBe(buildCfgId(structuredClone(base)));
  });
});
