// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import type { ScenarioManifest } from "../../src/manifest/schema.js";
import {
  runTestSpec,
  scrubEnv,
  TESTSPEC_TIMEOUT_MS,
  type TestSpecExecResult,
  type TestSpecOps,
  type TestSpecResult,
} from "../../src/orchestrate/testspec.js";

// --- fixtures ----------------------------------------------------------------

const REPO = "/repo";
const BRANCH = "bench-compact/run-2026-08-11-1/cfg-x/arm-bare-pi-1";

function makeManifest(testSpec: string | undefined): ScenarioManifest {
  const taskObjective = testSpec === undefined ? undefined : { description: "the game", testSpec };
  return {
    id: "scen-1",
    description: "an incremental economic tycoon",
    compactionBoundary: { phaseATokenBudget: 140000, plan: "build to the boundary" },
    recallFacts: [],
    doneOps: [],
    supersessions: [],
    abstentions: [],
    probes: [],
    taskObjective,
  } as unknown as ScenarioManifest;
}

/** Build injectable ops: a fake exec returning `result` + a stubbed checkout. */
function makeOps(result: TestSpecExecResult): TestSpecOps {
  return { exec: vi.fn((): TestSpecExecResult => result), checkout: vi.fn() };
}

describe("scrubEnv — strip secret-looking vars from the subprocess env", () => {
  it("drops provider API keys (ANTHROPIC/OPENAI/ZAI/etc.) + keeps PATH/HOME", () => {
    const scrubbed = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai",
      ZAI_API_KEY: "zai-key",
      MY_GAME_CONFIG: "x",
    });
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ZAI_API_KEY).toBeUndefined();
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/user");
    expect(scrubbed.MY_GAME_CONFIG).toBe("x");
  });

  it("drops SECRET/TOKEN/PASSWORD/CREDENTIAL patterns", () => {
    const scrubbed = scrubEnv({
      DB_PASSWORD: "pw",
      AUTH_TOKEN: "tok",
      MY_SECRET: "s",
      SERVICE_CREDENTIALS: "c",
      KEEP_ME: "y",
    });
    expect(scrubbed.DB_PASSWORD).toBeUndefined();
    expect(scrubbed.AUTH_TOKEN).toBeUndefined();
    expect(scrubbed.MY_SECRET).toBeUndefined();
    expect(scrubbed.SERVICE_CREDENTIALS).toBeUndefined();
    expect(scrubbed.KEEP_ME).toBe("y");
  });

  it("does not mutate the input env", () => {
    const input = { PATH: "/bin", ANTHROPIC_API_KEY: "k" };
    scrubEnv(input);
    expect(input.ANTHROPIC_API_KEY).toBe("k");
  });
});

describe("runTestSpec — exit-code → pass/runError mapping (the E7 objective signal)", () => {
  it("exit 0 → {ran, pass:true, runError:false}", () => {
    const ops = makeOps({ exitCode: 0, output: "all tests passed" });
    const result: TestSpecResult = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(result).toEqual({ kind: "ran", pass: true, output: "all tests passed", runError: false });
  });

  it("exit non-zero (the command ran) → {ran, pass:false, runError:false} — a SUBJECT's failing test IS the E7 signal, NOT a harness fault", () => {
    const ops = makeOps({ exitCode: 1, output: "2 failing" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(result).toEqual({ kind: "ran", pass: false, output: "2 failing", runError: false });
  });

  it("exit non-zero other than 1 (e.g. 2) is still pass:false, runError:false (the command ran)", () => {
    const ops = makeOps({ exitCode: 2, output: "syntax error in tests" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(result).toEqual({ kind: "ran", pass: false, output: "syntax error in tests", runError: false });
  });

  it("exitCode null (spawn error / timeout) → {ran, pass:false, runError:true} — a HARNESS fault (distinct from a subject failure)", () => {
    const ops = makeOps({ exitCode: null, output: "npm: command not found" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(result).toEqual({ kind: "ran", pass: false, output: "npm: command not found", runError: true });
  });
});

describe("runTestSpec — skip when there is no testSpec", () => {
  it("empty testSpec → {skipped} + does NOT checkout or exec (E7 falls back to judge ranking only)", () => {
    const ops = makeOps({ exitCode: 0, output: "" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest(""), ops });
    expect(result).toEqual({ kind: "skipped" });
    expect(ops.exec).not.toHaveBeenCalled();
    expect(ops.checkout).not.toHaveBeenCalled();
  });

  it("whitespace-only testSpec → {skipped}", () => {
    const ops = makeOps({ exitCode: 0, output: "" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("   \n "), ops });
    expect(result).toEqual({ kind: "skipped" });
    expect(ops.exec).not.toHaveBeenCalled();
  });

  it("absent taskObjective → {skipped} (defensive — the schema requires taskObjective, but guard anyway)", () => {
    const ops = makeOps({ exitCode: 0, output: "" });
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest(undefined), ops });
    expect(result).toEqual({ kind: "skipped" });
    expect(ops.exec).not.toHaveBeenCalled();
  });
});

describe("runTestSpec — checkout + exec wiring", () => {
  it("checks out the attempt branch before running the testSpec (runs ON the committed project files)", () => {
    const ops = makeOps({ exitCode: 0, output: "" });
    runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(ops.checkout).toHaveBeenCalledTimes(1);
    expect(ops.checkout).toHaveBeenCalledWith(REPO, BRANCH);
  });

  it("passes the testSpec command + the repo cwd + the timeout to exec", () => {
    const ops = makeOps({ exitCode: 0, output: "" });
    runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(ops.exec).toHaveBeenCalledTimes(1);
    expect(ops.exec).toHaveBeenCalledWith("npm test", REPO, TESTSPEC_TIMEOUT_MS);
  });
});

describe("runTestSpec — checkout-fault handling (: a harness fault, not a thrown contract break)", () => {
  it("a checkout error → {ran, pass:false, runError:true} (never throws past the runError contract)", () => {
    const ops: TestSpecOps = {
      exec: vi.fn((): TestSpecExecResult => ({ exitCode: 0, output: "" })),
      checkout: vi.fn(() => {
        throw new Error("fatal: not a valid object name");
      }),
    };
    const result = runTestSpec({ repo: REPO, branch: BRANCH, manifest: makeManifest("npm test"), ops });
    expect(result).toEqual({
      kind: "ran",
      pass: false,
      output: expect.stringContaining("testSpec checkout failed"),
      runError: true,
    });
    // exec never ran (checkout failed first).
    expect(ops.exec).not.toHaveBeenCalled();
  });
});
