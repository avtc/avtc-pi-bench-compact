// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The operator-facing headline report (markdown) from /bench-compact:results.
// Renders the result-JSON (exact per-arm values) as the headline report: a header
// (scenario + runId + cfgId + full config incl. per-arm tool versions), a results
// table (rates as %, [95% CI], baseline-delta polarity-aware, net-negative
// flagged, rank 1=best, ↑/↓ polarity), one-line verdicts per comparative axis,
// a compaction-cost breakdown, a reliability section, + artifact paths. The
// baseline delta / net-negative are DERIVED LIVE from the exact values +
// metricDefs.polarity (not stored), so toggling the baseline arm or comparing
// cross-run stays correct. Omitted when the baseline arm is absent.

import type { ArmId } from "../config/types.js";
import type { MetricId } from "../metrics/defs.js";
import { a1Delta, type PerMetricDelta } from "../stats/delta.js";
import {
  count,
  dollars,
  formatDeltaSuffix,
  formatMetricValue,
  METRIC_ORDER,
  polarityArrow,
  versionTag,
} from "./format.js";
import type { BenchResultJson, C4MetricJson, MetricJson } from "./result-json.js";
import { extractJsonScalars } from "./result-json.js";

/** Per-arm baseline-delta derived live (null when the baseline arm is absent or a metric missing). */
function deriveDeltas(result: BenchResultJson): {
  a1Present: boolean;
  deltas: Readonly<Partial<Record<ArmId, PerMetricDelta>>>;
} {
  const a1 = result.arms.A1;
  if (a1 === undefined) return { a1Present: false, deltas: {} };
  const a1Scalars = extractJsonScalars(a1.metrics);
  const deltas: Partial<Record<ArmId, PerMetricDelta>> = {};
  for (const [armId, arm] of Object.entries(result.arms) as [ArmId, BenchResultJson["arms"][ArmId]][]) {
    if (arm === undefined || armId === "A1") continue;
    const armScalars = extractJsonScalars(arm.metrics);
    deltas[armId] = a1Delta(armScalars, a1Scalars, result.metricDefs);
  }
  return { a1Present: true, deltas };
}

/** Per-arm probe-answer usage sums (the probes-only run-cost totals + the footer line).
 *  Null when the arm has no usage-bearing probes. */
function probeUsageTotals(arm: NonNullable<BenchResultJson["arms"][ArmId]> | undefined): {
  tokensIn: number;
  tokensOut: number;
  dollars: number;
  wallMs: number;
} | null {
  const usages = (arm?.probes ?? []).flatMap((p) => p.usages ?? []).filter((u) => u !== null);
  if (usages.length === 0) return null;
  return usages.reduce(
    (acc, u) => ({
      tokensIn: acc.tokensIn + u.tokensIn,
      tokensOut: acc.tokensOut + u.tokensOut,
      dollars: acc.dollars + u.dollars,
      wallMs: acc.wallMs + u.wallMs,
    }),
    { tokensIn: 0, tokensOut: 0, dollars: 0, wallMs: 0 },
  );
}

/** Render one metric cell for one arm (value + Δ suffix when baseline present). */
function renderCell(metricValue: MetricJson | undefined, delta: number | null | undefined, a1Present: boolean): string {
  if (metricValue === undefined) return "—";
  let value = formatMetricValue(metricValue);
  if (a1Present && delta !== undefined && delta !== null) {
    value += formatDeltaSuffix(delta, metricValue);
  }
  return value;
}

/** The arms present in the result, in canonical arm order. */
function armsPresent(result: BenchResultJson): ArmId[] {
  return (["A1", "A2", "A3", "A4", "A5"] as ArmId[]).filter((a) => result.arms[a] !== undefined);
}

