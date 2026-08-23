// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { resolveBackgroundAgents } from "../../src/config/background-agents.js";
import type { BenchConfig } from "../../src/config/types.js";

/** A minimal config with every background-agent setting at its default
 *  (per-agent null; background xhigh/64K/20m). Each test overrides what it exercises. */
function cfg(overrides: Partial<BenchConfig>): BenchConfig {
  return {
    evaluatedModel: "eval/model",
    judgeModel: null,
    judgeThinkingLevel: null,
    judgesNumber: 1,
    judge2Model: null,
    judge2ThinkingLevel: null,
    judge3Model: null,
    judge3ThinkingLevel: null,
    judgeMaxTokens: null,
    judgeTurnTimeoutMs: null,
    backgroundModel: null,
    backgroundThinkingLevel: "xhigh",
    backgroundMaxTokens: 65536,
    backgroundTimeoutMs: 1200000,
    authorModel: null,
    authorThinkingLevel: null,
    authorMaxTokens: null,
    authorTimeoutMs: null,
    probeValidateModel: null,
    probeValidateThinkingLevel: null,
    probeValidateMaxTokens: null,
    probeValidateTimeoutMs: null,
    simulatorModel: null,
    simulatorThinkingLevel: null,
    simulatorMaxTokens: null,
    simulatorTurnTimeoutMs: null,
    latentModel: null,
    latentThinkingLevel: null,
    latentStageMaxTokens: null,
    latentTimeoutMs: null,
    ...overrides,
  } as BenchConfig;
}

describe("resolveBackgroundAgents", () => {
  it("resolves all defaults: per-agent nulls fall back to the background settings; model bases differ", () => {
    const agents = resolveBackgroundAgents(cfg({}));
    expect(agents.author).toEqual({
      model: "eval/model",
      thinking: "xhigh",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    expect(agents.probeValidate).toEqual({
      model: "eval/model",
      thinking: "xhigh",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    expect(agents.simulator).toEqual({
      model: "eval/model",
      thinking: "xhigh",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    // The latent authoring agent's model base is the session default (null).
    expect(agents.latent).toEqual({ model: null, thinking: "xhigh", maxTokens: 65536, timeoutMs: 1200000 });
    // Judge members: model base is the session default (null); budget falls back to background.
    expect(agents.judge).toEqual({
      members: [
        { model: null, thinking: "xhigh" },
        { model: null, thinking: "xhigh" },
        { model: null, thinking: "xhigh" },
      ],
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
  });

  it("per-agent model/thinking override the background defaults; background overrides the bases", () => {
    const agents = resolveBackgroundAgents(
      cfg({
        backgroundModel: "bg/model",
        backgroundThinkingLevel: "low",
        authorModel: "author/model",
        authorThinkingLevel: "high",
        latentModel: "latent/model",
      }),
    );
    expect(agents.author.model).toBe("author/model");
    expect(agents.author.thinking).toBe("high");
    expect(agents.probeValidate.model).toBe("bg/model");
    expect(agents.probeValidate.thinking).toBe("low");
    expect(agents.simulator.model).toBe("bg/model");
    expect(agents.simulator.thinking).toBe("low");
    expect(agents.latent.model).toBe("latent/model");
    expect(agents.latent.thinking).toBe("low");
    // Judge members inherit the background model/thinking when unset.
    expect(agents.judge.members[0]?.model).toBe("bg/model");
    expect(agents.judge.members[1]?.thinking).toBe("low");
  });

  it("maxTokens/timeoutMs fall back per-agent → background only (no code-level fallback)", () => {
    const agents = resolveBackgroundAgents(
      cfg({
        backgroundMaxTokens: 8192,
        backgroundTimeoutMs: 60000,
        probeValidateMaxTokens: 512,
        simulatorTurnTimeoutMs: 30000,
        latentStageMaxTokens: 65536,
      }),
    );
    expect(agents.author.maxTokens).toBe(8192);
    expect(agents.author.timeoutMs).toBe(60000);
    expect(agents.probeValidate.maxTokens).toBe(512);
    expect(agents.probeValidate.timeoutMs).toBe(60000);
    expect(agents.simulator.maxTokens).toBe(8192);
    expect(agents.simulator.timeoutMs).toBe(30000);
    expect(agents.latent.maxTokens).toBe(65536);
    expect(agents.latent.timeoutMs).toBe(60000);
  });

  it("judge members: per-member model/thinking override the background defaults; budget falls back per-judge → background", () => {
    const agents = resolveBackgroundAgents(
      cfg({
        backgroundModel: "bg/model",
        judgeModel: "j1/model",
        judge2Model: "j2/model",
        judgeThinkingLevel: "minimal",
        judge3ThinkingLevel: "medium",
        judgeMaxTokens: 8192,
        judgeTurnTimeoutMs: 45000,
      }),
    );
    expect(agents.judge.members[0]).toEqual({ model: "j1/model", thinking: "minimal" });
    expect(agents.judge.members[1]).toEqual({ model: "j2/model", thinking: "xhigh" }); // inherits background
    expect(agents.judge.members[2]).toEqual({ model: "bg/model", thinking: "medium" });
    expect(agents.judge.maxTokens).toBe(8192);
    expect(agents.judge.timeoutMs).toBe(45000);
  });
});
