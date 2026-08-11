// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { AgentSettledAbortedError, awaitAgentSettled } from "../../src/session/done.js";
import { fakeBus, fakeSignal } from "./helpers.js";

describe("awaitAgentSettled", () => {
  it("resolves when agent_settled fires", async () => {
    const { pi, emit } = fakeBus();
    const p = awaitAgentSettled(pi);
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

  it("R4-9: rejects with a named AgentSettledAbortedError on signal abort (not a generic Error)", async () => {
    const { pi } = fakeBus();
    const ac = new AbortController();
    const p = awaitAgentSettled(pi, { signal: ac.signal });
    ac.abort(new Error("operator aborted"));
    await expect(p).rejects.toBeInstanceOf(AgentSettledAbortedError);
  });

  it("R4-3: on settle the signal abort listener is removed (no accumulation)", async () => {
    const { pi, emit } = fakeBus();
    const signal = fakeSignal();
    const p = awaitAgentSettled(pi, { signal });
    emit("agent_settled", { type: "agent_settled" });
    await p;
    expect(signal.listenerCount()).toBe(0);
  });
});
