// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared manifest-context rendering for judge system prompts. The trajectory
// grader (record_grades) + the trajectory-summary builder (write_summary) both
// render the manifest's doneOps as the rubric's ground-truth context; this is
// the single source so the two judge stages cannot drift apart.

import type { ScenarioManifest } from "../manifest/schema.js";

/** Render the manifest's doneOps as the judge-prompt context block. Returns
 *  "  (none)" when there are no doneOps so the prompt reads cleanly either way. */
export function renderDoneOps(manifest: ScenarioManifest): string {
  const lines = manifest.doneOps
    .map((op) => `  - ${op.id}: ${op.description} (${op.artifact}) [${op.reworkable ? "reworkable" : "done"}]`)
    .join("\n");
  return lines.length > 0 ? lines : "  (none)";
}
