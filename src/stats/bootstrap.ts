// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Bootstrap confidence intervals + binary-rate aggregation. The statistics layer
// is the bridge between per-run grades (which vary run-to-run because there is
// no seed) and the per-arm point estimates + CIs the report surfaces. All
// functions are PURE and DETERMINISTIC given a seed: the same input + seed yield
// the identical CI (the resampling sequence is reproducible), so two stat passes
// over the same grades are byte-identical and a result is reproducible.
//
// The bootstrap resamples WITH REPLACEMENT (`samples` draws of size N), takes
// each resample's mean, and reports the alpha/2 + (1-alpha/2) percentiles as the
// CI. For a binary metric the same procedure over the 0/1 encoding yields the
// CI of the proportion; the rate is the plain sample proportion (seed-independent).

import { mean } from "./util.js";

/** Options for a bootstrap pass (all optional via a nullable options arg). */
export interface BootstrapOptions {
  readonly samples?: number;
  readonly alpha?: number;
  readonly seed?: number;
}

/** A bootstrap result: the sample mean + the [lo, hi] CI. */
export interface CiResult {
  readonly mean: number;
  readonly ci: readonly [number, number];
}

/** Default resample count (10k gives a stable percentile bound). */
const DEFAULT_SAMPLES = 10000;
/** Default alpha for a 95% CI. */
const DEFAULT_ALPHA = 0.05;
/** Default seed (deterministic baseline; tests + production both default to it). */
const DEFAULT_SEED = 1;

interface ResolvedOptions {
  readonly samples: number;
  readonly alpha: number;
  readonly seed: number;
}

function resolveOptions(options: BootstrapOptions | null): ResolvedOptions {
  return {
    samples: options?.samples ?? DEFAULT_SAMPLES,
    alpha: options?.alpha ?? DEFAULT_ALPHA,
    seed: options?.seed ?? DEFAULT_SEED,
  };
}

/**
 * A tiny deterministic PRNG (mulberry32) — seeded, fast, good enough for
 * bootstrap resampling (it is NOT a crypto RNG; it does not need to be).
 * Returns a function producing floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** The percentile of a SORTED array at probability p (linear interpolation). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Bootstrap CI of the mean: resample-with-replacement `samples` times (each draw
 * the size of the input), collect each resample's mean, and report the
 * alpha/2 + (1-alpha/2) percentiles as the CI. `mean` is the plain sample mean
 * (seed-independent). Empty input → NaN mean + NaN CI. All-same input → a point
 * CI at that value. Deterministic given `seed`. Pure.
 */
export function bootstrapCi(values: readonly number[], options: BootstrapOptions | null): CiResult {
  if (values.length === 0) {
    return { mean: Number.NaN, ci: [Number.NaN, Number.NaN] };
  }
  const resolved = resolveOptions(options);
  const rand = mulberry32(resolved.seed);
  const n = values.length;
  const resampleMeans: number[] = [];
  for (let i = 0; i < resolved.samples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += values[Math.floor(rand() * n)];
    }
    resampleMeans.push(sum / n);
  }
  resampleMeans.sort((a, b) => a - b);
  const lo = percentile(resampleMeans, resolved.alpha / 2);
  const hi = percentile(resampleMeans, 1 - resolved.alpha / 2);
  return { mean: mean(values), ci: [lo, hi] };
}

/** Binary-rate result: the proportion + its bootstrap CI + the sample size n. */
export interface BinaryRateResult {
  readonly rate: number;
  readonly ci: readonly [number, number];
  readonly n: number;
}

/**
 * Aggregate a binary metric's per-run pass/fail into a rate + bootstrap CI. The
 * rate is the sample proportion (passes/n); the CI is the bootstrap CI of that
 * proportion (the 0/1 encoding resampled). `n` is the run count. Empty input →
 * rate NaN + n 0. Deterministic given `seed`. Pure.
 */
export function binaryRate(passes: readonly boolean[], options: BootstrapOptions | null): BinaryRateResult {
  const n = passes.length;
  if (n === 0) {
    return { rate: Number.NaN, ci: [Number.NaN, Number.NaN], n: 0 };
  }
  const encoded = passes.map((p) => (p ? 1 : 0));
  const { ci } = bootstrapCi(encoded, options);
  return { rate: mean(encoded), ci, n };
}
