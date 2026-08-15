// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { inject, makeAntiPeekInject, makeAntiPeekInjectFactory } from "../../src/session/inject.js";

const PREAMBLE = "no peeking";

function fakePi(): { pi: ExtensionAPI; calls: { content: unknown; deliverAs: string | undefined }[] } {
  const calls: { content: unknown; deliverAs: string | undefined }[] = [];
  const pi = {
    sendUserMessage: (content: unknown, options?: { deliverAs?: string }) => {
      calls.push({ content, deliverAs: options?.deliverAs });
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

describe("inject", () => {
  it("sends a steer message via pi.sendUserMessage", () => {
    const { pi, calls } = fakePi();
    inject(pi, "please review the loop first", "steer");
    expect(calls).toEqual([{ content: "please review the loop first", deliverAs: "steer" }]);
  });

  it("sends a followUp message via pi.sendUserMessage", () => {
    const { pi, calls } = fakePi();
    inject(pi, "what's left on the to-do?", "followUp");
    expect(calls).toEqual([{ content: "what's left on the to-do?", deliverAs: "followUp" }]);
  });
});

describe("makeAntiPeekInject", () => {
  it("prepends the preamble to the FIRST inject only", () => {
    const { pi, calls } = fakePi();
    const send = makeAntiPeekInject(pi, PREAMBLE);
    send("beat one");
    send("beat two");
    expect(calls[0]?.content).toBe(`no peeking

beat one`);
    expect(calls[1]?.content).toBe("beat two");
    expect(calls.every((c) => c.deliverAs === "followUp")).toBe(true);
  });
});

describe("makeAntiPeekInjectFactory (shared first-inject flag)", () => {
  it("injects the preamble ONCE across several loads of the SAME session (continue attempts)", () => {
    // The build drive re-switchSessions the stable build session per continue
    // attempt — each load gets a FRESH pi, but the conversation still contains the
    // first preamble, so only the very first inject ever carries it.
    const factory = makeAntiPeekInjectFactory(PREAMBLE);
    const a = fakePi();
    const b = fakePi();
    const sendA = factory(a.pi); // attempt 0's pi
    sendA("beat one");
    const sendB = factory(b.pi); // attempt 1's fresh pi — SAME conversation
    sendB("beat two");
    expect(a.calls[0]?.content).toBe(`no peeking

beat one`);
    expect(b.calls[0]?.content).toBe("beat two"); // NOT re-prefixed
  });

  it("independent factory instances arm independently (post-compaction forks)", () => {
    const a = fakePi();
    const b = fakePi();
    const first = makeAntiPeekInjectFactory(PREAMBLE)(a.pi);
    const second = makeAntiPeekInjectFactory(PREAMBLE)(b.pi);
    first("fork one");
    second("fork two");
    // each factory's FIRST inject carries the preamble (each fork lost it to compaction)
    expect(a.calls[0]?.content).toBe(`no peeking

fork one`);
    expect(b.calls[0]?.content).toBe(`no peeking

fork two`);
  });
});
