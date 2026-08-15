// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  _resetState,
  subscribeToDialogCoordinator,
} from "../../src/snippets/vendored/subscribe-to-dialog-coordinator.js";
import {
  _resetNotificationState,
  subscribeToNotificationApi,
} from "../../src/snippets/vendored/subscribe-to-notifications.js";
import { type AskUi, askOperator } from "../../src/ui/ask.js";

/** Event-bus fake: pi.events.on registers named handlers we can fire manually. */
function fakePi(): {
  pi: ExtensionAPI;
  fire: (event: string, data: unknown) => void;
} {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    events: {
      on: (event: string, handler: (data: unknown) => void): (() => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((h) => h !== handler),
          );
        };
      },
    },
    on: (_event: string, _handler: (data: unknown) => void) => {},
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire: (event, data) => {
      for (const h of handlers.get(event) ?? []) h(data);
    },
  };
}

function fakeUi(answer: string | undefined): { ui: AskUi; calls: { title: string; options: string[] }[] } {
  const calls: { title: string; options: string[] }[] = [];
  const ui: AskUi = {
    select: async (title, options) => {
      calls.push({ title, options });
      return answer;
    },
  };
  return { ui, calls };
}

describe("askOperator", () => {
  it("asks via ui.select and returns the choice (no coordinator/notification → direct)", async () => {
    _resetState();
    _resetNotificationState();
    const { ui, calls } = fakeUi("option-b");
    const choice = await askOperator(ui, {
      source: "bench-compact",
      detail: "condition topics did not land",
      title: "Prepare surfaced",
      options: ["plant", "start over"],
    });
    expect(choice).toBe("option-b");
    expect(calls).toEqual([{ title: "Prepare surfaced", options: ["plant", "start over"] }]);
  });

  it("coordinates + attends when both extensions are live (full wiring chain)", async () => {
    _resetState();
    _resetNotificationState();
    const { pi, fire } = fakePi();
    subscribeToNotificationApi(pi);
    subscribeToDialogCoordinator(pi);
    const attended: string[] = [];
    fire("pi-notification:ready", {
      requestAttention: (source: string, detail: string) => {
        attended.push(`${source}:${detail}`);
        return () => attended.push("cancelled");
      },
    });
    const enqueued: number[] = [];
    fire("dialog-coordinator:ready", {
      coordinator: {
        enqueueOrShow: async <T>(fn: () => Promise<T>): Promise<T> => {
          enqueued.push(1);
          return fn();
        },
      },
    });
    const { ui, calls } = fakeUi("proceed");
    const choice = await askOperator(ui, {
      source: "bench-compact",
      detail: "missing topics",
      title: "Prepare surfaced",
      options: ["proceed", "stop"],
    });
    expect(choice).toBe("proceed");
    expect(enqueued).toHaveLength(1); // serialized through the dialog queue
    expect(attended).toContain("bench-compact:missing topics"); // attention pinged
    expect(attended).toContain("cancelled"); // cancelled after the dialog resolved
    expect(calls).toHaveLength(1);
  });
});
