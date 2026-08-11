# avtc-pi-bench-compact

A pi extension that benchmarks compaction/memory approaches (arms) on an identical authored workload: it samples post-compaction agent behavior over N runs and scores effectiveness + cost via a calibrated LLM judge and exact trace signals.

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

### Dependencies

- **The OM-default and OM-full arms require the FORKED `pi-observational-memory`.** Upstream OM has a bug where `passive` mode (`PI_OBSERVATIONAL_MEMORY_PASSIVE=1`) does **not** catch up observations at compaction — the fork fixes this so both arms catch up identically to non-passive. Without the fork, both arms are invalid (no observations produced). The harness sets `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` itself at run start (env-only; no operator action needed).
- **The memkeeper-builder and memkeeper-selector arms require `avtc-pi-memkeeper`** (on-compaction mode; `renderMode` switched per arm).
- **The compaction-cost metric requires patching** the memory arms' `session_before_compact` hooks to emit per-stage LLM usage — see the design doc + Task 11.

Arm isolation writes project `.pi/settings.json` `packages` (suite + harness + the arm's memory ext) then `ctx.reload()` — verified that `ctx.reload()` re-reads project settings + re-discovers extensions (`agent-session.js`). The harness package is always included (pi's settings deep-merge treats `packages` arrays as replace-not-concat).

