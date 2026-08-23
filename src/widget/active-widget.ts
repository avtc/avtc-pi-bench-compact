// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Module-level active-widget ref — the one widget currently shown for the
// active bench run. The orchestrator sets it on run start (so `/bench-compact:abort`
// can reach it without a ctx/handle threaded through the command); abort hides it.
// Mirrors run-state's globalThis singleton pattern (one active widget per process).

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { JudgeUsage, WidgetPhase, WidgetStatus } from "./render.js";

/** The narrow widget surface the orchestrator + abort use. {@link WidgetController}
 *  satisfies this structurally; tests inject capturing implementations. */
export interface WidgetPort {
  show(): void;
  startPhase(phase: WidgetPhase, detail: string | null): void;
  setStatus(status: WidgetStatus, hint: string | null): void;
  /** Arm counter (`<armN>/<total> <tool>`); the harness calls this per arm/attempt. */
  setArm(index: number, total: number, tool: string): void;
  /** Clear the arm counter (cross-arm stages — comparative scoring). */
  clearArm(): void;
  /** Trailing detail on the phase label (e.g. `<attempt>/<N>`). */
  setDetail(detail: string | null): void;
  /** Set the background agent's context window when it starts (the <w> in `ctx <u>/<w>`). */
  setCtxWindow(ctxWindow: number | null): void;
  /** Retire the background agent's ctx/tok segments when it finishes (any exit). */
  clearAgent(): void;
  /** Set the per-judge usage list (score phase — K parallel judges). */
  setJudgeUsages(list: readonly JudgeUsage[] | null): void;
  /** Forward a background-agent event (user-simulator / judge) → two-tier token accumulator. */
  onEvent(event: AgentEvent): void;
  /** Forward a probe-validator agent event → the SECOND slot's accumulator. */
  onValidatorEvent(event: AgentEvent): void;
  /** Set the probe-validator's context window when its model resolves. */
  setValidatorCtxWindow(ctxWindow: number | null): void;
  /** Retire the probe-validator segment (per validation, incl. failures). */
  clearValidator(): void;
  hide(): void;
}

const GLOBAL_KEY = "__benchCompactActiveWidget";

function read(): WidgetPort | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as WidgetPort | null) ?? null;
}

function write(w: WidgetPort | null): void {
  if (w === null) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = null;
  } else {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = w;
  }
}

/** Set the active widget (the run-start widget), or null to clear. */
export function setActiveWidget(widget: WidgetPort | null): void {
  write(widget);
}

/** The active widget, or null when no run is active. */
export function getActiveWidget(): WidgetPort | null {
  return read();
}

/** Hide the active widget (tear down its TUI line). No-op when none is active. */
export function hideActiveWidget(): void {
  read()?.hide();
}
