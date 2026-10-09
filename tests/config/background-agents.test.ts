// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { resolveBackgroundAgents } from "../../src/config/background-agents.js";
import type { BenchConfig } from "../../src/config/types.js";

/** A minimal config with every background-agent setting at its default
 *  (per-agent nulls; background null = the session level applies). Each test
 *  overrides what it exercises; the second argument is the session thinking level. */
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
    backgroundThinkingLevel: null,
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
  it("resolves all defaults: per-agent nulls fall back to background → session; model bases differ", () => {
    const agents = resolveBackgroundAgents(cfg({}), "high");
    expect(agents.author).toEqual({
      model: "eval/model",
      thinking: "high",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    expect(agents.probeValidate).toEqual({
      model: "eval/model",
      thinking: "high",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    expect(agents.simulator).toEqual({
      model: "eval/model",
      thinking: "high",
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
    // The latent authoring agent's model base is the session default (null).
    expect(agents.latent).toEqual({ model: null, thinking: "high", maxTokens: 65536, timeoutMs: 1200000 });
    // Judge members: model base is the session default (null); budget falls back to background.
    expect(agents.judge).toEqual({
      members: [
        { model: null, thinking: "high" },
        { model: null, thinking: "high" },
        { model: null, thinking: "high" },
      ],
      maxTokens: 65536,
      timeoutMs: 1200000,
    });
  });

  it("per-agent model/thinking override the background defaults; background overrides the session + bases", () => {
    const agents = resolveBackgroundAgents(
      cfg({
        backgroundModel: "bg/model",
        backgroundThinkingLevel: "low",
        authorModel: "author/model",
        authorThinkingLevel: "high",
        latentModel: "latent/model",
      }),
      "high",
    );
    expect(agents.author.model).toBe("author/model");
    expect(agents.author.thinking).toBe("high");
    expect(agents.probeValidate.model).toBe("bg/model");
    expect(agents.probeValidate.thinking).toBe("low");
    expect(agents.simulator.model).toBe("bg/model");
    expect(agents.simulator.thinking).toBe("low");
    expect(agents.latent.model).toBe("latent/model");
    expect(agents.latent.thinking).toBe("low");
    // Judge members keep their model base (the session default) and judge 1's
    // thinking still follows the background level (its knob is unset).
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
      null,
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

  it("judge members: per-member knobs override; unset members inherit judge 1's resolved model + thinking", () => {
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
      "high",
    );
    expect(agents.judge.members[0]).toEqual({ model: "j1/model", thinking: "minimal" });
    // model set explicitly, thinking falls through judge 1 (not the background level)
    expect(agents.judge.members[1]).toEqual({ model: "j2/model", thinking: "minimal" });
    // model unset → judge 1's model; thinking set explicitly
    expect(agents.judge.members[2]).toEqual({ model: "j1/model", thinking: "medium" });
    expect(agents.judge.maxTokens).toBe(8192);
    expect(agents.judge.timeoutMs).toBe(45000);
  });

  it("an all-unset ensemble follows a single chain: background model → session thinking", () => {
    const withBackground = resolveBackgroundAgents(cfg({ backgroundModel: "bg/model" }), "high");
    expect(withBackground.judge.members).toEqual([
      { model: "bg/model", thinking: "high" },
      { model: "bg/model", thinking: "high" },
      { model: "bg/model", thinking: "high" },
    ]);
    const sessionOnly: ThinkingLevel | null = "xhigh";
    const noBackground = resolveBackgroundAgents(cfg({ backgroundThinkingLevel: null }), sessionOnly);
    expect(noBackground.author.thinking).toBe("xhigh");
    expect(noBackground.judge.members).toEqual([
      { model: null, thinking: "xhigh" },
      { model: null, thinking: "xhigh" },
      { model: null, thinking: "xhigh" },
    ]);
  });
});
