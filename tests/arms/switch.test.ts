// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARM_DEFS } from "../../src/arms/definitions.js";
import { clearMemoryProxies, type MemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";
import {
  ArmIsolationError,
  BUILTIN_TOOLS,
  configureArm,
  isolateArmOrStop,
  SUITE_TOOLS,
} from "../../src/arms/switch.js";

const OPTS = { omFullReflectionThresholdTokens: 4000 };

/** A fake tool-set context with a setActiveTools spy (mirrors pi.setActiveTools). */
function makeToolCtx() {
  return { setActiveTools: vi.fn<(toolNames: string[]) => void>() };
}

/** A fake config proxy: reloadConfig spy + getConfig returning a non-null snapshot (provider live). */
function makeProxy(live: boolean) {
  return {
    reloadConfig: vi.fn<() => void>(),
    getConfig: vi.fn<() => unknown>(() => (live ? { enabled: true } : null)),
  };
}

function expectedAllowlist(arm: keyof typeof ARM_DEFS): string[] {
  return [...BUILTIN_TOOLS, ...SUITE_TOOLS, ...ARM_DEFS[arm].memoryTools];
}

describe("arms/switch — tool allowlist constants", () => {
  it("BUILTIN_TOOLS = the full pi default coding tool set", () => {
    expect(BUILTIN_TOOLS).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  });

  it("SUITE_TOOLS = todo + user-decisions agent tools (portrait + notification expose none)", () => {
    expect(SUITE_TOOLS).toEqual([
      "todo_init",
      "todo_add",
      "todo_move",
      "todo_list",
      "todo_complete",
      "user_decision_add",
      "user_decision_list",
      "user_decision_detail",
    ]);
  });
});

describe("arms/switch — configureArm writes config, reloads both proxies, sets the allowlist", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-switch-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  for (const arm of ["A1", "A2", "A3", "A4", "A5"] as const) {
    it(`${arm}: calls both reloadConfig + setActiveTools with builtins+suite+arm.memoryTools`, () => {
      const toolCtx = makeToolCtx();
      const om = makeProxy(true);
      const mk = makeProxy(true);

      configureArm(toolCtx, om, mk, arm, repo, OPTS);

      expect(om.reloadConfig).toHaveBeenCalledTimes(1);
      expect(mk.reloadConfig).toHaveBeenCalledTimes(1);
      expect(toolCtx.setActiveTools).toHaveBeenCalledTimes(1);
      expect(toolCtx.setActiveTools).toHaveBeenCalledWith(expectedAllowlist(arm));
    });
  }

  it("configureArm is sync (no await needed) — reloadConfig/setActiveTools are sync", () => {
    const toolCtx = makeToolCtx();
    const om = makeProxy(true);
    const mk = makeProxy(true);
    // Calling without await must typecheck + work (the return is void, not a Promise).
    const result: unknown = configureArm(toolCtx, om, mk, "A1", repo, OPTS);
    expect(result).toBeUndefined();
  });
});

describe("arms/switch — configureArm presence check (stop-and-surface)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-switch-presence-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("throws when an OM-enabled arm's OM proxy is not live (getConfig null)", () => {
    const toolCtx = makeToolCtx();
    const omAbsent = makeProxy(false); // getConfig() === null
    const mk = makeProxy(true);
    expect(() => configureArm(toolCtx, omAbsent, mk, "A2", repo, OPTS)).toThrow(/observational-memory/i);
    expect(() => configureArm(toolCtx, omAbsent, mk, "A5", repo, OPTS)).toThrow(/observational-memory/i);
  });

  it("throws when a session-owl-enabled arm's session-owl proxy is not live (getConfig null)", () => {
    const toolCtx = makeToolCtx();
    const om = makeProxy(true);
    const mkAbsent = makeProxy(false);
    expect(() => configureArm(toolCtx, om, mkAbsent, "A3", repo, OPTS)).toThrow(/session-owl/i);
    expect(() => configureArm(toolCtx, om, mkAbsent, "A4", repo, OPTS)).toThrow(/session-owl/i);
  });

  it("does NOT throw for a disabled arm whose proxy is absent (A1 — both disabled)", () => {
    const toolCtx = makeToolCtx();
    // both proxies absent — fine, because neither extension is enabled for A1
    expect(() => configureArm(toolCtx, makeProxy(false), makeProxy(false), "A1", repo, OPTS)).not.toThrow();
    expect(toolCtx.setActiveTools).toHaveBeenCalledWith(expectedAllowlist("A1"));
  });

  it("throws AFTER writeArmConfig + reloadConfig ran (presence check is post-reload, not a guard)", () => {
    const toolCtx = makeToolCtx();
    const om = makeProxy(false); // OM absent
    const mk = makeProxy(true);
    // A2 enables OM → throws; but reloadConfig on both proxies still fired (reload is unconditional).
    expect(() => configureArm(toolCtx, om, mk, "A2", repo, OPTS)).toThrow();
    expect(om.reloadConfig).toHaveBeenCalledTimes(1);
    expect(mk.reloadConfig).toHaveBeenCalledTimes(1);
  });
});

