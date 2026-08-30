// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-simulator driver. One cycle per coding-agent run:
//   on `agent_settled` (the agent finished responding to the simulator's last
//   message) → pace (context vs boundary) → observe the unobserved gap since the
//   (renderFullTranscript — the whole conversation from the start) → run ONE
//   `runBenchStage` (maxTurns:1, no tools) with the system prompt → read the
//   assistant reply → inject it via `pi.sendUserMessage({deliverAs:"followUp"})`.
//
// **Trigger = agent_settled, not turn_end.** The design cites `turn_end` as the
// observation-mechanism heritage (session-owl observes every turn_end); but the
// simulator must produce exactly ONE user message per agent RUN (injecting on every
// turn_end would queue multiple followUps mid-run). The control flow is
// authoritative: "agent works → agent_end → harness measures context." So the
// driver's cycle fires on agent_settled; the harness wires pi events
// to `onAgentSettled` / `trackContext` / `setAgentQuestion`.
//
// **The harness owns pacing + stop.** The driver signals stop (boundary / error);
// it never captures the backup or compacts (the harness does).

import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_STAGE_END_HOOK,
  NO_STREAM_FN,
  runBenchStage,
  type StageRunInput,
  type StageRunResult,
  toStageReasoning,
} from "../runtime/agent-loop.js";
import { type ResolvedBenchModel, resolveBenchModel } from "../runtime/model.js";
import { CONDITION_TOPICS } from "./condition-topics.js";
import { buildSimulatorInput } from "./messages.js";
import { type ChunkOptions, renderFullTranscript } from "./observe.js";
import { buildSimulatorSystemPrompt } from "./prompt.js";

// --- pure helpers (tested directly) ----------------------------------------

export type PacingDecision = "continue" | "stop";

/** `continue` while under the boundary; `stop` at/over it. The harness owns the stop. */
export function pacingDecision(contextTokens: number, targetContext: number): PacingDecision {
  return contextTokens >= targetContext ? "stop" : "continue";
}

export interface NextInstructionInput {
  /** Zero-based step counter (0 = the opening message). */
  readonly step: number;
  /** Present when the agent asked a question mid-run (aUQ) — answer it as the user. */
  readonly agentQuestion?: string;
}

/**
 * The harness's per-step instruction (the "ask" the simulator answers with its next
 * user message). Generic pacing — the conditionTopics are voiced via the system
 * prompt (the simulator's creative responsibility), not steered per-step here.
 * Step 0 is the opening (the first `agent_settled`, before the simulator has spoken). */
export function nextInstruction(input: NextInstructionInput): string {
  if (input.agentQuestion !== undefined) {
    return `The agent asked a question: "${input.agentQuestion}". Answer it as yourself (the user / project designer), then continue with the next step.`;
  }
  if (input.step === 0) {
    return "Start building. Request your first system and make your opening design decisions.";
  }
  return "Review what the agent did since you last spoke, then request the next system, refinement, or feature. Keep building.";
}

/**
 * Read the text of the LAST assistant message in a stage result (the simulator's
 * reply). Concatenates multiple text parts; returns "" when there is no assistant
 * message (the stage produced no usable reply).
 */
export function extractAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((p: { type?: string }) => p?.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
  }
  return "";
}

// --- SimulatorDriver --------------------------------------------------------

type StopReason = "boundary" | "error";

export interface SimulatorHooks {
  /** Fired after a successful inject (the simulator voiced + the harness forwarded it). */
  onStep?: (info: { step: number; contextTokens: number; injectedText: string }) => void;
  /** Fired when the driver signals stop — boundary reached OR an error. The harness
   *  captures the backup (boundary) or stop-and-surfaces (error). */
  onStop?: (info: { contextTokens: number; reason: StopReason; error?: string }) => void;
}

/** Injectable seams over the session/model/inject dependencies (faked in tests). */
export interface SimulatorSeams {
  /** The current session branch (`ctx.sessionManager.getBranch(leafId)`). */
  getBranch(): SessionEntry[];
  /** Resolve the simulator's local model (`resolveBenchModel`). */
  resolveModel(): Promise<ResolvedBenchModel>;
  /** Run one bench stage (`runBenchStage`). Fake returns a canned result in tests. */
  runStage(input: StageRunInput): Promise<StageRunResult>;
  /** Inject the simulator's reply as a follow-up user message (`pi.sendUserMessage`). */
  inject(text: string): void;
}

