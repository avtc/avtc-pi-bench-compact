// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import { getActiveWidget, hideActiveWidget, setActiveWidget, type WidgetPort } from "../../src/widget/active-widget.js";

/** A capturing WidgetPort: records every method call. */
function capturingWidget(): WidgetPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    show: () => {
      calls.push("show");
    },
    startPhase: (phase, detail) => {
      calls.push(`startPhase:${phase}:${detail ?? "-"}`);
    },
    setStatus: (status, hint) => {
      calls.push(`setStatus:${status}:${hint ?? "-"}`);
    },
    hide: () => {
      calls.push("hide");
    },
  };
}

describe("active-widget", () => {
  it("setActiveWidget stores the widget; getActiveWidget returns it", () => {
    const w = capturingWidget();
    setActiveWidget(w);
    expect(getActiveWidget()).toBe(w);
  });

  it("hideActiveWidget calls hide() on the active widget", () => {
    const w = capturingWidget();
    setActiveWidget(w);
    hideActiveWidget();
    expect(w.calls).toContain("hide");
  });

  it("hideActiveWidget is a no-op when no widget is active (does not throw)", () => {
    setActiveWidget(null);
    expect(() => hideActiveWidget()).not.toThrow();
  });

  it("setActiveWidget(null) clears the ref", () => {
    const w = capturingWidget();
    setActiveWidget(w);
    setActiveWidget(null);
    expect(getActiveWidget()).toBeNull();
  });

  it("a second setActiveWidget replaces the prior widget", () => {
    const w1 = capturingWidget();
    const w2 = capturingWidget();
    setActiveWidget(w1);
    setActiveWidget(w2);
    expect(getActiveWidget()).toBe(w2);
    hideActiveWidget();
    expect(w2.calls).toContain("hide");
    expect(w1.calls).not.toContain("hide"); // prior widget untouched
  });
});
