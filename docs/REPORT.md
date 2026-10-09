# Reading a report

`/bench-compact:results <runId>` writes `report.md` next to the run's `results.json` under `<bench-root>/runs/<runId>/`. This walks the file top to bottom.

## Header

    # bench-compact — ae2d92c1 · run 2026-08-23-2
    Started 2026-08-24T15:55:13Z · cfg cfg-680f35 · scenario ae2d92c1 · backup build
    Config: eval=zai-proxy/glm-5.3 (xhigh) · judge=(default) (null) · K=3 · … · N=3 · compactionBoundary=140000 · arms A1,A2,A3,A4,A5
    Tool versions: A1 bare-pi · A2 om-default@g0c42d9 · …

- **scenario id** ties every run of the same prepared scenario together; **run id** is the dated run (`2026-08-23-2`), **cfg id** the settings fingerprint (a settings change starts a new one).
- `backup build` / `backup extract` — which prepare mode froze the scenario.
- The config line records the evaluated model + thinking level, each judge's model + thinking level (`(default)` = the resolved chain), `K`, `N`, `compactionBoundary`, and the enabled arms — the values that decide comparability.
- Tool versions pin the memory-extension commit per arm (the same version appears in each arm's branch names).

## Results

The headline table: one column per arm, one row per metric (ids match the ID reference in [RUNNING.md](RUNNING.md)).

| Convention | Meaning |
|---|---|
| `72%` | metric rate over the run's `N` continuations |
| `[95% CI]` | bootstrap confidence interval — overlapping intervals read as a tie |
| `[+57]` | delta vs the `A1 bare-pi` baseline, polarity-aware (`+` = better) |
| `⚠` | net-negative: the arm lands below the bare-pi baseline on this metric |
| `rank 1` | best arm on that row |
| `↑` / `↓` | higher / lower is better |

Read rows together rather than one at a time: the recall trio splits the nuance (`E5.1` facts the user stated, `E5.2` cued from the summary, `E5.3` recovered from session memory), the cost rows split the answer price from the run price (`C3` per answer and total, `C4` compaction), and an arm that buys recall with footprint shows it as `⚠` in the same row pair.

## C4 breakdown

Per arm: tokens in / out / cache-read / cache-write, `$`, wall time, and the stages the arm actually ran (`native-summary`, `observer+reflector+pruner`, `observe+build+select`).

## Probe breakdown

One section per binary metric, one row per probe, `k/N` per arm (continuations answered correctly / N). `—` marks an arm that owns no such probe; latent probes carry their arm in parentheses — `pl1 (A2)` — because each arm authors its own probe set. The `**rate**` row aggregates the column into the Results table above.

## Reliability

Completed / failed attempts per arm with the notes attached at run time.

## Artifacts

Paths to the scenario repo, `results.json`, the per-judge outputs, and the cfg file.

## Compare and merge

- A second run id renders a config diff plus a per-arm delta table (`report-compare.md`).
- `--merge` folds disjoint arm subsets into one full report (`report-merged.md`).
- Withholding the baseline (`<runId>:A2,A3`) drops its delta column; the header then says `no A1 baseline`.

## results.json

The machine-readable counterpart (`bench-compact.result-v1` schema) stores the **exact per-arm results** — deltas are derived downstream — and its `metricDefs` block names every metric, so the file reads against the inline ids without a cross-reference.