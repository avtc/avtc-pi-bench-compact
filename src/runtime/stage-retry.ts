// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Provider-request retries for the bench's out-of-session LLM stages
// (judge / manifest author / latent author / user-simulator).
//
// pi's built-in retries live in TWO layers, and the bench's background stages
// sit under BOTH of them:
//   - the turn-level retry loop (settings `retry.maxRetries`) is owned by
//     pi's agent-session wrapper — the bench calls `agentLoop` directly, so it
//     never applies;
//   - the provider-level retry (`retry.provider.maxRetries` → streamSimple's
//     `maxRetries`, retried on 408/409/429/5xx with exponential backoff) is
//     applied only by the per-session streamFn pi builds in createAgentSession —
//     the process-global default streamFn the bench's `agentLoop` calls falls
//     back to is BARE `streamSimple` with `maxRetries ?? 0` (no retries at all).
// So one transient 500 from a provider kills the whole stage (and with it the
// run) unless the bench wires its own retry. This module is that wiring: the
// same options-forwarding wrapper pi's session streamFn applies at the bench's
// single stage choke point (runBenchStage).
//
// Usage-limit parity with pi: pi-ai's provider layer never SLEEPS on a
// multi-hour server retry-after — a requested delay above `maxRetryDelayMs`
// fails the request immediately (the cap pi's session layer also applies) — and
// subscription/account limit errors (usage caps, quota, billing) are classified
// non-retryable upstream and surface to the operator instead of looping. The
// bench mirrors both: this wrapper forwards the delay cap, and the bench's
// rate-limit layer excludes those limit errors from pause-and-resume
// (see judge/rate-limit.ts isProviderLimitError). Transient throttles still
// pause; an account that is capped for hours stops the run for the operator —
// resume (verdict journal + phase walls) costs only the in-flight unit.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";

/** Default retry attempts per background-stage LLM request (transient 5xx/429/408/409). */
export const DEFAULT_STAGE_PROVIDER_MAX_RETRIES = 3;
/** Default cap on a provider-requested retry delay (pi's own provider default). */
export const DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS = 60_000;

/** The retry policy forwarded into every background-stage LLM request. */
export interface StageRetryPolicy {
  /** Attempts after the initial request (0 = no retries — one transient 5xx fails). */
  readonly maxRetries: number;
  /** Cap on server-requested retry delays (retry-after headers). */
  readonly maxRetryDelayMs: number;
}

/** The active policy (null = the built-in default). Set once per run from the
 *  bench config; the run-driver-only setter keeps stage calls signature-free. */
let activePolicy: StageRetryPolicy | null = null;

/** Install the run's stage retry policy (null restores the built-in default). */
export function setStageRetryPolicy(policy: StageRetryPolicy | null): void {
  activePolicy = policy;
}

/** The effective policy (the installed one, else the built-in default). */
export function stageRetryPolicy(): StageRetryPolicy {
  return (
    activePolicy ?? {
      maxRetries: DEFAULT_STAGE_PROVIDER_MAX_RETRIES,
      maxRetryDelayMs: DEFAULT_STAGE_PROVIDER_MAX_RETRY_DELAY_MS,
    }
  );
}

/** Wrap a base streamFn so every call carries the policy's retry options —
 *  exactly the options-forwarding pi's per-session streamFn applies
 *  (`maxRetries: options?.maxRetries ?? settings`, an explicit per-call value
 *  wins). Pure. */
export function makeRetryingStreamFn(base: StreamFn, retry: StageRetryPolicy): StreamFn {
  return (model, context, options) =>
    base(model, context, {
      ...options,
      maxRetries: options?.maxRetries ?? retry.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs ?? retry.maxRetryDelayMs,
    });
}

/** The default bench stage streamFn: pi-ai's `streamSimple` (the very function
 *  pi installs as the process-global default) wrapped with the effective retry
 *  policy. */
export function defaultRetryingStreamFn(): StreamFn {
  return makeRetryingStreamFn(streamSimple, stageRetryPolicy());
}
