// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Phase-2b direct-probe orchestration. For one arm's compacted base, fork a
// dedicated probe branch per direct probe (the manifest's `probes[]`), load the
// base session in-place, inject the anti-peek-prefixed probe question as a
// follow-up, await `agent_settled` (no simulator — the probe is a single
// harness-direct Q&A turn), capture the answer, commit, then apply the
// probe-lifecycle: a Q&A-only branch (diff is exclusively message entries) is
// DELETED to keep the repo clean; a branch the agent tool-called/edited into is
// KEPT. Probes carry no id in the manifest schema (they link via `targets`), so
// the bench assigns each a 1-based positional id used only for the branch name.
//
// fresh-pi / ctx-threading contract (load-bearing — same as Phase 1/2a):
// `switchSession` invalidates BOTH the command-handler `pi` AND the ctx it's
// called on, BUT its `createRuntime` RE-ACTIVATES the extension (`activate(freshPi)`
// runs again, stashing the fresh pi via bench-ctx). So inside each `withSession`
// the FRESH pi is read via `getBenchPi()` + the fresh ctx is the withSession arg;
// the fresh ctx is threaded into the next probe's `switchSession`. The inject
// lands on the fresh pi (never a stale handle).
//
// Stop-and-surface: a probe failure (inject/settle error) HALTS the run —
// `ProbeStoppedError`; the run driver catches + notifies. An abort (run signal)
// is `probe-hung`; any other error is `probe-failed`.

import { copyFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMemoryProxies } from "../arms/proxies.js";
import { ArmIsolationError, configureArm } from "../arms/switch.js";
import type { ArmId } from "../config/types.js";
import { log } from "../log.js";
import type { ScenarioManifest } from "../manifest/schema.js";
import { AgentSettledAbortedError, awaitAgentSettled } from "../session/done.js";
import { type InjectMode, inject } from "../session/inject.js";
import { extractContentText } from "../session/message-text.js";
import { loadSession } from "../session/switch.js";
import { ANTI_PEEK_PROMPT } from "../storage/anti-peek.js";
import { appendProbeAttempt } from "../storage/branches.js";
import { branchSessionFile } from "../storage/paths.js";
import { isQaOnlyBranch } from "../storage/probe-lifecycle.js";
import { branchExists, checkout, commitAll, forkBranch, resetBranch } from "../storage/repo.js";
import type { WidgetPort } from "../widget/active-widget.js";
import { getBenchPi } from "./bench-ctx.js";
import type { ArmBase } from "./phase1.js";
import { readSessionEntries } from "./trace.js";

/** Separator between the anti-peek preamble and the probe question in the inject body. */
const ANTI_PEEK_SEPARATOR = "\n\n";
/** Delivery mode for the probe inject (queued after the current run settles — the probe is a fresh turn). */
const DELIVER_AS_FOLLOW_UP: InjectMode = "followUp";
/** A signal that never aborts — the default when the caller threads no run signal. */
const NEVER_ABORT_CONTROLLER = new AbortController();
/** First array index (the probes loop starts here; probeId is 1-based positional). */
const FIRST_INDEX = 0;
/** The offset from a 0-based index to its 1-based positional probe id. */
const ONE_BASED_OFFSET = 1;

/** Why a direct probe halted (stop-and-surface). */
export type ProbeStopReason = "probe-failed" | "probe-hung" | "config-failed";

/** Thrown/recorded when a direct probe must stop-and-surface. The run driver catches
 *  it, records the reason, notifies the operator, and yields — never auto-retries. A
 *  probe-hung is the run signal aborting before the agent settled; a probe-failed is
 *  any other inject/settle error. */
export class ProbeStoppedError extends Error {
  readonly arm: ArmId;
  readonly probeId: string;
  readonly reason: ProbeStopReason;
  constructor(arm: ArmId, probeId: string, reason: ProbeStopReason, message: string) {
    super(message);
    this.name = "ProbeStoppedError";
    this.arm = arm;
    this.probeId = probeId;
    this.reason = reason;
  }
}

