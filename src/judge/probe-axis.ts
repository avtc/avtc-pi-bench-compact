// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Maps one manifest Probe to its grading axis. Probes carry no explicit axis
// field — the axis is implied by the probe's SHAPE (correctRefusal vs accept[])
// and its TARGETS (which condition id it references). This resolver is the
// single source the scoring orchestrator uses to route each probe's answer to
// the right binary axis (recall-accuracy / abstention / supersession).
//
// The rubric's abstention "two faces" unify here: BOTH the never-decided abstention
// (correctRefusal) AND the supersession-stale probe (also correctRefusal — the
// agent should flag the stale value rather than confirm it) grade to abstention. A
// supersession probe with accept[] (the latest value is the correct answer)
// grades to supersession.

import type { Probe, ScenarioManifest } from "../manifest/schema.js";
import type { MetricId } from "../metrics/defs.js";

/**
 * Resolve the grading axis for one probe. Returns null for a malformed probe
 * (no accept[] and no correctRefusal — the orchestrator skips such probes).
 *
 * Rule (precedence):
 *   1. `correctRefusal === true` -> abstention (never-decided OR stale-item face).
 *   2. `accept[]` present + non-empty, AND any target id is a supersession -> supersession (latest-value).
 *   3. `accept[]` present + non-empty, else -> recall-accuracy (targets a recallFact by default).
 *   4. otherwise -> null (malformed).
 *
 * Pure.
 */
export function axisForProbe(probe: Probe, manifest: ScenarioManifest): MetricId | null {
  if (probe.correctRefusal === true) return "E6";
  const accept = probe.accept;
  if (accept !== undefined && accept.length > 0) {
    // probe.targets are ENTRY ids (schema: "targets = the target's entryIds"); supersessions
    // are matched by their entry ids, not their condition id (s.id) — matching
    // deriveLanes/validateManifest (entry-id <-> entry-id).
    const supersessionEntryIds = new Set(manifest.supersessions.flatMap((s) => s.entryIds));
    const targetsSupersession = probe.targets.some((target) => supersessionEntryIds.has(target));
    return targetsSupersession ? "E8" : "E5";
  }
  return null;
}
