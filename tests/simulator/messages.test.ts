// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildSimulatorInput } from "../../src/simulator/messages.js";

/** The simulator builds user messages; read their (string) body. */
function bodyOf(msg: AgentMessage): string {
  const content = (msg as UserMessage).content;
  return typeof content === "string" ? content : "";
}

describe("buildSimulatorInput", () => {
  it("returns exactly ONE user message (maxTurns:1 → one assistant reply = the next user voice)", () => {
    const msgs = buildSimulatorInput({
      transcript: "<ASSISTANT>did a thing</ASSISTANT>",
      harnessInstruction: "Review what it did.",
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("embeds the rendered agent output + the harness instruction (instruction is the ask)", () => {
    const chunk = "<USER>build x</USER>\n<ASSISTANT>ok done</ASSISTANT>";
    const instr = "Decide how to model the next system.";
    const [msg] = buildSimulatorInput({ transcript: chunk, harnessInstruction: instr });
    const body = bodyOf(msg);
    expect(body).toContain(chunk);
    expect(body).toContain(instr);
    // instruction comes AFTER the rendered context (it's the ask, not the preamble)
    expect(body.indexOf(chunk)).toBeLessThan(body.indexOf(instr));
  });

  it("empty transcript (first turn — no session content yet) → just the instruction", () => {
    const [msg] = buildSimulatorInput({
      transcript: "",
      harnessInstruction: "Start building: request your first system.",
    });
    const body = bodyOf(msg);
    expect(body).toBe("Start building: request your first system.");
    expect(body).not.toContain("what the agent did"); // no preamble when nothing happened yet
  });

  it("returns AgentMessage[] (the shape runBenchStage.messages expects)", () => {
    const msgs: AgentMessage[] = buildSimulatorInput({ transcript: "x", harnessInstruction: "y" });
    expect(Array.isArray(msgs)).toBe(true);
  });
});
