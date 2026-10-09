# Running the bench (manual E2E)

The canonical operator flow: **configure → prepare a scenario → run every arm → read the report.** Repeat runs sit at the step where they belong.

## 1. Configure

`/bench-compact:settings` opens the panel — evaluated agent model and thinking level, judges, background agents, `N`, `compactionBoundary`, `fastEval`, `latentProbes`, per-arm enables, `scenario`, and `outputDir`.

Every knob with type, default, and description lives in [CONFIGURATION.md](CONFIGURATION.md), together with the storage levels (session → project → global), the `PI_SETTINGS_BENCH_COMPACT` env var, and how your session-owl settings merge under the arm pins.

## 2. Prepare a scenario

**Build mode** — `/bench-compact:prepare-scenario <idea>` builds the scene through a user-simulator up to the `compactionBoundary` and freezes the pre-compaction backup. `--force` prepares over an existing scenario folder.

**Extract mode** — `/bench-compact:prepare-scenario --from-session <path>` freezes a real session — un-compacted (the bench performs the first compaction) and run from a real codebase on disk.

The frozen scenario lands under `<bench-root>/scenarios/<id>/` (`repo/` + `manifest.json`).

> **Trust prompt:** as soon as the bench switches the session into a freshly created scenario repo, pi asks `Trust project folder?` — answer **Trust**. The repo's `.pi/settings.json` carries the packages the run depends on; answering differently switches arm isolation off for that run. Expect one prompt per new scenario folder.

> **Review the authored `testSpec` before running.** The manifest's `taskObjective.testSpec` is authored by the manifest-authoring agent from the evaluated model's own build session, and scoring runs it in the real shell (`scrubEnv` strips provider API keys and other secret-looking env vars; the execution itself stays outside a sandbox). Inspect the frozen `manifest.json` before `/bench-compact:run-scenario` — especially after `/bench-compact:run <idea>`, which chains prepare → run without a human checkpoint in between.

**Re-author probes in place** — `/bench-compact:prepare-scenario --re-author <folder>` re-runs only the manifest authoring: it trial-compacts a copy of the frozen `main` backup at the current boundary, authors with tail validation (the author reads the full backup and drops findings the kept tail reveals or changes), validates, then replaces `manifest.json` (the previous one is kept as `manifest.pre-re-author.json`). The frozen backup, the scenario repo, and the committed arm bases stay untouched — only the probes and conditions change.

**Recovery when a build surfaces** (the prepare stores `landing.json` in the scenario folder when condition topics do not reach the compacted-away span):

- `--plant <folder>` — resume the SAME build one attempt past the surfaced one. The pacing target grows about +20K above the usage already reached, the resumed cycle continues the session while the simulator voices the missing topics, then re-trials → re-authors → re-validates. The resumed build runs with its own full attempt budget.
- `--skip-topics <ids> --from <folder>` — freeze the surfaced prepare's manifest without the dropped topics. Ids are comma-separated; `safeToSkip` topics only, essential topics are rejected.

```bash
/bench-compact:prepare-scenario build an incremental economic tycoon with AI thematic
/bench-compact:prepare-scenario --from-session C:/Users/…/.pi/agent/sessions/…/2026-08-09T….jsonl
/bench-compact:prepare-scenario --force <idea>
/bench-compact:prepare-scenario --re-author ~/.pi/bench-compact/scenarios/2026-08-14-1
/bench-compact:prepare-scenario --plant ~/.pi/bench-compact/scenarios/2026-08-14-1
/bench-compact:prepare-scenario --skip-topics change-mind,open-question --from ~/.pi/bench-compact/scenarios/2026-08-14-1
```

## 3. Run every arm

`/bench-compact:run-scenario <folder>` forks the scenario per arm, isolates each arm (config write + `reloadConfig()` + `setActiveTools`), runs `N` continuation attempts plus the manifest's direct probes, scores effectiveness (judge) and cost (trace), and writes `runs/<runId>/results.json` + `report.md`. The folder positional is optional — with `scenario` set in settings the run takes it from there.

**Repeat runs start from what an earlier run already compacted.** A plain `run-scenario <folder>` (after switching the model in `/bench-compact:settings`) reuses the previous run's compaction and latent-probe pools per arm and starts at the probes; `--fresh` recomputes compaction and latent authoring from scratch (`--fresh` and `--resume` stay mutually exclusive, as do `--fresh` and `--from`).

Decide which continuation fits:

| Situation | Command |
|---|---|
| Model or arm extension changed | `run-scenario <folder> --resume --allow-config-change --reuse-bases` |
| Interrupted run, latest one | `run-scenario <folder> --resume` (auto-detects the latest incomplete run) |
| Interrupted run, named | `run-scenario <folder> --resume=<runId>` (the `run-` branch prefix is accepted and normalized) |
| Scoring only, arms already finished | `run-scenario <folder> --resume=<runId> --rescore` |
| Everything from scratch | `run-scenario <folder> --fresh` |
| Grouped operator shortcut | `/bench-compact:resume [extra flags]` |

