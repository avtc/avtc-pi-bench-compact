// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { vi } from "vitest";

/** The minimal command-handler ctx surface the run commands need (mode/hasUI/ui +
 * switchSession). {@link ExtensionCommandContext} satisfies this structurally. */
export interface FakeCommandCtx {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly ui: {
    notify: (msg: string, level: string) => void;
    setWidget: (key: string, content: unknown, opts: { placement: string }) => void;
  };
  switchSession: (
    sessionPath: string,
    options?: { withSession?: (ctx: unknown) => Promise<void> },
  ) => Promise<{ cancelled: boolean }>;
}

/** A capturing fake command ctx: records every notify + stubs switchSession. Shared
 * by the run/run-scenario/run-session-file/run-shared command tests. */
export function fakeCommandCtx(opts: { mode?: string; hasUI?: boolean } = {}): {
  ctx: FakeCommandCtx;
  notifies: { msg: string; level: string }[];
} {
  const notifies: { msg: string; level: string }[] = [];
  return {
    notifies,
    ctx: {
      mode: opts.mode ?? "tui",
      hasUI: opts.hasUI ?? true,
      ui: {
        notify: (msg: string, level: string): void => {
          notifies.push({ msg, level });
        },
        setWidget: (): void => {},
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    },
  };
}

/** A fake command ctx modeling pi's GUARDED ctx getters: after `invalidate()` (what
 * switchSession → runner.invalidate does), every getter access (ui/mode/hasUI)
 * throws "stale" — exactly like runner.js createContext's assertActive guards.
 * Handlers that capture the UI surface EAGERLY keep working after invalidation;
 * lazy ctx.ui readers throw (the regression the guard catches). */
export function fakeGuardedCtx(): {
  ctx: FakeCommandCtx;
  invalidate: () => void;
  notifies: { msg: string; level: string }[];
} {
  const notifies: { msg: string; level: string }[] = [];
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new Error("This extension ctx is stale after session replacement");
  };
  const ui = {
    notify: (msg: string, level: string): void => {
      notifies.push({ msg, level });
    },
    setWidget: (): void => {},
  };
  return {
    notifies,
    invalidate: (): void => {
      active = false;
    },
    ctx: {
      get mode(): string {
        assertActive();
        return "tui";
      },
      get hasUI(): boolean {
        assertActive();
        return true;
      },
      get ui(): FakeCommandCtx["ui"] {
        assertActive();
        return ui;
      },
      switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    },
  };
}
