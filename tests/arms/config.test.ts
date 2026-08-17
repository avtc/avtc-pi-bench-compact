// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearArmConfig, clearArmEnv, readMemkeeperGlobalSettings, writeArmConfig } from "../../src/arms/config.js";

const OPTS = { omFullReflectionThresholdTokens: 4000 };

interface EnvSnapshot {
  enabled: string | undefined;
  passive: string | undefined;
  memkeeper: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return {
    enabled: process.env.PI_OBSERVATIONAL_MEMORY_ENABLED,
    passive: process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE,
    memkeeper: process.env.PI_SETTINGS_MEMKEEPER,
  };
}

function restoreEnv(s: EnvSnapshot): void {
  for (const [key, val] of Object.entries(s)) {
    const envKey =
      key === "enabled"
        ? "PI_OBSERVATIONAL_MEMORY_ENABLED"
        : key === "passive"
          ? "PI_OBSERVATIONAL_MEMORY_PASSIVE"
          : "PI_SETTINGS_MEMKEEPER";
    if (val === undefined) delete process.env[envKey];
    else process.env[envKey] = val;
  }
}

function readSettings(repo: string): Record<string, unknown> {
  const path = join(repo, ".pi", "settings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readMemkeeperEnv(): Record<string, unknown> {
  return JSON.parse(process.env.PI_SETTINGS_MEMKEEPER ?? "{}") as Record<string, unknown>;
}

describe("arms/config — writeArmConfig writes OM settings.json observational-memory section", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-armcfg-"));
    env = snapshotEnv();
    delete process.env.PI_OBSERVATIONAL_MEMORY_ENABLED;
    delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    delete process.env.PI_SETTINGS_MEMKEEPER;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("bare-pi arm: OM disabled, no passive, no threshold", () => {
    writeArmConfig("A1", repo, OPTS);
    expect(readSettings(repo)["observational-memory"]).toEqual({ enabled: false });
  });

  it("om-default arm: OM enabled + passive, no threshold override (author-intended)", () => {
    writeArmConfig("A2", repo, OPTS);
    expect(readSettings(repo)["observational-memory"]).toEqual({ enabled: true, passive: true });
  });

  it("memkeeper arms: OM disabled (OM section present but off)", () => {
    writeArmConfig("A3", repo, OPTS);
    expect(readSettings(repo)["observational-memory"]).toEqual({ enabled: false });
  });

  it("om-full arm: OM enabled + passive + reflectionThresholdTokens injected from config", () => {
    writeArmConfig("A5", repo, OPTS);
    expect(readSettings(repo)["observational-memory"]).toEqual({
      enabled: true,
      passive: true,
      reflectionThresholdTokens: 4000,
    });
  });

  it("om-full arm respects the configured threshold value (not hardcoded)", () => {
    writeArmConfig("A5", repo, { omFullReflectionThresholdTokens: 1234 });
    const om = readSettings(repo)["observational-memory"] as { reflectionThresholdTokens?: number };
    expect(om.reflectionThresholdTokens).toBe(1234);
  });
});

