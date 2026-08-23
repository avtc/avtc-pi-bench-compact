// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeScenarioId,
  makePrepareScenarioHandler,
  surfaceConditionsMessage,
} from "../../src/commands/prepare-scenario.js";
import { SurfaceConditionsError } from "../../src/production/build.js";
import type { PrepareDeps, ReAuthorDeps } from "../../src/production/prepare.js";
import { fakeCommandCtx } from "./helpers.js";

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
      prepareScenario: vi.fn().mockRejectedValue(new Error("live wiring failed")),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
    });
    await handler("my idea", ctx);
    expect(notified.some((n) => n.level === "error" && n.msg.includes("live wiring failed"))).toBe(true);
  });

  it("sets the widget to 'prepared' on success + 'stopped' on failure", async () => {
    const widgetCalls: string[] = [];
    const capturingWidget = (): import("../../src/widget/active-widget.js").WidgetPort =>
      ({
        show: () => widgetCalls.push("show"),
        startPhase: (phase: string) => {
          widgetCalls.push(`startPhase:${phase}`);
        },
        setStatus: (status: string, hint: string) => widgetCalls.push(`setStatus:${status}:${hint}`),
        setArm: () => {},
        setDetail: () => {},
        setCtxWindow: () => {},
        onEvent: () => {},
        onValidatorEvent: () => {},
        setValidatorCtxWindow: () => {},
        clearValidator: () => {},
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
    expect(widgetCalls.some((c) => c.startsWith("setStatus:stopped:/bench-compact:prepare-scenario"))).toBe(true);

    // extract mode (--from-session) → startPhase('extract') BEFORE show (build■ from first render)
    widgetCalls.length = 0;
    const sessionDir = mkdtempSync(join(tmpdir(), "bench-prep-ext-"));
    const sessionFile = join(sessionDir, "real-session.jsonl");
    writeFileSync(sessionFile, `{"type":"session","id":"h","cwd":"${sessionDir}"}\n`);
    const extractHandler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockResolvedValue({ repoPath: "/repo/x", manifestPath: "/m.json" }),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: capturingWidget,
    });
    await extractHandler(`--from-session ${sessionFile}`, ctx);
    const extractIdx = widgetCalls.indexOf("startPhase:extract");
    const showIdx = widgetCalls.indexOf("show");
    expect(extractIdx).toBeGreaterThanOrEqual(0);
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(extractIdx).toBeLessThan(showIdx); // startPhase('extract') before show
  });
});

describe("makePrepareScenarioHandler — stale-ctx safety (guarded getters)", () => {
  it("captures ui EAGERLY: the post-prepare notify works after prepare's switchSessions invalidate the ctx", async () => {
    // Models pi: prepare's driveAndCapture/trialCompact/author switchSession, which
    // invalidates the command ctx's guarded getters (ui/mode/hasUI throw "stale").
    // The success + failure notifies fire AFTER those switches, so they must go
    // through the eagerly-captured ui object.
    const { fakeGuardedCtx } = await import("./helpers.js");
    const { ctx, invalidate, notifies } = fakeGuardedCtx();
    const fakePrepare = vi.fn().mockImplementation(async () => {
      invalidate(); // the build drive's switchSession
      return { repoPath: "/repo/x", manifestPath: "/m.json" };
    });
    const handler = makePrepareScenarioHandler({
      prepareScenario: fakePrepare,
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: () =>
        ({
          show: () => {},
          startPhase: () => {},
          setStatus: () => {},
          setArm: () => {},
          setDetail: () => {},
          setCtxWindow: () => {},
          onEvent: () => {},
          hide: () => {},
        }) as unknown as import("../../src/widget/active-widget.js").WidgetPort,
    });
    await handler("my idea", ctx);
    expect(notifies.some((n) => n.msg.includes("/repo/x") && n.level === "info")).toBe(true);
  });

  it("the failure notify works after the ctx went stale (no throw masking the real error)", async () => {
    const { fakeGuardedCtx } = await import("./helpers.js");
    const { ctx, invalidate, notifies } = fakeGuardedCtx();
    const handler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockImplementation(async () => {
        invalidate();
        throw new Error("simulator stopped with an error");
      }),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: () =>
        ({
          show: () => {},
          startPhase: () => {},
          setStatus: () => {},
          setArm: () => {},
          setDetail: () => {},
          setCtxWindow: () => {},
          onEvent: () => {},
          hide: () => {},
        }) as unknown as import("../../src/widget/active-widget.js").WidgetPort,
    });
    await handler("my idea", ctx);
    expect(notifies.some((n) => n.level === "error" && n.msg.includes("simulator stopped"))).toBe(true);
  });
});

