// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Maps one manifest Probe to its grading axis. Probes carry no explicit axis
// field — the axis is implied by the probe's SHAPE (correctRefusal vs accept[])
// and, for supersession-latest probes, the EXPLICIT `supersessionId` link (the
// authored reversal the probe tests the latest value of). This resolver is the
// single source the scoring orchestrator uses to route each probe's answer to
// the right binary axis (recall-accuracy / abstention / supersession).
//
// The rubric's abstention "two faces" unify here: BOTH the never-decided abstention
// (correctRefusal) AND the supersession-stale probe (also correctRefusal — the
// agent should flag the stale value rather than confirm it) grade to abstention. A
// supersession probe with accept[] (the latest value is the correct answer)
// grades to supersession.

import type { Probe, ScenarioManifest, Supersession } from "../manifest/schema.js";
import type { MetricId } from "../metrics/defs.js";

/**
 * Resolve the grading axis for one probe. Returns null for a malformed probe
 * (no accept[] and no correctRefusal — the orchestrator skips such probes).
 *
 * Rule (precedence):
 *   1. `correctRefusal === true` -> abstention (never-decided OR stale-item face).
 *   2. `accept[]` present + non-empty, AND `supersessionId` names a recorded
 *      supersession -> supersession (latest-value).
 *   3. `accept[]` present + non-empty, else -> recall-accuracy.
 *   4. otherwise -> null (malformed).
 *
 * The link is NEVER inferred from entry-id overlap: probes and supersessions
 * cite the same broad transcript entries for unrelated facts, so intersection
 * matching mislabeled ordinary recall probes as supersession probes. An accept[]
 * probe citing a supersession's entries without naming `supersessionId` grades
 * as plain recall-accuracy.
 *
 * Pure.
 */
export function axisForProbe(probe: Probe, manifest: ScenarioManifest): MetricId | null {
  if (probe.correctRefusal === true) return "E6";
  const accept = probe.accept;
  if (accept !== undefined && accept.length > 0) {
    return matchedSupersession(probe, manifest) !== null ? "E8" : "E5.1";
  }
  return null;
}

/**
 * The supersession a supersession-latest probe tests the LATEST value of, or
 * null when the probe is not one. Matched ONLY by the explicit `supersessionId`
 * (must name a recorded supersessions[].id — validateManifest enforces the
 * reference). An unknown id matches nothing (recall axis). Shared by the axis
 * resolver + the judge slice builder so the two can never disagree. Pure.
 */
export function matchedSupersession(probe: Probe, manifest: ScenarioManifest): Supersession | null {
  if (probe.supersessionId === undefined) return null;
  return manifest.supersessions.find((s) => s.id === probe.supersessionId) ?? null;
}
