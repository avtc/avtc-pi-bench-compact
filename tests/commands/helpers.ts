// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { vi } from "vitest";

/** The minimal command-handler ctx surface the run commands need (mode/hasUI/ui +
 *  switchSession). {@link ExtensionCommandContext} satisfies this structurally. */
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
 *  by the run/run-scenario/run-session-file/run-shared command tests. */
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
