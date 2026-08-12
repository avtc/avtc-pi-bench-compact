// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Seeded presentation-order shuffle for the comparative-ranking judge (rankAxis).
// rankAxis REQUIRES a Shuffle (no identity default — anti-position-bias depends on
// it): it anonymizes arms behind A/B/C… labels + presents them in a shuffled order
// so a judge's position bias does not systematically favor the first-presented arm.
// The shuffle is SEEDED (deterministic per run) so a re-run reproduces the same
// ordering → the same judge ranking (reproducibility). mulberry32 (shared with the
// bootstrap resampler) is the PRNG.

import { mulberry32 } from "../stats/bootstrap.js";
import type { Shuffle } from "./ranking.js";

/** Build a seeded Fisher–Yates shuffle. The same seed yields the same permutation
 *  every call (deterministic); a different seed yields a different one. Pure. */
export function seededShuffle<T>(seed: number): Shuffle<T> {
  const rand = mulberry32(seed);
  return (items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  };
}
