// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Contract tests for the shared session-test fakes (tests/session/helpers.ts). These
// enforce that the fakes match the REAL pi/Node dispatch semantics the SUT relies on
// (snapshot dispatch — a listener that removes itself or a sibling during dispatch must
// not cause later listeners to be skipped, matching Node EventEmitter + AbortSignal).

import { describe, expect, it } from "vitest";
import { fakeBus, fakeSignal } from "./helpers.js";

describe("fakeBus.emit — snapshot dispatch (matches Node EventEmitter)", () => {
  it("a self-removing listener during emit does NOT skip later listeners", () => {
    const { pi, emit } = fakeBus();
    const fired: string[] = [];
    // first listener self-removes during emit (like `once` does internally)
    const disposeFirst = pi.events.on("ch", () => {
      fired.push("A");
      disposeFirst();
    });
    pi.events.on("ch", () => fired.push("B"));
    emit("ch", null);
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
