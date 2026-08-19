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
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Copy the session file `src` to `dest` with a freshly generated session id in its
 * header entry.
 *
 * @param src — path to the source session JSONL file (must start with a session header).
 * @param dest — path where the forked copy is written.
 * @throws if the first line of `src` is not a `session` header entry with a string id.
 */
export function copySessionFork(src: string, dest: string): void {
  const raw = readFileSync(src, "utf8");
  const newline = raw.indexOf("\n");
  const headerLine = newline === -1 ? raw : raw.slice(0, newline);
  const header = JSON.parse(headerLine) as { type?: string; id?: unknown };
  if (header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`session fork: "${src}" does not start with a session header entry`);
  }
  header.id = randomUUID();
  const body = newline === -1 ? "" : raw.slice(newline);
  writeFileSync(dest, `${JSON.stringify(header)}${body}`);
}
