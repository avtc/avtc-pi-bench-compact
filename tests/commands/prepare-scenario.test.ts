// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { computeScenarioId, makePrepareScenarioHandler } from "../../src/commands/prepare-scenario.js";
import type { PrepareDeps } from "../../src/production/prepare.js";

describe("computeScenarioId", () => {
  it("hashes the idea deterministically (build mode)", () => {
    const a = computeScenarioId({ idea: "AI tycoon game" });
    const b = computeScenarioId({ idea: "AI tycoon game" });
    const c = computeScenarioId({ idea: "different idea" });
    expect(a).toBe(b); // deterministic
    expect(a).not.toBe(c); // distinct per idea
    expect(a).toMatch(/^[a-z0-9]+$/i);
  });

  it("derives from the session path basename (extract mode)", () => {
    const id = computeScenarioId({ fromSession: "/path/to/my-session.jsonl" });
    expect(id).toMatch(/my-session/);
  });
});

describe("makePrepareScenarioHandler", () => {
  it("parses + prefights + calls prepareScenario via buildDeps + notifies the repo path", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const fakePrepare = vi.fn().mockResolvedValue({ repoPath: "/repo/x", manifestPath: "/m.json" });
    const fakeBuildDeps = vi.fn().mockReturnValue({ repoPath: "/repo/x" } as unknown as PrepareDeps);
    const handler = makePrepareScenarioHandler({
      prepareScenario: fakePrepare,
      buildDeps: fakeBuildDeps,
    });
    await handler("my tycoon idea", ctx);
    expect(fakeBuildDeps).toHaveBeenCalledOnce();
    expect(fakePrepare).toHaveBeenCalledOnce();
    expect(notified.some((n) => n.msg.includes("/repo/x"))).toBe(true);
  });

  it("notifies a parse error as a warning (no prepare call)", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const fakePrepare = vi.fn();
    const handler = makePrepareScenarioHandler({
      prepareScenario: fakePrepare,
      buildDeps: vi.fn(),
    });
    // both idea AND --from-session → parse error
    await handler("some-idea --from-session /path", ctx);
    expect(fakePrepare).not.toHaveBeenCalled();
    expect(notified.some((n) => n.level === "warning")).toBe(true);
  });

  it("surfaces a prepare failure as an error notification", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const handler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockRejectedValue(new Error("live wiring is Task 19")),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
    });
    await handler("my idea", ctx);
    expect(notified.some((n) => n.level === "error" && n.msg.includes("Task 19"))).toBe(true);
  });

  it("sets the widget to 'prepared' on success + 'stopped' on failure", async () => {
    const widgetCalls: string[] = [];
    const capturingWidget = (): import("../../src/widget/active-widget.js").WidgetPort =>
      ({
        show: () => widgetCalls.push("show"),
        startPhase: () => {},
        setStatus: (status: string, hint: string) => widgetCalls.push(`setStatus:${status}:${hint}`),
        setArm: () => {},
        setDetail: () => {},
        setCtxWindow: () => {},
        onEvent: () => {},
        hide: () => {},
      }) as unknown as import("../../src/widget/active-widget.js").WidgetPort;
    const ctx = { ui: { notify: () => {} } };

    // success → prepared
    const okHandler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockResolvedValue({ repoPath: "/repo/x", manifestPath: "/m.json" }),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: capturingWidget,
    });
    await okHandler("my idea", ctx);
    expect(widgetCalls).toContain("show");
    expect(widgetCalls.some((c) => c.startsWith("setStatus:prepared:/bench-compact:run-scenario "))).toBe(true);

    // failure → stopped
    widgetCalls.length = 0;
    const failHandler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockRejectedValue(new Error("boom")),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: capturingWidget,
    });
    await failHandler("my idea", ctx);
    expect(widgetCalls.some((c) => c.startsWith("setStatus:stopped:/bench-compact:resume"))).toBe(true);
  });
});
