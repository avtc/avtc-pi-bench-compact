// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Registers every `/bench-compact:*` command EXCEPT `settings` (wired in
// Task 2 via registerBenchSettings). Each handler closes over `pi` (for
// sendUserMessage) and receives `(args, ctx)` from pi.
//
// prepare-scenario + results + run/run-scenario/run-session-file are all real
// handlers (Task 23 replaced the run-command stubs). `pause`/`resume`/`abort`/
// `status` are real-minimal control commands (steer/continue/stop/report).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { validateBenchConfig } from "../config/validate.js";
import { abortActiveRun } from "../orchestrate/run-state.js";
import { hideActiveWidget } from "../widget/active-widget.js";
import { registerPrepareScenarioCommand } from "./prepare-scenario.js";
import { registerResultsCommand } from "./results.js";
import { registerRunCommand } from "./run.js";
import { registerRunScenarioCommand } from "./run-scenario.js";
import { registerRunSessionFileCommand } from "./run-session-file.js";

/** Register all bench-compact commands (except settings) on `pi`. Called from activate. */
export function registerBenchCommands(pi: ExtensionAPI): void {
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

  pi.registerCommand("bench-compact:resume", {
    description: "Continue the agent after a pause, interrupt, or mid-turn error.",
    handler: async (_args, ctx) => {
      pi.sendUserMessage("continue");
      ctx.ui.notify("resumed", "info");
    },
  });

  // abort: stops the run cleanly + tears down the live-progress widget. Fires the
  // active run's cooperative-abort signal (threaded into the phase loops' awaitSettled),
  // so the run stops via its existing stop-and-surface path.
  // `preflight` is not applicable (abort needs no args/config).
  pi.registerCommand("bench-compact:abort", {
    description: "Stop the run cleanly (fires the run's abort signal + tears down the progress widget).",
    handler: async (_args, ctx) => {
      const wasRunning = abortActiveRun();
      hideActiveWidget();
      ctx.ui.notify(wasRunning ? "aborted — run stopping" : "aborted (no active run)", "info");
    },
  });

  pi.registerCommand("bench-compact:status", {
    description: "Show current run state (arm / attempt / phase / ctx) + last config validity.",
    handler: async (_args, ctx) => {
      const v = validateBenchConfig(getBenchConfig());
      const validity = v.ok ? "config OK" : `config invalid: ${v.reason}`;
      ctx.ui.notify(`${validity} · not started`, "info");
    },
  });
}
