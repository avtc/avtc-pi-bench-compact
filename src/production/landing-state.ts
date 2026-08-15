// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Persisted landing state for a FAILED prepare (condition topics did not land).
// Written next to the manifest (<scenarioDir>/landing.json — OUTSIDE the repo, so the
// agent never sees it) when the build surfaces; read back by the recovery commands
// (`--plant <folder>` resumes the build session steering the missing topics in;
// `--skip-topics <ids> --from <folder>` re-validates + freezes without them).

import { readFileSync, writeFileSync } from "node:fs";
import type { ScenarioManifest } from "../manifest/schema.js";

/** One missing condition topic (id/label/tag from the frozen topic constants). */
interface LandingTopic {
  readonly id: string;
  readonly label: string;
  readonly tag: string;
}

/** The persisted state of a surfaced prepare. */
export interface LandingState {
  /** Condition topics that did not land in the compacted-away span. */
  readonly missingTopics: readonly LandingTopic[];
  /** True when every missing topic is safeToSkip (skip + proceed is offered). */
  readonly skipOffered: boolean;
  /** The build session JSONL (stable across continue attempts) — --plant resumes it. */
  readonly buildSessionPath: string;
  /** The trial compaction's cut point (re-pre-slicing for --skip re-validation). */
  readonly firstKeptEntryId: string;
  /** The build attempt that surfaced (the --plant resume continues from here). */
  readonly attempt: number;
  /** The build-mode scenario idea (the --plant resume re-seeds the simulator with it). */
  readonly scenario: string;
  /** The last authored manifest (--skip re-validates + freezes it with topics dropped). */
  readonly manifest: ScenarioManifest;
}

/** The landing-state file name (written next to the manifest in the scenario folder). */
export const LANDING_FILE = "landing.json";

const TOPIC_FIELDS: ReadonlySet<string> = new Set(["id", "label", "tag"]);

/** Shape-check a parsed landing topic. */
function isLandingTopic(v: unknown): v is LandingTopic {
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v);
  return keys.length === TOPIC_FIELDS.size && keys.every((k) => TOPIC_FIELDS.has(k));
}

/** Parse + shape-check a landing state (throws a one-line error naming the field). */
export function parseLandingState(text: string): LandingState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("landing.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("landing.json: expected an object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.missingTopics) || r.missingTopics.length === 0 || !r.missingTopics.every(isLandingTopic)) {
    throw new Error("landing.json: missingTopics must be a non-empty array of {id,label,tag}");
  }
  if (typeof r.skipOffered !== "boolean") throw new Error("landing.json: skipOffered must be a boolean");
  if (typeof r.buildSessionPath !== "string" || r.buildSessionPath === "") {
    throw new Error("landing.json: buildSessionPath must be a non-empty string");
  }
  if (typeof r.firstKeptEntryId !== "string" || r.firstKeptEntryId === "") {
    throw new Error("landing.json: firstKeptEntryId must be a non-empty string");
  }
  if (typeof r.attempt !== "number" || !Number.isInteger(r.attempt) || r.attempt < 0) {
    throw new Error("landing.json: attempt must be a non-negative integer");
  }
  if (typeof r.manifest !== "object" || r.manifest === null)
    throw new Error("landing.json: manifest must be an object");
  if (typeof r.scenario !== "string" || r.scenario === "") {
    throw new Error("landing.json: scenario must be a non-empty string");
  }
  return {
    missingTopics: r.missingTopics,
    skipOffered: r.skipOffered,
    buildSessionPath: r.buildSessionPath,
    firstKeptEntryId: r.firstKeptEntryId,
    attempt: r.attempt,
    scenario: r.scenario,
    manifest: r.manifest as ScenarioManifest,
  };
}

/** Write the landing state to `path` (parent must exist). */
export function writeLandingState(path: string, state: LandingState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/** Read + parse the landing state from `path`. Throws when absent/malformed. */
export function readLandingState(path: string): LandingState {
  return parseLandingState(readFileSync(path, "utf-8"));
}
