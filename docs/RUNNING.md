# Running the bench (manual E2E)

The canonical operator flow: **configure → prepare a scenario → run every arm → read the report**.

## Prerequisites

1. Install the memory extensions the enabled arms need (see the README):
   - **Forked `pi-observational-memory`** (OM-default `A2` + OM-full `A5`).
   - **`avtc-pi-memkeeper`** (memkeeper-builder `A3` + memkeeper-selector `A4`).
   - The **C4 usage patches** on both (so compaction-cost is measurable for memory arms).
2. Load the extension in pi's `.pi/settings.json` `packages` (the harness + the full avtc-pi suite).
3. Configure the run via `/bench-compact:settings`: evaluated model + thinking level, judge model(s) + thinking level(s), `N` (continuations per arm), `compactionBoundary` (Phase-1 trigger), `backupMode` (`build` or `extract`), and which arms are enabled.

## Procedure

### 1. Prepare a scenario (once, reusable across runs)

- **Build mode** — `/bench-compact:prepare-scenario <idea>`: the harness drives a user-simulator to build brand-new work with the evaluated agent up to the `compactionBoundary`, then freezes the pre-compaction backup. (Shorthand: `/bench-compact:run <idea>` prepares + runs.)
- **Extract mode** — `/bench-compact:prepare-scenario --from-session <path>`: reuse a **real** un-compacted session that was run from a codebase on disk. (Shorthand: `/bench-compact:run-session-file <path>`.)

The frozen scenario lands under `~/.pi/bench-compact/scenarios/<id>/` (`repo/` + `manifest.json`). Re-prepare over an existing folder with `--force`.

> **Review the authored `testSpec` before running.** The manifest's `taskObjective.testSpec` is authored by the manifest-authoring agent from the evaluated model's own build session and is executed via the real shell during scoring (`scrubEnv` strips provider API keys + other secret-looking env vars first, but the execution itself is unsandboxed). Inspect the frozen `manifest.json` before `/bench-compact:run-scenario` — especially if you used the `/bench-compact:run <idea>` shorthand, which automates prepare→run with no human checkpoint. A malicious or injected model under test can otherwise author a `testSpec` that runs arbitrary code in the repo cwd.

### 2. Run every arm

`/bench-compact:run-scenario <folder>` forks the scenario per arm, isolates each arm (configure-API `reloadConfig` + `setActiveTools`), runs `N` continuation attempts + the manifest's direct probes, scores effectiveness (judge) + cost (trace), and writes `runs/<runId>/results.json` + `report.md`.

The live-progress widget tracks the phases (`build` → `compact` → `resume` → `probe` → `score`). The bench **stops and surfaces** any failure via notification (never auto-retries) — inspect the cause, then `/bench-compact:resume`.

### 3. Read the report

`/bench-compact:results <runId>` renders the headline report; `/bench-compact:results <runId>:A1,A3` restricts to an arm subset; `/bench-compact:results <runId1> <runId2>` compares two runs. See the README "How to read a report" + [COMMANDS.md](COMMANDS.md) for conventions.

## Current status

The bench is feature-complete for **scoring + reporting** (judge ensemble, exact metrics, statistics, result-JSON + headline report, live-progress widget, results command) — verified by the automated smoke + acceptance tests (`tests/e2e/`) which drive the **real** run driver + real scoring orchestrator end-to-end with mocked live-session phases + canned judges.

The **prepare-scenario live seams** (the user-simulator drive-and-capture, the trial compaction, the manifest authoring agent) are wired via `buildLiveSeams` (`src/production/live-seams.ts`) — `/bench-compact:prepare-scenario` drives a real build (or extracts a real session) end-to-end. `/bench-compact:run <idea>` + `/bench-compact:run-session-file <path>` chain through the same wiring. The optional tail-content detection (`findTailContent`) is not yet wired (absent → missing tail topics surface for the operator).

## Verifying without live LLMs (automated)

The full pipeline is verified without live sessions via the e2e suite:

```bash
npm test                              # all lints + 971 tests (incl. e2e smoke + acceptance)
npx vitest run tests/e2e/             # the smoke (real driver + real score → result-v1) + acceptance checks
```

The smoke proves the real run driver → real scoring → `results.json` + `report.md` with the full result-v1 shape; the acceptance checks pin cost determinism, confidence-interval sanity, A1 attribution + net-negative, run-config-id reproducibility, and that the bench mechanism primitives (compaction trigger + anti-peek inject) fire.
