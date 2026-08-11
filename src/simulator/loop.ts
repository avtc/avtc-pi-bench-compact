// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-simulator driver (§4.17). One cycle per coding-agent run:
//   on `agent_settled` (the agent finished responding to the simulator's last
//   message) → pace (context vs boundary) → observe the unobserved gap since the
//   last injection (reusing memkeeper's computeUnobserved + buildChunks) → run ONE
//   `runBenchStage` (maxTurns:1, no tools) with the §4.17 system prompt → read the
//   assistant reply → inject it via `pi.sendUserMessage({deliverAs:"followUp"})`.
//
// **Trigger = agent_settled, not turn_end.** §4.15 cites `turn_end` as the
// observation-mechanism heritage (memkeeper observes every turn_end); but the
// simulator must produce exactly ONE user message per agent RUN (injecting on every
// turn_end would queue multiple followUps mid-run). §4.17 control flow is
// authoritative: "agent works → agent_end → harness measures context." So the
// driver's cycle fires on agent_settled; the harness (Task 10/12) wires pi events
// to `onAgentSettled` / `trackContext` / `setAgentQuestion`.
//
// **The harness owns pacing + stop.** The driver signals stop (boundary / error);
// it never captures the backup or compacts (Task 10/12 does).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { log } from "../log.js";
import {
  NO_EVENT_SINK,
  NO_LOOP_OVERRIDE,
  NO_REASONING,
  NO_STAGE_END_HOOK,
  type StageRunInput,
  type StageRunResult,
} from "../runtime/agent-loop.js";
import type { ResolvedBenchModel } from "../runtime/model.js";
import { buildSimulatorInput } from "./messages.js";
import { buildChunks, type ChunkOptions, computeUnobserved, lastUserMessageId, type RenderedChunk } from "./observe.js";

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

export type StopReason = "boundary" | "error";

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
  /** The §4.17 system prompt (from `buildSimulatorSystemPrompt`). */
  readonly systemPrompt: string;
  /** The Phase-0 compaction target (tokens) — the pacing boundary. */
  readonly targetContext: number;
  /** Per-call output cap for the simulator's `runBenchStage`. */
  readonly maxTokens: number;
  /** Cooperative-abort signal (the run/compaction signal). */
  readonly signal: AbortSignal;
  readonly hooks?: SimulatorHooks;
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
    //    harness wired only to onStop (R2.1). The pacing check (step 1) stays outside.
    try {
      // 2. observe the agent's response since the simulator's last injection.
      //    The frontier is DERIVED (lastUserMessageId = the simulator's last injection;
      //    the coding agent never produces user messages), so the gap is exactly the
      //    agent's response — never re-rendering the simulator's own previous message.
      const branch = this.deps.seams.getBranch();
      const frontier = lastUserMessageId(branch);
      const unobserved = computeUnobserved(branch, frontier);
      const chunks = buildChunks(unobserved, SIM_CHUNK_OPTS);
      const renderedChunk = chunks.map((c: RenderedChunk) => c.text).join("\n");

      // 3. resolve the simulator's local model
      const resolved = await this.deps.seams.resolveModel();
      if (!resolved.ok) {
        log.warn(`simulator: model resolution failed — ${resolved.error}`);
        this.deps.hooks?.onStop?.({ contextTokens: this._contextTokens, reason: "error", error: resolved.error });
        return;
      }

      // 4. build the simulator input (rendered context + the harness's step instruction)
      const harnessInstruction = nextInstruction({ step: this._step, agentQuestion: this._agentQuestion });
      const messages = buildSimulatorInput({ renderedChunk, harnessInstruction });

      // 5. run ONE stage (maxTurns:1, no tools) → the simulator's next user voice
      const result = await this.deps.seams.runStage({
        systemPrompt: this.deps.systemPrompt,
        messages,
        tools: [],
        model: resolved.model,
        apiKey: resolved.apiKey,
        signal: this.deps.signal,
        reasoning: NO_REASONING,
        maxTurns: 1,
        maxTokens: this.deps.maxTokens,
        timeoutMs: null,
        onEvent: NO_EVENT_SINK,
        onStageEnd: NO_STAGE_END_HOOK,
        loopFn: NO_LOOP_OVERRIDE,
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
      // never an unhandled rejection that stalls a harness wired only to onStop (R2.1)
      const msg = cause instanceof Error ? cause.message : String(cause);
      log.warn(`simulator: stage threw — ${msg}`);
      this.deps.hooks?.onStop?.({ contextTokens: this._contextTokens, reason: "error", error: msg });
    }
  }
}
