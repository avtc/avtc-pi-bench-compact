# avtc-pi-bench-compact

Benchmarks compaction-memory extensions for [pi](https://pi.dev) head-to-head — judges what a post-compaction agent retains and recalls, whether it redoes work, and what that memory costs in tokens.

## Features

- **Head-to-head arms** — five memory setups — bare pi, two pi-observational-memory configs, two session-owl configs — run identically over the same scenario, so score deltas are attributable to the memory extension alone
- **Two scenario sources** — build fresh work with a user-simulator up to the compaction boundary, or extract a real un-compacted session from your own history
- **Frozen, reusable scenarios** — a scenario is a git repo plus an agent-hidden manifest; prepare once, run it across arms and tool versions
- **Exact cost metrics** — footprint, recall-cost, run-cost, and compaction-cost, computed straight off the captured trace
- **Judge-graded effectiveness** — redo, proactive recall, recall accuracy, abstention, supersession, resume, and task quality, rated per run over N trials
- **Optional multi-judge ensemble** — set `judgesNumber` to 3 for majority vote on binary axes and Borda rank-aggregation on comparative ones
- **Contamination guard** — bench artifacts stay out of the agent's working dir and an anti-peek prompt keeps the agent from reading results mid-run
- **Live progress widget** — a full-width status line tracks the phase (`build → extract → compact → latent → eval → probe → score`), the active arm and tool, and the background agent's token usage; `/bench-compact:abort` clears it
- **In-process arm isolation** — arms switch by rewriting and reloading config inside the running pi process

## Installation

```bash
pi install npm:avtc-pi-bench-compact
pi install npm:avtc-pi-session-owl
pi install git:github.com/avtc/pi-observational-memory@feature/v2-patches-to-run-bench-compact
```

Worth adding alongside:

- **`avtc-pi-notification`** — pings you when a run stalls or finishes while you are away.

The OM build on the branch above carries the patch set the bench measures with: passive-mode observations reach the compaction summary, `PI_OBSERVATIONAL_MEMORY_ENABLED=0` switches the extension off while a non-OM arm runs, `reloadConfig()` gives the harness in-place arm config, and its compaction reports per-stage usage for the cost metric — session-owl reports the same through its own compaction hook, bare-pi through pi itself. Patched source ships on the branch; the harness limits itself to config writes.

## Quick start

One line prepares a scenario and runs every armed setup end-to-end; the next renders the report:

```
/bench-compact:run build an incremental economic tycoon with AI thematic
/bench-compact:results <runId>
```

Reuse a real un-compacted session: `/bench-compact:run-session-file <path>`.

Once a scenario is prepared, two commands cover the repeat runs:

```
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/<id>             # run it again — set the new model in /bench-compact:settings first
/bench-compact:run-scenario ~/.pi/bench-compact/scenarios/<id> --resume    # continue an interrupted run
```

`<folder>` is the prepared scenario directory (shown when prepare finishes): `~/.pi/bench-compact/scenarios/<id>/` — it holds `manifest.json` and `repo/`, and the repo directory itself is accepted too. More repeat-run variants (`--allow-config-change`, `--reuse-bases`, `--rescore`, `--re-author`, `results --merge`) and the full operator procedure are in [docs/RUNNING.md](docs/RUNNING.md).

## Arms

The bench compares five arms in one shared package set; they differ only in the compaction-memory extension:

| Arm | Tool | Memory extension |
|---|---|---|
| Bare-pi | `bare-pi` | none (native pi LLM summary) |
| OM-default | `om-default` | pi-observational-memory (passive, author-default threshold) |
| Session Owl-builder | `session-owl-builder` | avtc-pi-session-owl (`observations-root`, Selector OFF) |
| Session Owl-selector | `session-owl-selector` | avtc-pi-session-owl (`selected-root`, Selector runs) |
| OM-full | `om-full` | pi-observational-memory (passive, reflector/pruner forced via low `reflectionThresholdTokens`) |

Bare-pi is the **baseline floor** — every other arm is compared against it. Disable it via the `armBarePiEnabled` setting to rank the memory arms standalone.

### Evaluating another compaction extension

Check three things about the extension first:

- Its configuration reaches it from a source the harness controls — an env var or a settings file.
- It re-reads that configuration on demand through `reloadConfig()`, so arms switch inside one running session.
- Its compaction reports per-stage usage, the number the compaction-cost metric reads.

Then add the arm: one data row in `src/arms/definitions.ts` (tool name, per-arm config, recall tools) and its config write in `src/arms/config.ts`. Judging, metrics, and the report work with any arm you add. Hand that starting point to your agent — `src/arms/` holds both seams.

### Arm isolation in one process

Arms share a single pi process: for each arm the harness writes its config (env + settings), calls `reloadConfig()` so every read site picks up the new values, then sets the tool allowlist with `pi.setActiveTools()` so only the active arm's recall tool reaches the model. The `packages` list and the loaded extensions stay fixed for the whole run — switching arms costs a config write, and the run keeps every extension warm.

## Scenarios

A **scenario** is a frozen, reusable workload: a git repo (tracking `session.jsonl` + project files) plus a manifest (agent-hidden). Prepare it once, run it across arms + tool versions.

- **Build mode** (`backupMode: build`, default) — the harness drives a user-simulator to build brand-new work with the evaluated agent up to the `compactionBoundary`, then freezes the pre-compaction backup. `/bench-compact:prepare-scenario <idea>` or the shorthand `/bench-compact:run <idea>`.
- **Extract mode** (`backupMode: extract`) — reuse a **real** past session. The session must be **un-compacted** (no `CompactionEntry` yet — the bench performs the first compaction) and must have been **run from a real codebase on disk** (`session.cwd` must match a repo path so the agent resumes in a coherent project). `/bench-compact:prepare-scenario --from-session <path>` or `/bench-compact:run-session-file <path>`.

A prepared scenario is ready for re-runs: `/bench-compact:run-scenario <folder>`.

> **Status:** `/bench-compact:prepare-scenario`, `/bench-compact:run <idea>`, and `/bench-compact:run-session-file <path>` run end-to-end (user-simulator drive, trial compaction, manifest authoring). See [docs/RUNNING.md](docs/RUNNING.md).

## Scoring

Effectiveness is judge-graded; cost is computed exactly off the captured trace:

- **Exact** — derived from the trace: footprint (compaction summary tokens), recall-cost (tokens until the first correct recall), run-cost (post-compaction output tokens), compaction-cost (tokens/$/wall across the arm's compaction stages).
- **Binary** — the judge answers yes/no each run, averaged into a rate over `N`: redo-exec, proactive-recall, recall-accuracy, abstention, supersession.
- **Comparative** — the judge ranks the enabled arms: resume, redo-plan, task-quality, goal.

Every metric has a stable single-letter id (printed in the report columns + the result-JSON `metricDefs` block); see [docs/RUNNING.md](docs/RUNNING.md) for the id→name map.

### Multi-judge reliability

Judge reliability runs as an **optional multi-judge ensemble**. Set `judgesNumber` to `1` (single judge, default) or `3` (majority vote on binary axes, Borda rank-aggregation on comparative axes, union of recovered facts for recall-cost). Judge 2 and judge 3 take optional `judge2Model`/`judge2ThinkingLevel` and `judge3Model`/`judge3ThinkingLevel`; unset, they reuse judge 1's model and thinking level, then the background level, the session's thinking level, and the model default — set them to run a heterogeneous ensemble.

## Benchmarks

Self-run evidence from this harness: one authored scenario, `N = 3` continuations per arm, LLM-judge scoring, bare-pi as the baseline. Evaluated model glm-5.3, background qwen3.8-27B:

| Recall accuracy (per-probe rate) | bare pi | om-default | session-owl-builder | session-owl-selector | om-full |
|---|---|---|---|---|---|
| Facts the user explicitly stated | 100% | 87% | 100% | 100% | 90% |
| Facts cued from the summary — the agent must recall the detail | 21% | 23% | 78% | 77% | 43% |
| Facts absent from the summary — recovered from session memory | 11% | 22% | 100% | 56% | 22% |

Arms: **bare pi** — native compaction summary, no memory extension; **om-default** — pi-observational-memory (the v2 fork) with observations that fit the budget; **session-owl-builder / session-owl-selector** — session-owl with the Builder's full view, or the Selector's curated view; **om-full** — observations past the threshold, so Reflector + Prune run.

Full reports: [agent glm-5.3 · background qwen3.8-27B](docs/benchmarks/report-agent-glm5.3-bg-qwen3.8-27b.md) · [agent qwen3.8-27B fp16 · xhigh](docs/benchmarks/report-qwen3.8-27b-fp16-xhigh-everything.md)

## How to read a report

`/bench-compact:results <runId>` renders `report.md` beside the run — rates with `[95% CI]`, polarity-aware baseline deltas flagged `⚠` when an arm lands below bare-pi, ranks, per-probe breakdowns, reliability, artifacts. The section-by-section walk-through is [docs/REPORT.md](docs/REPORT.md); the machine-readable twin (`results.json`, `bench-compact.result-v1`) keeps the exact per-arm numbers.

## Live progress widget

While a run is active, a full-width line under the prompt tracks it:

```
🅑 ◧□□□□□□ build · ctx 142k/200k · 1.1k tok
🅑 1/5 session-owl-builder · ■■◧□□□□ compact
🅑 2/5 session-owl-selector · ■■■■■◧□ probe 5/7 · ctx 8.0k/200k · 200 tok
🅑 ■■■■■■■ done · /bench-compact:results
```

Left to right: the bench mark, the arm counter with the active tool (omitted while the scenario builds), the seven-cell phase bar (`build → extract → compact → latent → eval → probe → score`) with the active phase named plus its detail (`3/10` attempts, `5/7` probes, `cued 1/3 · uncued 2/3` on the latent pass), the background agent's `ctx <used>/<window>` usage and output tokens, then a status word on stop and the next command. `ctx` and tokens show while an agent generates (user-simulator in build/eval, judge in score) and drop during compaction, where the memory extensions render their own stage line; `?` is a window the model hasn't resolved yet. A finished run holds `■■■■■■■ done · /bench-compact:results` (a prepared-only run shows `prepared · /bench-compact:run-scenario <folder>`) until `/bench-compact:abort` clears it.

## Commands

| Command | Description |
|---|---|
| `/bench-compact:settings` | Open the settings panel — models, `N`, `compactionBoundary`, arm enables, judge ensemble |
| `/bench-compact:prepare-scenario <idea>` | Build a scenario with a user-simulator; `--from-session <path>` extracts a real one |
| `/bench-compact:run <idea>` | Prepare + run in one step |
| `/bench-compact:run-session-file <path>` | Extract a session file + run in one step |
| `/bench-compact:run-scenario <folder>` | Run every enabled arm from a prepared scenario (`--resume`, `--fresh`, `--rescore`) |
| `/bench-compact:results <runId>` | Render the headline report; add a second run to compare (`--merge` = one combined report) |
| `/bench-compact:pause` | Pause an active run |
| `/bench-compact:resume [flags]` | Resume the latest interrupted run |
| `/bench-compact:abort` | Stop bench activity and hide the progress widget |
| `/bench-compact:status` | Show the current run state and config validity |

Flag semantics and recovery flows: [docs/RUNNING.md](docs/RUNNING.md).

## Configuration

Run settings are edited through `/bench-compact:settings` — evaluated model and thinking level, judge model(s) and ensemble size, `N`, `compactionBoundary`, the prepared `scenario` folder, enabled arms, and `outputDir` (null = `~/.pi/bench-compact/`). Persisted values are what the run config snapshots fingerprint, so a changed setting starts a new cfg id. The full roster lives in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Storage

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

## Full suite

Check out the full suite of related extensions, [avtc-pi](https://github.com/avtc/avtc-pi) — deterministic feature development, subagent delegation, working-memory, behavioral learning, parallel-work guardrails, durable decisions, notifications, and more.

Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT
