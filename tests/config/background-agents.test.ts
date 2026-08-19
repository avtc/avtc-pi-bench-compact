// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { resolveBackgroundAgents } from "../../src/config/background-agents.js";
import type { BenchConfig } from "../../src/config/types.js";

/** A minimal config with every background-agent setting at its default
 *  (per-agent null; background 32K tokens / 20m). Each test overrides what it exercises. */
function cfg(overrides: Partial<BenchConfig>): BenchConfig {
  return {
    evaluatedModel: "eval/model",
    backgroundModel: null,
    backgroundThinkingLevel: null,
    backgroundMaxTokens: 32768,
    backgroundTimeoutMs: 1200000,
    authorModel: null,
    authorThinkingLevel: null,
    authorMaxTokens: null,
    authorTimeoutMs: null,
    tailCheckModel: null,
    tailCheckThinkingLevel: null,
    tailCheckMaxTokens: null,
    tailCheckTimeoutMs: null,
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
      thinking: null,
      maxTokens: 32768,
      timeoutMs: 1200000,
    });
    expect(agents.tailCheck).toEqual({
      model: "eval/model",
      thinking: null,
      maxTokens: 32768,
      timeoutMs: 1200000,
    });
    expect(agents.simulator).toEqual({
      model: "eval/model",
      thinking: null,
      maxTokens: 32768,
      timeoutMs: 1200000,
    });
    // The latent authoring agent's model base is the session default (null).
    expect(agents.latent).toEqual({ model: null, thinking: null, maxTokens: 32768, timeoutMs: 1200000 });
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
    expect(agents.tailCheck.model).toBe("bg/model");
    expect(agents.tailCheck.thinking).toBe("low");
    expect(agents.simulator.model).toBe("bg/model");
    expect(agents.simulator.thinking).toBe("low");
    expect(agents.latent.model).toBe("latent/model");
    expect(agents.latent.thinking).toBe("low");
  });

  it("maxTokens/timeoutMs fall back per-agent → background only (no code-level fallback)", () => {
    const agents = resolveBackgroundAgents(
      cfg({
        backgroundMaxTokens: 8192,
        backgroundTimeoutMs: 60000,
        tailCheckMaxTokens: 512,
        simulatorTurnTimeoutMs: 30000,
        latentStageMaxTokens: 65536,
      }),
    );
    expect(agents.author.maxTokens).toBe(8192);
    expect(agents.author.timeoutMs).toBe(60000);
    expect(agents.tailCheck.maxTokens).toBe(512);
    expect(agents.tailCheck.timeoutMs).toBe(60000);
    expect(agents.simulator.maxTokens).toBe(8192);
    expect(agents.simulator.timeoutMs).toBe(30000);
    expect(agents.latent.maxTokens).toBe(65536);
    expect(agents.latent.timeoutMs).toBe(60000);
  });
});
