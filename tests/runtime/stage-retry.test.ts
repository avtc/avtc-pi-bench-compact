// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STAGE_PROVIDER_MAX_RETRIES,
  DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS,
  makeRetryingStreamFn,
  setStageRetryPolicy,
  stageRetryPolicy,
} from "../../src/runtime/stage-retry.js";

/** A fake base stream that records the options it was called with. */
function captureBase(seen: { options?: unknown }): StreamFn {
  return async (_model, _context, options) => {
    seen.options = options;
    return "stream" as unknown as ReturnType<StreamFn>;
  };
}

describe("stageRetryPolicy", () => {
  afterEach(() => {
    setStageRetryPolicy(null);
  });

  it("defaults to the built-in policy (3 attempts, 60s cap)", () => {
    expect(stageRetryPolicy()).toEqual({
      maxRetries: DEFAULT_STAGE_PROVIDER_MAX_RETRIES,
      maxRetryDelayMs: DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS,
    });
    expect(DEFAULT_STAGE_PROVIDER_MAX_RETRIES).toBeGreaterThan(0);
  });

  it("the setter overrides; null resets to the default", () => {
    setStageRetryPolicy({ maxRetries: 7, maxRetryDelayMs: 12345 });
    expect(stageRetryPolicy()).toEqual({ maxRetries: 7, maxRetryDelayMs: 12345 });
    setStageRetryPolicy(null);
    expect(stageRetryPolicy().maxRetries).toBe(DEFAULT_STAGE_PROVIDER_MAX_RETRIES);
  });
});

describe("makeRetryingStreamFn", () => {
  it("forwards the policy's retry options into the base call (pi's session streamFn parity)", async () => {
    const seen: { options?: unknown } = {};
    const fn = makeRetryingStreamFn(captureBase(seen), { maxRetries: 5, maxRetryDelayMs: 25000 });
    await fn({} as unknown as Parameters<StreamFn>[0], {} as unknown as Parameters<StreamFn>[1], {
      signal: new AbortController().signal,
    });
    expect(seen.options).toMatchObject({ maxRetries: 5, maxRetryDelayMs: 25000 });
    // existing options are preserved
    expect((seen.options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("an explicit per-call maxRetries wins over the policy (pi's options-first parity)", async () => {
    const seen: { options?: unknown } = {};
    const fn = makeRetryingStreamFn(captureBase(seen), { maxRetries: 5, maxRetryDelayMs: 25000 });
    await fn({} as unknown as Parameters<StreamFn>[0], {} as unknown as Parameters<StreamFn>[1], { maxRetries: 1 });
    expect(seen.options).toMatchObject({ maxRetries: 1, maxRetryDelayMs: 25000 });
  });

  it("works with no options at all", async () => {
    const seen: { options?: unknown } = {};
    const fn = makeRetryingStreamFn(captureBase(seen), { maxRetries: 2, maxRetryDelayMs: 1000 });
    await fn({} as unknown as Parameters<StreamFn>[0], {} as unknown as Parameters<StreamFn>[1], undefined);
    expect(seen.options).toMatchObject({ maxRetries: 2, maxRetryDelayMs: 1000 });
  });
});
