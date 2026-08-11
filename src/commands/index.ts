// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Registers every `/bench-compact:*` command (§3.13) EXCEPT `settings` (wired in
// Task 2 via registerBenchSettings). Each handler closes over `pi` (for
// sendUserMessage) and receives `(args, ctx)` from pi.
//
// Stub commands (prepare/run/run-scenario/run-session-file/results/abort) run
// `preflight` then notify "not implemented yet: <kind>" — later phase tasks replace
// the stub with the real implementation. `pause`/`resume` are real-minimal now
// (steer/continue the agent); `status` reports config validity + run state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBenchConfig } from "../config/accessor.js";
import { validateBenchConfig } from "../config/validate.js";
import { parsePositional, parsePrepareArgs, parseResultsArgs } from "./parse.js";
import { type CommandKind, preflight } from "./validate.js";

/** Register all bench-compact commands (except settings) on `pi`. Called from activate. */
export function registerBenchCommands(pi: ExtensionAPI): void {
  // --- stub commands: preflight -> "not implemented" ------------------------
  stub(
    pi,
    "bench-compact:prepare-scenario",
    "Prepare a scenario (build from <idea> or extract --from-session).",
    "prepare",
    (args) => parsePrepareArgs(args),
  );
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
  stub(pi, "bench-compact:abort", "Stop the run cleanly (tears down the progress widget).", "abort", () => ({}));

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
  kind: CommandKind | "abort",
  parse: (args: string) => { error?: string } | undefined,
): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      const parsed = parse(args) ?? {};
      if (parsed.error !== undefined) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const check = preflight(getBenchConfig(), kind as CommandKind, parsed as never);
      if (!check.ok) {
        ctx.ui.notify(check.reason, "warning");
        return;
      }
      ctx.ui.notify(`not implemented yet: ${name.replace("bench-compact:", "")}`, "info");
    },
  });
}
