// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { isRateLimitError, type RateLimitOptions, withRateLimit } from "../../src/judge/rate-limit.js";

/** Build a call that throws the given errors in sequence, then resolves `value`. */
function callSequence<T>(errors: unknown[], value: T): { call: () => Promise<T>; state: { calls: number } } {
  let i = 0;
  const state = { calls: 0 };
  const call = async (): Promise<T> => {
    state.calls += 1;
    if (i < errors.length) {
      const err = errors[i];
      i += 1;
      throw err;
    }
    return value;
  };
  return { call, state };
}

const opts = (overrides: Partial<RateLimitOptions>): RateLimitOptions => ({
  isRateLimit: (e) => isRateLimitError(e),
  sleep: async () => {},
  waitMs: 0,
  maxAttempts: 5,
  ...overrides,
});

describe("withRateLimit", () => {
  it("returns the result when the call succeeds on the first attempt", async () => {
    const { call } = callSequence([], "ok");
    await expect(withRateLimit(call, opts({}))).resolves.toBe("ok");
  });

  it("retries after a rate-limit error + returns the result (never discards)", async () => {
    const rateErr = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    const { call, state } = callSequence([rateErr], "recovered");
    const result = await withRateLimit(call, opts({}));
    expect(result).toBe("recovered");
    expect(state.calls).toBe(2); // initial + 1 retry
  });

  it("rethrows a NON-rate-limit error immediately (does not mask real failures)", async () => {
    const { call } = callSequence([new Error("network unreachable")], "x");
    await expect(withRateLimit(call, opts({}))).rejects.toThrow("network unreachable");
  });

  it("sleeps waitMs between retries (pause/resume)", async () => {
    const rateErr = Object.assign(new Error("rate limit exceeded"), { status: 429 });
    const sleeps: number[] = [];
    const { call } = callSequence([rateErr, rateErr], "done");
    const o = opts({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      waitMs: 12345,
    });
    await withRateLimit(call, o);
    expect(sleeps).toEqual([12345, 12345]); // one sleep per retry
  });

  it("throws after maxAttempts consecutive rate-limit errors (does not loop forever)", async () => {
    const rateErr = Object.assign(new Error("429"), { status: 429 });
    const { call, state } = callSequence(
      Array.from({ length: 100 }, () => rateErr),
      "never",
    );
    await expect(withRateLimit(call, opts({ maxAttempts: 3 }))).rejects.toThrow();
    expect(state.calls).toBe(3); // stopped at maxAttempts, no infinite loop
  });
});

describe("isRateLimitError", () => {
  it("detects HTTP 429 status", () => {
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
  });

  it("detects rate-limit phrasing in the message", () => {
    expect(isRateLimitError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("Too many requests"))).toBe(true);
  });

  it("rejects non-rate-limit errors", () => {
    expect(isRateLimitError(new Error("network unreachable"))).toBe(false);
    expect(isRateLimitError(Object.assign(new Error("server error"), { status: 500 }))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});
