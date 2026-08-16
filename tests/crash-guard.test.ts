// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { type CrashWitnessTarget, registerCrashWitness } from "../src/crash-guard.js";
import { _setBaseLoggerForTest } from "../src/log.js";

function fakeTarget(overrides: Partial<CrashWitnessTarget> | null): {
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
    ...(overrides ?? {}),
  };
  return { target, exitHandlers, crashHandlers };
}

/** Capturing logger sink — records every (level, msg) pair. */
function capturingSink(): { sink: ReturnType<typeof _setBaseLoggerForTest>; lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    sink: {
      info: () => {},
      warn: (m: string) => lines.push({ level: "warn", msg: m }),
      error: (m: string) => lines.push({ level: "error", msg: m }),
      debug: () => {},
    },
  };
}

/** Reset the idempotency guard + logger, run `body`, restore. */
function withWitness(body: (lines: { level: string; msg: string }[]) => void, target: CrashWitnessTarget): void {
  delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
  const { lines, sink } = capturingSink();
  const prev = _setBaseLoggerForTest(sink);
  try {
    registerCrashWitness(target);
    body(lines);
  } finally {
    _setBaseLoggerForTest(prev);
    delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
  }
}

describe("registerCrashWitness", () => {
  it("registers exit + uncaughtException witnesses that LOG via the bench logger", () => {
    const { target, exitHandlers, crashHandlers } = fakeTarget(null);
    withWitness((lines) => {
      expect(exitHandlers).toHaveLength(1);
      expect(crashHandlers).toHaveLength(1);
      exitHandlers[0]?.(129);
      crashHandlers[0]?.(new Error("boom"));
      expect(lines.some((l) => l.msg.includes("exiting (code 129)"))).toBe(true);
      expect(lines.some((l) => l.level === "error" && l.msg.includes("uncaughtException"))).toBe(true);
    }, target);
  });

  it("idempotent across re-activations (globalThis guard — no duplicate witnesses)", () => {
    (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness = undefined;
    const { target, exitHandlers } = fakeTarget(null);
    registerCrashWitness(target);
    registerCrashWitness(target);
    expect(exitHandlers).toHaveLength(1);
    delete (globalThis as { __benchCompactCrashWitness?: boolean }).__benchCompactCrashWitness;
  });

  it("tees stderr into the exit dump (pi's crash print survives a lost terminal)", () => {
    const writes: unknown[][] = [];
    const stderr = {
      write: (chunk: unknown, ...rest: unknown[]) => {
        writes.push([chunk, ...rest]);
        return true;
      },
    };
    const { target, exitHandlers } = fakeTarget({ stderr });
    withWitness((lines) => {
      // normal TUI-ish writes flow through the passthrough unchanged
      const passthrough = stderr.write("some TUI output\n", "utf8");
      expect(passthrough).toBe(true);
      expect(writes).toHaveLength(1);
      // pi's uncaught-crash print lands on stderr AFTER ui.stop()
      stderr.write("pi exiting due to uncaughtException:\n");
      stderr.write("Error: something threw\n    at inner (om.js:1:1)\n");
      exitHandlers[0]?.(1);
      const dump = lines.find((l) => l.msg.includes("stderr tail"));
      expect(dump).toBeDefined();
      expect(dump?.msg).toContain("pi exiting due to uncaughtException:");
      expect(dump?.msg).toContain("at inner (om.js:1:1)");
    }, target);
  });

  it("keeps only the trailing ring of stderr (bounded dump)", () => {
    let forwarded = "";
    const stderr = { write: (chunk: unknown) => (forwarded += String(chunk)) };
    const { target, exitHandlers } = fakeTarget({ stderr });
    withWitness((lines) => {
      stderr.write(`${"x".repeat(20_000)}`);
      stderr.write("TAIL-MARKER");
      exitHandlers[0]?.(0);
      const dump = lines.find((l) => l.msg.includes("stderr tail"));
      expect(dump).toBeDefined();
      expect(dump?.msg).toContain("TAIL-MARKER");
      expect(dump?.msg.length).toBeLessThan(20_000);
      // the passthrough forwarded everything (no truncation of real output)
      expect(forwarded.length).toBe(20_000 + "TAIL-MARKER".length);
    }, target);
  });

  it("skips the stderr dump when nothing was captured", () => {
    const { target, exitHandlers } = fakeTarget(null);
    withWitness((lines) => {
      exitHandlers[0]?.(0);
      expect(lines.some((l) => l.msg.includes("stderr tail"))).toBe(false);
      expect(lines.some((l) => l.msg.includes("exiting (code 0)"))).toBe(true);
    }, target);
  });

  it("wraps process.exit with a log-only stack witness (passthrough preserved)", () => {
    const calls: (number | undefined)[] = [];
    const baseExit = (code: number | undefined): never => {
      calls.push(code);
      throw new Error("process.exit in a test — not a real exit");
    };
    const holder: { exit?: (code?: number) => never } = { exit: baseExit };
    const { target } = fakeTarget({
      exit: (code?: number): never => {
        holder.exit?.(code); // baseExit always throws — the line below is unreachable
        throw new Error("unreachable — passthrough base did not throw");
      },
    });
    withWitness((lines) => {
      expect(() => target.exit?.(1)).toThrow("not a real exit");
      expect(calls).toEqual([1]); // passthrough called the original with the same code
      const stackLine = lines.find((l) => l.msg.includes("process.exit(1) called at"));
      expect(stackLine).toBeDefined();
      expect(stackLine?.msg).toContain("witness exit stack"); // the capture stack is included
    }, target);
  });

  it("accepts Buffer chunks in the stderr tee", () => {
    const stderr = { write: (_chunk: unknown) => true };
    const { target, exitHandlers } = fakeTarget({ stderr });
    withWitness((lines) => {
      stderr.write(Buffer.from("buffered crash print", "utf8"));
      exitHandlers[0]?.(1);
      expect(lines.some((l) => l.msg.includes("buffered crash print"))).toBe(true);
    }, target);
  });
});
