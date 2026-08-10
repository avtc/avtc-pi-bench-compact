// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import activate from "../src/index.js";

/** A minimal fake `pi` (ExtensionAPI) that only spies on registerCommand. */
function fakePi(): { pi: ExtensionAPI; registerCommand: ReturnType<typeof vi.fn> } {
  const registerCommand = vi.fn();
  return { pi: { registerCommand } as unknown as ExtensionAPI, registerCommand };
}

/** A minimal fake command ctx that spies on `ui.notify`. */
function fakeCtx(): { ctx: ExtensionCommandContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  return { ctx: { ui: { notify } } as unknown as ExtensionCommandContext, notify };
}

describe("activate", () => {
  it("registers the /bench-compact:status command", () => {
    const { pi, registerCommand } = fakePi();
    activate(pi);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith(
      "bench-compact:status",
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });

  it("the status handler notifies 'not started'", () => {
    const { pi, registerCommand } = fakePi();
    activate(pi);
    const { ctx, notify } = fakeCtx();

    const command = registerCommand.mock.calls[0]?.[1];
    const handler = command?.handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    void handler("", ctx);

    expect(notify).toHaveBeenCalledWith("not started", "info");
  });
});
