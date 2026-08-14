// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortActiveRun,
  clearRunState,
  getRunState,
  isPrepareInFlight,
  isRunInFlight,
  setActiveRunAbort,
  setPrepareInFlight,
  setRunState,
  statusString,
  updateRunState,
} from "../../src/orchestrate/run-state.js";

const GLOBAL_KEY = "__benchCompactRunState";
const ABORT_KEY = "__benchCompactRunAbort";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  delete (globalThis as Record<string, unknown>)[ABORT_KEY];
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  delete (globalThis as Record<string, unknown>)[ABORT_KEY];
});

describe("run-state singleton", () => {
  it("getRunState returns null when no run is active", () => {
    expect(getRunState()).toBeNull();
  });

  it("setRunState persists + getRunState returns it", () => {
    setRunState({
      runId: "2026-08-11-1",
      date: "2026-08-11",
      id: 1,
      cfgId: "cfg-abc123",
      scenarioRepo: "/repo/scenario-x",
      phase: "phase-1",
      currentArm: "A2",
      currentAttempt: null,
      lastStopReason: null,
    });
    const s = getRunState();
    expect(s?.runId).toBe("2026-08-11-1");
    expect(s?.phase).toBe("phase-1");
    expect(s?.currentArm).toBe("A2");
  });

  it("state survives a simulated /reload (persisted on globalThis, not the module)", () => {
    setRunState({
      runId: "2026-08-11-2",
      date: "2026-08-11",
      id: 2,
      cfgId: "cfg-def456",
      scenarioRepo: "/repo",
      phase: "phase-1",
      currentArm: "A3",
      currentAttempt: null,
      lastStopReason: null,
    });
    // A /reload re-imports the module, but globalThis is NOT reset — the state lives there.
    // Simulate by reading globalThis directly (what a fresh module instance would do).
    const persisted = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
    expect(persisted).toBeDefined();
    expect((persisted as { runId: string }).runId).toBe("2026-08-11-2");
    // getRunState reads globalThis each call, so it reflects the persisted value.
    expect(getRunState()?.cfgId).toBe("cfg-def456");
  });

  it("updateRunState patches fields without dropping the rest", () => {
    setRunState({
      runId: "2026-08-11-3",
      date: "2026-08-11",
      id: 3,
      cfgId: "cfg-xyz",
      scenarioRepo: "/repo",
      phase: "phase-1",
      currentArm: "A1",
      currentAttempt: null,
      lastStopReason: null,
    });
    updateRunState({ phase: "phase-2", currentArm: "A3", currentAttempt: 2 });
    const s = getRunState();
    expect(s?.phase).toBe("phase-2");
    expect(s?.currentArm).toBe("A3");
    expect(s?.currentAttempt).toBe(2);
    // unchanged fields preserved
    expect(s?.runId).toBe("2026-08-11-3");
    expect(s?.cfgId).toBe("cfg-xyz");
  });

  it("updateRunState throws when no run is active (no silent no-op)", () => {
    expect(() => updateRunState({ phase: "phase-2" })).toThrow(/no active bench run/i);
  });

  it("clearRunState removes the state", () => {
    setRunState({
      runId: "x",
      date: "x",
      id: 1,
      cfgId: "c",
      scenarioRepo: "/r",
      phase: "phase-1",
      currentArm: null,
      currentAttempt: null,
      lastStopReason: null,
    });
    clearRunState();
    expect(getRunState()).toBeNull();
  });
});

describe("statusString", () => {
  it("returns 'idle' when no run is active", () => {
    expect(statusString()).toBe("idle");
  });

  it("formats the active run: phase + arm + attempt + stop reason", () => {
    setRunState({
      runId: "2026-08-11-1",
      date: "2026-08-11",
      id: 1,
      cfgId: "cfg-abc123",
      scenarioRepo: "/repo",
      phase: "phase-2",
      currentArm: "A3",
      currentAttempt: 2,
      lastStopReason: null,
    });
    const s = statusString();
    expect(s).toContain("phase-2");
    expect(s).toContain("A3");
    expect(s).toContain("attempt 2");
  });

  it("includes the last stop reason when surfaced", () => {
    setRunState({
      runId: "r",
      date: "d",
      id: 1,
      cfgId: "c",
      scenarioRepo: "/r",
      phase: "phase-1",
      currentArm: "A2",
      currentAttempt: null,
      lastStopReason: "arm A2 compaction cancelled — no memory produced",
    });
    const s = statusString();
    expect(s).toContain("stopped");
    expect(s).toContain("compaction cancelled");
  });
});

describe("run-abort holder (cooperative abort)", () => {
  it("abortActiveRun returns false when no controller is active", () => {
    expect(abortActiveRun()).toBe(false);
  });

  it("setActiveRunAbort + abortActiveRun fires the controller + returns true", () => {
    const controller = new AbortController();
    setActiveRunAbort(controller);
    expect(controller.signal.aborted).toBe(false);
    expect(abortActiveRun()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("abortActiveRun clears the holder (idempotent — second call returns false)", () => {
    const controller = new AbortController();
    setActiveRunAbort(controller);
    expect(abortActiveRun()).toBe(true);
    expect(abortActiveRun()).toBe(false);
  });

  it("setActiveRunAbort(null) clears an active controller without firing it", () => {
    const controller = new AbortController();
    setActiveRunAbort(controller);
    setActiveRunAbort(null);
    expect(controller.signal.aborted).toBe(false);
    expect(abortActiveRun()).toBe(false);
  });
});

describe("isRunInFlight", () => {
  const liveState = {
    runId: "2026-08-14-1",
    date: "2026-08-14",
    id: 1,
    cfgId: "cfg-abc123",
    scenarioRepo: "/repo/s",
    phase: "phase-2" as const,
    currentArm: "A3" as const,
    currentAttempt: 2,
    lastStopReason: null,
  };

  it("no state (idle/done) → NOT in-flight", () => {
    expect(isRunInFlight()).toBe(false);
  });

  it("a live run (lastStopReason null) → in-flight (concurrent commands must refuse)", () => {
    setRunState(liveState);
    expect(isRunInFlight()).toBe(true);
  });

  it("a stopped run (lastStopReason set) → NOT in-flight (follow-up runs allowed)", () => {
    setRunState(liveState);
    updateRunState({ lastStopReason: "judge model unavailable" });
    expect(isRunInFlight()).toBe(false);
  });

  it("a crashed run (unexpected-error exit recorded a stop) → NOT in-flight", () => {
    setRunState(liveState);
    updateRunState({ lastStopReason: "unexpected error: git fault" });
    expect(isRunInFlight()).toBe(false);
  });

  it("a done run (state cleared) → NOT in-flight", () => {
    setRunState(liveState);
    clearRunState();
    expect(isRunInFlight()).toBe(false);
  });
});

describe("prepare-in-flight marker", () => {
  it("false by default; set/clear round-trips on globalThis", () => {
    setPrepareInFlight(false);
    expect(isPrepareInFlight()).toBe(false);
    setPrepareInFlight(true);
    expect(isPrepareInFlight()).toBe(true);
    setPrepareInFlight(false);
    expect(isPrepareInFlight()).toBe(false);
  });

  it("clear removes the key entirely (no stale true after /reload-style reads)", () => {
    setPrepareInFlight(true);
    setPrepareInFlight(false);
    const g = globalThis as Record<string, unknown>;
    expect(g.__benchCompactPrepareInFlight).toBeUndefined();
  });
});
