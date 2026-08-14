// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { BenchJudgeError, type JudgeErrorCategory } from "../../src/judge/errors.js";
import { RankMalformedJsonError } from "../../src/judge/ranking.js";
import { JudgeMalformedJsonError } from "../../src/judge/single-call.js";

describe("BenchJudgeError (typed judge STOP+surface contract)", () => {
  it("carries a machine-readable category + a human-readable message", () => {
    const err = new BenchJudgeError("model-unavailable", "authoring model not available: no key");
    expect(err).toBeInstanceOf(Error);
    expect(err.category).toBe("model-unavailable");
    expect(err.message).toBe("authoring model not available: no key");
    expect(err.name).toBe("BenchJudgeError");
  });

  it("JudgeMalformedJsonError is a BenchJudgeError with category 'malformed-json'", () => {
    const err = new JudgeMalformedJsonError("E4", 3);
    expect(err).toBeInstanceOf(BenchJudgeError);
    expect(err.category).toBe("malformed-json");
    expect(err.axis).toBe("E4");
    expect(err.attempts).toBe(3);
    expect(err.name).toBe("JudgeMalformedJsonError");
  });

  it("RankMalformedJsonError is a BenchJudgeError with category 'malformed-json'", () => {
    const err = new RankMalformedJsonError("E7", "unknown label");
    expect(err).toBeInstanceOf(BenchJudgeError);
    expect(err.category).toBe("malformed-json");
    expect(err.axis).toBe("E7");
    expect(err.reason).toBe("unknown label");
    expect(err.name).toBe("RankMalformedJsonError");
  });

  it("every category value is a known JudgeErrorCategory", () => {
    // Locks the category union: switches on these.
    const categories: JudgeErrorCategory[] = [
      "model-unavailable",
      "timeout",
      "aborted",
      "no-capture",
      "incomplete-output",
      "malformed-json",
    ];
    for (const category of categories) {
      const err = new BenchJudgeError(category, "x");
      expect(err.category).toBe(category);
    }
  });
});
