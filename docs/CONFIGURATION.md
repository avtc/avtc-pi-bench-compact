# bench-compact configuration

Every run knob lives behind `/bench-compact:settings` — 45 settings across eight tabs (General / Run / Arms / Judge / Author / Validate / Sim / Latent). This page lists them all: key, type, default, and what the setting drives.

## Where settings live

Settings persist in three levels, each overriding the one above:

| Level | File |
|---|---|
| session | live for the current session |
| project | `<cwd>/.pi/avtc-pi-bench-compact-settings.json` |
| global | `~/.pi/agent/avtc-pi-bench-compact-settings.json` |

The settings stack is also reachable through the `PI_SETTINGS_BENCH_COMPACT` env var, and the panel re-reads persisted state on every open, so an edit lands in the next command.

Persisted values are what the run config snapshot fingerprints: a changed setting starts a new cfg id, which the resume guard compares against.

Types used below: `model` (model id, empty = the fallback named in the description) · `thinking-level` · `number` · `duration` (milliseconds) · `string` · `boolean`.

## General

| Key | Type | Default | Description |
|---|---|---|---|
| `evaluatedModel` | model | `null` | The agent under test — the subject of the bench. Empty = the current session model. |
| `evaluatedThinkingLevel` | thinking-level | `"high"` | Thinking level for the evaluated agent. |
| `judgesNumber` | number | `1` | Judges per grading call. `1` = single judge (cheap dev default); `3` = majority vote on binary axes, Borda rank-aggregation on comparative axes. |
| `backgroundModel` | model | `null` | Default model for every background agent (manifest author, probe validator, simulator, latent authoring). Empty = each agent keeps its built-in base — author / probe validator / simulator use the evaluated model, latent authoring uses the session default. |
| `backgroundThinkingLevel` | thinking-level | `null` | Thinking level for every background agent unless overridden per agent. Unset follows the session's thinking level; `off` omits the reasoning field (the model default applies). |
| `backgroundMaxTokens` | number | `65536` | Default per-call output-token cap for background agents unless overridden per agent. |
| `backgroundTimeoutMs` | duration | `1200000` | Default wall-clock cap for background-agent LLM calls unless overridden per agent. |
| `stageProviderMaxRetries` | number | `3` | Provider-level retries per background-stage LLM call (judge, manifest author, latent author, user-simulator) on transient 5xx/429/408/409 responses. pi's session-owned retries cover the bench stages separately. |

## Run

| Key | Type | Default | Description |
|---|---|---|---|
| `N` | number | `10` | Post-compaction continuation runs per arm. Higher = tighter confidence intervals and higher cost. |
| `compactionBoundary` | number | `140000` | The harness fires the Phase-1 compaction when context reaches this many tokens. The bench's own trigger — the model's context window stays untouched. |
| `fastEval` | string (`off` · `probes-only`) | `"probes-only"` | `probes-only` = quick iteration: after the Phase-1 compaction the agent pauses goal work and answers the manifest's direct questions, scoring probe recall, summary cost, and compaction cost with continuation lanes out of scope. `off` = full budget, continuations drive to the model's context window. |
| `latentProbes` | string (`off` · `per-arm` · `shared`) | `"per-arm"` | `planted-fact probes only` with `off`; `per-arm` = a second authoring agent reads each arm's session file and writes that arm's probes for knowledge absent from its summary and tail; `shared` = one authoring run over all arms producing a single question set absent from every summary. |
| `testspecTimeoutMs` | number | `120000` | Wall-clock cap for the embedded testSpec shell run on each attempt branch. |
| `scenario` | string | `null` | Prepared scenario folder used by default. `null` = the folder is passed to `/bench-compact:run-scenario` (or `/bench-compact:resume` warns). |
| `outputDir` | string | `null` | Bench root for run artifacts (manifest, results, judge outputs). Empty = `~/.pi/bench-compact/`. |

## Arms

| Key | Type | Default | Description |
|---|---|---|---|
| `armBarePiEnabled` | boolean | `true` | **bare-pi** — native pi compaction (LLM summary). The baseline every other arm is compared against. |
| `armOmDefaultEnabled` | boolean | `true` | **observational-memory (default)** — OM at its default `reflectionThresholdTokens`. Needs the patched `pi-observational-memory` branch (passive catch-up). |
| `armSessionOwlObservationsRootEnabled` | boolean | `true` | **session-owl (observations-root)** — `renderMode=observations-root`, the Builder's full root view with the Selector off. |
| `armSessionOwlSelectedRootEnabled` | boolean | `true` | **session-owl (selected-root)** — `renderMode=selected-root`, the Selector-curated active set. |
| `armOmFullEnabled` | boolean | `true` | **observational-memory (full)** — OM with `reflectionThresholdTokens` overridden so reflector and pruner always run. Needs the patched `pi-observational-memory` branch. |
| `omFullReflectionThresholdTokens` | number | `4000` | `reflectionThresholdTokens` override for the om-full arm (forces reflector + pruner). Consulted only while that arm is enabled. |