/** Render the full headline report. Pure. */
export function renderHeadline(result: BenchResultJson): string {
  const lines: string[] = [];
  const arms = armsPresent(result);
  const { a1Present, deltas } = deriveDeltas(result);

  // --- Header ---
  lines.push(`# bench-compact — ${result.scenario.id} · run ${result.runId}`);
  lines.push("");
  lines.push(
    `Started ${result.timestamp} · cfg ${result.cfgId} · scenario ${result.scenario.id} · backup ${result.config.backupMode}`,
  );
  const c = result.config;
  const judgeEnsemble =
    c.judgesNumber > 1
      ? ` · K=${c.judgesNumber} · judge2=${c.judge2Model ?? "(default)"} (${c.judge2ThinkingLevel}) · judge3=${c.judge3Model ?? "(default)"} (${c.judge3ThinkingLevel})`
      : "";
  lines.push(
    `Config: eval=${c.evaluatedModel ?? "(default)"} (${c.evaluatedThinkingLevel}) · judge=${c.judgeModel ?? "(default)"} (${c.judgeThinkingLevel})${judgeEnsemble} · N=${c.N} · compactionBoundary=${c.compactionBoundary} · arms ${c.armsEnabled.join(",")}`,
  );
  // SessionOwl arm params (approved format): shape-defining knobs per session-owl
  // arm — present-when-set key=value pairs; the whole line only when a session-owl
  // arm ran (older snapshots without sessionOwlArms render nothing).
  const sessionOwlEntries = (Object.entries(c.sessionOwlArms ?? {}) as [ArmId, Record<string, unknown> | null][])
    .filter(([, params]) => params !== null)
    .map(([arm, paramsIn]) => {
      const params = paramsIn as Record<string, unknown>;
      // positive list: the variable/shape keys only (approved short labels) —
      // enabled/ignoreConflicts are constants and the stage modes are arm identity
      const LABELS: ReadonlyArray<readonly [string, string]> = [
        ["renderMode", "render"],
        ["rootViewTargetNodes", "rootTarget"],
        ["rootViewStrategy", "rootStrategy"],
      ];
      const pairs = LABELS.filter(([key]) => params[key] !== undefined).map(
        ([key, label]) => `${label}=${String(params[key])}`,
      );
      return `${arm} ${pairs.join(" ")}`;
    });
  if (sessionOwlEntries.length > 0) {
    lines.push(`SessionOwl: ${sessionOwlEntries.join("; ")}`);
  }
  const toolLine = arms
    .map((a) => {
      const v = result.toolVersions[a];
      const tag = versionTag(v);
      return `${a} ${result.arms[a]?.tool ?? ""}${tag ? `@${tag}` : ""}`;
    })
    .join(" · ");
  lines.push(`Tool versions: ${toolLine}`);
  lines.push("");

  // --- Results table ---
  const resultsDesc = a1Present
    ? "## Results   (rates in %; [95% CI]; ΔvsA1 = arm − A1 (raw; ⚠ = worse than A1); rank 1=best; ↑/↓ polarity)"
    : "## Results   (rates in %; [95% CI]; rank 1=best; ↑/↓ polarity — no A1 baseline)";
  lines.push(resultsDesc);
  const header = `| Metric | ${arms.map((a) => `${a} ${result.arms[a]?.tool ?? ""}`).join(" | ")} |`;
  const sep = `|---|${arms.map(() => "---").join("|")}|`;
  lines.push(header);
  lines.push(sep);
  // rows: union of metrics any arm has, in canonical order
  const presentMetrics = METRIC_ORDER.filter((m) => arms.some((a) => result.arms[a]?.metrics[m] !== undefined));
  for (const metric of presentMetrics) {
    const def = result.metricDefs[metric];
    const polarity = def?.polarity ?? "lowerBetter";
    const arrow = polarityArrow(polarity);
    const chan = def?.channel ?? "exact";
    // The probes-only run-cost metric is the PER-ANSWER compound — relabel it and
    // follow it with a live totals row (the same sums the footer line shows, in the table).
    const perAnswerC3 =
      metric === "C3" && arms.some((a) => "answers" in ((result.arms[a]?.metrics.C3 ?? {}) as MetricJson));
    const label = `${metric} ${def?.name ?? ""}${perAnswerC3 ? "/answer" : ""}${chan === "comparative" ? " (rank)" : arrow ? ` (${arrow})` : ""}`;
    const cells = arms.map((a) => {
      const mv = result.arms[a]?.metrics[metric];
      const delta = a === "A1" ? null : (deltas[a]?.[metric] ?? null);
      return renderCell(mv, delta, a1Present);
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
    if (perAnswerC3) {
      const totalCells = arms.map((a) => {
        const totals = probeUsageTotals(result.arms[a]);
        return totals === null ? "—" : `${dollars(totals.dollars)}/${(totals.wallMs / 1000).toFixed(0)}s`;
      });
      lines.push(`| C3 run-cost total (↓) | ${totalCells.join(" | ")} |`);
    }
  }
  lines.push("");

  // --- Verdicts (one-line per comparative axis) ---
  const comparativeAxes = (Object.keys(result.ranks) as MetricId[]).sort();
  if (comparativeAxes.length > 0) {
    lines.push("## Verdicts (one-line per comparative axis)");
    for (const axis of comparativeAxes) {
      const def = result.metricDefs[axis];
      const order = result.ranks[axis]?.order ?? [];
      lines.push(`- ${axis} ${def?.name ?? ""}: ${order.join(" > ")}`);
    }
    lines.push("");
  }

  // --- Compaction-cost breakdown ---
  const c4Arms = arms.filter((a) => {
    const m = result.arms[a]?.metrics.C4;
    return m !== undefined && "dollars" in (m as MetricJson);
  });
  if (c4Arms.length > 0) {
    lines.push("## C4 breakdown (per arm: tokens in/out/cacheR/cacheW + $ + wall + stages)");
    lines.push("| Arm | in | out | cacheR | cacheW | $ | wall | stages |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const a of c4Arms) {
      const c4 = result.arms[a]?.metrics.C4 as C4MetricJson | undefined;
      if (c4 === undefined) continue;
      lines.push(
        `| ${a} ${result.arms[a]?.tool} | ${count(c4.tokensIn)} | ${count(c4.tokensOut)} | ${count(c4.cacheRead)} | ${count(c4.cacheWrite)} | ${dollars(c4.dollars)} | ${(c4.wallMs / 1000).toFixed(0)}s | ${c4.stages.join("+")} |`,
      );
    }
    lines.push("");
  }

  // --- Probe breakdown (one table per probe category/axis; cell = passed/graded) ---
  const probeArms = arms.filter((a) => (result.arms[a]?.probes?.length ?? 0) > 0);
  if (probeArms.length > 0) {
    // Rows: manifest probes (positional ids) union across arms in numeric order —
    // the SAME question in every arm. Latent pool ids (l*) name a DIFFERENT question
    // per arm, so they render one row per arm (a cross-arm union would mix questions).
    type BreakdownRow = {
      readonly label: string;
      readonly axis: MetricId;
      readonly cells: readonly string[];
      readonly passesByArm: readonly number[];
      readonly gradedByArm: readonly number[];
    };
    const shortQuestion = (question: string): string =>
      question.length > 64 ? `${question.slice(0, 61)}...` : question;
    const passCell = (p: { passes: readonly boolean[] } | undefined): string =>
      p === undefined ? "—" : `${p.passes.filter(Boolean).length}/${p.passes.length}`;
    const rows: BreakdownRow[] = [];
    const numericIds = [
      ...new Set(
        probeArms.flatMap((a) => (result.arms[a]?.probes ?? []).map((p) => p.probeId).filter((id) => /^\d+$/.test(id))),
      ),
    ].sort((x, y) => Number(x) - Number(y));
    for (const probeId of numericIds) {
      const first = probeArms
        .map((a) => (result.arms[a]?.probes ?? []).find((p) => p.probeId === probeId))
        .find((p) => p !== undefined);
      if (first === undefined) continue;
      rows.push({
        label: `p${probeId} · ${shortQuestion(first.question)}`,
        axis: first.axis,
        cells: probeArms.map((a) => passCell((result.arms[a]?.probes ?? []).find((entry) => entry.probeId === probeId))),
        passesByArm: probeArms.map(
          (a) => (result.arms[a]?.probes ?? []).find((entry) => entry.probeId === probeId)?.passes.filter(Boolean).length ?? 0,
        ),
        gradedByArm: probeArms.map(
          (a) => (result.arms[a]?.probes ?? []).find((entry) => entry.probeId === probeId)?.passes.length ?? 0,
        ),
      });
    }
    for (const a of probeArms) {
      const latentRows = (result.arms[a]?.probes ?? []).filter((p) => !/^\d+$/.test(p.probeId));
      for (const p of latentRows) {
        rows.push({
          label: `p${p.probeId} (${a}) · ${shortQuestion(p.question)}`,
          axis: p.axis,
          cells: probeArms.map((arm) => (arm === a ? passCell(p) : "—")),
          passesByArm: probeArms.map((arm) => (arm === a ? p.passes.filter(Boolean).length : 0)),
          gradedByArm: probeArms.map((arm) => (arm === a ? p.passes.length : 0)),
        });
      }
    }
    // One table per probe category (axis), in canonical metric order; the header
    // names the category (latent axes carry their cued/uncued flavor).
    const axisOrder = [
      ...METRIC_ORDER.filter((m) => rows.some((r) => r.axis === m)),
      ...[...new Set(rows.map((r) => r.axis))].filter((m) => !METRIC_ORDER.includes(m)),
    ];
    for (const axis of axisOrder) {
      const def = result.metricDefs[axis];
      const latentFlavor = axis === "E5.2" ? " (latent, cued)" : axis === "E5.3" ? " (latent, uncued)" : "";
      lines.push(`## Probe breakdown — ${axis} ${def?.name ?? ""}${latentFlavor}`);
      lines.push(`| Probe | ${probeArms.map((a) => a).join(" | ")} |`);
      lines.push(`|---|${probeArms.map(() => "---").join("|")}|`);
      for (const row of rows.filter((r) => r.axis === axis)) {
        lines.push(`| ${row.label} | ${row.cells.join(" | ")} |`);
      }
      const rateCells = probeArms.map((_, i) => {
        const graded = rows.filter((r) => r.axis === axis).reduce((n, r) => n + r.gradedByArm[i], 0);
        if (graded === 0) return "—";
        const passes = rows.filter((r) => r.axis === axis).reduce((n, r) => n + r.passesByArm[i], 0);
        return `${Math.round((passes / graded) * 100)}%`;
      });
      lines.push(`| **rate** | ${rateCells.join(" | ")} |`);
      lines.push("");
    }
    // Per-arm answer-cost summary (sums over every probe × attempt with usage).
    const costCells = probeArms.map((a) => {
      const usages = (result.arms[a]?.probes ?? []).flatMap((p) => p.usages ?? []).filter((u) => u !== null);
      if (usages.length === 0) return `${a} —`;
      const sum = usages.reduce(
        (acc, u) => ({
          tokensIn: acc.tokensIn + u.tokensIn,
          tokensOut: acc.tokensOut + u.tokensOut,
          dollars: acc.dollars + u.dollars,
          wallMs: acc.wallMs + u.wallMs,
        }),
        { tokensIn: 0, tokensOut: 0, dollars: 0, wallMs: 0 },
      );
      return `${a} ${count(sum.tokensIn)}in ${count(sum.tokensOut)}out ${dollars(sum.dollars)} ${(sum.wallMs / 1000).toFixed(0)}s`;
    });
    if (costCells.some((cell) => !cell.endsWith("—"))) {
      lines.push("");
      lines.push(`answer cost per arm: ${costCells.join(" | ")}`);
    }
    // Per-arm memory-recall overhead (lookup calls + injected tokens + tool wall),
    // summed over every probe × attempt with usage. Tokens are an estimate (chars/4).
    const recallCells = probeArms.map((a) => {
      const recalls = (result.arms[a]?.probes ?? [])
        .flatMap((p) => p.usages ?? [])
        .filter((u) => u !== null && u !== undefined)
        .flatMap((u) => (u.recall === undefined ? [] : [u.recall]));
      if (recalls.length === 0) return `${a} 0 calls`;
      const sum = recalls.reduce(
        (acc, r) => ({ calls: acc.calls + r.calls, tokens: acc.tokens + r.tokensInjected, wallMs: acc.wallMs + r.wallMs }),
        { calls: 0, tokens: 0, wallMs: 0 },
      );
      return `${a} ${count(sum.calls)} calls ${count(sum.tokens)} tok ${(sum.wallMs / 1000).toFixed(1)}s`;
    });
    if (costCells.some((cell) => !cell.endsWith("—"))) {
      lines.push(`recall cost per arm: ${recallCells.join(" | ")}`);
    }
    lines.push("");
  }

  // --- Reliability (per arm: completed/failed + stop-and-surface notes) ---
  lines.push("## Reliability (per arm: completed/failed + notes)");
  for (const a of arms) {
    const arm = result.arms[a];
    const completed = arm?.runsCompleted ?? 0;
    const failed = arm?.runsFailed ?? 0;
    lines.push(`- ${a} ${arm?.tool}: ${completed}/${completed + failed} completed, ${failed} failed`);
    // Append each failure note for this arm (reason + branch + resolved state — stop-and-surface transparency).
    for (const f of result.failures.filter((fl) => fl.arm === a)) {
      const status = f.resolved ? "resolved" : "unresolved";
      lines.push(`    - run ${f.run} (${f.phase}, ${status}): ${f.reason} [${f.traceBranch}]`);
    }
  }
  lines.push("");

  // --- Artifacts ---
  lines.push("## Artifacts");
  lines.push(`- scenario repo: ${result.artifacts.scenarioRepo}`);
  lines.push(`- result-JSON: ${result.artifacts.results ?? result.artifacts.config}`);
  lines.push(`- judge outputs: ${result.artifacts.judgeDir}`);
  lines.push(`- config: ${result.artifacts.config}`);
  return lines.join("\n");
}