describe("makePrepareScenarioHandler — concurrent-run refusal", () => {
  it("refuses to prepare while a bench run is in-flight (prepare also drives the main session)", async () => {
    const { setRunState } = await import("../../src/orchestrate/run-state.js");
    setRunState({
      runId: "2026-08-14-1",
      date: "2026-08-14",
      id: 1,
      cfgId: "cfg-x",
      scenarioRepo: "/repo/s",
      phase: "phase-2",
      currentArm: "A3",
      currentAttempt: 2,
      lastStopReason: null,
    });
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const fakePrepare = vi.fn();
    const handler = makePrepareScenarioHandler({
      prepareScenario: fakePrepare,
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
    });
    await handler("my idea", ctx);
    expect(fakePrepare).not.toHaveBeenCalled();
    expect(notified.some((n) => n.msg.includes("already active") && n.level === "warning")).toBe(true);
  });
});

describe("makePrepareScenarioHandler — surface notify (v2 recovery options)", () => {
  const surfaceErr = (
    missing: { id: string; label: string; tag: "essential" | "safeToSkip" }[],
    skipOffered: boolean,
  ) =>
    new SurfaceConditionsError(
      { kind: "surface", skipOffered, missing: missing.map((m) => ({ ...m, hint: "h", metricAxis: "recallFact" })) },
      { firstKeptEntryId: "e4", attempt: 1, manifest: {} as unknown as SurfaceConditionsError["manifest"] },
    );

  it("essential missing → names labels + the three options with the scenario folder", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const err = surfaceErr(
      [
        { id: "key-decision", label: "Key decision", tag: "essential" },
        { id: "change-mind", label: "Changed mind", tag: "safeToSkip" },
      ],
      false,
    );
    const handler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockRejectedValue(err),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: () => inertWidget(),
    });
    await handler("my idea", ctx);
    const msg = notified.find((n) => n.level === "error")?.msg ?? "";
    expect(msg).toContain("essential condition topics did not land");
    expect(msg).toContain("Key decision");
    expect(msg).toContain("(a) plant + continue — /bench-compact:prepare-scenario --plant");
    expect(msg).toContain("(b) start over — re-run /bench-compact:prepare-scenario <idea>");
    expect(msg).toContain("(c) skip — /bench-compact:prepare-scenario --skip-topics change-mind --from");
    expect(msg).toContain("(safe-to-skip only: Changed mind)");
  });

  it("only safeToSkip missing → the safe-to-skip opening", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const err = surfaceErr([{ id: "open-question", label: "Open question", tag: "safeToSkip" }], true);
    const handler = makePrepareScenarioHandler({
      prepareScenario: vi.fn().mockRejectedValue(err),
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      makeWidget: () => inertWidget(),
    });
    await handler("my idea", ctx);
    const msg = notified.find((n) => n.level === "error")?.msg ?? "";
    expect(msg).toContain("only safe-to-skip topics are missing: Open question");
    expect(msg).toContain("--skip-topics open-question");
  });

  it("no safe topics among missing → (c) not available", async () => {
    const err = surfaceErr([{ id: "key-decision", label: "Key decision", tag: "essential" }], false);
    const msg = surfaceConditionsMessage(err, "/scen/x");
    expect(msg).toContain("(c) skip — not available (no safe-to-skip topics among the missing)");
  });

  function inertWidget(): import("../../src/widget/active-widget.js").WidgetPort {
    return {
      show: () => {},
      startPhase: () => {},
      setStatus: () => {},
      setArm: () => {},
      setDetail: () => {},
      setCtxWindow: () => {},
      onEvent: () => {},
      hide: () => {},
    } as unknown as import("../../src/widget/active-widget.js").WidgetPort;
  }
});

describe("computeScenarioId — recovery modes", () => {
  it("derives from the recovery folder basename", () => {
    expect(
      computeScenarioId({
        idea: undefined,
        fromSession: undefined,
        plantFrom: "/root/scenarios/abc",
        skipFrom: undefined,
      }),
    ).toBe("abc");
    expect(
      computeScenarioId({
        idea: undefined,
        fromSession: undefined,
        plantFrom: undefined,
        skipFrom: "/root/scenarios/xyz",
      }),
    ).toBe("xyz");
  });
});

