// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { _resetStageClocks, activeStageClock, pushStageClock, type StageClock } from "../../src/ui/operator-wait.js";

function spyClock(): StageClock & { pauses: () => number; resumes: () => number } {
  const pause = vi.fn();
  const resume = vi.fn();
  return {
    pause,
    resume,
    pauses: () => pause.mock.calls.length,
    resumes: () => resume.mock.calls.length,
  };
}

describe("stage-clock registry", () => {
  it("empty registry: activeStageClock is null (a dialog outside any stage pauses nothing)", () => {
    _resetStageClocks();
    expect(activeStageClock()).toBeNull();
  });

  it("the pushed stage's clock is active; unregistering removes it", () => {
    _resetStageClocks();
    const clock = spyClock();
    const unregister = pushStageClock(clock);
    const active = activeStageClock();
    expect(active).not.toBeNull();
    active?.pause();
    expect(clock.pauses()).toBe(1);
    unregister();
    expect(activeStageClock()).toBeNull();
  });

  it("nested stages: the innermost (last-pushed) clock is the active one", () => {
    _resetStageClocks();
    const outer = spyClock();
    const inner = spyClock();
    const unOuter = pushStageClock(outer);
    const unInner = pushStageClock(inner);
    activeStageClock()?.pause();
    expect(inner.pauses()).toBe(1);
    expect(outer.pauses()).toBe(0);
    unInner();
    activeStageClock()?.resume();
    expect(outer.resumes()).toBe(1);
    expect(inner.resumes()).toBe(0);
    unOuter();
    expect(activeStageClock()).toBeNull();
  });

  it("a clock whose stage already ended is neutralized: later pause/resume never reach it", () => {
    _resetStageClocks();
    const clock = spyClock();
    const unregister = pushStageClock(clock);
    const active = activeStageClock();
    unregister();
    // a dialog answered after its stage ended must not re-arm the dead stage's timer
    active?.pause();
    active?.resume();
    expect(clock.pauses()).toBe(0);
    expect(clock.resumes()).toBe(0);
  });
});
