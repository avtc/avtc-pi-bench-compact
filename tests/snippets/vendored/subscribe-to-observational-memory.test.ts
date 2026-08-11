// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type ObservationalMemoryReadyApi,
  subscribeToObservationalMemory,
} from "../../../src/snippets/vendored/subscribe-to-observational-memory.js";

/** Minimal fake pi: captures `on`/`events.on` listeners; `events.on` returns a
 *  real unsub (mirrors pi's shared eventBus); `fire` dispatches all listeners.
 *  Same shape as the canonical-consumer test in the memkeeper repo. */
interface FakePi {
  _handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  events: {
    on(event: string, handler: (...args: unknown[]) => void): () => void;
  };
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const reg = (event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  };
  const remove = (event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  };
  return {
    _handlers: handlers,
    on: (event, handler) => reg(event, handler),
    events: {
      on: (event, handler) => {
        reg(event, handler);
        return () => remove(event, handler);
      },
    },
  };
}

function fire(pi: FakePi, event: string, ...args: unknown[]): void {
  for (const h of pi._handlers.get(event) ?? []) h(...args);
}

describe("subscribeToObservationalMemory (vendored snippet)", () => {
  it("returns safe defaults before :ready fires (provider absent)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToObservationalMemory(pi as unknown as ExtensionAPI);
    expect(proxy.getConfig()).toBeNull();
    // no-op reloadConfig must not throw (with or without the optional cwd arg)
    expect(() => proxy.reloadConfig()).not.toThrow();
    expect(() => proxy.reloadConfig("/some/cwd")).not.toThrow();
  });

  it("delegates to the api after pi-observational-memory:ready fires", () => {
    const pi = makeFakePi();
    const proxy = subscribeToObservationalMemory(pi as unknown as ExtensionAPI);
    const reloadConfig = vi.fn();
    const getConfig = vi.fn(() => ({ enabled: true, passive: true }));
    const api: ObservationalMemoryReadyApi = { reloadConfig, getConfig };
    fire(pi, "pi-observational-memory:ready", api);

    proxy.reloadConfig();
    expect(reloadConfig).toHaveBeenCalledTimes(1);

    expect(proxy.getConfig()).toEqual({ enabled: true, passive: true });
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it("forwards the optional cwd argument to reloadConfig", () => {
    const pi = makeFakePi();
    const proxy = subscribeToObservationalMemory(pi as unknown as ExtensionAPI);
    const reloadConfig = vi.fn();
    fire(pi, "pi-observational-memory:ready", { reloadConfig } as ObservationalMemoryReadyApi);

    proxy.reloadConfig("/repo/cwd");
    expect(reloadConfig).toHaveBeenCalledWith("/repo/cwd");
  });

  it("returns null from getConfig when the bridge is older (no getConfig method)", () => {
    const pi = makeFakePi();
    const proxy = subscribeToObservationalMemory(pi as unknown as ExtensionAPI);
    // older provider: has reloadConfig but NOT getConfig
    fire(pi, "pi-observational-memory:ready", { reloadConfig() {} });
    expect(proxy.getConfig()).toBeNull();
    expect(() => proxy.reloadConfig()).not.toThrow();
  });

  it("session_shutdown cleans the :ready listener (reload-safe)", () => {
    const pi = makeFakePi();
    subscribeToObservationalMemory(pi as unknown as ExtensionAPI);
    // before shutdown, both listeners are registered
    expect((pi._handlers.get("pi-observational-memory:ready") ?? []).length).toBe(1);
    expect((pi._handlers.get("session_shutdown") ?? []).length).toBe(1);
    fire(pi, "session_shutdown");
    // after shutdown, the :ready listener is cleared
    expect((pi._handlers.get("pi-observational-memory:ready") ?? []).length).toBe(0);
  });
});