describe("arms/config — writeArmConfig sets OM env deterministically (env precedence wins)", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-armenv-"));
    env = snapshotEnv();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("OM-enabled arms set ENABLED=1 + PASSIVE=1; OM-disabled arms set ENABLED=0 + PASSIVE=0 (no stale override)", () => {
    // Run an OM arm first so a stale ENABLED=1 is present, then a disabled arm must overwrite it.
    writeArmConfig("A2", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("1");
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");

    writeArmConfig("A1", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("0");
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("0");
  });

  it("memkeeper arms (OM-disabled) still set ENABLED=0 + PASSIVE=0 (deterministic)", () => {
    writeArmConfig("A3", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("0");
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("0");
  });
});

describe("arms/config — writeArmConfig sets PI_SETTINGS_MEMKEEPER env JSON per arm", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-armmk-"));
    env = snapshotEnv();
    delete process.env.PI_SETTINGS_MEMKEEPER;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("non-memkeeper arms set {enabled:false} (no stale override from a prior memkeeper arm)", () => {
    writeArmConfig("A3", repo, OPTS); // seed a memkeeper env
    expect(readMemkeeperEnv().enabled).toBe(true);

    writeArmConfig("A1", repo, OPTS); // switching to a non-memkeeper arm must clear it
    expect(readMemkeeperEnv()).toEqual({ enabled: false });
  });

  it("memkeeper-builder arm: observations-root (Selector OFF), all stages on-compaction", () => {
    writeArmConfig("A3", repo, OPTS);
    expect(readMemkeeperEnv()).toEqual({
      enabled: true,
      renderMode: "observations-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    });
  });

  it("memkeeper-selector arm: selected-root (Selector runs)", () => {
    writeArmConfig("A4", repo, OPTS);
    expect(readMemkeeperEnv()).toEqual({
      enabled: true,
      renderMode: "selected-root",
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    });
  });

  it("memkeeperGlobal merges the operator's global settings UNDER the arm pins (pins win)", () => {
    writeArmConfig("A4", repo, {
      ...OPTS,
      memkeeperGlobal: {
        llmCallTimeoutMs: 180_000,
        observerThinkingLevel: "low",
        renderMode: "observations-root", // a pin the arm must OVERRIDE
        observerModel: "local-server/Qwen3.8-27B",
      },
    });
    expect(readMemkeeperEnv()).toEqual({
      llmCallTimeoutMs: 180_000,
      observerThinkingLevel: "low",
      observerModel: "local-server/Qwen3.8-27B",
      enabled: true,
      renderMode: "selected-root", // the pin wins over the global value
      observerMode: "on-compaction",
      builderMode: "on-compaction",
      selectorMode: "on-compaction",
    });
  });

  it("non-memkeeper arm with global settings: {...global, enabled:false} (knobs ride along, stages stay off)", () => {
    writeArmConfig("A1", repo, { ...OPTS, memkeeperGlobal: { observerThinkingLevel: "low" } });
    expect(readMemkeeperEnv()).toEqual({ observerThinkingLevel: "low", enabled: false });
  });
});

describe("arms/config — readMemkeeperGlobalSettings (global file reader)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-mkglobal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses <dir>/agent/avtc-pi-memkeeper-settings.json when present", () => {
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(
      join(dir, "agent", "avtc-pi-memkeeper-settings.json"),
      JSON.stringify({ observerThinkingLevel: "low", llmCallTimeoutMs: 180_000 }),
      "utf-8",
    );
    expect(readMemkeeperGlobalSettings(dir)).toEqual({ observerThinkingLevel: "low", llmCallTimeoutMs: 180_000 });
  });

  it("returns {} when the file is absent, corrupt, or non-object", () => {
    expect(readMemkeeperGlobalSettings(dir)).toEqual({});
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "avtc-pi-memkeeper-settings.json"), "{not json", "utf-8");
    expect(readMemkeeperGlobalSettings(dir)).toEqual({});
    writeFileSync(join(dir, "agent", "avtc-pi-memkeeper-settings.json"), "[1,2]", "utf-8");
    expect(readMemkeeperGlobalSettings(dir)).toEqual({});
  });
});

describe("arms/config — writeArmConfig preserves other .pi/settings.json keys (merge)", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-armmerge-"));
    env = snapshotEnv();
    delete process.env.PI_OBSERVATIONAL_MEMORY_ENABLED;
    delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    delete process.env.PI_SETTINGS_MEMKEEPER;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("writes the observational-memory section without dropping sibling keys", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ otherKey: "keep-me" }), "utf-8");

    writeArmConfig("A2", repo, OPTS);
    const settings = readSettings(repo);
    expect(settings.otherKey).toBe("keep-me");
    expect(settings["observational-memory"]).toEqual({ enabled: true, passive: true });
  });
});

describe("arms/config — clearArmConfig teardown", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-armclear-"));
    env = snapshotEnv();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("removes the observational-memory section + all three env keys", () => {
    writeArmConfig("A2", repo, OPTS);
    expect(readSettings(repo)["observational-memory"]).toBeDefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("1");

    clearArmConfig(repo);
    expect(readSettings(repo)["observational-memory"]).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeUndefined();
  });

  it("keeps the settings.json file when it has other keys, removes it when empty", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ otherKey: "keep-me" }), "utf-8");

    writeArmConfig("A2", repo, OPTS);
    clearArmConfig(repo);
    // otherKey survives; the file is NOT removed (still has content)
    const settings = readSettings(repo);
    expect(settings["observational-memory"]).toBeUndefined();
    expect(settings.otherKey).toBe("keep-me");
    expect(existsSync(join(repo, ".pi", "settings.json"))).toBe(true);
  });

  it("removes the settings.json file when it would be empty after clearing", () => {
    writeArmConfig("A2", repo, OPTS); // creates .pi/settings.json with only observational-memory
    clearArmConfig(repo);
    expect(existsSync(join(repo, ".pi", "settings.json"))).toBe(false);
  });
});

describe("arms/config — clearArmEnv (env-only teardown, no repo)", () => {
  let repo: string;
  let env: EnvSnapshot;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-envclear-"));
    env = snapshotEnv();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    restoreEnv(env);
  });

  it("deletes all three managed env keys without touching the settings file", () => {
    writeArmConfig("A2", repo, OPTS);
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBe("1");
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBe("1");
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeDefined();
    expect(readSettings(repo)["observational-memory"]).toBeDefined();

    clearArmEnv();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeUndefined();
    // env-only: the settings.json section is NOT cleared (that's clearArmConfig's job)
    expect(readSettings(repo)["observational-memory"]).toBeDefined();
  });

  it("is a no-op when the env keys are already absent", () => {
    clearArmEnv();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_ENABLED).toBeUndefined();
    expect(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE).toBeUndefined();
    expect(process.env.PI_SETTINGS_MEMKEEPER).toBeUndefined();
  });
});
