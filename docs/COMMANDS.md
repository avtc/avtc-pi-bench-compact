# bench-compact commands

Every command uses the `bench-compact:` namespace.

## Configure

### `/bench-compact:settings`
Open the settings panel: evaluated model + thinking level, judge model(s) + thinking level(s), multi-judge ensemble size (`judgesNumber` 1 or 3), `N` (continuations per arm), `compactionBoundary` (Phase-1 trigger), `backupMode` (build or extract), per-arm enables, `scenario` (a default prepared folder for `/bench-compact:run-scenario`), and `outputDir` (the bench root; null = `~/.pi/bench-compact/`).

## Prepare / run

### `/bench-compact:prepare-scenario <idea>`
**Build mode.** Drive a user-simulator to build brand-new work with the evaluated agent up to the `compactionBoundary`, then freeze the pre-compaction backup into a reusable scenario folder.

```
/bench-compact:prepare-scenario build an incremental economic tycoon with AI thematic
```

### `/bench-compact:prepare-scenario --from-session <path>`
**Extract mode.** Reuse a **real** past session. The session must be **un-compacted** (no `CompactionEntry` yet — the bench performs the first compaction) and run from a **real codebase on disk** (`session.cwd` must match a repo path).

```
/bench-compact:prepare-scenario --from-session C:/Users/.../.pi/agent/sessions/.../2026-08-09T....jsonl
```

### `/bench-compact:prepare-scenario <idea> --force`
Re-prepare over an existing scenario folder (otherwise an existing folder is rejected).

### `/bench-compact:prepare-scenario --plant <folder>` *(recovery)*
**Plant + continue.** When a build surfaces (condition topics did not land in the compacted-away span), the failed prepare persists `landing.json` in the scenario folder. This resumes the SAME build session ONE attempt past the surfaced one — the pacing target grows ~+20K above the already-reached usage, so the first resumed cycle continues the session while the simulator voices the missing topics — then re-trials → re-authors → re-validates. The resumed build runs with its own full attempt budget.

```
/bench-compact:prepare-scenario --plant ~/.pi/bench-compact/scenarios/2026-08-14-1
```

### `/bench-compact:prepare-scenario --skip-topics <ids> --from <folder>` *(recovery)*
**Skip + proceed.** Freeze the surfaced prepare's manifest WITHOUT the dropped topics (no re-build). Ids are comma-separated; only `safeToSkip` topics that are actually missing can be skipped (essential topics are rejected).

```
/bench-compact:prepare-scenario --skip-topics change-mind,open-question --from ~/.pi/bench-compact/scenarios/2026-08-14-1
```

### `/bench-compact:run-scenario <folder>`
Run every enabled arm from a **prepared** scenario folder (skips prepare). The folder is either the scenario dir (containing `manifest.json` + `repo/`) or the repo dir (with `manifest.json` in its parent).

```
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/2026-08-09-1
```

### `/bench-compact:run-scenario <folder> --resume [runId]` *(crash recovery)*
Continue an interrupted run. Completed arms (Phase 1), continuation attempts (Phase 2a), and kept probe branches (Phase 2b) are detected from the scenario repo's committed `bench-compact/*` branches and skipped; unfinished leftovers re-run; scoring (Phase 3) always re-runs. Bare `--resume` auto-detects the latest incomplete run (a run is complete once `runs/<runId>/results.json` exists). The run-config fingerprint must be unchanged — a config or arm-tool-version change since the crash refuses the resume.

