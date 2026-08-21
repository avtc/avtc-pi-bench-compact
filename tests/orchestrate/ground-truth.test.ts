// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundTruthExcerpt } from "../../src/judge/slices.js";
import type { LatentProbe } from "../../src/manifest/latent.js";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import {
  buildProbeGroundTruthMap,
  type GroundTruthReadEntries,
  groundTruthDigest,
} from "../../src/orchestrate/ground-truth.js";
import { readSessionEntries } from "../../src/orchestrate/trace.js";

/** Write a one-arm session file fixture; returns its path + cleanup. */
function sessionFixture(dir: string, name: string, lines: readonly object[]): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

function msgEntry(id: string, text: string, role: "user" | "assistant"): SessionEntry {
  return {
    type: "message",
    id,
    timestamp: "2026-08-20T00:00:00Z",
    message: { role, content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

const manifest: ScenarioManifest = {
  id: "scen-1",
  description: "x",
  compactionBoundary: { phaseATokenBudget: 140_000, plan: "p" },
  recallFacts: [],
  doneOps: [],
  supersessions: [],
  abstentions: [],
  taskObjective: { description: "goal", testSpec: "" },
  probes: [
    { question: "q1?", accept: ["a1"], targets: ["e1"], lanes: ["direct-probe"] },
    { question: "q2?", accept: ["a2"], targets: ["e-missing"], lanes: ["direct-probe"] },
  ],
};

function latentOf(id: string, entryIds: readonly string[]): LatentProbe {
  return {
    id,
    question: `latent ${id}?`,
    accept: ["latent-answer"],
    entryIds,
    probeClass: "cued",
    note: "work-relevant",
    arm: "A1",
    verdicts: { A1: "absent" },
  };
}

describe("buildProbeGroundTruthMap", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("resolves manifest targets + latent entryIds against the arm's session; skips unresolvable", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-gt-"));
    dirs.push(dir);
    const sessionPath = sessionFixture(dir, "tool-arm", [
      msgEntry("e1", "Revenue is price times units sold.", "user"),
      msgEntry("e2", "An unrelated turn, as an assistant.", "assistant"),
      msgEntry("e-latent", "The bankruptcy window fires after three negative turns.", "user"),
    ]);
    const readEntries: GroundTruthReadEntries = (path) =>
      path === sessionPath
        ? [
            msgEntry("e1", "Revenue is price times units sold.", "user"),
            msgEntry("e2", "An unrelated turn, as an assistant.", "assistant"),
            msgEntry("e-latent", "The bankruptcy window fires after three negative turns.", "user"),
          ]
        : [];
    const latent = new Map<string, LatentProbe>([["A1:l1", latentOf("l1", ["e-latent"])]]);

    const map = buildProbeGroundTruthMap({
      bases: [{ arm: "A1", branch: "tool-arm" }],
      sessionsDir: dir,
      manifest,
      latent,
      readEntries,
    });

    // manifest probe 1 resolves via targets (user turn -> USER role)
    expect(map.get("A1:1")).toEqual([{ id: "e1", role: "USER", text: "Revenue is price times units sold." }]);
    // manifest probe 2's target is absent from the session → no entry
    expect(map.has("A1:2")).toBe(false);
    // latent probe resolves via entryIds
    expect(map.get("A1:l1")).toEqual([
      { id: "e-latent", role: "USER", text: "The bankruptcy window fires after three negative turns." },
    ]);
  });

  it("yields an empty map (and null digest) when the session file is unreadable", () => {
    const readEntries: GroundTruthReadEntries = () => {
      throw new Error("ENOENT");
    };
    const map = buildProbeGroundTruthMap({
      bases: [{ arm: "A1", branch: "tool-arm" }],
      sessionsDir: "/nonexistent",
      manifest,
      latent: new Map(),
      readEntries,
    });
    expect(map.size).toBe(0);
    expect(groundTruthDigest(map)).toBeNull();
  });

  it("reads the real session file when the real readEntries seam is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-gt-"));
    dirs.push(dir);
    sessionFixture(dir, "tool-arm", [msgEntry("e1", "Real file text.", "user")]);
    const map = buildProbeGroundTruthMap({
      bases: [{ arm: "A1", branch: "tool-arm" }],
      sessionsDir: dir,
      manifest,
      latent: new Map(),
      readEntries: readSessionEntries,
    });
    expect(map.get("A1:1")).toEqual([{ id: "e1", role: "USER", text: "Real file text." }]);
  });
});

describe("groundTruthDigest", () => {
  it("is deterministic, order-insensitive over keys, and changes on content change", () => {
    const mapA: ReadonlyMap<string, readonly GroundTruthExcerpt[]> = new Map([
      ["A1:1", [{ id: "e1", role: "USER", text: "t" }]],
      ["A1:l1", [{ id: "e2", role: "ASSISTANT", text: "u" }]],
    ]);
    const mapB: ReadonlyMap<string, readonly GroundTruthExcerpt[]> = new Map([
      ["A1:l1", [{ id: "e2", role: "ASSISTANT", text: "u" }]],
      ["A1:1", [{ id: "e1", role: "USER", text: "t" }]],
    ]);
    expect(groundTruthDigest(mapA)).toBe(groundTruthDigest(mapB));
    const mapC: ReadonlyMap<string, readonly GroundTruthExcerpt[]> = new Map([
      ["A1:1", [{ id: "e1", role: "USER", text: "changed" }]],
      ["A1:l1", [{ id: "e2", role: "ASSISTANT", text: "u" }]],
    ]);
    expect(groundTruthDigest(mapA)).not.toBe(groundTruthDigest(mapC));
    expect(groundTruthDigest(new Map())).toBeNull();
  });
});
