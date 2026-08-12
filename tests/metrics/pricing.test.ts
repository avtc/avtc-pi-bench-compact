// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  costDollars,
  DEFAULT_MODELS_PATH,
  type Pricing,
  readPricing,
  TOKENS_PER_MILLION,
  usageTokens,
} from "../../src/metrics/pricing.js";

/** A pricing entry shape mirroring the real models.json nested provider structure. */
interface CostFields {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface ProviderModel {
  id: string;
  name: string;
  cost: Partial<CostFields>;
}
interface ProviderConfig {
  models: ProviderModel[];
}
interface ModelsFile {
  providers: Record<string, ProviderConfig>;
}

function writeModels(repo: string, file: ModelsFile): string {
  const path = join(repo, "models.json");
  writeFileSync(path, JSON.stringify(file), "utf8");
  return path;
}

describe("readPricing", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bench-pricing-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reads the model cost fields from the nested providers structure (dollars per million tokens)", () => {
    const path = writeModels(repo, {
      providers: {
        "zai-proxy": {
          models: [
            {
              id: "glm-5",
              name: "GLM-5",
              cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
            },
          ],
        },
      },
    });

    const pricing = readPricing("glm-5", { modelsPath: path });

    expect(pricing).toEqual({ inputPerM: 1, outputPerM: 3.2, cacheReadPerM: 0.2, cacheWritePerM: 0 });
  });

  it("finds the model across multiple providers (first match wins)", () => {
    const path = writeModels(repo, {
      providers: {
        first: { models: [{ id: "alpha", name: "A", cost: { input: 2 } }] },
        second: { models: [{ id: "alpha", name: "A2", cost: { input: 9 } }] },
      },
    });

    const pricing = readPricing("alpha", { modelsPath: path });

    expect(pricing.inputPerM).toBe(2);
  });

  it("throws a clear error when the model is not found", () => {
    const path = writeModels(repo, { providers: { p: { models: [] } } });

    expect(() => readPricing("no-such-model", { modelsPath: path })).toThrow(/no-such-model/);
  });

  it("returns 0 for cost fields the model omits", () => {
    const path = writeModels(repo, {
      providers: { p: { models: [{ id: "partial", name: "P", cost: { input: 5 } }] } },
    });

    const pricing = readPricing("partial", { modelsPath: path });

    expect(pricing).toEqual({ inputPerM: 5, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 });
  });

  it("exposes the real models.json path under the pi home as the default", () => {
    // Smoke: the default path points at the pi home models config filename.
    expect(DEFAULT_MODELS_PATH.endsWith(join(".pi", "agent", "models.json"))).toBe(true);
  });
});

describe("costDollars", () => {
  const pricing: Pricing = {
    inputPerM: 2,
    outputPerM: 6,
    cacheReadPerM: 0.3,
    cacheWritePerM: 2.5,
  };

  it("sums each token kind times its per-million price", () => {
    // 1M input @ 2 + 0.5M output @ 6 + 2M cacheRead @ 0.3 + 0.4M cacheWrite @ 2.5
    const tokens = {
      tokensIn: TOKENS_PER_MILLION,
      tokensOut: TOKENS_PER_MILLION / 2,
      cacheRead: TOKENS_PER_MILLION * 2,
      cacheWrite: TOKENS_PER_MILLION * 0.4,
    };

    expect(costDollars(tokens, pricing)).toBeCloseTo(2 + 3 + 0.6 + 1, 10);
  });

  it("zero tokens cost zero dollars", () => {
    const zero = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costDollars(zero, pricing)).toBe(0);
  });
});

describe("usageTokens", () => {
  it("reads the four token kinds off a usage object, guarding each with zero", () => {
    const tokens = usageTokens({ input: 100, output: 40, cacheRead: 70, cacheWrite: 12 });
    expect(tokens).toEqual({ tokensIn: 100, tokensOut: 40, cacheRead: 70, cacheWrite: 12 });
  });

  it("returns all-zero for an undefined usage", () => {
    expect(usageTokens(undefined)).toEqual({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("substitutes zero for any token kind the usage omits", () => {
    const tokens = usageTokens({ input: 5 });
    expect(tokens).toEqual({ tokensIn: 5, tokensOut: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