Add `--allow-config-change` to continue anyway after a config or arm-tool-version change (e.g. a crash fix landed in an arm's extension): the run keeps its original branch namespace and config snapshot on disk, arms whose tool version changed re-compact under the new version (branch names embed it), and unchanged arms skip as before.

```
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/2026-08-09-1 --resume
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/2026-08-09-1 --resume=2026-08-14-1
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/2026-08-09-1 --resume --allow-config-change
```

### `/bench-compact:run <idea>` *(shorthand)*
Prepare (build) + run in one step.

### `/bench-compact:run-session-file <path>` *(shorthand)*
Extract a real session file + run in one step.

## Results

### `/bench-compact:results <runId>`
Render the single-run headline report (`report.md`) — per-metric table (rates as `%`, `[95% CI]`, `ΔvsA1`, ranks), comparative verdicts, `C4` breakdown, reliability, artifacts.

```
/bench-compact:results 2026-08-09-1
```

### `/bench-compact:results <runId>:<arms>` *(arm subset)*
Restrict the report to a subset of arms (comma-separated, no spaces). Deselecting the bare-pi baseline arm omits its delta column.

```
/bench-compact:results 2026-08-09-1:A1,A3
```

### `/bench-compact:results <runId1>[:arms] <runId2>[:arms2]` *(cross-run comparison)*
Compare two (or more) runs — renders a config diff + a per-arm metric-delta table. Mix in arm subsets per run.

```
/bench-compact:results 2026-08-09-1 2026-08-10-2:A1,A3
```

## Control

### `/bench-compact:pause`
Temporarily pause: steer the live agent to stop + abort the current op.

### `/bench-compact:resume`
Continue the agent after a pause, an interrupt, or a mid-turn error.

### `/bench-compact:abort`
Stop any active bench activity — a live run or a live scenario prepare — and hide the progress widget. An aborted prepare finishes winding down on its own; wait for it to exit before starting another bench command.

### `/bench-compact:status`
Show the current run state (arm / attempt / phase / ctx) + the last config validity.

## Live-progress widget

While a run is active, a single full-width TUI line shows progress through the phases (`build` → `extract` → `compact` → `eval` → `probe` → `score`), the active arm + tool, and the background agent's token usage (user-simulator during build/eval, judge during score). It stays visible through completion and is hidden only on `/bench-compact:abort`.

## Failure handling

The bench **stops and surfaces** failures via notification (never auto-retries or silently skips) — inspect the root cause, then `/bench-compact:resume`. The notification extension auto-fires on a 2-minute idle/stall. Rate-limit throttling is the only automatic pause/resume (distinct from a failure).

## ID reference

### Arm ids

| Id | Arm | Tool |
|---|---|---|
| `A1` | Bare-pi | `bare-pi` |
| `A2` | OM-default | `om-default` |
| `A3` | Memkeeper-builder | `memkeeper-builder` |
| `A4` | Memkeeper-selector | `memkeeper-selector` |
| `A5` | OM-full | `om-full` |

Use these in the `:arms` subset syntax (e.g. `/bench-compact:results <runId>:A1,A3`).

### Metric ids

Every metric has a stable id (the report columns + the result-JSON `metricDefs` keys). `↑` = higher is better, `↓` = lower is better, comparative axes are ranked (`rank 1` = best).

| Id | Name | Channel | Polarity |
|---|---|---|---|
| `C1` | footprint (compaction summary tokens) | exact | ↓ |
| `C2` | recall-cost (tokens to first correct recall) | exact | ↓ |
| `C3` | run-cost (post-compaction output tokens) | exact | ↓ |
| `C4` | compaction-cost (tokens/$/wall across the arm's compaction stages) | exact | ↓ |
| `E1` | resume (resumes in-progress task) | comparative | rank |
| `E2` | redo-exec (re-executes completed work) | binary | ↓ |
| `E3` | redo-plan (re-proposes tried/rejected approaches) | comparative | rank |
| `E4` | proactive-recall | binary | ↑ |
| `E5` | recall-accuracy | binary | ↑ |
| `E6` | abstention | binary | ↑ |
| `E7` | task-quality | comparative | rank |
| `E8` | supersession | binary | ↑ |
| _E9_ | _reserved (unused)_ | — | — |
| `E10` | goal (stays on the scripted objective) | comparative | rank |
