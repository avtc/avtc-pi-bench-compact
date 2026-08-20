// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `copySessionFork` — copy a session file under a FRESH session id.
 *
 * pi derives the session id from the `session` header entry embedded in the file, so
 * a raw file copy keeps the parent's id and every fork aliases ONE session for
 * id-keyed extension state (e.g. per-session decision stores). This copy rewrites
 * the header id to a fresh UUID so each fork is a distinct session. The header id is
 * self-contained (subsequent entries carry their own entry ids), so the swap is
 * complete — no other line references it.
 *
 * The copy may also PIN the fork's runtime model + thinking level: a forked session
 * replays its historical `model_change` / `thinking_level_change` entries on load, so
 * without a pin every bench-driven session inherits whatever the ORIGINAL authoring
 * session happened to run (e.g. the scenario build's level — regardless of the
 * current bench settings). Appending fresh change-entries at the fork point makes the
 * configured runtime win on replay — the run compares models/thinking levels on the
 * same scenario instead of re-measuring the build-time ones.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The runtime a forked session is pinned to. The model may stay unset (null = keep
 * whatever model the session file already carries); the thinking level is always
 * concrete — every caller has a configured level. */
export interface SessionRuntimePins {
  readonly model: { readonly provider: string; readonly modelId: string } | null;
  readonly thinkingLevel: ThinkingLevel;
}

/** Split a `"<provider>/<id>"` model setting into its parts (first slash — an id may
 * itself contain slashes). Returns null for a non-`provider/id` form. */
export function splitModelSetting(value: string): { provider: string; modelId: string } | null {
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** Build the pins from the bench settings: `model` is the `provider/id` setting
 * (null = session default → no model pin); `thinkingLevel` always pins. */
export function pinsFromSettings(model: string | null, thinkingLevel: ThinkingLevel): SessionRuntimePins {
  return { model: model === null ? null : splitModelSetting(model), thinkingLevel };
}

/** A fresh entry id in pi's style (8 hex chars). */
function freshEntryId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** The id of the LAST entry in a session body (the chain parent for appended
 * entries), or null when the body has no entries. */
function lastEntryId(body: string): string | null {
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed === "") return null;
  const lastLine = trimmed.slice(Math.max(trimmed.lastIndexOf("\n"), 0));
  const last = JSON.parse(lastLine) as { id?: unknown };
  return typeof last.id === "string" ? last.id : null;
}

/**
 * Copy the session file `src` to `dest` with a freshly generated session id in its
 * header entry, optionally appending runtime pins (see {@link SessionRuntimePins}).
 *
 * @param src — path to the source session JSONL file (must start with a session header).
 * @param dest — path where the forked copy is written.
 * @param pins — when non-null, a `model_change` (iff a model is set) + a
 *   `thinking_level_change` entry are appended at the fork point, chained onto the
 *   copied body's last entry — the configured runtime wins over the file's
 *   historical change-entries on replay.
 * @throws if the first line of `src` is not a `session` header entry with a string id.
 */
export function copySessionFork(src: string, dest: string, pins: SessionRuntimePins | null): void {
  const raw = readFileSync(src, "utf8");
  const newline = raw.indexOf("\n");
  const headerLine = newline === -1 ? raw : raw.slice(0, newline);
  const header = JSON.parse(headerLine) as { type?: string; id?: unknown };
  if (header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`session fork: "${src}" does not start with a session header entry`);
  }
  header.id = randomUUID();
  const body = newline === -1 ? "" : raw.slice(newline);
  if (pins === null) {
    writeFileSync(dest, `${JSON.stringify(header)}${body}`);
    return;
  }
  let parentId = lastEntryId(body);
  const lines: string[] = [];
  const timestamp = new Date().toISOString();
  if (pins.model !== null) {
    const modelChange = {
      type: "model_change",
      id: freshEntryId(),
      parentId,
      timestamp,
      provider: pins.model.provider,
      modelId: pins.model.modelId,
    };
    lines.push(JSON.stringify(modelChange));
    parentId = modelChange.id;
  }
  const thinkingChange = {
    type: "thinking_level_change",
    id: freshEntryId(),
    parentId,
    timestamp,
    thinkingLevel: pins.thinkingLevel,
  };
  lines.push(JSON.stringify(thinkingChange));
  const pinBlock = `${body === "" ? "" : body.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;
  writeFileSync(dest, `${JSON.stringify(header)}${body}${pinBlock}`);
}
