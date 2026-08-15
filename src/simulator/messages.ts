// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Build the user-simulator's conversation input (`AgentMessage[]`) for one
// `runBenchStage` call. The system prompt is passed SEPARATELY to `runBenchStage`
// (its `StageRunInput.systemPrompt`), so it is NOT threaded through here — this
// function builds only the conversational messages. `maxTurns:1` → the model
// emits ONE assistant reply (the next user voice to inject via `pi.sendUserMessage`).
//
// Input shape: the FULL rendered session transcript (context) + the harness instruction
// + the harness's per-step instruction (the ask). On the first turn there is no
// agent output yet, so the message is just the instruction.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Input to {@link buildSimulatorInput}. */
export interface SimulatorMessageInput {
  /** The FULL rendered session transcript so far (all entries from the start —
   *  the simulator's own messages + all agent work; append-only across cycles).
   *  Empty on the first turn of a brand-new session (nothing happened yet). */
  readonly transcript: string;
  /** The harness's per-step instruction — the "ask" the simulator answers with its
   *  next user message (e.g. "Build your next system." / "Review what it did." /
   *  "Decide X." / "The agent asked: '…'. Answer as yourself."). */
  readonly harnessInstruction: string;
}

/** Preamble introducing the rendered context (omitted when there is none). */
const CONTEXT_PREAMBLE =
  "The session so far, in full (you are the user in this conversation — your messages and the agent's work):";

/**
 * Build the simulator's `AgentMessage[]`: a single user message combining the
 * rendered agent output (context) + the harness instruction (the ask). Empty
 * `renderedChunk` → the message is just the instruction (first turn).
 */
export function buildSimulatorInput(input: SimulatorMessageInput): AgentMessage[] {
  const body =
    input.transcript.length === 0
      ? input.harnessInstruction
      : `${CONTEXT_PREAMBLE}\n${input.transcript}\n\n${input.harnessInstruction}`;
  return [{ role: "user", content: body, timestamp: Date.now() }];
}