describe("arms/switch — isolateArmOrStop (shared per-phase isolation sequence)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-isolate-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    clearMemoryProxies();
  });

  /** A stop factory that records its calls (mirrors the phase-specific *StoppedError builder). */
  function makeStopFactory() {
    const calls: Array<{ reason: string; message: string }> = [];
    const stop = (message: string): Error => {
      calls.push({ reason: "config-failed", message });
      return new Error(`STOP(${message})`);
    };
    return { stop, calls };
  }

  it("throws the stop error when the memory proxies are not cached (null)", () => {
    const { stop, calls } = makeStopFactory();
    clearMemoryProxies();
    expect(() => isolateArmOrStop(makeToolCtx(), "A1", repo, OPTS, "arm A1", stop)).toThrow(/STOP/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toMatch(/has not cached the memory proxies/);
    expect(calls[0]?.message).toContain("arm A1");
  });

  it("calls configureArm when proxies are cached (reloadConfig + setActiveTools fire)", () => {
    const toolCtx = makeToolCtx();
    const om = makeProxy(true);
    const mk = makeProxy(true);
    setMemoryProxies({ om, mk } as unknown as MemoryProxies);
    isolateArmOrStop(toolCtx, "A1", repo, OPTS, "arm A1", makeStopFactory().stop);
    expect(om.reloadConfig).toHaveBeenCalledTimes(1);
    expect(mk.reloadConfig).toHaveBeenCalledTimes(1);
    expect(toolCtx.setActiveTools).toHaveBeenCalledWith(expectedAllowlist("A1"));
  });

  it("maps an ArmIsolationError from configureArm → stop error (provider-not-live message)", () => {
    const { stop, calls } = makeStopFactory();
    // OM-enabled arm (A2) but OM proxy not live → configureArm throws ArmIsolationError.
    setMemoryProxies({ om: makeProxy(false), mk: makeProxy(true) } as unknown as MemoryProxies);
    expect(() => isolateArmOrStop(makeToolCtx(), "A2", repo, OPTS, "arm A2 attempt 1", stop)).toThrow(/STOP/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toMatch(/observational-memory is enabled but its extension proxy is not live/);
    expect(calls[0]?.message).toContain("pi-observational-memory");
    expect(calls[0]?.message).toContain("arm A2 attempt 1");
  });

  it("re-throws a non-ArmIsolationError from configureArm as-is (not wrapped in the stop error)", () => {
    // configureArm itself doesn't throw arbitrary errors, but the helper's contract is to
    // pass through anything that isn't ArmIsolationError. Simulate via a toolCtx that throws.
    const throwingToolCtx = {
      setActiveTools: vi.fn<() => void>(() => {
        throw new TypeError("boom");
      }),
    };
    setMemoryProxies({ om: makeProxy(true), mk: makeProxy(true) } as unknown as MemoryProxies);
    // A1 (both disabled) passes the presence check, then setActiveTools throws in step 4.
    expect(() => isolateArmOrStop(throwingToolCtx, "A1", repo, OPTS, "arm A1", makeStopFactory().stop)).toThrow(
      TypeError,
    );
    expect(() => isolateArmOrStop(throwingToolCtx, "A1", repo, OPTS, "arm A1", makeStopFactory().stop)).toThrow(/boom/);
  });

  it("ArmIsolationError is exported (the helper maps it internally)", () => {
    // Sanity: the class the helper catches is the same one configureArm throws.
    const err = new ArmIsolationError("A2", "observational-memory", "msg");
    expect(err).toBeInstanceOf(ArmIsolationError);
    expect(err.provider).toBe("observational-memory");
  });
});
