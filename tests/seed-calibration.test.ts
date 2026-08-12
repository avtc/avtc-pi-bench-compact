// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CalibrationSample } from "../src/judge/calibration.js";

const SCRIPT = resolve("scripts/seed-calibration.mjs");

/** Run the seed script with a temp manifest; return the parsed output. */
function runSeed(manifest: unknown): CalibrationSample[] {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  const manifestPath = join(dir, "manifest.json");
  const outPath = join(dir, "out.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  execFileSync("node", [SCRIPT, manifestPath, outPath], { encoding: "utf8" });
  return JSON.parse(readFileSync(outPath, "utf8")) as CalibrationSample[];
}

describe("scripts/seed-calibration.mjs (operator bootstrap helper)", () => {
  it("emits a binary template per probe with goldPass null (operator fills)", () => {
    const out = runSeed({
      id: "s1",
      probes: [{ question: "How is revenue calculated?", accept: ["price * units"] }],
    });
    const binary = out.filter((s) => s.kind === "binary");
    expect(binary.length).toBe(1);
    expect((binary[0] as { goldPass: null }).goldPass).toBeNull();
    expect((binary[0] as { slice: string }).slice).toContain("revenue");
  });

  it("emits a comparative template per comparative axis with empty goldOrder + armSlices", () => {
    const out = runSeed({ id: "s1", probes: [] });
    const comparative = out.filter((s) => s.kind === "comparative");
    expect(comparative.length).toBe(4); // the 4 comparative axes
    for (const slot of comparative as Array<{ goldOrder: unknown[]; armSlices: Record<string, unknown> }>) {
      expect(slot.goldOrder).toEqual([]);
      expect(slot.armSlices).toEqual({});
    }
  });

  it("notes correctRefusal probes in the slice criteria (abstention face)", () => {
    const out = runSeed({ id: "s1", probes: [{ question: "Power source?", correctRefusal: true }] });
    const binary = out.find((s) => s.kind === "binary") as { slice: string };
    expect(binary.slice).toMatch(/refus/i);
  });
});
