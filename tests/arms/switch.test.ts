// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let savedMkEnv: string | undefined;
  let savedOmEnv: string | undefined;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-arm-"));
    savedMkEnv = process.env.PI_SETTINGS_MEMKEEPER;
    savedOmEnv = process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    delete process.env.PI_SETTINGS_MEMKEEPER;
    delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv("PI_SETTINGS_MEMKEEPER", savedMkEnv);
    restoreEnv("PI_OBSERVATIONAL_MEMORY_PASSIVE", savedOmEnv);
  });
  function restoreEnv(key: string, val: string | undefined): void {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

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

  it("always reloads exactly once, AFTER writing files + syncing env (R1-2/R1-5/R-3)", async () => {
    let fileWritten = false;
    let memkeeperEnvSynced = false;
    const ctx: SwitchContext = {
      reload: vi.fn(async () => {
        // by the time reload runs, BOTH the settings file AND the env must be in place.
        // Pins R1-2 (the critical premise): PI_SETTINGS_MEMKEEPER env must be set BEFORE reload
        // fires, else the stale env-first-precedence (factory.ts:184) silently overrides A4.
        fileWritten = existsSync(join(repo, ".pi", "settings.json"));
        memkeeperEnvSynced = JSON.parse(process.env.PI_SETTINGS_MEMKEEPER ?? "{}").renderMode === "observations-root";
      }),
    };
    await switchArm(ctx, "A3", repo, OPTS); // A3 sets the memkeeper env transport
    expect(fileWritten).toBe(true);
    expect(memkeeperEnvSynced).toBe(true);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });

  // --- env transport (R1-2/R1-5): avtc-pi-settings-ui reads PI_SETTINGS_MEMKEEPER env FIRST
  // (factory.ts:184), so a stale env from a prior arm silently overrides the file; OM passive is
  // env-only. switchArm must set both explicitly per arm so isolation is deterministic. ---
  it("A3/A4 set PI_SETTINGS_MEMKEEPER env to the arm's renderMode (env-first precedence)", async () => {
    await switchArm(makeCtx(), "A3", repo, OPTS);
    expect(JSON.parse(process.env.PI_SETTINGS_MEMKEEPER ?? "{}").renderMode).toBe("observations-root");
    await switchArm(makeCtx(), "A4", repo, OPTS);
    expect(JSON.parse(process.env.PI_SETTINGS_MEMKEEPER ?? "{}").renderMode).toBe("selected-root");
  });

  it("non-memkeeper arms DELETE PI_SETTINGS_MEMKEEPER (no stale override)", async () => {
    process.env.PI_SETTINGS_MEMKEEPER = JSON.stringify({ renderMode: "stale-from-A3" });
    await switchArm(makeCtx(), "A1", repo, OPTS);
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeUndefined();
  });

  it("OM arms (A2/A5) set PI_OBSERVATIONAL_MEMORY_PASSIVE=1 (self-contained, not a forgotten precondition)", async () => {
    await switchArm(makeCtx(), "A2", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");
    await switchArm(makeCtx(), "A5", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");
  });

  it("non-OM arms DELETE PI_OBSERVATIONAL_MEMORY_PASSIVE", async () => {
    process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
    await switchArm(makeCtx(), "A1", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
  });

  it("removes a stale memkeeper settings file when switching to a non-memkeeper arm (R1-7)", async () => {
    // run A3 first so .pi/ + the memkeeper file exist
    await switchArm(makeCtx(), "A3", repo, OPTS);
    const mkFile = join(repo, ".pi", "avtc-pi-memkeeper-settings.json");
    expect(existsSync(mkFile)).toBe(true);
    // switch to A1 — the stale memkeeper file must be removed (no lingering override)
    await switchArm(makeCtx(), "A1", repo, OPTS);
    expect(existsSync(mkFile)).toBe(false);
  });
});