describe("prepare in-flight guard", () => {
  it("refuses a second prepare while one is active (no buildDeps call)", async () => {
    const { setPrepareInFlight } = await import("../../src/orchestrate/run-state.js");
    setPrepareInFlight(true);
    try {
      const { ctx, notifies } = fakeCommandCtx();
      const buildDeps = vi.fn();
      const prepareScenario = vi.fn();
      const handler = makePrepareScenarioHandler({ buildDeps, prepareScenario });
      await handler("some idea", ctx);
      expect(buildDeps).not.toHaveBeenCalled();
      expect(prepareScenario).not.toHaveBeenCalled();
      expect(notifies.some((n) => n.level === "warning" && n.msg.includes("prepare is already active"))).toBe(true);
    } finally {
      setPrepareInFlight(false);
    }
  });

  it("clears the flag on SurfaceConditionsError (finally runs on every exit)", async () => {
    const { isPrepareInFlight } = await import("../../src/orchestrate/run-state.js");
    const { ctx } = fakeCommandCtx();
    const prepareScenario = vi.fn().mockRejectedValue(
      new SurfaceConditionsError(
        {
          kind: "surface",
          skipOffered: true,
          missing: [
            { id: "open-question", label: "Open question", tag: "safeToSkip", hint: "h", metricAxis: "abstention" },
          ],
        },
        { firstKeptEntryId: "e4", attempt: 1, manifest: {} as unknown as SurfaceConditionsError["manifest"] },
      ),
    );
    const handler = makePrepareScenarioHandler({
      buildDeps: vi.fn().mockReturnValue({} as PrepareDeps),
      prepareScenario,
    });
    await handler("some idea", ctx);
    expect(isPrepareInFlight()).toBe(false);
  });
});

describe("makePrepareScenarioHandler — --re-author", () => {
  it("re-authors in place: manifest.json replaced, previous preserved, notify carries the probe count", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const folder = mkdtempSync(join(tmpdir(), "bench-reauthor-"));
    writeFileSync(join(folder, "manifest.json"), JSON.stringify({ id: "old", probes: [] }));
    const newManifest = {
      id: "scen",
      description: "d",
      compactionBoundary: { phaseATokenBudget: 140000, plan: "extract" },
      recallFacts: [],
      doneOps: [],
      supersessions: [],
      abstentions: [],
      taskObjective: { description: "b", testSpec: "" },
      probes: [{ question: "q1", accept: ["a"], targets: ["e1"], lanes: ["direct-probe"] }],
    };
    const fakePrepare = vi.fn();
    const fakeBuildDeps = vi.fn();
    const handler = makePrepareScenarioHandler({
      prepareScenario: fakePrepare,
      buildDeps: fakeBuildDeps,
      reAuthorDeps: () =>
        ({
          scenarioFolder: folder,
          sessionsDir: join(folder, "sessions"),
          preSliceDir: join(folder, "pre-slice"),
          seams: {},
        }) as unknown as ReAuthorDeps,
      reAuthor: vi.fn().mockResolvedValue(newManifest),
    });

    await handler(`--re-author ${folder}`, ctx);

    expect(fakePrepare).not.toHaveBeenCalled(); // no build/freeze path
    const replaced = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { probes: unknown[] };
    expect(replaced.probes).toHaveLength(1);
    const previous = JSON.parse(readFileSync(join(folder, "manifest.pre-re-author.json"), "utf8")) as { id: string };
    expect(previous.id).toBe("old");
    expect(notified.some((n) => /re-authored manifest/.test(n.msg) && /1 probes/.test(n.msg))).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a re-author failure surfaces an error and leaves manifest.json untouched", async () => {
    const notified: { msg: string; level: string }[] = [];
    const ctx = { ui: { notify: (msg: string, level: string) => void notified.push({ msg, level }) } };
    const folder = mkdtempSync(join(tmpdir(), "bench-reauthor-"));
    writeFileSync(join(folder, "manifest.json"), JSON.stringify({ id: "old", probes: [] }));
    const handler = makePrepareScenarioHandler({
      prepareScenario: vi.fn(),
      buildDeps: vi.fn(),
      reAuthorDeps: () => ({ scenarioFolder: folder }) as unknown as ReAuthorDeps,
      reAuthor: vi.fn().mockRejectedValue(new Error("manifest validation failed: boom")),
    });

    await handler(`--re-author ${folder}`, ctx);

    const kept = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { id: string };
    expect(kept.id).toBe("old");
    expect(notified.some((n) => /re-author|prepare failed/.test(n.msg) && n.level === "error")).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });
});
