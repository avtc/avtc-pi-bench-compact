// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  RegisterSettingsOptions,
  registerSettingsCommand,
  SettingsHandle,
  SettingsSchema,
} from "avtc-pi-settings-ui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _setRegisterSettingsCommand, BENCH_SCHEMA, BENCH_SETTINGS_COMMAND } from "../src/config/schema.js";
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

/** Records registerSettingsCommand calls + returns a stub handle. The schema/options
 *  are captured so the activate-wiring test can assert them. */
function fakeRegisterSettingsCommand(): {
  fn: typeof registerSettingsCommand;
  calls: { schema: SettingsSchema; options: RegisterSettingsOptions }[];
} {
  const calls: { schema: SettingsSchema; options: RegisterSettingsOptions }[] = [];
  // Cast: the concrete (non-generic) arrow is assignable to the generic registerSettingsCommand.
  const fn = ((_pi: ExtensionAPI, schema: SettingsSchema, options: RegisterSettingsOptions): SettingsHandle => {
    calls.push({ schema, options });
    return { getSettings: () => ({}) } as unknown as SettingsHandle;
  }) as typeof registerSettingsCommand;
  return { fn, calls };
}

describe("activate", () => {
  // activate() calls registerBenchSettings -> the real registerSettingsCommand, which
  // needs the full settings-ui stack. Inject a fake via the seam so a minimal fakePi suffices.
  const { fn: fakeRegister, calls: registerCalls } = fakeRegisterSettingsCommand();

  beforeAll(() => {
    _setRegisterSettingsCommand(fakeRegister);
  });
  afterAll(() => {
    _setRegisterSettingsCommand(null);
  });
  beforeEach(() => {
    registerCalls.length = 0;
  });

  it("registers the /bench-compact:status command", () => {
    const { pi, registerCommand } = fakePi();
    activate(pi);

    expect(registerCommand).toHaveBeenCalledWith(
      "bench-compact:status",
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });

  it("the status handler reports config validity + 'not started'", async () => {
    const { pi, registerCommand } = fakePi();
    activate(pi);
    const { ctx, notify } = fakeCtx();

    // find the status command by name (activate now registers many commands)
    const statusCall = registerCommand.mock.calls.find((c) => c[0] === "bench-compact:status");
    const handler = statusCall?.[1]?.handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    await handler("", ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [msg, type] = notify.mock.calls[0];
    expect(type).toBe("info");
    expect(msg).toMatch(/not started/i);
    expect(msg).toMatch(/config/i);
  });

  it("registers /bench-compact:settings via registerSettingsCommand with the bench schema", () => {
    const { pi } = fakePi();
    activate(pi);

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]?.schema).toBe(BENCH_SCHEMA);
    expect(registerCalls[0]?.options.commandName).toBe(BENCH_SETTINGS_COMMAND);
    expect(registerCalls[0]?.options.title).toBe("Bench-Compact Settings");
  });
});
