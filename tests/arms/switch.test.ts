// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARM_DEFS } from "../../src/arms/definitions.js";
import { BUILTIN_TOOLS, configureArm, SUITE_TOOLS } from "../../src/arms/switch.js";

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

  it("throws when a memkeeper-enabled arm's memkeeper proxy is not live (getConfig null)", () => {
    const toolCtx = makeToolCtx();
    const om = makeProxy(true);
    const mkAbsent = makeProxy(false);
    expect(() => configureArm(toolCtx, om, mkAbsent, "A3", repo, OPTS)).toThrow(/memkeeper/i);
    expect(() => configureArm(toolCtx, om, mkAbsent, "A4", repo, OPTS)).toThrow(/memkeeper/i);
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