/** One direct probe's structured trace — Phase-3 scoring's recall-signal source. */
export interface ProbeTrace {
  /** The arm this probe belongs to. */
  readonly arm: ArmId;
  /** The 1-based attempt this probe fork samples (probes fork N× per arm → rate over N). */
  readonly attempt: number;
  /** The 1-based positional probe id (probes carry no id in the manifest schema). */
  readonly probeId: string;
  /** The probe branch the answer was captured on. */
  readonly branch: string;
  /** The agent's answer (the last assistant message text on the branch). */
  readonly answer: string;
  /** Whether the branch was KEPT (false = Q&A-only, deleted; true = the agent tool-called/edited). */
  readonly kept: boolean;
}

/** Result of {@link runProbes}: the captured probe traces (one per probe) + the FINAL
 *  fresh command ctx (the last probe's `withSession`). The run driver threads
 *  `finalCtx` into the next arm's probe driver (or Phase-3) so the switchSession chain
 *  continues from a valid ctx — every switchSession invalidates the prior ctx. */
export interface ProbeResult {
  readonly traces: readonly ProbeTrace[];
  readonly finalCtx: ExtensionCommandContext;
}

/** Injectable operations — the I/O / non-deterministic seams. Defaults are the real
 *  implementations; tests inject fakes. `deleteBranch` defaults to `resetBranch`
 *  (deletes the branch ref via `git update-ref -d` — works even on the checked-out
 *  branch, leaving HEAD on the now-unreferenced commit until the next checkout). */
export interface ProbeOps {
  loadSession: typeof loadSession;
  fork: typeof forkBranch;
  checkout: typeof checkout;
  branchExists: typeof branchExists;
  commit: typeof commitAll;
  /** Seed a branch's session file by copying its parent's (parallel to forking the git branch). */
  copySeed: (src: string, dest: string) => void;
  awaitSettled: typeof awaitAgentSettled;
  isQaOnly: typeof isQaOnlyBranch;
  deleteBranch: typeof resetBranch;
  /** Read the agent's answer (the last assistant message text) off the probe branch's session file. */
  readAnswer: (sessionPath: string) => string;
}

/** Inputs to {@link runProbes}. `cmdCtx` is threaded across probes (each switchSession
 *  invalidates the prior ctx; the fresh ctx from each `withSession` is threaded into
 *  the next probe's switchSession). */
export interface ProbeDeps {
  /** The command context that starts the loop (the first probe's switchSession). */
  readonly cmdCtx: ExtensionCommandContext;
  /** The arm's compacted base (Phase-1 result) — the fork point for every probe. */
  readonly armBase: ArmBase;
  /** Probes fork N× per arm (one probe-set per attempt 1..N) → rate over N. Each fork is an
   *  independent sample of agent-response variance from the SAME post-compaction memory. */
  readonly N: number;
  /** The scenario manifest (its `probes[]` are the direct probes to run). */
  readonly manifest: ScenarioManifest;
  /** The scenario repo path (holds the branches; tracks ONLY project files — the session transcript lives in `sessionsDir`). */
  readonly repo: string;
  /** The om-full arm's reflection-threshold override (threaded to per-arm isolation). */
  readonly omFullReflectionThresholdTokens: number;
  /** The per-branch session-transcript store (sibling of the repo; agent-invisible). Each
   *  probe's session file is seeded from its arm base's + appended to by the probe turn. */
  readonly sessionsDir: string;
  /** Run signal (default = a never-aborting signal). */
  readonly signal?: AbortSignal;
  /** The live-progress widget (TUI-only; null/absent → no-op). */
  readonly widget?: WidgetPort | null;
  /** Injectable seams (defaults = real implementations). */
  readonly ops?: Partial<ProbeOps>;
}

// --- pure helpers -----------------------------------------------------------

/** A minimal view of a session JSONL message entry (only the fields the answer
 *  extractor reads). Same conservative shape `probe-lifecycle` uses. */
interface MessageLike {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
}

/**
 * Extract the agent's answer to the probe: the most-recent assistant message's text
 * AFTER the most-recent USER message (the probe inject). The scan is bounded to after
 * the inject so the compacted-base history (which has its own user/assistant messages)
 * is never scanned. Returns the concatenated `text` blocks of that assistant message,
 * or "" if the agent's response was tool-call-only / had no text / there was no
 * assistant response after the inject (an empty/degenerate answer — scored as-is).
 *
 * Pure transformation of the parsed session entries.
 */