export interface SimulatorDriverDeps {
  readonly seams: SimulatorSeams;
  /** The system prompt (from `buildSimulatorSystemPrompt`). */
  readonly systemPrompt: string;
  /** The Phase-0 compaction target (tokens) — the pacing boundary. */
  readonly targetContext: number;
  /** Per-call output cap for the simulator's `runBenchStage`. */
  readonly maxTokens: number;
  /** The simulator's thinking level (null = omit the reasoning field). */
  readonly thinking: ThinkingLevel | null;
  /** Per-turn wall-clock cap for the simulator's stage call (null = no cap). */
  readonly timeoutMs: number | null;
  /** Cooperative-abort signal (the run/compaction signal). */
  readonly signal: AbortSignal;
  readonly hooks?: SimulatorHooks;
  /** Plant-and-continue recovery: overrides the harness instruction for the driver's
   *  FIRST cycle only (the resumed drive's plant step), then falls back to the normal
   * per-step pacing instructions. */
  readonly firstInstruction?: string;
  /** Optional sink for the simulator's agentLoop events (forwarded to runStage's
   *  onEvent). The live-progress widget subscribes here for ctx/tok during resume. */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Optional hook fired after a successful model resolution (the widget sets its
   *  context window from the resolved model). */
  readonly onModelResolved?: (model: Model<Api>) => void;
}

/** Chunk options for the simulator's render: one chunk (the whole gap), no entry
 *  ids (the simulator doesn't cite), no thinking (the user doesn't see private
 *  reasoning), tool results capped to keep the simulator's context bounded. */
const SIM_CHUNK_OPTS: ChunkOptions = {
  tokenThreshold: Number.POSITIVE_INFINITY,
  toolBlockCapTokens: 200,
  includeThinking: false,
  includeEntryId: false,
};

/**
 * The user-simulator driver. Call `trackContext` on each `message_end`, then
 * `onAgentSettled` on each `agent_settled`. `setAgentQuestion` when the agent asked
 * a question mid-run (aUQ). The driver paces (stop at boundary), observes the gap,
 * runs one `runBenchStage` (maxTurns:1), and injects the reply via `followUp`.
 */
export class SimulatorDriver {
  private _step = 0;
  private _contextTokens = 0;
  private _agentQuestion: string | undefined;
  private readonly deps: SimulatorDriverDeps;

  constructor(deps: SimulatorDriverDeps) {
    this.deps = deps;
  }

  /** Completed simulator cycles (injects). */
  get step(): number {
    return this._step;
  }

  /** Update the tracked context size (from `message_end.message.usage.totalTokens`). */
  trackContext(totalTokens: number): void {
    this._contextTokens = totalTokens;
  }

  /** Set the agent's pending question (aUQ) — answered on the next cycle, then cleared. */
  setAgentQuestion(question: string): void {
    this._agentQuestion = question;
  }