## Judge

| Key | Type | Default | Description |
|---|---|---|---|
| `judgeModel` | model | `null` | Model for the LLM judge (scoring). Empty = background default, then the session model. |
| `judgeThinkingLevel` | thinking-level | `null` | Thinking level for the judge. Empty = the background thinking level. |
| `judge2Model` | model | `null` | Second judge model (engaged when the ensemble size reaches 2). Empty = judge 1's model, then the background default, then the session model. |
| `judge2ThinkingLevel` | thinking-level | `null` | Thinking level for judge 2. Empty = judge 1's thinking level, then background, then the session level. |
| `judge3Model` | model | `null` | Third judge model (engaged when the ensemble size reaches 3). Empty = judge 1's model, then the background default, then the session model. |
| `judge3ThinkingLevel` | thinking-level | `null` | Thinking level for judge 3. Empty = judge 1's thinking level, then background, then the session level. |
| `judgeMaxTokens` | number | `null` | Per-call output-token cap for judge calls (single-call slices, rankings, trajectory summaries). Empty = the background max tokens. |
| `judgeTurnTimeoutMs` | duration | `null` | Wall-clock cap per judge LLM call. Empty = the background timeout. |

## Author

| Key | Type | Default | Description |
|---|---|---|---|
| `authorModel` | model | `null` | Manifest authoring agent (prepare). Empty = background default, then the evaluated model. |
| `authorThinkingLevel` | thinking-level | `null` | Manifest author thinking level. Empty = the background thinking level. |
| `authorMaxTokens` | number | `null` | Per-call output-token cap for the (multi-turn, tool-bearing) manifest author. Empty = the background max tokens. |
| `authorTimeoutMs` | duration | `null` | Wall-clock cap for manifest-author LLM calls. Empty = the background timeout. |

## Validate

| Key | Type | Default | Description |
|---|---|---|---|
| `probeValidateModel` | model | `null` | Probe validator (validates each authored probe at add time) and the kept-tail content check. Empty = background default, then the evaluated model. |
| `probeValidateThinkingLevel` | thinking-level | `null` | Probe validator thinking level. Empty = the background thinking level. |
| `probeValidateMaxTokens` | number | `null` | Per-call output-token cap per probe-validator call. Empty = the background max tokens. |
| `probeValidateTimeoutMs` | duration | `null` | Wall-clock cap per probe-validator LLM call. Empty = the background timeout. |

## Sim

| Key | Type | Default | Description |
|---|---|---|---|
| `simulatorModel` | model | `null` | User-simulator (build drive + continuations). Empty = background default, then the evaluated model. |
| `simulatorThinkingLevel` | thinking-level | `null` | User-simulator thinking level. Empty = the background thinking level. |
| `simulatorMaxTokens` | number | `null` | Per-call output-token cap for simulator turns. Empty = the background max tokens. |
| `simulatorTurnTimeoutMs` | duration | `null` | Wall-clock cap per user-simulator LLM call. Empty = the background timeout. |

## Latent

| Key | Type | Default | Description |
|---|---|---|---|
| `latentModel` | model | `null` | Latent-probe authoring agent. Empty = background default, then the session model. |
| `latentThinkingLevel` | thinking-level | `null` | Latent authoring thinking level. Empty = the background thinking level. |
| `latentStageMaxTokens` | number | `null` | Per-call output-token cap for the latent-probe authoring agent. Empty = the background max tokens. |
| `latentTimeoutMs` | duration | `null` | Wall-clock cap for latent-author LLM calls. Empty = the background timeout. |

## session-owl knobs

session-owl settings run through their own panel (`/owl:settings` → `~/.pi/agent/avtc-pi-session-owl-settings.json`). Your global values reach the bench arms; the bench pins only the arm-defining keys (`enabled`, stage modes, `renderMode`) and merges your values underneath. See session-owl's [CONFIGURATION.md](https://github.com/avtc/avtc-pi-session-owl/blob/master/docs/CONFIGURATION.md) for its roster.