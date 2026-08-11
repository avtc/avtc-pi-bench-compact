// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARNESS_PACKAGE, MEMKEEPER_PACKAGE, OM_PACKAGE, SUITE_PACKAGES } from "../../src/arms/definitions.js";
import { buildMemkeeperSettings, buildProjectSettings, type SwitchContext, switchArm } from "../../src/arms/switch.js";

const OPTS = { omFullReflectionThresholdTokens: 4000 };

describe("arms/switch — buildProjectSettings (.pi/settings.json content)", () => {
  it("A1: packages = suite + harness, no observational-memory section", () => {
    const s = buildProjectSettings("A1", OPTS);
    expect(s.packages).toEqual([...SUITE_PACKAGES, HARNESS_PACKAGE]);
    expect(s["observational-memory"]).toBeUndefined();
  });

  it("A2: packages add OM, but NO threshold override (author-intended)", () => {
    const s = buildProjectSettings("A2", OPTS);
    expect(s.packages).toEqual([...SUITE_PACKAGES, HARNESS_PACKAGE, OM_PACKAGE]);
    expect(s["observational-memory"]).toBeUndefined();
  });

  it("A3/A4: packages add memkeeper, no observational-memory section", () => {
    for (const arm of ["A3", "A4"] as const) {
      const s = buildProjectSettings(arm, OPTS);
      expect(s.packages).toEqual([...SUITE_PACKAGES, HARNESS_PACKAGE, MEMKEEPER_PACKAGE]);
      expect(s["observational-memory"]).toBeUndefined();
    }
  });

  it("A5: packages add OM + observational-memory.reflectionThresholdTokens injected from config", () => {
    const s = buildProjectSettings("A5", OPTS);
    expect(s.packages).toEqual([...SUITE_PACKAGES, HARNESS_PACKAGE, OM_PACKAGE]);
    expect(s["observational-memory"]).toEqual({ reflectionThresholdTokens: 4000 });
  });

  it("A5 respects the configured threshold value (not hardcoded)", () => {
    const s = buildProjectSettings("A5", { omFullReflectionThresholdTokens: 1234 });
    expect(s["observational-memory"]?.reflectionThresholdTokens).toBe(1234);
  });

  it("packages is always a PackageSource[] of strings", () => {
    for (const arm of ["A1", "A2", "A3", "A4", "A5"] as const) {
      const pkgs = buildProjectSettings(arm, OPTS).packages;
      for (const p of pkgs) expect(typeof p).toBe("string");
    }
  });
});

describe("arms/switch — buildMemkeeperSettings (.pi/avtc-pi-memkeeper-settings.json)", () => {
  it("A3 → observations-root, all modes on-compaction", () => {
    const mk = buildMemkeeperSettings("A3");
    expect(mk).toEqual({
      renderMode: "observations-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    });
  });

  it("A4 → selected-root (Selector runs)", () => {
    expect(buildMemkeeperSettings("A4")?.renderMode).toBe("selected-root");
  });

  it("A1/A2/A5 → null (no memkeeper settings file)", () => {
    expect(buildMemkeeperSettings("A1")).toBeNull();
    expect(buildMemkeeperSettings("A2")).toBeNull();
    expect(buildMemkeeperSettings("A5")).toBeNull();
  });
});

describe("arms/switch — switchArm writes files + reloads", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-arm-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function makeCtx(): SwitchContext & { reloadCalls: number } {
    const ctx = {
      reloadCalls: 0,
      reload: vi.fn(async () => {
        ctx.reloadCalls++;
      }),
    };
    return ctx;
  }

  it("writes .pi/settings.json (packages) + calls reload()", async () => {
    const ctx = makeCtx();
    await switchArm(ctx, "A1", repo, OPTS);
    const settings = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf-8"));
    expect(settings.packages).toEqual([...SUITE_PACKAGES, HARNESS_PACKAGE]);
    expect(ctx.reloadCalls).toBe(1);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });

  it("A3 writes BOTH .pi/settings.json AND .pi/avtc-pi-memkeeper-settings.json", async () => {
    await switchArm(makeCtx(), "A3", repo, OPTS);
    const settings = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf-8"));
    expect(settings.packages).toContain(MEMKEEPER_PACKAGE);
    const mk = JSON.parse(readFileSync(join(repo, ".pi", "avtc-pi-memkeeper-settings.json"), "utf-8"));
    expect(mk.renderMode).toBe("observations-root");
  });

  it("A1 does NOT create a memkeeper settings file", async () => {
    await switchArm(makeCtx(), "A1", repo, OPTS);
    expect(existsSync(join(repo, ".pi", "avtc-pi-memkeeper-settings.json"))).toBe(false);
  });

  it("A5 writes the threshold into .pi/settings.json observational-memory section", async () => {
    await switchArm(makeCtx(), "A5", repo, { omFullReflectionThresholdTokens: 7000 });
    const settings = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf-8"));
    expect(settings["observational-memory"]).toEqual({ reflectionThresholdTokens: 7000 });
  });

  it("A4 memkeeper file has selected-root", async () => {
    await switchArm(makeCtx(), "A4", repo, OPTS);
    const mk = JSON.parse(readFileSync(join(repo, ".pi", "avtc-pi-memkeeper-settings.json"), "utf-8"));
    expect(mk.renderMode).toBe("selected-root");
  });

  it("always reloads exactly once, after writing", async () => {
    let written = false;
    const ctx: SwitchContext = {
      reload: vi.fn(async () => {
        // by the time reload runs, the settings file must already be on disk
        written = existsSync(join(repo, ".pi", "settings.json"));
      }),
    };
    await switchArm(ctx, "A3", repo, OPTS);
    expect(written).toBe(true);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });
});