  /** Run one simulator cycle. Paces → observes → resolves → runs stage → injects. */
  async onAgentSettled(): Promise<void> {
    // 1. pacing — the harness owns the stop; the driver just signals it
    if (pacingDecision(this._contextTokens, this.deps.targetContext) === "stop") {
      log.debug(`simulator: stop at boundary (ctx=${this._contextTokens} >= ${this.deps.targetContext})`);
      this.deps.hooks?.onStop?.({ contextTokens: this._contextTokens, reason: "boundary" });
      return;
    }

    // 2-8. observe → resolve → run stage → inject. Wrapped so ANY throw (runStage
    //    StageRunError on LLM/network/rate-limit failure, a throwing seam) is funneled
    //    into onStop({reason:"error"}) — never an unhandled rejection that stalls a
    //    harness wired only to onStop. The pacing check (step 1) stays outside.
    try {
      // 2. render the FULL session transcript — the simulator is a real session
      //    participant: it sees the whole conversation from the start (its own
      //    beats + all agent work) every call, not just the gap since its last
      //    injection. Append-only growth keeps the request prefix byte-stable
      //    (prefix-cache friendly). Continuation session files carry the
      //    pre-compaction history too — the user's memory is never compacted
      //    (the asymmetry the bench measures).
      const branch = this.deps.seams.getBranch();
      const renderedChunk = renderFullTranscript(branch, SIM_CHUNK_OPTS);

      // 3. resolve the simulator's local model
      const resolved = await this.deps.seams.resolveModel();
      if (!resolved.ok) {
        log.warn(`simulator: model resolution failed — ${resolved.error}`);
        this.deps.hooks?.onStop?.({ contextTokens: this._contextTokens, reason: "error", error: resolved.error });
        return;
      }
      this.deps.onModelResolved?.(resolved.model);

      // 4. build the simulator input (rendered context + the harness's step instruction).
      //    A plant-resume's first cycle uses the plant instruction; every other cycle
      //    uses the normal per-step pacing text.
      const harnessInstruction =
        this._step === 0 && this.deps.firstInstruction !== undefined
          ? this.deps.firstInstruction
          : nextInstruction({ step: this._step, agentQuestion: this._agentQuestion });
      log.info(
        `simulator cycle ${this._step}: full transcript ${branch.length} entries, ` +
          `${renderedChunk.length} chars rendered, instruction ${harnessInstruction.length} chars`,
      );
      const messages = buildSimulatorInput({ transcript: renderedChunk, harnessInstruction });

      // 5. run ONE stage (maxTurns:1, no tools) → the simulator's next user voice
      const result = await this.deps.seams.runStage({
        systemPrompt: this.deps.systemPrompt,
        messages,
        tools: [],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: this.deps.signal,
        reasoning: toStageReasoning(this.deps.thinking),
        maxTurns: 1,
        maxTokens: this.deps.maxTokens,
        timeoutMs: this.deps.timeoutMs,
        onEvent: this.deps.onEvent ?? NO_EVENT_SINK,
        onStageEnd: NO_STAGE_END_HOOK,
        loopFn: NO_LOOP_OVERRIDE,
        streamFn: NO_STREAM_FN,
      });

      // 6. aborted (run/compaction signal OR per-turn timeout) → stop+surface
      if (result.aborted) {
        log.warn(`simulator: stage aborted (timedOut=${result.timedOut})`);
        this.deps.hooks?.onStop?.({
          contextTokens: this._contextTokens,
          reason: "error",
          error: result.timedOut ? "simulator stage timed out" : "simulator stage aborted",
        });
        return;
      }

      // 7. extract the reply + inject it as the next follow-up user message
      const text = extractAssistantText(result.messages);
      if (text.trim().length === 0) {
        // no usable reply (no assistant msg / text-less response) — stop+surface,
        // consistent with the abort/model-failure paths (don't inject an empty msg)
        log.warn("simulator: stage produced no reply text");
        this.deps.hooks?.onStop?.({
          contextTokens: this._contextTokens,
          reason: "error",
          error: "simulator produced no reply text",
        });
        return;
      }
      this.deps.seams.inject(text);

      // 8. advance the step; clear the question. (frontier is derived — no stored state.)
      this._step += 1;
      this._agentQuestion = undefined;
      this.deps.hooks?.onStep?.({ step: this._step, contextTokens: this._contextTokens, injectedText: text });
    } catch (cause) {
      // any thrown error (runStage StageRunError, a throwing seam) → stop+surface,
      // never an unhandled rejection that stalls a harness wired only to onStop
      const msg = cause instanceof Error ? cause.message : String(cause);
      log.warn(`simulator: stage threw — ${msg}`);
      this.deps.hooks?.onStop?.({ contextTokens: this._contextTokens, reason: "error", error: msg });
    }
  }
}

// --- shared drive helpers (build Phase 0 + continuation Phase 2) -----------

/** Per-call output cap for the user-simulator's stage calls (build Phase 0 + continuation Phase 2). */

/** Mutable drive-stop state shared between the driver's onStop hook + the drive loop. */
export interface DriveStop {
  stopped: boolean;
  reason: StopReason | null;
  error: string | null;
}

/** Args to {@link buildSimulatorDriver} — the common inputs both the build (Phase 0)
 *  + continuation (Phase 2) simulator drivers share. */
export interface BuildSimulatorDriverArgs {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  /** The task brief (manifest description / scenario idea) seeding the system prompt. */
  readonly task: string;
  /** The simulator's model (`provider/id`, or null = session default). */
  readonly model: string | null;
  /** The simulator's thinking level (null = omit the reasoning field). */
  readonly thinking: ThinkingLevel | null;
  readonly targetContext: number;
  readonly maxTokens: number;
  /** Per-turn wall-clock cap (null = no cap). */
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal;
  readonly inject: (text: string) => void;
  readonly onStop: NonNullable<SimulatorHooks["onStop"]>;
  /** Plant-and-continue recovery: the first cycle's harness instruction override. */
  readonly firstInstruction?: string;
  /** Optional event sink forwarded to the simulator's runStage (the widget subscribes for ctx/tok). */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Optional hook fired after a successful model resolution (the widget sets its ctx window). */
  readonly onModelResolved?: (model: Model<Api>) => void;
}