- `--allow-config-change` — the run-config fingerprint normally refuses a resume after a config or arm-tool-version change; this flag continues instead: the run keeps its original branch namespace and config snapshot, arms whose tool version changed re-compact under the new version (branch names embed it), unchanged arms skip as before.
- `--reuse-bases` — for fixes that did not change compaction behaviour (prompts, logic): reuse a committed arm base built under an older tool version when the new version's base is absent. Every reused base is logged with the version it was built under.
- `--rescore` — replays every phase from its durable artifacts, replays unchanged slices of the verdict journal, and rewrites `results.json` / `report.md`. A changed manifest (a probe-face fix, say) invalidates the journal and judging starts fresh.
- `/bench-compact:resume` — `run-scenario <scenario> --resume --allow-config-change --reuse-bases`, with the scenario taken from settings and the continuation flags implied. Extra args pass through verbatim (e.g. `--resume=<runId>`). Per-arm logs surface the config-change override and base reuse. It needs `scenario` set, otherwise it warns.
- `/bench-compact:pause` — steer the live agent to stop ("wait, stop") and stop the active run; the abort signal fires and the run winds down through its stop path. `/bench-compact:resume` continues afterwards.
- `/bench-compact:abort` — stop any active bench activity (a run or a prepare) and hide the progress widget. An aborted prepare winds down on its own; let it exit before starting another bench command.

**Resume mechanics.** Completed arms (Phase 1), continuation attempts (Phase 2a), and settled probes (Phase 2b — a committed probe branch, or a complete answer in the probe's session file) are detected from the scenario repo's committed `bench-compact/*` branches plus the sessions store and skipped; unfinished leftovers re-run; scoring (Phase 3) always re-runs but replays persisted verdicts from `runs/<runId>/judge/verdicts.jsonl` (one line per completed judge unit, so losing power mid-scoring costs the in-flight unit only). Bare `--resume` auto-detects the latest incomplete run — a run counts as complete once `runs/<runId>/results.json` exists.

If pi itself dies mid-run, restart pi and continue with `--resume`. Bench-timed compaction wall-clock is not recoverable after a crash — it reports as `0` in the compaction-cost metric, while token usage is re-read from the session transcripts.

**`fastEval`** defaults to `probes-only` for quick iteration (Phase-1 compactions + direct probes, minutes per arm); set `off` for full-budget continuations.

**`latentProbes`** (default `per-arm`) authors probes after compaction and scores them beside the planted set; `off` keeps planted probes, `shared` authors one question set across all arms.

## 4. Read the report

- `/bench-compact:results <runId>` — the single-run headline report (`report.md`): per-metric table (rates as `%`, `[95% CI]`, baseline deltas, ranks), comparative verdicts, the compaction-cost breakdown, reliability, artifacts.
- `/bench-compact:results <runId>:<arms>` — restrict to an arm subset (comma-separated, space-free), e.g. `2026-08-09-1:A1,A3`. Deselecting the bare-pi baseline omits its delta column.
- `/bench-compact:results <runId1>[:arms] <runId2>[:arms]` — compare two or more runs: a config diff plus a per-arm metric-delta table, arm subsets per run.
- `/bench-compact:results --merge <runId1>[:arms] <runId2>[:arms]` — fold disjoint arm subsets into ONE full headline report (`report-merged.md`, written next to the first run's results): baseline arms from an earlier run plus re-compact arms from a scoped run. Arms must be disjoint (each arm comes from one run), all runs must share the scenario, and comparative verdicts are per-run artifacts, so they stay out of the merged report.

Conventions and the section-by-section walk-through live in [REPORT.md](REPORT.md); metric ids are listed below, and `results.json` (`bench-compact.result-v1`) is the machine-readable counterpart.

## Live-progress widget

The run shows in a full-width widget under the prompt — the phases, the arm + tool, the background agent's stage: `build` → `extract` → `compact` → `latent` → `eval` → `probe` → `score`. Samples and the segment legend are in the README's *Live progress widget*; it holds after completion and `/bench-compact:abort` clears it.

## Failure handling

The bench **stops and surfaces** the first failure through a notification and waits for you — inspect the root cause, then `/bench-compact:resume`. The notification extension auto-fires on a 2-minute idle or stall. Rate limiting runs its own pause/resume cycle and stays separate from failure handling.

## ID reference

### Arm ids

| Id | Arm | Tool |
|---|---|---|
| `A1` | Bare-pi | `bare-pi` |
| `A2` | OM-default | `om-default` |
| `A3` | Session Owl-builder | `session-owl-builder` |
| `A4` | Session Owl-selector | `session-owl-selector` |
| `A5` | OM-full | `om-full` |

Use these in the `:arms` subset syntax (e.g. `/bench-compact:results <runId>:A1,A3`).

### Metric ids

Every metric carries a stable id (report columns + the `metricDefs` keys in the result JSON). `↑` = higher is better, `↓` = lower is better, comparative axes are ranked (`rank 1` = best).

| Id | Name | Channel | Polarity |
|---|---|---|---|
| `C1` | footprint (compaction summary tokens) | exact | ↓ |
| `C2` | recall-cost (tokens to first correct recall) | exact | ↓ |
| `C3` | run-cost (post-compaction output tokens) | exact | ↓ |
| `C4` | compaction-cost (tokens/$/wall across the arm's compaction stages) | exact | ↓ |
| `E1` | resume (resumes in-progress task) | comparative | rank |
| `E2` | redo-exec (re-executes completed work) | binary | ↓ |
| `E3` | redo-plan (re-proposes tried/rejected approaches) | comparative | rank |
| `E4` | proactive-recall (uses a needed fact unprompted) | binary | ↑ |
| `E5.1` | recall-accuracy-explicit (planted fact, direct probe) | binary | ↑ |
| `E5.2` | recall-accuracy-from-summary (cued latent probe) | binary | ↑ |
| `E5.3` | recall-accuracy-absent-in-summary (uncued latent probe) | binary | ↑ |
| `E6` | abstention (declines vs fabricates; flags stale) | binary | ↑ |
| `E7` | task-quality (resumed + continued work quality) | comparative | rank |
| `E8` | supersession (uses latestValue, suppresses oldValue) | binary | ↑ |
| `E10` | goal (stays on scripted goal) | comparative | rank |
