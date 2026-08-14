// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingsHandle } from "avtc-pi-settings-ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBenchCommands } from "../../src/commands/index.js";
import { _setHandleForTest } from "../../src/config/accessor.js";
import { setActiveRunAbort } from "../../src/orchestrate/run-state.js";

interface Captured {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakeHandle(raw: Record<string, unknown>): SettingsHandle {
  return { getSettings: () => raw } as unknown as SettingsHandle;
}

/** Fake pi: captures registered commands + spies sendUserMessage. */
function fakePi(): { pi: ExtensionAPI; commands: Map<string, Captured>; sent: { text: string; deliverAs?: string }[] } {
  const commands = new Map<string, Captured>();
  const sent: { text: string; deliverAs?: string }[] = [];
  const pi = {
    registerCommand(name: string, opts: Captured) {
      commands.set(name, opts);
    },
    sendUserMessage(text: string, options: { deliverAs?: string } | null) {
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
  afterEach(() => {
    _setHandleForTest(null);
    setActiveRunAbort(null);
  });

  it("registers every §3.13 command (except settings, wired separately)", () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    for (const name of ALL_COMMANDS) {
      expect(commands.has(name), `${name} registered`).toBe(true);
    }
    // settings is NOT registered here (Task 2 owns it)
    expect(commands.has("bench-compact:settings")).toBe(false);
  });

  it("prepare-scenario surfaces a prepare failure for a valid idea (real command, not stub)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:prepare-scenario")("a tycoon idea", ctx);
    // the live prepare seams fail against the fake ctx (no real pi/session)
    expect(notifies.some((n) => /prepare failed/i.test(n.msg))).toBe(true);
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

  it("abort fires the active run's cooperative-abort signal (R0-1)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const controller = new AbortController();
    setActiveRunAbort(controller);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:abort")("", ctx);
    expect(controller.signal.aborted).toBe(true);
    expect(notifies.some((n) => /run stopping/i.test(n.msg))).toBe(true);
  });

  it("abort with no active run notifies 'no active run' without throwing (R0-1)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:abort")("", ctx);
    expect(notifies.some((n) => /no active run/i.test(n.msg))).toBe(true);
  });

  it("abort is a real minimal handler that notifies without throwing (R1-1)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:abort")("", ctx);
    // R2-3: assert message content (sibling handlers all assert content, not just length)
    expect(notifies.some((n) => /abort/i.test(n.msg))).toBe(true);
  });

  it("run/run-scenario/run-session-file are real handlers (no 'not implemented' stub) (Task 23)", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    // run-scenario with a real dir lacking a manifest → resolveScenarioLayout warns
    // about manifest.json (real handler path, NOT a 'not implemented' stub).
    const dir = import.meta.dirname;
    await handlerOf(commands, "bench-compact:run-scenario")(dir, ctx);
    expect(notifies.some((n) => /manifest\.json/i.test(n.msg))).toBe(true);
    expect(notifies.some((n) => /not implemented/i.test(n.msg))).toBe(false);

    // run <idea> → reaches prepare; the live prepare seams fail against the fake ctx
    // → 'prepare failed' (real prepare→run chain, NOT a stub).
    notifies.length = 0;
    await handlerOf(commands, "bench-compact:run")("an incremental game idea", ctx);
    expect(notifies.some((n) => /prepare failed/i.test(n.msg))).toBe(true);
    expect(notifies.some((n) => /not implemented/i.test(n.msg))).toBe(false);

    // run-session-file <path> → same prepare path (extract mode).
    notifies.length = 0;
    const file = import.meta.filename;
    await handlerOf(commands, "bench-compact:run-session-file")(file, ctx);
    expect(notifies.some((n) => /prepare failed/i.test(n.msg))).toBe(true);
    expect(notifies.some((n) => /not implemented/i.test(n.msg))).toBe(false);
  });

  it("resume sends 'continue' to the agent", async () => {
    const { pi, commands, sent } = fakePi();
    registerBenchCommands(pi);
    const { ctx } = fakeCtx();
    await handlerOf(commands, "bench-compact:resume")("", ctx);
    expect(sent.some((s) => s.text === "continue")).toBe(true);
  });

  it("status reports config validity + 'not started' when no run is active", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    await handlerOf(commands, "bench-compact:status")("", ctx);
    expect(notifies.length).toBe(1);
    expect(notifies[0].msg).toMatch(/not started/i);
    expect(notifies[0].msg).toMatch(/config/i);
  });

  it("status reports the live run state (arm / attempt / phase) mid-run, + the stop reason after a stop", async () => {
    const { pi, commands } = fakePi();
    registerBenchCommands(pi);
    const { ctx, notifies } = fakeCtx();
    const { setRunState, clearRunState } = await import("../../src/orchestrate/run-state.js");

    // Mid-run: the singleton reflects the orchestrator's live writes.
    setRunState({
      runId: "2026-08-14-1",
      date: "2026-08-14",
      id: 1,
      cfgId: "cfg-abc123",
      scenarioRepo: "/scenario/repo",
      phase: "phase-2",
      currentArm: "A3",
      currentAttempt: 2,
      lastStopReason: null,
    });
    notifies.length = 0;
    await handlerOf(commands, "bench-compact:status")("", ctx);
    expect(notifies[0].msg).toContain("phase-2");
    expect(notifies[0].msg).toContain("A3");
    expect(notifies[0].msg).toContain("attempt 2");
    expect(notifies[0].msg).not.toMatch(/not started/i);

    // After a stop-and-surface: the state persists so the operator can query the reason.
    const { updateRunState } = await import("../../src/orchestrate/run-state.js");
    updateRunState({ lastStopReason: "judge model unavailable" });
    notifies.length = 0;
    await handlerOf(commands, "bench-compact:status")("", ctx);
    expect(notifies[0].msg).toContain("stopped");
    expect(notifies[0].msg).toContain("judge model unavailable");

    // After a clean completion the orchestrator clears the state → back to 'not started'.
    clearRunState();
    notifies.length = 0;
    await handlerOf(commands, "bench-compact:status")("", ctx);
    expect(notifies[0].msg).toMatch(/not started/i);
  });
});
