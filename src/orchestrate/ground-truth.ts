// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Ground-truth excerpt building for probe-answer judge slices. Latent probes
// cite the pre-compaction span entries their answer lives in (entryIds); manifest
// probes cite theirs via targets. The arm's compacted-base session file still
// carries those entries (compaction is a replay boundary, not a file rewrite), so
// the span text can be re-read at scoring time and handed to the judges as a
// bounded reference block — letting them grade substance over accept[] phrasing.
//
// Pure map-building over an injectable read seam; the run driver builds the map
// once (one session-file read per arm) and scoring threads it into every probe
// slice. Judge-facing bounding happens later, in renderGroundTruthBlock
// (judge/slices.ts) — this layer passes full entry texts through.

import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ArmId } from "../config/types.js";
import type { GroundTruthExcerpt, GroundTruthRole } from "../judge/slices.js";
import { log } from "../log.js";
import type { LatentProbe } from "../manifest/latent.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { messageText } from "../session/message-text.js";
import { branchSessionFile } from "../storage/paths.js";

/** The session-file read seam (the run driver passes the real readSessionEntries;
 *  tests inject a fake). */
export type GroundTruthReadEntries = (sessionPath: string) => SessionEntry[];

/** The arm identity the map builder needs (a Phase-1 base). */
export interface GroundTruthArmBase {
  readonly arm: ArmId;
  readonly branch: string;
}

/** Inputs to {@link buildProbeGroundTruthMap}. */
export interface BuildGroundTruthOpts {
  /** The run's arm bases (arm id + compacted-base branch). */
  readonly bases: readonly GroundTruthArmBase[];
  /** The run's sessions dir (branch session files live here). */
  readonly sessionsDir: string;
  /** The scenario manifest (positional probe targets). */
  readonly manifest: ScenarioManifest;
  /** Active latent probes keyed "<arm>:<poolId>". */
  readonly latent: ReadonlyMap<string, LatentProbe>;
  /** Session-file read seam (the run driver passes the real readSessionEntries). */
  readonly readEntries: GroundTruthReadEntries;
}

/** An entry reduced to the fields the excerpt lookup needs. */
interface EntryLike {
  readonly id?: string;
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
  };
}

/** The excerpt role for an entry: ASSISTANT for assistant messages, USER for
 *  everything else (user messages, custom messages, branch summaries) — the
 *  memory tools' role-tag convention. */
function excerptRole(entry: SessionEntry): GroundTruthRole {
  const like = entry as EntryLike;
  return like.type === "message" && like.message?.role === "assistant" ? "ASSISTANT" : "USER";
}

/** Build the per-probe ground-truth excerpt map, keyed "<arm>:<probeId>" (the
 *  1-based positional id for manifest probes, the pool id for latent probes —
 *  the same keys gradeProbeAxesForRun routes by). Probes whose cited entries
 *  cannot be resolved are simply absent (their slices stay unchanged). An
 *  unreadable session file disables ground truth for that arm only. */
export function buildProbeGroundTruthMap(opts: BuildGroundTruthOpts): Map<string, readonly GroundTruthExcerpt[]> {
  const map = new Map<string, readonly GroundTruthExcerpt[]>();
  for (const base of opts.bases) {
    let byId: Map<string, GroundTruthExcerpt>;
    try {
      const entries = opts.readEntries(branchSessionFile(opts.sessionsDir, base.branch));
      byId = new Map(
        entries
          .map((entry) => {
            const id = (entry as EntryLike).id;
            if (id === undefined) return null;
            const text = messageText(entry).trim();
            if (text.length === 0) return null;
            return [id, { id, role: excerptRole(entry), text }] as const;
          })
          .filter((pair): pair is readonly [string, GroundTruthExcerpt] => pair !== null),
      );
    } catch (error) {
      log.warn(`ground-truth: session unreadable for ${base.arm} (${base.branch}) — slices stay without excerpts`);
      log.debug(`ground-truth read error: ${String(error)}`);
      continue;
    }
    const excerptsOf = (entryIds: readonly string[]): readonly GroundTruthExcerpt[] =>
      entryIds.flatMap((id) => {
        const excerpt = byId.get(id);
        return excerpt === undefined ? [] : [excerpt];
      });
    opts.manifest.probes.forEach((probe, index) => {
      const excerpts = excerptsOf(probe.targets);
      if (excerpts.length > 0) map.set(`${base.arm}:${index + 1}`, excerpts);
    });
    for (const [key, probe] of opts.latent) {
      if (!key.startsWith(`${base.arm}:`)) continue;
      const excerpts = excerptsOf(probe.entryIds);
      if (excerpts.length > 0) map.set(key, excerpts);
    }
  }
  return map;
}

/** A stable digest of the ground-truth map (null when empty) — feeds the
 *  verdict-journal fingerprint so a change in the excerpts the judges see
 *  restarts the journal (stale no-excerpt verdicts never replay). */
export function groundTruthDigest(map: ReadonlyMap<string, readonly GroundTruthExcerpt[]>): string | null {
  if (map.size === 0) return null;
  const canonical = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, excerpts]) => `${key}\n${excerpts.map((e) => `<${e.role} entry=${e.id}> ${e.text}`).join("\n")}`)
    .join("\n---\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
