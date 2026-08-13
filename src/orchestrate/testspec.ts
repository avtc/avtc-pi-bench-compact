// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The task-verifiability secondary objective signal: run the manifest's
// `taskObjective.testSpec` command on an attempt branch's committed project files
// and capture its pass/fail. SWE-bench-style embedded tests — objective, binary.
//
// Result shape (discriminated — the done-snapshot consumes `kind`):
//   - `{ kind: "skipped" }` — no testSpec (empty/absent); the objective axis falls
//     back to judge ranking only (no embedded-test signal).
//   - `{ kind: "ran", pass, output, runError }`:
//       pass:true                          → embedded test passed (positive signal).
//       pass:false, runError:false         → the SUBJECT's failing test — THIS is the
//                                            negative embedded-test signal (the
//                                            command ran, tests failed). NOT a
//                                            harness fault.
//       pass:false, runError:true          → HARNESS fault — the command did not run
//                                            (spawn error / timeout). Do NOT score as
//                                            a subject failure; surface (stop-and-surface).
//
// The runError flag is the crux: a failing test (exit non-zero) is the SIGNAL; a
// broken harness (command not found / timed out) is a FAULT. They must never be
// conflated. `execSync`'s non-zero exit throws with `.status` set (a number) →
// ran; a spawn error / timeout throws with no numeric `.status` → harness fault.

import { execSync } from "node:child_process";
import type { ScenarioManifest } from "../manifest/schema.js";
import { checkout } from "../storage/repo.js";

/** Process exit code indicating success. */
const EXIT_SUCCESS = 0;
/** Default wall-clock cap for one testSpec run (ms). A run that exceeds this is a harness timeout (runError). */
export const TESTSPEC_TIMEOUT_MS = 120_000;
/** Max captured stdout+stderr bytes (10 MiB) — guards against a runaway test flooding memory. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Empty-output fallback (no captured bytes). */
const EMPTY_OUTPUT = "";

/** A run's exec outcome. `exitCode` null = the command did not run (spawn error / timeout). */
export interface TestSpecExecResult {
  /** The command's exit code, or null when it never ran to completion (spawn error / timeout). */
  readonly exitCode: number | null;
  /** Captured stdout + stderr (concatenated). */
  readonly output: string;
}

/**
 * Run a testSpec command in `cwd` with a wall-clock cap. Injectable so unit tests
 * avoid real subprocesses. The default runs the command via the bench's shell
 * (mirrors the storage git wrapper's execFileSync pattern).
 */
type TestSpecExec = (command: string, cwd: string, timeoutMs: number) => TestSpecExecResult;

/** Injectable operations — the I/O seams. Defaults are the real implementations. */
export interface TestSpecOps {
  /** Run the testSpec command (default = `execTestSpec` via `execSync`). */
  readonly exec: TestSpecExec;
  /** Switch the working tree to the attempt branch (default = real `checkout`). */
  readonly checkout: typeof checkout;
}

/** Inputs to {@link runTestSpec}. `ops` defaults to the real exec + checkout; tests inject fakes. */
export interface TestSpecDeps {
  /** The scenario repo path (the command's cwd = the committed project files). */
  readonly repo: string;
  /** The attempt branch whose committed project files the testSpec runs against. */
  readonly branch: string;
  /** The scenario manifest (its `taskObjective.testSpec` is the command to run). */
  readonly manifest: ScenarioManifest;
  /** Injectable seams (defaults = real implementations). */
  readonly ops?: Partial<TestSpecOps>;
}

/** The discriminated testSpec result consumed by the done-snapshot (Task 16a). */
export type TestSpecResult =
  | { readonly kind: "skipped" }
  | { readonly kind: "ran"; readonly pass: boolean; readonly output: string; readonly runError: boolean };

/** Why a testSpec run must stop-and-surface (a harness fault — the command did not
 *  run, distinct from the subject's failing test which IS the signal). */
export type TestSpecStopReason = "testspec-fault";

