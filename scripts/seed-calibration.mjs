#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// seed-calibration.mjs — operator helper to SEED the judge calibration set.
//
// BOOTSTRAP PROCEDURE (§5.11, plan Task 16a AC "calibration-set format + bootstrap"):
//   The judge must be calibrated against a hand-scored reference set before it
//   grades real runs (runCalibrationGate: ≥85% binary agreement + ±1 rank on
//   ≥80% slots; fail → STOP+surface). The set is seeded from the FIRST real run's
//   traces — the operator hand-scores ~10–15 samples on the same rubric
//   (src/judge/rubrics.ts). This is the ONE manual deliverable in the bench.
//
//   1. Run the bench once (/bench-compact:run <idea>) → produces per-arm traces
//      + a manifest at ~/.pi/bench-compact/scenarios/<id>/manifest.json.
//   2. node scripts/seed-calibration.mjs <manifest.json> [out.json]
//      → emits a CalibrationSample[] TEMPLATE (gold left as null/[]) for the
//      operator to fill by hand against the rubric.
//   3. The operator fills goldPass (binary samples) / goldOrder (comparative
//      slots), saves the completed set as JSON files under
//      ~/.pi/bench-compact/calibration/<id>.json (one sample or one slot per file,
//      or a single array file — runCalibrationGate accepts the union).
//   4. Task 19's acceptance is CONDITIONAL on a non-empty calibration set (or
//      calibration is explicitly deferred/mocked with a recorded decision).
//
//   The synthetic set in tests/judge/calibration.test.ts doubles as the format
//   example. This script only produces TEMPLATES — it does not score anything.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: node scripts/seed-calibration.mjs <manifest.json> [out.json]");
  process.exit(2);
}

const manifestPath = resolve(args[0] ?? "");
const outPath = args[1] ?? join(homedir(), ".pi", "bench-compact", "calibration", "seed-template.json");

/** Read + parse the scenario manifest. */
function readManifest(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/** Build a binary-axis template per probe (goldPass left null for the operator). */
function binaryTemplates(manifest) {
  const samples = [];
  for (const probe of manifest.probes ?? []) {
    // Pick the axis from the probe target's condition type, defaulting to E5.
    samples.push({
      kind: "binary",
      id: `seed-probe-${probe.question.slice(0, 16).replace(/\W+/g, "-")}`,
      axis: "E5",
      slice: `PROBE QUESTION\n${probe.question}\n\nGRADING CRITERIA\naccept[]: ${(probe.accept ?? []).join(" | ") || correctRefusalNote(probe)}`,
      goldPass: null,
    });
  }
  return samples;
}

function correctRefusalNote(probe) {
  return probe.correctRefusal === true ? "CORRECT ANSWER = REFUSE (never-decided question)" : "(none)";
}

/** Build a comparative-slot template per comparative axis (goldOrder left empty). */
function comparativeTemplates() {
  const axes = ["E1", "E3", "E7", "E10"];
  return axes.map((axis) => ({
    kind: "comparative",
    id: `seed-comparative-${axis}`,
    axis,
    // armSlices are filled by the operator from the first run's per-arm slices.
    armSlices: {},
    goldOrder: [],
  }));
}

const manifest = readManifest(manifestPath);
const templates = [...binaryTemplates(manifest), ...comparativeTemplates()];

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
console.error(`wrote ${templates.length} calibration template(s) → ${outPath}`);
console.error("Fill goldPass (binary) / goldOrder + armSlices (comparative) by hand.");
