// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Low-level session content extraction: turn a message entry's content blocks
// into plain text. Shared by the probe-answer extractor (orchestrate/probes.ts),
// the judge slice renderers (judge/slices.ts), and any consumer that needs an
// entry's text. Single source of truth for the content-block → text transform.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** A minimal view of a content block (the fields the extractor reads). */
interface ContentBlock {
  readonly type?: string;
  readonly text?: unknown;
}

/** A minimal view of a session message entry (the fields the extractor reads). */
interface MessageEntry {
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
}

/**
 * Concatenate the `text` blocks of a content array into a single string. Returns
 * "" for non-array content + ignores non-text / malformed blocks. Pure.
 */
export function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const blockLike = block as ContentBlock;
    if (blockLike.type === "text" && typeof blockLike.text === "string") texts.push(blockLike.text);
  }
  return texts.join("");
}

/**
 * Extract the text from a session message entry's content. Returns "" if the
 * entry has no message or non-array content. Pure.
 */
export function messageText(entry: SessionEntry): string {
  const message = (entry as MessageEntry).message;
  if (message === undefined) return "";
  return extractContentText(message.content);
}
