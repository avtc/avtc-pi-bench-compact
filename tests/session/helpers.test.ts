// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Contract tests for the shared session-test fakes (tests/session/helpers.ts). These
// enforce that the fakes match the REAL pi dispatch semantics the SUT exercises:
// snapshot dispatch so a listener that guards ITSELF off during dispatch (the
// `once` pattern — pi.on offers no removal, so one-shot listeners self-guard) does
// not skip later listeners — matching how the extension runner iterates a copied
// handler list + AbortSignal's removeEventListener for the signal case.

import { describe, expect, it } from "vitest";
import { fakeBus, fakeSignal } from "./helpers.js";

describe("fakeBus.emit — snapshot dispatch (matches the extension runner)", () => {
  it("a self-guarding listener during emit does NOT skip later listeners", () => {
    const { pi, emit } = fakeBus();
    const fired: string[] = [];
    // first listener self-guards during emit (like `once` does internally — the
    // registration stays; only the guard flag flips)
    let guarded = false;
    pi.on("turn_end", () => {
      if (guarded) return;
      guarded = true;
      fired.push("A");
    });
    pi.on("turn_end", () => {
      fired.push("B");
    });
    emit("turn_end", null);
    expect(fired).toEqual(["A", "B"]); // both fire (snapshot, not live-array iteration)
  });
});

describe("fakeSignal.abort — snapshot dispatch (matches AbortSignal)", () => {
  it("a self-removing listener during abort does NOT skip later listeners", () => {
    const signal = fakeSignal();
    const fired: string[] = [];
    const a = () => {
      fired.push("A");
      signal.removeEventListener("abort", a);
    };
    signal.addEventListener("abort", a);
    signal.addEventListener("abort", () => fired.push("B"));
    signal.abort();
    expect(fired).toEqual(["A", "B"]);
  });
});
