# avtc-pi-bench-compact

A pi extension that benchmarks compaction/memory approaches (**arms**) on an identical authored workload. For each arm it drives a harness-paced build up to a compaction boundary, then samples post-compaction agent behavior over `N` continuation runs and scores **effectiveness + cost** via a multi-judge LLM ensemble (judge-graded) and exact trace signals (no judge).

The full specification (design + task plan) lives in the project's `.featyard/` storage (managed, not committed). Run `/bench-compact:status` to check the current run state.

## Arms

The bench compares five arms — all run within the full avtc-pi suite (todo + user-decisions + portrait + notification); they differ only in the compaction-memory extension:

| Arm | Tool | Memory extension |
|---|---|---|
| Bare-pi | `bare-pi` | none (native pi LLM summary) |
| OM-default | `om-default` | pi-observational-memory (passive, author-default threshold) |
| Memkeeper-builder | `memkeeper-builder` | avtc-pi-memkeeper (`observations-root`, Selector OFF) |
| Memkeeper-selector | `memkeeper-selector` | avtc-pi-memkeeper (`selected-root`, Selector runs) |
| OM-full | `om-full` | pi-observational-memory (passive, reflector/pruner forced via low `reflectionThresholdTokens`) |

Bare-pi is the **baseline floor** — every other arm is compared against it. Disable it via the `armBarePiEnabled` setting to rank the memory arms standalone.

### Prerequisites (install the memory extensions first)

- **The OM-default and OM-full arms require the FORKED `pi-observational-memory`.** Upstream OM has a bug where `passive` mode (`PI_OBSERVATIONAL_MEMORY_PASSIVE=1`) does **not** catch up observations at compaction — the fork fixes this so both arms catch up identically to non-passive. Without the fork, both arms are invalid (no observations produced). The harness sets `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` itself at run start (env-only; no operator action needed).
- **The memkeeper-builder and memkeeper-selector arms require `avtc-pi-memkeeper`** (on-compaction mode; `renderMode` switched per arm).
- **The compaction-cost metric requires patching** the memory arms' `session_before_compact` hooks to emit per-stage LLM usage (so the bench can read `CompactionEntry.usage` uniformly across arms — bare-pi gets this natively).

### Arm isolation (no reload)

