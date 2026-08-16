// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type CrashWitnessTarget, registerCrashWitness } from "../src/crash-guard.js";
import { _setBaseLoggerForTest } from "../src/log.js";

function fakeTarget(): {
  target: CrashWitnessTarget;
  exitHandlers: Array<(code: number | null) => void>;
  crashHandlers: Array<(err: unknown) => void>;
} {
  const exitHandlers: Array<(code: number | null) => void> = [];
  const crashHandlers: Array<(err: unknown) => void> = [];
  const target: CrashWitnessTarget = {
    on: ((event: string, listener: (...args: never[]) => void): unknown => {
      if (event === "exit") exitHandlers.push(listener as (code: number | null) => void);
      if (event === "uncaughtException") crashHandlers.push(listener as (err: unknown) => void);
      return undefined;
    }) as CrashWitnessTarget["on"],
  };
  return { target, exitHandlers, crashHandlers };
}

describe("registerCrashWitness", () => {
  it("registers exit + uncaughtException witnesses that LOG via the bench logger", () => {
    delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
    const lines: { level: string; msg: string }[] = [];
    const prev = _setBaseLoggerForTest({
      info: () => {},
      warn: (m: string) => lines.push({ level: "warn", msg: m }),
      error: (m: string) => lines.push({ level: "error", msg: m }),
      debug: () => {},
    });
    try {
      const { target, exitHandlers, crashHandlers } = fakeTarget();
      registerCrashWitness(target);
      expect(exitHandlers).toHaveLength(1);
      expect(crashHandlers).toHaveLength(1);
      exitHandlers[0]?.(129);
      crashHandlers[0]?.(new Error("boom"));
      expect(lines.some((l) => l.msg.includes("exiting (code 129)"))).toBe(true);
      expect(lines.some((l) => l.level === "error" && l.msg.includes("uncaughtException"))).toBe(true);
    } finally {
      _setBaseLoggerForTest(prev);
      delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
    }
  });

  it("idempotent across re-activations (globalThis guard — no duplicate witnesses)", () => {
    (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness = undefined;
    const { target, exitHandlers } = fakeTarget();
    registerCrashWitness(target);
    registerCrashWitness(target);
    expect(exitHandlers).toHaveLength(1);
    delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
  });
});
