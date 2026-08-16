// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Registers every `/bench-compact:*` command EXCEPT `settings` (wired separately
// via registerBenchSettings). Each handler closes over `pi` (for
// sendUserMessage) and receives `(args, ctx)` from pi.
//
// prepare-scenario + results + run/run-scenario/run-session-file are all real
// handlers (not stubs). `pause`/`resume`/`abort`/
// `status` are real-minimal control commands (steer/continue/stop/report).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { validateBenchConfig } from "../config/validate.js";
import {
  abortActivePrepare,
  abortActiveRun,
  getRunState,
  isPrepareInFlight,
  setPrepareInFlight,
  statusString,
} from "../orchestrate/run-state.js";
import { hideActiveWidget } from "../widget/active-widget.js";
import { registerPrepareScenarioCommand } from "./prepare-scenario.js";
import { registerResultsCommand } from "./results.js";
import { registerRunCommand } from "./run.js";
import { makeRunScenarioHandler, registerRunScenarioCommand } from "./run-scenario.js";
import { registerRunSessionFileCommand } from "./run-session-file.js";
import { detectIncompleteRunHint, NO_HINT_IO } from "./run-shared.js";

/** Injectable inputs for {@link registerBenchCommands} (tests inject fakes). */
export interface BenchCommandsOptions {
  /** The run-scenario continuation path `/bench-compact:resume` delegates to
   *  (default = the real `makeRunScenarioHandler({})`; tests capture the invocation). */
  readonly runScenarioHandler?: (args: string, ctx: unknown) => Promise<void>;
}

/** The no-seams invocation for {@link registerBenchCommands} (production wiring:
 *  real handlers; the no-bare-literals-safe named null). */
export const NO_COMMAND_SEAMS: BenchCommandsOptions | null = null;

/** Register all bench-compact commands (except settings) on `pi`. Called from activate. */
export function registerBenchCommands(pi: ExtensionAPI, opts: BenchCommandsOptions | null): void {
  // --- real handlers -------------------------------------------------------
  registerPrepareScenarioCommand(pi);
  registerResultsCommand(pi);
  registerRunScenarioCommand(pi);
  registerRunCommand(pi);
  registerRunSessionFileCommand(pi);

  // --- real-minimal control commands ---------------------------------------
  pi.registerCommand("bench-compact:pause", {
    description: "Temporarily pause: steer the live agent to stop + abort the current op.",
    handler: async (_args, ctx) => {
      pi.sendUserMessage("wait, stop", { deliverAs: "steer" });
      ctx.abort();
      ctx.ui.notify("paused", "info");
    },
  });

  pi.registerCommand("bench-compact:continue", {
    description: "Send 'continue' to the agent after a pause or stall.",
    handler: async (_args, ctx) => {
      pi.sendUserMessage("continue");
      ctx.ui.notify("resumed", "info");
    },
  });

  // resume: continue the latest interrupted run FROM WHERE IT STOPPED. Delegates to
  // the run-scenario continuation path (--resume) — the committed phase artifacts
  // (arm bases, attempts, probes) ARE the checkpoint state, so --resume re-enters at
  // the first incomplete unit: settled work is skipped, scoring re-runs. Accepts the
  // same continuation flags (--allow-config-change, --reuse-bases) as pass-through.
  const runScenarioHandler =
    opts?.runScenarioHandler ?? (makeRunScenarioHandler({}) as (args: string, ctx: unknown) => Promise<void>);
  pi.registerCommand("bench-compact:resume", {
    description:
      "Resume the latest interrupted run from where it stopped (flags: --allow-config-change, --reuse-bases).",
    handler: async (args, ctx) => {
      const config = getBenchConfig();
      if (config.scenario === null) {
        ctx.ui.notify(
          "no scenario configured — set it in /bench-compact:settings or use /bench-compact:run-scenario <folder> --resume",
          "warning",
        );
        return;
      }
      await runScenarioHandler(`${config.scenario} --resume ${args}`.trim(), ctx);
    },
  });

  // abort: stops the run cleanly + tears down the live-progress widget. Fires the
  // active run's cooperative-abort signal (threaded into the phase loops' awaitSettled),
  // so the run stops via its existing stop-and-surface path. A LIVE prepare is
  // aborted the same way (its finally clears the guard — the concurrency window
  // stays closed until the prepare has actually exited). Only a WEDGED guard (a
  // prepare that died between set + finally, no live controller) is cleared directly.
  // `preflight` is not applicable (abort needs no args/config).
  pi.registerCommand("bench-compact:abort", {
    description: "Stop any active bench run or scenario prepare; hides the progress widget.",
    handler: async (_args, ctx) => {
      const wasRunning = abortActiveRun();
      const prepareAborted = abortActivePrepare();
      const wasPreparing = isPrepareInFlight();
      if (wasPreparing && !prepareAborted) {
        // No live prepare controller — the guard is stale (wedge recovery).
        setPrepareInFlight(false);
      }
      // Kill the in-flight agent operation too: the bench's run signal stops the
      // DRIVING (no further injects), but the agent's current turn is an unbounded
      // agentic loop that would otherwise keep working long after the run stopped.
      // ctx.abort() aborts the agent loop + any live compaction/bash/retry.
      try {
        ctx.abort();
      } catch {
        // ctx already stale (no live agent surface) — nothing to abort.
      }
      hideActiveWidget();
      const msg = wasRunning
        ? "aborted — run stopping"
        : prepareAborted
          ? "aborted — prepare stopping (wait for it to exit before starting another bench command)"
          : wasPreparing
            ? "aborted — stale prepare state cleared"
            : "aborted (no active run)";
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("bench-compact:status", {
    description: "Show current run state (arm / attempt / phase / ctx) + last config validity.",
    handler: async (_args, ctx) => {
      const config = getBenchConfig();
      const v = validateBenchConfig(config);
      const validity = v.ok ? "config OK" : `config invalid: ${v.reason}`;
      // The run-state singleton survives `/reload` (globalThis) — null when no run
      // is active or after a run completed cleanly; stop-and-surface states persist
      // (lastStopReason) so the operator can query WHY a run stopped.
      const run = getRunState() === null ? "not started" : statusString();
      ctx.ui.notify(`${validity} · ${run}`, "info");
      // Idle + a configured scenario: point the operator at an interrupted run
      // (branches without results.json) — the crash-recovery entry point.
      const hint = detectIncompleteRunHint(config, NO_HINT_IO);
      if (hint !== null) {
        ctx.ui.notify(hint, "info");
      }
    },
  });
}
