// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Rate-limit resilience for the judge. The cloud judge (scoring) is DECOUPLED
// from run capture: a rate-limited judge must NEVER cause a full agent run to be
// discarded. Instead the call PAUSES (waits for the reset window — limits reset
// every few hours) and RESUMES, retrying until it succeeds or hits maxAttempts.
// Non-rate-limit errors rethrow immediately (a network fault or a malformed-
// response error is a real failure the caller must surface, not mask).
//
// `withRateLimit` wraps any async call; the rate-limit detector + the sleep +
// the wait + the attempt cap are all injectable so this module has no real-timer
// dependency and is fully testable with an instant fake sleep.

/** The async call wrapped by {@link withRateLimit}. */
export type RateLimitedCall<T> = () => Promise<T>;

/** A minimal view of an error with an optional HTTP status (e.g. fetch rejects). */
interface ErrorWithStatus {
  readonly status?: number;
  readonly message?: string;
}

/**
 * Detect a rate-limit error: HTTP 429 status OR rate-limit phrasing in the
 * message — EXCEPT subscription/account limit errors (usage caps, quota,
 * billing), which carry 429 too but never reset within a pause window. Those
 * follow pi's own precedence (its turn-retry classifier checks the
 * non-retryable limit patterns BEFORE the retryable 429/rate-limit ones) and
 * fail fast for the operator to decide — waiting on them is futile. The
 * pattern mirrors pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN. Never
 * throws on non-error inputs.
 */
const PROVIDER_LIMIT_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage.?limit|monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** A subscription/account limit error (usage caps, quota, billing exhaustion) —
 *  429-carrying but not a transient throttle; must surface, not pause. */
export function isProviderLimitError(error: unknown): boolean {
  const message =
    error instanceof Error || typeof error === "string"
      ? String(typeof error === "string" ? error : error.message)
      : "";
  return message.length > 0 && PROVIDER_LIMIT_ERROR_PATTERN.test(message);
}

export function isRateLimitError(error: unknown): boolean {
  if (isProviderLimitError(error)) return false;
  if (error === null || typeof error !== "object") {
    if (typeof error === "string") return /rate.?limit|429|too many requests/i.test(error);
    return false;
  }
  const e = error as ErrorWithStatus;
  if (e.status === 429) return true;
  if (typeof e.message === "string") return /rate.?limit|429|too many requests/i.test(e.message);
  return false;
}

/** The default sleep: a plain setTimeout-based promise. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Options for {@link withRateLimit}. All have sensible overridable defaults. */
export interface RateLimitOptions {
  /** Detect a rate-limit error (default: {@link isRateLimitError}). */
  readonly isRateLimit: (error: unknown) => boolean;
  /** The wait between retries, in ms (default 60_000 = 1 min; prod may set the reset window). */
  readonly waitMs: number;
  /** Total attempts before giving up (default 5). */
  readonly maxAttempts: number;
  /** The sleep impl (default setTimeout-based; tests inject an instant fake). */
  readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULTS: RateLimitOptions = {
  isRateLimit: isRateLimitError,
  waitMs: 60_000,
  maxAttempts: 5,
  sleep: defaultSleep,
};

/**
 * Wrap an async call with rate-limit resilience. On a rate-limit error, waits
 * `waitMs` then retries, up to `maxAttempts` total. Non-rate-limit errors rethrow
 * immediately. Never discards a partial result — the caller's captured run is
 * safe; only the judge call is retried. The options seam makes the wait instant
 * in tests.
 */
export async function withRateLimit<T>(call: RateLimitedCall<T>, options: RateLimitOptions | null): Promise<T> {
  const opts = options ?? DEFAULTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (!opts.isRateLimit(error)) throw error; // real failure — surface immediately
      if (attempt >= opts.maxAttempts) break; // exhausted retries
      await opts.sleep(opts.waitMs); // pause for the reset window, then resume
    }
  }
  throw lastError; // too many rate-limit errors in a row — surface the last one
}
