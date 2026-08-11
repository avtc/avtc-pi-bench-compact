// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Build the user-simulator's conversation input (`AgentMessage[]`) for one
// `runBenchStage` call. The system prompt is passed SEPARATELY to `runBenchStage`
// (its `StageRunInput.systemPrompt`), so it is NOT threaded through here — this
// function builds only the conversational messages. `maxTurns:1` → the model
// emits ONE assistant reply (the next user voice to inject via `pi.sendUserMessage`).
//
// Input shape: the rendered agent output since the simulator last spoke (context)
// + the harness's per-step instruction (the ask). On the first turn there is no
// agent output yet, so the message is just the instruction.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Input to {@link buildSimulatorInput}. */
export interface SimulatorMessageInput {
  /** The rendered agent output since the simulator last spoke (one or more joined
   *  `RenderedChunk.text`). Empty on the first turn (nothing happened yet). */
  readonly renderedChunk: string;
  /** The harness's per-step instruction — the "ask" the simulator answers with its
   *  next user message (e.g. "Build your next system." / "Review what it did." /
   *  "Decide X." / "The agent asked: '…'. Answer as yourself."). */
  readonly harnessInstruction: string;
}

/** Preamble introducing the rendered context (omitted when there is none). */
const CONTEXT_PREAMBLE = "Here's what the agent did since you last spoke:";

/**
 * Build the simulator's `AgentMessage[]`: a single user message combining the
 * rendered agent output (context) + the harness instruction (the ask). Empty
 * `renderedChunk` → the message is just the instruction (first turn).
 */
export function buildSimulatorInput(input: SimulatorMessageInput): AgentMessage[] {
  const body =
    input.renderedChunk.length === 0
      ? input.harnessInstruction
      : `${CONTEXT_PREAMBLE}\n${input.renderedChunk}\n\n${input.harnessInstruction}`;
  return [{ role: "user", content: body, timestamp: Date.now() }];
}
