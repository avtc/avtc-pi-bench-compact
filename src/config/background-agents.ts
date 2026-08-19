// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NO_MODEL } from "./schema.js";
import type { BenchConfig } from "./types.js";

/** One background agent's effective parameters after settings resolution. */
export interface BackgroundAgent {
  /** The model id the agent's stage calls resolve against (null = session default). */
  readonly model: string | null;
  /** The agent's thinking level (null = omit the reasoning field — the model default). */
  readonly thinking: ThinkingLevel | null;
  /** The agent's per-call output-token cap (the per-agent setting, else the background default). */
  readonly maxTokens: number;
  /** The agent's per-call wall-clock cap in ms (the per-agent setting, else the background default). */
  readonly timeoutMs: number;
}

/** The four background agents' effective parameters, resolved once per consumer
 *  (prepare seams, Phase 2 simulator, latent stage). Per agent: model and thinking
 *  fall back per-agent → background → base (author/tail-check/simulator base: the
 *  evaluated model; latent authoring: the session default); maxTokens and timeoutMs
 *  fall back per-agent → background setting only — no code-level fallback, the
 *  background settings always carry a value. */
export interface BackgroundAgents {
  readonly author: BackgroundAgent;
  readonly tailCheck: BackgroundAgent;
  readonly simulator: BackgroundAgent;
  readonly latent: BackgroundAgent;
}

/** Resolve the background agents' effective parameters. Pure. */
export function resolveBackgroundAgents(config: BenchConfig): BackgroundAgents {
  const model = (agentModel: string | null, base: string | null): string | null =>
    agentModel ?? config.backgroundModel ?? base;
  const thinking = (agentThinking: ThinkingLevel | null): ThinkingLevel | null =>
    agentThinking ?? config.backgroundThinkingLevel;
  const maxTokens = (agentMaxTokens: number | null): number => agentMaxTokens ?? config.backgroundMaxTokens;
  const timeoutMs = (agentTimeoutMs: number | null): number => agentTimeoutMs ?? config.backgroundTimeoutMs;
  return {
    author: {
      model: model(config.authorModel, config.evaluatedModel),
      thinking: thinking(config.authorThinkingLevel),
      maxTokens: maxTokens(config.authorMaxTokens),
      timeoutMs: timeoutMs(config.authorTimeoutMs),
    },
    tailCheck: {
      model: model(config.tailCheckModel, config.evaluatedModel),
      thinking: thinking(config.tailCheckThinkingLevel),
      maxTokens: maxTokens(config.tailCheckMaxTokens),
      timeoutMs: timeoutMs(config.tailCheckTimeoutMs),
    },
    simulator: {
      model: model(config.simulatorModel, config.evaluatedModel),
      thinking: thinking(config.simulatorThinkingLevel),
      maxTokens: maxTokens(config.simulatorMaxTokens),
      timeoutMs: timeoutMs(config.simulatorTurnTimeoutMs),
    },
    // The latent authoring agent's model base is the session default (null), not the evaluated model.
    latent: {
      model: model(config.latentModel, NO_MODEL),
      thinking: thinking(config.latentThinkingLevel),
      maxTokens: maxTokens(config.latentStageMaxTokens),
      timeoutMs: timeoutMs(config.latentTimeoutMs),
    },
  };
}