/** Thrown/recorded when an embedded-testSpec run hit a harness fault (`runError:
 *  true` — spawn error / timeout / checkout fault). The run driver catches it,
 *  records the reason, notifies the operator, and yields — a harness fault is NOT a
 *  subject failure to score, it is a fault the operator must inspect. */
export class TestSpecFaultError extends Error {
  readonly branch: string;
  readonly reason: TestSpecStopReason;
  constructor(branch: string, output: string) {
    super(`testSpec on ${branch} hit a harness fault (spawn error / timeout / checkout fault): ${output}`);
    this.name = "TestSpecFaultError";
    this.branch = branch;
    this.reason = "testspec-fault";
  }
}

/** A minimal view of the exception `execSync` throws on non-zero exit / spawn error. */
interface ExecException {
  readonly status?: number | null;
  readonly stdout?: Buffer | string;
  readonly stderr?: Buffer | string;
}

/** Decode a captured byte stream (Buffer or string) to a utf8 string. */
function decode(stream: Buffer | string | undefined): string {
  if (stream === undefined) return EMPTY_OUTPUT;
  return typeof stream === "string" ? stream : stream.toString();
}

/**
 * The default {@link TestSpecExec}: run `command` in `cwd` via the shell with a
 * wall-clock `timeoutMs`. On success → exit 0 + captured output. On a non-zero
 * exit (the command ran) → that exit code + captured output (a subject's failing
 * test). On a spawn error / timeout (no numeric `.status`) → exitCode null + any
 * captured output (a harness fault). Mirrors the storage git wrapper's try/catch.
 */
function execTestSpec(command: string, cwd: string, timeoutMs: number): TestSpecExecResult {
  try {
    const output = execSync(command, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_OUTPUT_BYTES,
    }).toString();
    return { exitCode: EXIT_SUCCESS, output };
  } catch (err) {
    const e = err as ExecException;
    const output = decode(e.stdout) + decode(e.stderr);
    if (typeof e.status === "number") {
      return { exitCode: e.status, output }; // ran, non-zero (subject's failing test)
    }
    return { exitCode: null, output }; // spawn error / timeout (harness fault)
  }
}

const DEFAULT_OPS: TestSpecOps = {
  exec: execTestSpec,
  checkout,
};

/**
 * Run the manifest's `taskObjective.testSpec` on `branch`'s committed project files.
 * Checks out the branch, runs the command in the repo cwd, and maps the exit code to
 * a discriminated result. Skips cleanly (returns `{ kind: "skipped" }`) when the
 * manifest has no testSpec — the objective axis then falls back to judge ranking
 * only. A subject's failing test is `{ kind: "ran", pass: false, runError: false }`
 * (the embedded-test signal); only a harness fault (`runError: true`) is a
 * stop-and-surface condition.
 *
 * Pure orchestration over the injectable `ops` (no hidden globals).
 */
export function runTestSpec(deps: TestSpecDeps): TestSpecResult {
  const ops: TestSpecOps = { ...DEFAULT_OPS, ...deps.ops };
  const testSpec = deps.manifest.taskObjective?.testSpec ?? EMPTY_OUTPUT;
  if (testSpec.trim().length === 0) {
    return { kind: "skipped" };
  }

  // Checkout is part of the runError contract: a checkout fault (corrupt branch / git
  // error) is a HARNESS fault, not a subject failure. Wrap it so the discriminated
  // result is always returned (never throws past the contract the JSDoc promises).
  try {
    ops.checkout(deps.repo, deps.branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "ran",
      pass: false,
      output: `testSpec checkout failed: ${message}`,
      runError: true,
    };
  }
  const result = ops.exec(testSpec, deps.repo, TESTSPEC_TIMEOUT_MS);
  const pass = result.exitCode === EXIT_SUCCESS;
  const runError = result.exitCode === null; // null = spawn error / timeout (did not run)
  return { kind: "ran", pass, output: result.output, runError };
}
