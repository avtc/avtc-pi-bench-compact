// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Durable Phase-1 compaction wall-times, one JSON file per run
// (`runs/<runId>/phase1-walls.json`: `{ "<arm>": <wallMs> }`). The bench times each
// arm's boundary compaction in-process; without this file a crash/resume (or a
// later --rescore) rebuilds the arm bases in a fresh process and the wall would be
// silently lost (the compaction-cost metric would render 0s). Merge-on-write so a
// resumed run re-compacting SOME arms updates just those entries.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArmId } from "../config/types.js";

/** Per-arm Phase-1 compaction wall-times (only arms that compacted are present). */
export type Phase1Walls = Partial<Record<ArmId, number>>;

/** Read a run's walls file ({} when absent/corrupt — a missing file degrades to 0s). */
export function readPhase1Walls(path: string): Phase1Walls {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const walls: Phase1Walls = {};
    for (const [arm, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        walls[arm as ArmId] = value;
      }
    }
    return walls;
  } catch {
    return {};
  }
}

/** Merge-write per-arm walls (existing entries for OTHER arms are preserved — a
 *  resume re-compacting a subset updates only those). Creates the parent dir. */
export function writePhase1Walls(path: string, walls: Phase1Walls): void {
  const merged = { ...readPhase1Walls(path), ...walls };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}
