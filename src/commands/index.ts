// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Registers every `/bench-compact:*` command EXCEPT `settings` (wired in
// Task 2 via registerBenchSettings). Each handler closes over `pi` (for
// sendUserMessage) and receives `(args, ctx)` from pi.
//
// Stub commands (prepare/run/run-scenario/run-session-file/results) run `preflight`
// then notify "not implemented yet: <kind>" — later phase tasks replace the stub with
// the real implementation. `pause`/`resume`/`abort`/`status` are real-minimal now
// (steer/continue/stop/report); Task 18 wires the widget teardown for `abort`, Task 19
// refines run-stop semantics.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { validateBenchConfig } from "../config/validate.js";
import { parsePositional, parsePrepareArgs, parseResultsArgs } from "./parse.js";
import { registerPrepareScenarioCommand } from "./prepare-scenario.js";
import { type CommandArgs, type CommandKind, preflight } from "./validate.js";

/** Register all bench-compact commands (except settings) on `pi`. Called from activate. */
export function registerBenchCommands(pi: ExtensionAPI): void {
  // --- real: prepare-scenario (Task 10) -------------------------------------
  registerPrepareScenarioCommand(pi);

  // --- stub commands: preflight -> "not implemented" ------------------------
  stub(pi, "bench-compact:run", "Prepare + run a scenario from <idea>.", "run", (args) => parsePrepareArgs(args));
  stub(
    pi,
    "bench-compact:run-scenario",
    "Run every enabled arm from a prepared scenario folder.",
    "run-scenario",
    (args) => parsePositional(args),
  );
  stub(pi, "bench-compact:run-session-file", "Extract a real session file + run.", "run-session-file", (args) =>
    parsePositional(args),
  );
  stub(
    pi,
    "bench-compact:results",
    "Render the headline report for <runId>[:arms] (compare multiple).",
    "results",
    (args) => parseResultsArgs(args),
  );

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

  // abort: real-minimal now (not a stub — it is a real handler). No
  // run-state or widget exists yet (Tasks 18/19), so this just signals abort intent
  // without crashing. `preflight` is not applicable (abort needs no args/config).
  pi.registerCommand("bench-compact:abort", {
    description: "Stop the run cleanly (tears down the progress widget).",
    handler: async (_args, ctx) => {
      ctx.ui.notify("aborted (no run in progress)", "info");
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

/** Build a stub command: parse args, preflight, then notify "not implemented" (or
 *  the preflight/parsing failure as a warning). The kind maps to a preflight branch. */
function stub(
  pi: ExtensionAPI,
  name: string,
  description: string,
  kind: CommandKind,
  parse: (args: string) => CommandArgs & { error?: string },
): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      const parsed = parse(args);
      if (parsed.error !== undefined) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const check = preflight(getBenchConfig(), kind, parsed, existsSync);
      if (!check.ok) {
        ctx.ui.notify(check.reason, "warning");
        return;
      }
      ctx.ui.notify(`not implemented yet: ${name.replace("bench-compact:", "")}`, "info");
    },
  });
}
