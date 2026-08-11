// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { inject } from "../../src/session/inject.js";

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
