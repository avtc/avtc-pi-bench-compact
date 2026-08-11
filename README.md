# avtc-pi-bench-compact

A pi extension that benchmarks compaction/memory approaches (arms) on an identical authored workload: it samples post-compaction agent behavior over N runs and scores effectiveness + cost via a calibrated LLM judge and exact trace signals.

The full specification (design + task plan) lives in the project's `.featyard/` storage (managed, not committed). Run `/bench-compact:status` to check the current run state.
