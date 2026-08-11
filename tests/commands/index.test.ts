// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBenchCommands } from "../../src/commands/index.js";
import { _setHandleForTest } from "../../src/config/accessor.js";

interface Captured {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakeHandle(raw: Record<string, unknown>) {
  return { getSettings: () => raw } as never;
}

/** Fake pi: captures registered commands + spies sendUserMessage. */
function fakePi(): { pi: ExtensionAPI; commands: Map<string, Captured>; sent: { text: string; deliverAs?: string }[] } {
  const commands = new Map<string, Captured>();
  const sent: { text: string; deliverAs?: string }[] = [];
  const pi = {
    registerCommand(name: string, opts: Captured) {
      commands.set(name, opts);
    },
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, sent };
}

function fakeCtx(): { ctx: ExtensionCommandContext; notifies: { msg: string; type?: string }[] } {
  const notifies: { msg: string; type?: string }[] = [];
  const ctx = {
    ui: { notify: (msg: string, type?: string) => notifies.push({ msg, type }) },
    abort: () => {},
  } as unknown as ExtensionCommandContext;
  return { ctx, notifies };
}

function handlerOf(
  commands: Map<string, Captured>,
  name: string,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  const c = commands.get(name);
  if (!c) throw new Error(`missing command ${name}`);
  return c.handler;
}

const ALL_COMMANDS = [
  "bench-compact:prepare-scenario",
  "bench-compact:run-scenario",
  "bench-compact:run",
  "bench-compact:run-session-file",
  "bench-compact:pause",
  "bench-compact:resume",
  "bench-compact:abort",
  "bench-compact:status",
  "bench-compact:results",
];

describe("registerBenchCommands", () => {
  beforeEach(() => _setHandleForTest(fakeHandle({})));
  afterEach(() => _setHandleForTest(null));

  it("registers every §3.13 command (except settings, wired separately)", () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    for (const name of ALL_COMMANDS) {
      expect(commands.has(name), `${name} registered`).toBe(true);
    }
    // settings is NOT registered here (Task 2 owns it)
    expect(commands.has("bench-compact:settings")).toBe(false);
  });

  it("prepare-scenario surfaces the Task-19 live-wiring error for a valid idea (real command, not stub)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:prepare-scenario")("a tycoon idea", ctx);
    // defaultBuildPrepareDeps throws NotImplemented (Task 19 wires the live seams)
    expect(notifies.some((n) => /Task 19|prepare failed/i.test(n.msg))).toBe(true);
  });

  it("stub handler surfaces a preflight failure as a warning", async () => {
    // 0 arms enabled -> config invalid
    _setHandleForTest(
      fakeHandle({
        armBarePiEnabled: false,
        armOmDefaultEnabled: false,
        armMemkeeperObservationsRootEnabled: false,
        armMemkeeperSelectedRootEnabled: false,
        armOmFullEnabled: false,
      }),
    );
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:prepare-scenario")("an idea", ctx);
    expect(notifies.some((n) => /arm/i.test(n.msg) && n.type === "warning")).toBe(true);
  });

  it("pause steers the live agent ('wait, stop') + aborts", async () => {
    const { pi, commands, sent } = fakePi();
    registerBenchCommands(pi);
    const { ctx } = fakeCtx();
    await handlerOf(commands, "bench-compact:pause")("", ctx);
    expect(sent).toContainEqual({ text: "wait, stop", deliverAs: "steer" });
  });

  it("abort is a real minimal handler that notifies without throwing (R1-1)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:abort")("", ctx);
    // R2-3: assert message content (sibling handlers all assert content, not just length)
    expect(notifies.some((n) => /abort/i.test(n.msg))).toBe(true);
  });

  it("every stub command body runs preflight then notifies 'not implemented' (R4-1)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    // run-scenario/run-session-file need a real existing path (preflight checks
    // existence via existsSync); use this test file's own dir/file.
    const dir = import.meta.dirname;
    const file = import.meta.filename;
    const cases: [string, string][] = [
      ["bench-compact:run", "an incremental game idea"],
      ["bench-compact:run-scenario", dir],
      ["bench-compact:run-session-file", file],
      ["bench-compact:results", "run-2026-08-10-1"],
    ];
    for (const [name, args] of cases) {
      notifies.length = 0;
      await handlerOf(commands, name)(args, ctx);
      expect(
        notifies.some((n) => /not implemented/i.test(n.msg)),
        `${name} should notify 'not implemented'`,
      ).toBe(true);
    }
  });

  it("resume sends 'continue' to the agent", async () => {
    const { pi, commands, sent } = fakePi();
    registerBenchCommands(pi);
    const { ctx } = fakeCtx();
    await handlerOf(commands, "bench-compact:resume")("", ctx);
    expect(sent.some((s) => s.text === "continue")).toBe(true);
  });

  it("status reports config validity + 'not started'", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:status")("", ctx);
    expect(notifies.length).toBe(1);
    expect(notifies[0].msg).toMatch(/not started/i);
    expect(notifies[0].msg).toMatch(/config/i);
  });
});
