// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The user-simulator's observation primitives: read the coding agent's output +
// render a readable transcript of recent work so the simulator LLM can decide its
// next user message. Unlike a memory Observer (which renders to cite source ids),
// the simulator renders a readable transcript + calls `buildChunks` with
// `includeEntryId: false` (it never cites).
//
// What's here: `isRenderableEntry` (the renderable filter), `computeUnobserved`
// (the id-cursor frontier gap), `renderGroups` + `buildChunks` (the entry-bounded,
// token-gated XML-tagged transcript: USER/ASSISTANT/THINKING/TOOLCALL/TOOLRESULT
// pairs), and `stripAnsi` (tool output often carries ANSI codes — stripped so the
// simulator's context stays compact + clean). The chars/4 token estimate is shared
// with the agent-loop runtime (single source: `../runtime/streaming-tokens.js`).

import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CHARS_PER_TOKEN_ESTIMATE } from "../runtime/streaming-tokens.js";

// --- stripAnsi -------------------------------------------------------------

/** ANSI/VT escape sequences stripped from all rendered text (CSI incl. 24-bit
 *  color with ':' params + cursor moves + '?' private modes via \x1b[ or the
 *  8-bit \x9b; OSC via BEL or String Terminator). Tool output carries these. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are the explicit target here
const ANSI_ESCAPE_PATTERN = /\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b\[[0-9;:?]*[A-Za-z]|\x9b[0-9;:?]*[A-Za-z]/g;

/** Strip ANSI/VT escape sequences from text (applied to all rendered text). */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

// --- isRenderableEntry (the renderable filter) -----------------------------

/** Entry types the simulator renders (message/custom_message/branch_summary). */
const RENDERABLE_ENTRY_TYPES: ReadonlySet<string> = new Set(["message", "custom_message", "branch_summary"]);

/** Whether an entry is a renderable source (message/custom_message/branch_summary). */
export function isRenderableEntry(entry: SessionEntry): boolean {
  return RENDERABLE_ENTRY_TYPES.has(entry.type);
}

// --- render block / group / chunk types -----------------------------------

/** One rendered tag-block in the transcript (carries entry=entryId when cited). */
interface RenderBlock {
  readonly text: string;
  readonly entryId: string;
}

/** One entry's rendered blocks kept together as an atomic chunking unit (a whole
 *  entry is never split across chunks). An assistant entry's tool calls absorb
 *  each matched tool-result entry into its group. */
interface RenderGroup {
  readonly blocks: readonly RenderBlock[];
}

export interface ChunkOptions {
  /** Emit a chunk once accumulated entry-groups reach this many tokens (chars/4). */
  readonly tokenThreshold: number;
  /** Cap each tool arg/result block to this many tokens (head/tail + marker); null = no cap. */
  readonly toolBlockCapTokens: number | null;
  /** Include non-redacted thinking blocks (redacted always skipped). */
  readonly includeThinking: boolean;
  /** Emit the `entry=id` attribute on each tag (the Observer cites; the simulator does not). */
  readonly includeEntryId: boolean;
}

// --- computeUnobserved (id-cursor frontier gap) ---------------------------

/** Whether a session entry is a user message (anchors the null-frontier start). */
/**
 * The id of the last user-role message in the branch, or null if there is none.
 * For the simulator: this is its most recent injected message (the coding agent
 * never produces user messages), so it is the natural frontier to observe-after —
 * the unobserved gap becomes exactly the agent's response to it. Derived fresh each
 * cycle (no stored state — robust against inject/delivery timing).
 */
/**
 * The unobserved slice: renderable entries strictly AFTER the frontier id. When
 * `frontier` is null (no user message at all) the slice is empty (no anchor).
 * Operational entries are never unobserved sources.
 *
 * For the simulator: pass `lastUserMessageId(branch)` — the simulator's last
 * injection — so the result is exactly the agent's response since the simulator
 * last spoke (never re-rendering the simulator's own previous message).
 */
// --- sanitization & truncation --------------------------------------------

