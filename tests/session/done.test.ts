// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import {
  AgentSettledAbortedError,
  AgentStalledError,
  awaitAgentSettled,
  withStallWatch,
} from "../../src/session/done.js";
import { fakeBus, fakeSignal } from "./helpers.js";

describe("awaitAgentSettled", () => {
  it("resolves when agent_settled fires", async () => {
    const { pi, emit } = fakeBus();
    const p = awaitAgentSettled(pi, null);
    emit("agent_settled", { type: "agent_settled" });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects when the signal aborts before the agent settles", async () => {
    const { pi } = fakeBus();
    const ac = new AbortController();
    const p = awaitAgentSettled(pi, { signal: ac.signal });
    ac.abort(new Error("operator aborted"));
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("rejects with a named AgentSettledAbortedError on signal abort (not a generic Error)", async () => {
    const { pi } = fakeBus();
    const ac = new AbortController();
    const p = awaitAgentSettled(pi, { signal: ac.signal });
    ac.abort(new Error("operator aborted"));
    await expect(p).rejects.toBeInstanceOf(AgentSettledAbortedError);
  });

  it("on settle the signal abort listener is removed (no accumulation)", async () => {
    const { pi, emit } = fakeBus();
    const signal = fakeSignal();
    const p = awaitAgentSettled(pi, { signal });
    emit("agent_settled", { type: "agent_settled" });
    await p;
    expect(signal.listenerCount()).toBe(0);
  });
});

describe("withStallWatch", () => {
  it("resolves normally when settle arrives within the budget (timer cleared)", async () => {
    const settle = async (): Promise<void> => {};
    await expect(withStallWatch(settle, 60_000, "test")({})).resolves.toBeUndefined();
  });

  it("rejects with AgentStalledError when the budget elapses first", async () => {
    vi.useFakeTimers();
    try {
      const never = (): Promise<void> => new Promise(() => {});
      const p = withStallWatch(never, 60_000, "drive label")({});
      const assertion = expect(p).rejects.toThrow(AgentStalledError);
      await vi.advanceTimersByTimeAsync(60_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the UNDERLYING error when settle itself rejects (no stall)", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("run signal aborted");
    };
    await expect(withStallWatch(failing, 60_000, "t")({})).rejects.toThrow("run signal aborted");
  });
});