/** Construct a real {@link SimulatorDriver} wired to the fresh session ctx (branch +
 *  model resolution) + the bench agent-loop runner. Shared by the build + continuation
 *  simulator factories so the seams/systemPrompt/driver-construction lives in one place. */
export function buildSimulatorDriver(args: BuildSimulatorDriverArgs): SimulatorDriver {
  const systemPrompt = buildSimulatorSystemPrompt({
    task: args.task,
    conditionTopics: CONDITION_TOPICS,
    targetContext: args.targetContext,
  });
  const seams: SimulatorSeams = {
    getBranch: () => args.ctx.sessionManager.getBranch(),
    resolveModel: (): Promise<ResolvedBenchModel> => resolveBenchModel(args.ctx, args.model),
    runStage: runBenchStage,
    inject: args.inject,
  };
  return new SimulatorDriver({
    seams,
    systemPrompt,
    targetContext: args.targetContext,
    maxTokens: args.maxTokens,
    thinking: args.thinking,
    timeoutMs: args.timeoutMs,
    signal: args.signal,
    hooks: { onStop: args.onStop },
    firstInstruction: args.firstInstruction,
    onEvent: args.onEvent,
    onModelResolved: args.onModelResolved,
  });
}

/** Args to {@link driveUntilStop} — the common drive-loop inputs. */
export interface DriveUntilStopArgs {
  /** The driver (runs one simulator cycle per call). */
  readonly driver: { onAgentSettled(): Promise<void> };
  /** The shared stop state (mutated by the driver's onStop hook). */
  readonly stop: DriveStop;
  /** Await the agent settling (already wrapped to throw the caller's stop-error on abort/stall). */
  readonly awaitSettled: () => Promise<void>;
  /** Return true to break the loop (e.g. stop.stopped OR a budget reached). */
  readonly shouldBreak: () => boolean;
  /** Build the error thrown when a cycle signals an error-stop (caller picks the typed error). */
  readonly makeCycleError: (error: string | null) => Error;
  /** Optional hook fired when the drive finishes — ANY exit (boundary/budget break,
   *  thrown cycle error). The widget retires the simulator's ctx/tok segments here. */
  readonly onDone?: () => void;
}

/** The shared drive loop: kick-off cycle → { check stop → await-settle → check break → cycle }
 *  until the driver signals stop or the caller's break condition holds. A cycle that signals
 *  an error-stop throws `makeCycleError(stop.error)`. Shared by build (Phase 0) +
 *  continuation (Phase 2).
 *
 *  Two stop checks, not one: a boundary-stop cycle injects NOTHING (the pacing check in
 *  onAgentSettled returns before the inject), so awaiting the agent's settle afterwards
 *  would block forever — `awaitAgentSettled` is an `awaitOnce` one-shot that resolves only
 *  on the NEXT `agent_settled` event, never on idle state. So `stop.stopped` (set by the
 *  boundary-stop) is checked BEFORE the await, letting a no-inject cycle exit cleanly. The
 *  full `shouldBreak` (which also covers the budget monitor) is checked AFTER the await,
 *  because the budget is reached DURING the agent's run (the monitor fires at 90% of the
 *  window, while pacing-stop fires at the window) — moving it before the await would let a
 *  budget-reached run inject one more cycle past the budget before breaking. */
export async function driveUntilStop(args: DriveUntilStopArgs): Promise<void> {
  const cycle = async (): Promise<void> => {
    await args.driver.onAgentSettled();
    if (args.stop.reason === "error") {
      throw args.makeCycleError(args.stop.error);
    }
  };
  try {
    await cycle();
    while (true) {
      if (args.stop.stopped) break; // a boundary-stop cycle injected nothing — exit, don't await
      await args.awaitSettled();
      if (args.shouldBreak()) break; // budget reached DURING the just-awaited run
      await cycle();
    }
  } finally {
    args.onDone?.();
  }
}

/** Create the shared mutable drive-stop state + the `onStop` hook that populates it.
 *  Both the build (Phase 0) + continuation (Phase 2) drivers wire this identical pair. */
export function makeDriveStop(): {
  stop: DriveStop;
  onStop: NonNullable<SimulatorHooks["onStop"]>;
} {
  const stop: DriveStop = { stopped: false, reason: null, error: null };
  return {
    stop,
    onStop: (info) => {
      stop.stopped = true;
      stop.reason = info.reason;
      stop.error = info.error ?? null;
    },
  };
}