export function extractProbeAnswer(entries: readonly SessionEntry[]): string {
  // The answer is the agent's response to the probe inject. We bound the scan to AFTER
  // the most-recent USER message (the probe inject): the compacted-base history has its
  // own user/assistant messages, so without this bound a tool-call-only probe response
  // (or a run with no assistant response) would scan backward into the base + return a
  // STALE base message as the probe "answer" (silent probe scoring corruption).
  let injectIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i] as MessageLike;
    if (candidate.type === "message" && candidate.message?.role === "user") {
      injectIdx = i;
      break;
    }
  }
  if (injectIdx === -1) return ""; // no user message — no probe inject found
  // Return the most-recent assistant message's text AFTER the inject ("" if the agent's
  // final message was tool-call-only — no clean text answer).
  for (let i = entries.length - 1; i > injectIdx; i--) {
    const entry = entries[i] as MessageLike;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === undefined || message.role !== "assistant") continue;
    const text = extractContentText(message.content);
    return text;
  }
  return ""; // no assistant message after the inject
}

/**
 * Read the agent's probe answer off the probe branch's session-transcript FILE. The
 * default {@link ProbeOps.readAnswer}: parses the file + extracts the last
 * assistant message text. Reads the file AFTER `agent_settled` + BEFORE the commit
 * (so the answer is captured on the live transcript).
 */
function readProbeAnswer(sessionPath: string): string {
  return extractProbeAnswer(readSessionEntries(sessionPath));
}

const DEFAULT_OPS: ProbeOps = {
  loadSession,
  fork: forkBranch,
  checkout,
  branchExists,
  commit: commitAll,
  copySeed: (src, dest) => copyFileSync(src, dest),
  awaitSettled: awaitAgentSettled,
  isQaOnly: isQaOnlyBranch,
  deleteBranch: resetBranch,
  readAnswer: readProbeAnswer,
};

// --- runProbes ---------------------------------------------------------------

/**
 * Run the direct probes for one arm's compacted base, forked N× per arm (one probe-set per
 * attempt 1..N). For each attempt × probe: fork the arm base into a probe branch (the
 * branch carries the attempt suffix), checkout, load the session in-place (switchSession
 * re-activates the extension → fresh pi/ctx), inject the anti-peek-prefixed probe
 * question, await `agent_settled`, capture the answer, commit, then apply the
 * probe-lifecycle (delete a Q&A-only branch; keep a branch the agent changed). Returns
 * N×{@link ProbeTrace}s (one per attempt × probe) — each an independent sample of
 * agent-response variance from the SAME post-compaction memory → rate over N.
 *
 * @throws {ProbeStoppedError} on a probe failure (inject/settle error) or hang (abort).
 */
