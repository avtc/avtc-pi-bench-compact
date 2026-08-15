// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** `ask` — ask the operator a blocking question, coordinating with the other
 *  operator-facing extensions:
 *  - **Dialog coordination** (avtc-pi-ui-components): the question is serialized
 *    through the shared dialog queue — it waits behind any open modal instead of
 *    stealing focus (`withCoordinator`, vendored snippet).
 *  - **Attention** (avtc-pi-notification): a notification fires while the question
 *    blocks, so an away-from-keyboard operator is pinged (`withAttention`, vendored
 *    snippet). No-op when either extension is absent.
 *
 *  All call-site strings (title/options/detail) are protected text. */

import { withCoordinator } from "../snippets/vendored/subscribe-to-dialog-coordinator.js";
import { withAttention } from "../snippets/vendored/subscribe-to-notifications.js";

/** The `ctx.ui` surface `askOperator` needs (satisfied by ExtensionUIContext). */
export interface AskUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** What to ask. Every field is required — callers state their question fully. */
export interface AskOperatorArgs {
  /** Attention source label (e.g. `"bench-compact"`). */
  readonly source: string;
  /** Attention detail — one line naming WHAT is being asked (shown in the notification). */
  readonly detail: string;
  /** Dialog title. */
  readonly title: string;
  /** Selectable answers, in display order. */
  readonly options: readonly string[];
}

/** Ask the operator a blocking question: coordinated dialog + attention ping.
 *  Resolves with the chosen option, or `undefined` when dismissed. */
export async function askOperator(ui: AskUi, args: AskOperatorArgs): Promise<string | undefined> {
  return withCoordinator(() => withAttention(args.source, args.detail, () => ui.select(args.title, [...args.options])));
}
