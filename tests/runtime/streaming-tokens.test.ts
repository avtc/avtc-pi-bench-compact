// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  deltaTextOf,
  deltaTokens,
  estimateContentTokens,
  messageEndUsage,
  streamedOutputUsage,
} from "../../src/runtime/streaming-tokens.js";

/** Build a minimal assistant message; pass `usage` to attach one, or omit it for the no-usage case. */
function msgWithUsage(usage?: Record<string, unknown>): AgentMessage {
  const base: Record<string, unknown> = { role: "assistant", content: [] };
  if (usage !== undefined) base.usage = usage;
  return base as unknown as AgentMessage;
}

describe("streaming-tokens", () => {
  describe("messageEndUsage", () => {
    it("reads input/output/cacheRead/cacheWrite/cost/totalTokens off a message_end message", () => {
      const m = msgWithUsage({
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 20,
        cost: { total: 0.0123 },
        totalTokens: 200,
      });
      expect(messageEndUsage(m)).toEqual({
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 20,
        cost: 0.0123,
        totalTokens: 200,
      });
    });

    it("defaults missing numeric fields to 0 (cacheWrite + cacheRead optional per provider)", () => {
      const m = msgWithUsage({ input: 10, output: 5 });
      expect(messageEndUsage(m)).toEqual({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        totalTokens: 0,
      });
    });

    it("returns null when the message carries no usage", () => {
      expect(messageEndUsage(msgWithUsage())).toBeNull();
    });
  });

  describe("streamedOutputUsage", () => {
    it("reads the cumulative output off a message_update event", () => {
      const ev = { type: "message_update", message: { usage: { output: 42 } } } as unknown as AgentEvent;
      expect(streamedOutputUsage(ev)).toBe(42);
    });
    it("returns null for non-message_update events", () => {
      expect(streamedOutputUsage({ type: "turn_end" } as unknown as AgentEvent)).toBeNull();
    });
    it("returns null when the message_update carries no output usage", () => {
      const ev = { type: "message_update", message: {} } as unknown as AgentEvent;
      expect(streamedOutputUsage(ev)).toBeNull();
    });
  });

  describe("deltaTextOf", () => {
    it("extracts the delta string from text/thinking/toolcall deltas", () => {
      for (const t of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
        const ev = {
          type: "message_update",
          assistantMessageEvent: { type: t, delta: "abc" },
        } as unknown as AgentEvent;
        expect(deltaTextOf(ev)).toBe("abc");
      }
    });
    it("returns null for non-message_update events and non-delta inner events", () => {
      expect(deltaTextOf({ type: "turn_end" } as unknown as AgentEvent)).toBeNull();
      expect(
        deltaTextOf({ type: "message_update", assistantMessageEvent: { type: "text_start" } } as unknown as AgentEvent),
      ).toBeNull();
    });
  });

  describe("token estimates", () => {
    it("deltaTokens == estimateContentTokens == ceil(len/4)", () => {
      expect(estimateContentTokens("")).toBe(0);
      expect(estimateContentTokens("ab")).toBe(1); // ceil(2/4)
      expect(estimateContentTokens("abcd")).toBe(1); // ceil(4/4)
      expect(estimateContentTokens("abcde")).toBe(2); // ceil(5/4)
      expect(deltaTokens("abcde")).toBe(2);
    });
  });
});
