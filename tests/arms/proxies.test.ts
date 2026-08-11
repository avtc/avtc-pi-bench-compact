// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryProxies, getMemoryProxies, setMemoryProxies } from "../../src/arms/proxies.js";

const GLOBAL_KEY = "__benchCompactMemoryProxies";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
});

describe("arms/proxies — globalThis cache", () => {
  it("getMemoryProxies returns null when no proxies are cached", () => {
    expect(getMemoryProxies()).toBeNull();
  });

  it("setMemoryProxies caches + getMemoryProxies returns them", () => {
    const om = { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({})) };
    const mk = { reloadConfig: vi.fn(), getConfig: vi.fn(() => ({})) };
    setMemoryProxies({ om, mk });
    expect(getMemoryProxies()).toEqual({ om, mk });
  });

  it("setMemoryProxies overwrites a prior cache", () => {
    setMemoryProxies({
      om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => 1) },
      mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => 1) },
    });
    const next = {
      om: { reloadConfig: vi.fn(), getConfig: vi.fn(() => 2) },
      mk: { reloadConfig: vi.fn(), getConfig: vi.fn(() => 2) },
    };
    setMemoryProxies(next);
    expect(getMemoryProxies()).toBe(next);
  });

  it("clearMemoryProxies empties the cache", () => {
    setMemoryProxies({
      om: { reloadConfig: vi.fn(), getConfig: vi.fn() },
      mk: { reloadConfig: vi.fn(), getConfig: vi.fn() },
    });
    clearMemoryProxies();
    expect(getMemoryProxies()).toBeNull();
  });
});
