# Running the bench (manual E2E)

The canonical operator flow: **configure → prepare a scenario → run every arm → read the report**.

## Prerequisites

1. Install the memory extensions the enabled arms need (see the README):
   - **Forked `pi-observational-memory`** (OM-default `A2` + OM-full `A5`).
   - **`avtc-pi-memkeeper`** (memkeeper-builder `A3` + memkeeper-selector `A4`).
   - The **C4 usage patches** on both (so compaction-cost is measurable for memory arms).
2. Load the extension in pi's `.pi/settings.json` `packages` (the harness + the full avtc-pi suite).
3. Configure the run via `/bench-compact:settings`: evaluated model + thinking level, judge model(s) + thinking level(s), `N` (continuations per arm), `compactionBoundary` (Phase-1 trigger), `latentProbes` (off / per-arm / shared), and which arms are enabled.
4. Tune memkeeper via its OWN global settings (`/mk:settings`, persisted to `~/.pi/agent/avtc-pi-memkeeper-settings.json`): models, per-call timeout (`llmCallTimeoutMs`), thinking levels (e.g. `observerThinkingLevel`), max output tokens, and thresholds all reach the bench arms — the bench pins only the arm-defining keys (`enabled`, stage modes, `renderMode`) and merges your global settings underneath.

## Procedure

### 1. Prepare a scenario (once, reusable across runs)

- **Build mode** — `/bench-compact:prepare-scenario <idea>`: the harness drives a user-simulator to build brand-new work with the evaluated agent up to the `compactionBoundary`, then freezes the pre-compaction backup. (Shorthand: `/bench-compact:run <idea>` prepares + runs.)
- **Extract mode** — `/bench-compact:prepare-scenario --from-session <path>`: reuse a **real** un-compacted session that was run from a codebase on disk. (Shorthand: `/bench-compact:run-session-file <path>`.)

The frozen scenario lands under `~/.pi/bench-compact/scenarios/<id>/` (`repo/` + `manifest.json`). Re-prepare over an existing folder with `--force`.

> **Trust prompt:** when the bench first switches the session into a freshly created scenario repo, pi asks `Trust project folder?` — answer **Trust**. The repo's `.pi/settings.json` carries the bench + suite + arm packages the run depends on; declining it silently disables arm isolation for that run. Expect one prompt per new scenario folder.

> **Review the authored `testSpec` before running.** The manifest's `taskObjective.testSpec` is authored by the manifest-authoring agent from the evaluated model's own build session and is executed via the real shell during scoring (`scrubEnv` strips provider API keys + other secret-looking env vars first, but the execution itself is unsandboxed). Inspect the frozen `manifest.json` before `/bench-compact:run-scenario` — especially if you used the `/bench-compact:run <idea>` shorthand, which automates prepare→run with no human checkpoint. A malicious or injected model under test can otherwise author a `testSpec` that runs arbitrary code in the repo cwd.

### 2. Run every arm

`/bench-compact:run-scenario <folder>` forks the scenario per arm, isolates each arm (configure-API `reloadConfig` + `setActiveTools`), runs `N` continuation attempts + the manifest's direct probes, scores effectiveness (judge) + cost (trace), and writes `runs/<runId>/results.json` + `report.md`.

The live-progress widget tracks the phases (`build` → `extract` → `compact` → `latent` → `eval` → `probe` → `score`).

With `Latent probes` on, an authoring pass after compaction adds probes for knowledge lost from the summary + tail; they score alongside the planted probes. The bench **stops and surfaces** any failure via notification (never auto-retries) — inspect the cause, then `/bench-compact:resume`.

If pi itself dies mid-run (a crash or force-quit), restart pi and continue via `/bench-compact:run-scenario <folder> --resume`. A half-finished arm or attempt re-runs from scratch; scoring always re-runs. Bench-timed compaction wall-clock is not recoverable (reported as `0` in the compaction-cost metric); token usage is re-read from the session transcripts. If a config or arm-tool version changed since the crash (e.g. an extension fix landed), the resume is refused — add `--allow-config-change` to continue anyway: arms whose tool version changed re-compact under the new version, unchanged arms skip. If the fix did not change compaction behavior (prompts/logic), also add `--reuse-bases` to reuse their already-compacted bases instead of re-compacting.

For quick iteration runs set `Fast eval` to `probes-only`: the run stops after Phase-1 compactions + direct probe Q&A (minutes per arm, scaling with `N`) and scores probe recall + compaction cost; continuation lanes are n/a. Real runs keep it off.

### 3. Read the report

`/bench-compact:results <runId>` renders the headline report; `/bench-compact:results <runId>:A1,A3` restricts to an arm subset; `/bench-compact:results <runId1> <runId2>` compares two runs. See the README "How to read a report" + [COMMANDS.md](COMMANDS.md) for conventions.

## Current status

The bench is feature-complete for **scoring + reporting** (judge ensemble, exact metrics, statistics, result-JSON + headline report, live-progress widget, results command) — verified by the automated smoke + acceptance tests (`tests/e2e/`) which drive the **real** run driver + real scoring orchestrator end-to-end with mocked live-session phases + canned judges.

The **prepare-scenario live seams** (the user-simulator drive-and-capture, the trial compaction, the manifest authoring agent) are wired via `buildLiveSeams` (`src/production/live-seams.ts`) — `/bench-compact:prepare-scenario` drives a real build (or extracts a real session) end-to-end. `/bench-compact:run <idea>` + `/bench-compact:run-session-file <path>` chain through the same wiring. Tail-content detection (`findTailContent`) is wired: when a topic's condition-list comes back empty, a kind-level presence check asks whether that content lives in the kept tail (conservative on malformed replies; skipped entirely when every topic has conditions). Recovery flows: `--plant` resumes the build session past the surfaced attempt with a fresh attempt budget; `--skip-topics` freezes without the dropped topics.

## Verifying without live LLMs (automated)

The full pipeline is verified without live sessions via the e2e suite:

```bash
npm test                              # all lints + full suite (incl. e2e smoke + acceptance)
npx vitest run tests/e2e/             # the smoke (real driver + real score → result-v1) + acceptance checks
```

The smoke proves the real run driver → real scoring → `results.json` + `report.md` with the full result-v1 shape; the acceptance checks pin cost determinism, confidence-interval sanity, A1 attribution + net-negative, run-config-id reproducibility, and that the bench mechanism primitives (compaction trigger + anti-peek inject) fire.