export async function runProbes(deps: ProbeDeps): Promise<ProbeResult> {
  const ops: ProbeOps = { ...DEFAULT_OPS, ...deps.ops };
  const signal = deps.signal ?? NEVER_ABORT_CONTROLLER.signal;
  const { arm, tool, branch: baseBranch } = deps.armBase;

  let currentCtx: ExtensionCommandContext = deps.cmdCtx;
  const traces: ProbeTrace[] = [];
  for (let attempt = 1; attempt <= deps.N; attempt++) {
    for (let i = FIRST_INDEX; i < deps.manifest.probes.length; i++) {
      const probe = deps.manifest.probes[i];
      deps.widget?.setDetail(`probe ${i + 1}/${deps.manifest.probes.length} · attempt ${attempt}/${deps.N}`);
      const probeId = String(i + ONE_BASED_OFFSET); // 1-based positional (probes carry no id in the schema)
      const probeBranch = appendProbeAttempt(baseBranch, probeId, attempt);

      // Fork arm-base → probe branch (idempotent: a re-run reuses an existing probe branch).
      if (!ops.branchExists(deps.repo, probeBranch)) {
        ops.fork(deps.repo, baseBranch, probeBranch);
      }
      ops.checkout(deps.repo, probeBranch);
      // Seed this probe's session file from its arm base's (parallel to forking the git
      // branch): the transcript lives in the sessions store (outside the repo), so each
      // probe gets its OWN file, appended to by the probe turn below.
      const sessionPath = branchSessionFile(deps.sessionsDir, probeBranch);
      ops.copySeed(branchSessionFile(deps.sessionsDir, baseBranch), sessionPath);

      // Load the arm base in-place + drive the single probe turn. switchSession
      // RE-ACTIVATES the extension (fresh pi stashed in globalThis) AND invalidates the
      // prior ctx — so ALL probe work runs INSIDE withSession using the fresh pi (read
      // from globalThis) + the fresh ctx (the withSession arg). The fresh ctx is threaded
      // into currentCtx for the next probe's switchSession. ANTI_PEEK is prepended to the
      // question so the agent re-sees the forbid-peek instruction before answering.
      await ops.loadSession(currentCtx, sessionPath, async (sessionCtx) => {
        currentCtx = sessionCtx;
        const pi: ExtensionAPI = getBenchPi();
        // Re-isolate the arm IN-PLACE (same as Phase-1/2): switchSession resets the active
        // tool set + the prior arm's memory config may still be live, so re-write THIS arm's
        // config + reload + setActiveTools before the probe turn. Keeps the probe arm-isolated.
        const proxies = getMemoryProxies();
        try {
          if (proxies === null) {
            throw new ProbeStoppedError(
              arm,
              probeId,
              "config-failed",
              `arm ${arm} probe ${probeId}: memory proxies not cached — ensure the extension is active.`,
            );
          }
          configureArm(pi, proxies.om, proxies.mk, arm, deps.repo, {
            omFullReflectionThresholdTokens: deps.omFullReflectionThresholdTokens,
          });
        } catch (err) {
          if (err instanceof ProbeStoppedError) throw err;
          if (err instanceof ArmIsolationError) {
            throw new ProbeStoppedError(
              arm,
              probeId,
              "config-failed",
              `arm ${arm} probe ${probeId} ${err.provider} is enabled but its extension proxy is not live. Stop and ensure ${
                err.provider === "observational-memory" ? "pi-observational-memory" : "avtc-pi-memkeeper"
              } is in the loaded packages.`,
            );
          }
          throw err;
        }
        try {
          const body = `${ANTI_PEEK_PROMPT}${ANTI_PEEK_SEPARATOR}${probe.question}`;
          inject(pi, body, DELIVER_AS_FOLLOW_UP);
          await ops.awaitSettled(pi, { signal });
        } catch (err) {
          if (err instanceof ProbeStoppedError) throw err;
          const aborted = err instanceof AgentSettledAbortedError;
          const cause = aborted ? "run signal aborted" : err instanceof Error ? err.message : String(err);
          const reason: ProbeStopReason = aborted ? "probe-hung" : "probe-failed";
          throw new ProbeStoppedError(
            arm,
            probeId,
            reason,
            `probe ${probeId} (attempt ${attempt}) for arm ${arm} did not settle (${cause})`,
          );
        }
      });

      // Capture the answer off the probe branch's session file, then commit the probe boundary.
      const answer = ops.readAnswer(sessionPath);
      ops.commit(deps.repo, `phase-2b: probe ${probeId} (attempt ${attempt}) for arm ${arm} (${tool})`);

      // Probe-lifecycle: a Q&A-only branch (diff is exclusively message entries) is
      // DELETED (clean repo); a branch the agent tool-called/edited is KEPT. The session
      // transcript is compared by reading the base + probe session FILES directly.
      const kept = !ops.isQaOnly(
        deps.repo,
        baseBranch,
        probeBranch,
        branchSessionFile(deps.sessionsDir, baseBranch),
        sessionPath,
      );
      if (!kept) {
        ops.deleteBranch(deps.repo, probeBranch);
      }

      traces.push({ arm, attempt, probeId, branch: probeBranch, answer, kept });
      log.info(`phase-2b: arm ${arm} probe ${probeId} (attempt ${attempt}) settled → ${probeBranch} (kept=${kept})`);
    }
  }
  return { traces, finalCtx: currentCtx };
}