Each arm is isolated in-place within one process: the harness writes the arm's config (env + settings), then calls each memory extension's `reloadConfig()` (so every read site sees the new values with no per-site patching) and sets the tool allowlist via `pi.setActiveTools` (the disabled arms' tools are never sent to the model). There is **no `packages` edit and no `ctx.reload()`** — the suite extensions stay loaded for every arm.

## Install

```bash
# in the avtc-pi suite checkout
npm install
npm test            # biome + tsc + knip + jscpd + 5 custom lints + vitest
```

Enable the extension in pi's project or global settings (`.pi/settings.json`):

```jsonc
{
  "packages": ["avtc-pi-bench-compact", "avtc-pi-todo", "avtc-pi-user-decisions",
               "avtc-pi-portrait", "avtc-pi-notification",
               "pi-observational-memory", "avtc-pi-memkeeper"]
}
```

Configure the run via `/bench-compact:settings` (models, `N`, `compactionBoundary`, which arms are enabled, multi-judge ensemble). See [docs/COMMANDS.md](docs/COMMANDS.md) for the full command surface, and [docs/RUNNING.md](docs/RUNNING.md) for the end-to-end operator procedure + current status.

## Two ways to produce a scenario

A **scenario** is a frozen, reusable workload: a git repo (tracking `session.jsonl` + project files) plus a manifest (agent-hidden). Prepare it once, run it across arms + tool versions.

- **Build mode** (`backupMode: build`, default) — the harness drives a user-simulator to build brand-new work with the evaluated agent up to the `compactionBoundary`, then freezes the pre-compaction backup. `/bench-compact:prepare-scenario <idea>` or the shorthand `/bench-compact:run <idea>`.
- **Extract mode** (`backupMode: extract`) — reuse a **real** past session. The session must be **un-compacted** (no `CompactionEntry` yet — the bench performs the first compaction) and must have been **run from a real codebase on disk** (`session.cwd` must match a repo path so the agent resumes in a coherent project). `/bench-compact:prepare-scenario --from-session <path>` or `/bench-compact:run-session-file <path>`.

A prepared scenario lands under `~/.pi/bench-compact/scenarios/<id>/` (the repo at `repo/`, the manifest at `manifest.json`). Re-run it with `/bench-compact:run-scenario <folder>`.

> **Status:** the prepare live-seams (user-simulator drive, trial compaction, manifest authoring) are pending wiring, so `/bench-compact:prepare-scenario` + the `/bench-compact:run` / `/bench-compact:run-session-file` shorthands are not yet runnable; `/bench-compact:run-scenario <folder>` works against a pre-prepared folder. See [docs/RUNNING.md](docs/RUNNING.md).

## Scoring

Effectiveness is judge-graded; cost is computed exactly off the captured trace (no judge):

- **Exact (no judge):** footprint (compaction summary tokens), recall-cost (tokens until the first correct recall), run-cost (post-compaction output tokens), compaction-cost (tokens/$/wall across the arm's compaction stages).
- **Binary (judge per-run yes/no → rate over N):** redo-exec, proactive-recall, recall-accuracy, abstention, supersession.
- **Comparative (judge ranks the enabled arms):** resume, redo-plan, task-quality, goal.

Every metric has a stable single-letter id (printed in the report columns + the result-JSON `metricDefs` block); see [docs/COMMANDS.md](docs/COMMANDS.md) for the id→name map.

### Multi-judge reliability

Judge reliability is an **optional multi-judge ensemble** (not calibration). Set `judgesNumber` to `1` (single judge, default) or `3` (majority vote on binary axes, Borda rank-aggregation on comparative axes, union of recovered facts for recall-cost). For `K=3`, set `judge2Model`/`judge2ThinkingLevel` and `judge3Model`/`judge3ThinkingLevel` (flat settings knobs — settings-ui has no arrays).

## How to read a report

`/bench-compact:results <runId>` renders a single-run headline report (`report.md`); pass two runs to compare. Conventions:

- **Rates are shown as `%`** (e.g. `72%`); the result-JSON stores them as `[0,1]`.
- **`[95% CI]`** is a bootstrap confidence interval.
- **Baseline delta** is polarity-aware (`+` = better than bare-pi). A `⚠` flag marks **net-negative** metrics (the arm is worse than the bare-pi baseline).
- **Rank `1` = best**; `↑`/`↓` indicate polarity (higher/lower is better).
- The **compaction-cost** metric renders a per-arm breakdown (tokens-in / tokens-out / cache-read / cache-write / `$` / wall / stages); the result-JSON also carries a phase-2-compaction count per arm.
- A **reliability** section surfaces run failures + per-arm reliability flags; an **artifacts** section lists the result-JSON, config, and repo paths.

The machine-readable counterpart is `results.json` (`bench-compact.result-v1` schema) — it stores **exact per-arm results only** (no derived deltas); a self-describing `metricDefs` block names every metric, so a consumer needs no cross-reference to the doc.

## Storage layout

All artifacts derive from a single root: `outputDir ?? ~/.pi/bench-compact/`.

```
~/.pi/bench-compact/
├── scenarios/<id>/repo/      # scenario git repo (session.jsonl + project files)  [AGENT-VISIBLE]
│   └── ..                     # branches: main, bench-compact/run-…/arm-<tool>-<ver>
├── scenarios/<id>/manifest.json   # scenario manifest                          [agent-hidden]
├── runs/<runId>/             # judge/, results.json, report.md            [agent-hidden]
└── configs/<cfgId>.json      # full run config (the run-condition fingerprint) [agent-hidden]
```

**Contamination rule:** bench artifacts (manifest, results, judge output, configs) are **never** written into a scenario repo's working dir (the agent's cwd) — the agent cannot see or analyze them during its run. An anti-peek prompt is also injected at run start forbidding the agent from browsing sibling git branches or `~/.pi/bench-compact/`.

The scenario git repo tracks **session files only** — one `session.jsonl` per branch. Branches encode the run config (`cfg-{cfgId}`) + per-arm tool version (`{ver}`) so stats stay comparable across tool improvements. The bench runs sequentially in a single worktree (checkout at phase boundaries).
