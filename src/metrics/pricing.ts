// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Model pricing + token-cost conversion for the exact compaction-cost metric.
//
// The pi home models config (`~/.pi/agent/models.json`) nests models under
// providers: `{ providers: { <providerId>: { models: [ { id, cost: { input,
// output, cacheRead, cacheWrite } } ] } } }`. Each cost value is dollars per
// million tokens (the unit pi-ai itself uses — its cache-stats divides cost
// fields by one million to get a per-token rate). `readPricing` walks every
// provider's models to find the first model whose id matches, so callers pass a
// bare model id without needing to know its provider.
//
// `costDollars` + `usageTokens` are the shared token-quadruple → dollars
// conversion reused by the compaction-cost metric (total, the native arm default,
// and the continuation-compaction aggregate).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One million tokens — the unit the models.json cost fields are priced per. */
export const TOKENS_PER_MILLION = 1_000_000;

/** Default location of the pi home models config (the real models.json). */
export const DEFAULT_MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");

/** Dollars-per-million-tokens price for one model, one per token kind. */
export interface Pricing {
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
}

/** A normalized token quadruple (the four kinds the cost metric sums). */
export interface TokenCounts {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Required options for `readPricing` (the models.json path is injectable). */
export interface PricingReadOpts {
  /** Absolute path to a models.json (the real default or a test fixture). */
  readonly modelsPath: string;
}

/** The token fields a usage object carries (the only ones the cost metric reads). */
export interface UsageTokenFields {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** One model under a provider in models.json. */
interface ProviderModel {
  readonly id: string;
  readonly cost?: UsageTokenFields;
}

/** A provider entry in models.json. */
interface ProviderConfig {
  readonly models?: ProviderModel[];
}

/** The top-level models.json shape. */
interface ModelsFile {
  readonly providers?: Record<string, ProviderConfig>;
}

/**
 * Read one model's pricing from a models.json. Walks every provider's `models`
 * list and returns the first model whose id matches `modelId` (callers know the
 * model id, not its provider). Missing cost fields default to 0; a model id that
 * no provider lists throws (a missing price is a stop-and-surface config error,
 * not a silent zero — the cost metric would be meaningless without a price).
 */
export function readPricing(modelId: string, opts: PricingReadOpts): Pricing {
  const raw = readFileSync(opts.modelsPath, "utf8");
  const parsed = JSON.parse(raw) as ModelsFile;
  const providers = parsed.providers ?? {};
  for (const providerId of Object.keys(providers)) {
    const models = providers[providerId]?.models ?? [];
    for (const model of models) {
      if (model.id !== modelId) continue;
      const cost = model.cost ?? {};
      return {
        inputPerM: cost.input ?? 0,
        outputPerM: cost.output ?? 0,
        cacheReadPerM: cost.cacheRead ?? 0,
        cacheWritePerM: cost.cacheWrite ?? 0,
      };
    }
  }
  throw new Error(`readPricing: model "${modelId}" not found in any provider of ${opts.modelsPath}`);
}

/**
 * Convert a token quadruple to dollars via per-million pricing: each kind's
 * tokens divided by one million times its per-million price, summed. Pure +
 * deterministic — the same counts + pricing always yield the same dollars.
 */
export function costDollars(tokens: TokenCounts, pricing: Pricing): number {
  return (
    (tokens.tokensIn / TOKENS_PER_MILLION) * pricing.inputPerM +
    (tokens.tokensOut / TOKENS_PER_MILLION) * pricing.outputPerM +
    (tokens.cacheRead / TOKENS_PER_MILLION) * pricing.cacheReadPerM +
    (tokens.cacheWrite / TOKENS_PER_MILLION) * pricing.cacheWritePerM
  );
}

/**
 * Read the four token kinds off a usage object, defaulting any omitted or
 * undefined field to 0 (the cost metric must never see undefined — partial
 * emission would NaN-propagate through the sum).
 */
export function usageTokens(usage: UsageTokenFields | undefined): TokenCounts {
  return {
    tokensIn: usage?.input ?? 0,
    tokensOut: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
  };
}