const TRUNCATION_MARKER = "[…truncated…]";
const THINKING_PREFIX_PATTERN = /^Thinking:\s*/;
const ATTR_ERROR = "error";
/** Separator between rendered blocks (each tag on its own line). */
const BLOCK_SEP = "\n";

function sanitizeThinking(text: string): string {
  return stripAnsi(text).replace(THINKING_PREFIX_PATTERN, "");
}

/** Cap a tool block's inner text to `capTokens` tokens (chars/4): keep head + tail. null = no cap. */
function capBlock(text: string, capTokens: number | null): string {
  if (capTokens === null) return text;
  const budgetChars = capTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= budgetChars) return text;
  const half = Math.trunc(budgetChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

/** Extract joinable text from a content array (skip images), then strip ANSI. */
function cleanText(content: string | readonly (TextContent | { readonly type: string })[]): string {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join("");
  return stripAnsi(raw);
}

// --- block constructors (final inner text already cleaned/capped) -----------

function tagBlock(tag: string, id: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<${tag}${attr}>${inner}</${tag}>` };
}

const uBlock = (id: string, inner: string, includeEntryId: boolean): RenderBlock =>
  tagBlock("USER", id, inner, includeEntryId);
const aBlock = (id: string, inner: string, includeEntryId: boolean): RenderBlock =>
  tagBlock("ASSISTANT", id, inner, includeEntryId);
const tBlock = (id: string, inner: string, includeEntryId: boolean): RenderBlock =>
  tagBlock("THINKING", id, inner, includeEntryId);

function cBlock(id: string, toolName: string, inner: string, includeEntryId: boolean): RenderBlock {
  const attr = includeEntryId ? ` entry=${id}` : "";
  return { entryId: id, text: `<TOOLCALL:${toolName}${attr}>${inner}</TOOLCALL>` };
}

function rBlock(id: string, inner: string, isError: boolean, includeEntryId: boolean): RenderBlock {
  const entryAttr = includeEntryId ? ` entry=${id}` : "";
  const attr = isError ? `${entryAttr} ${ATTR_ERROR}` : entryAttr;
  return { entryId: id, text: `<TOOLRESULT${attr}>${inner}</TOOLRESULT>` };
}

// --- per-entry group rendering --------------------------------------------

function renderCustomMessageGroup(entry: CustomMessageEntry, includeEntryId: boolean): RenderGroup | null {
  const text = cleanText(entry.content);
  if (text.length === 0) return null;
  return { blocks: [uBlock(entry.id, text, includeEntryId)] };
}

function renderBranchSummaryGroup(entry: BranchSummaryEntry, includeEntryId: boolean): RenderGroup | null {
  const text = stripAnsi(entry.summary);
  if (text.length === 0) return null;
  return { blocks: [uBlock(entry.id, text, includeEntryId)] };
}

/**
 * Render the entry list into entry-bounded groups. Each renderable entry is one
 * group (its blocks never split across chunks). An assistant entry's tool calls
 * absorb their matched tool-result entries into the group (the TOOLCALL block is
 * immediately followed by its TOOLRESULT); matched results are consumed + skipped.
 */
function renderGroups(entries: readonly SessionEntry[], options: ChunkOptions): RenderGroup[] {
  const cap = options.toolBlockCapTokens;
  const includeEntryId = options.includeEntryId;
  const resultByCallId = buildResultIndex(entries);
  const consumedResultIds = new Set<string>();
  const groups: RenderGroup[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const blocks = renderMessageBlocks(entry, options, cap, resultByCallId, consumedResultIds);
        if (blocks.length > 0) groups.push({ blocks });
        break;
      }
      case "custom_message": {
        const group = renderCustomMessageGroup(entry, includeEntryId);
        if (group !== null) groups.push(group);
        break;
      }
      case "branch_summary": {
        const group = renderBranchSummaryGroup(entry, includeEntryId);
        if (group !== null) groups.push(group);
        break;
      }
      // operational entries (model_change, thinking_level_change, label, session_info, custom)
      // are not renderable sources — skip.
      default:
        break;
    }
  }
  return groups;
}

function buildResultIndex(entries: readonly SessionEntry[]): Map<string, SessionMessageEntry> {
  const resultByCallId = new Map<string, SessionMessageEntry>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (typeof message === "object" && message !== null && message.role === "toolResult") {
      resultByCallId.set(message.toolCallId, entry);
    }
  }
  return resultByCallId;
}

function renderMessageBlocks(
  entry: SessionMessageEntry,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
): RenderBlock[] {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return [];
  const id = entry.id;
  const includeEntryId = options.includeEntryId;

  if (message.role === "user") {
    const text = cleanText(message.content);
    return text.length > 0 ? [uBlock(id, text, includeEntryId)] : [];
  }

  if (message.role === "toolResult") {
    if (consumedResultIds.has(id)) return []; // already absorbed into its call's group
    const text = capBlock(cleanText(message.content), cap);
    return [rBlock(id, text, message.isError, includeEntryId)];
  }

  if (message.role === "assistant") {
    return renderAssistantBlocks(message, id, options, cap, resultByCallId, consumedResultIds);
  }
  return [];
}

function renderAssistantBlocks(
  message: AssistantMessage,
  id: string,
  options: ChunkOptions,
  cap: number | null,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
): RenderBlock[] {
  const includeEntryId = options.includeEntryId;
  const blocks: RenderBlock[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        const text = cleanText([part]);
        if (text.length > 0) blocks.push(aBlock(id, text, includeEntryId));
        break;
      }
      case "thinking": {
        if (!options.includeThinking) break;
        if (part.redacted === true) break; // redacted always skipped
        const cleaned = sanitizeThinking(part.thinking);
        if (cleaned.length > 0) blocks.push(tBlock(id, cleaned, includeEntryId));
        break;
      }
      case "toolCall": {
        emitToolCallPair(part, id, cap, includeEntryId, resultByCallId, consumedResultIds, blocks);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function emitToolCallPair(
  call: ToolCall,
  callEntryId: string,
  cap: number | null,
  includeEntryId: boolean,
  resultByCallId: Map<string, SessionMessageEntry>,
  consumedResultIds: Set<string>,
  blocks: RenderBlock[],
): void {
  // args are structured JSON (not free text) — capped but not ANSI-stripped
  const argsText = capBlock(JSON.stringify(call.arguments), cap);
  blocks.push(cBlock(callEntryId, call.name, argsText, includeEntryId));

  const resultEntry = resultByCallId.get(call.id);
  if (resultEntry === undefined) return; // orphan call (result absent mid-stream)
  const result = resultEntry.message;
  if (typeof result !== "object" || result === null || result.role !== "toolResult") return;
  const resultText = capBlock(cleanText(result.content), cap);
  blocks.push(rBlock(resultEntry.id, resultText, result.isError, includeEntryId));
  consumedResultIds.add(resultEntry.id);
}

// --- chunk splitting (entry-bounded) --------------------------------------

/**
 * Split entries into entry-bounded, token-gated chunks. A whole entry (its group)
 * is never split across chunks. Each chunk reports `allowedIds`: the entry ids
 * cited in its blocks, + `firstEntryId`/`lastEntryId` (the coverage range).
 */
/** Render EVERY renderable entry as one contiguous transcript text (no chunking,
 *  no token gating) — the user-simulator's per-cycle input. The simulator is a
 *  REAL session participant: it sees the whole conversation from the start (its
 *  own messages + all agent work) every call — append-only growth keeps the
 *  request prefix stable (provider prefix-cache friendly). Deterministic per
 *  entry, so successive cycles extend the prefix byte-stably. */
export function renderFullTranscript(entries: readonly SessionEntry[], options: ChunkOptions): string {
  const groups = renderGroups(entries, options);
  const blocks = groups.flatMap((g) => g.blocks);
  return blocks.map((b) => b.text).join(BLOCK_SEP);
}
