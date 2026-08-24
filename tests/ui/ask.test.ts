// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  _resetState,
  subscribeToDialogCoordinator,
} from "../../src/snippets/vendored/subscribe-to-dialog-coordinator.js";
import {
  _resetNotificationState,
  subscribeToNotificationApi,
} from "../../src/snippets/vendored/subscribe-to-notifications.js";
import { type AskUi, askOperator } from "../../src/ui/ask.js";
import { _resetStageClocks, pushStageClock } from "../../src/ui/operator-wait.js";

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

function fakeUi(answer: string | undefined): {
  ui: AskUi;
  calls: { title: string; options: string[]; opts?: { signal?: AbortSignal } }[];
} {
  const calls: { title: string; options: string[]; opts?: { signal?: AbortSignal } }[] = [];
  const ui: AskUi = {
    select: async (title, options, opts) => {
      calls.push({ title, options, opts });
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
      signal: null,
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
      signal: null,
    });
    expect(choice).toBe("proceed");
    expect(enqueued).toHaveLength(1); // serialized through the dialog queue
    expect(attended).toContain("bench-compact:missing topics"); // attention pinged
    expect(attended).toContain("cancelled"); // cancelled after the dialog resolved
    expect(calls).toHaveLength(1);
  });

  it("pauses the active stage's clock while the dialog is open and resumes it after", async () => {
    _resetState();
    _resetNotificationState();
    _resetStageClocks();
    const order: string[] = [];
    const unregister = pushStageClock({
      pause: (): void => {
        order.push("pause");
      },
      resume: (): void => {
        order.push("resume");
      },
    });
    const ui: AskUi = {
      select: async () => {
        order.push("select");
        return "x";
      },
    };
    await askOperator(ui, { source: "s", detail: "d", title: "t", options: ["x"], signal: null });
    expect(order).toEqual(["pause", "select", "resume"]);
    unregister();
  });

  it("forwards a non-null abort signal to ui.select; null passes no opts", async () => {
    _resetState();
    _resetNotificationState();
    _resetStageClocks();
    const { ui, calls } = fakeUi("x");
    const ac = new AbortController();
    await askOperator(ui, { source: "s", detail: "d", title: "t", options: ["x"], signal: ac.signal });
    expect(calls[0]?.opts).toEqual({ signal: ac.signal });
    await askOperator(ui, { source: "s", detail: "d", title: "t", options: ["x"], signal: null });
    expect(calls[1]?.opts).toBeUndefined();
  });

  it("a dialog with no active stage (registry empty) asks directly", async () => {
    _resetState();
    _resetNotificationState();
    _resetStageClocks();
    const { ui, calls } = fakeUi("y");
    const choice = await askOperator(ui, { source: "s", detail: "d", title: "t", options: ["y"], signal: null });
    expect(choice).toBe("y");
    expect(calls).toHaveLength(1);
  });
});
