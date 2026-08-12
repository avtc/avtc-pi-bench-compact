// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { elideMiddle, fitLine, joinSegments, type Segment } from "../../src/widget/fitline.js";

describe("elideMiddle", () => {
  it("returns the text unchanged when it fits", () => {
    expect(elideMiddle("hello", 10)).toBe("hello");
    expect(elideMiddle("hello", 5)).toBe("hello");
  });
  it("middle-elides to head + … + tail when too long", () => {
    expect(elideMiddle("memkeeper-builder-selector", 12)).toMatch(/^m.+r$/);
    expect(elideMiddle("memkeeper-builder-selector", 12)).toContain("…");
  });
  it("returns empty for maxLen<=0 (never overflows); ellipsis for maxLen==1", () => {
    expect(elideMiddle("anything", 0)).toBe("");
    expect(elideMiddle("anything", -3)).toBe("");
    expect(elideMiddle("anything", 1)).toBe("…");
  });
});

describe("joinSegments", () => {
  it("joins segments with ' · ' (no leading separator)", () => {
    expect(joinSegments(["a", "b", "c"])).toBe("a · b · c");
    expect(joinSegments(["solo"])).toBe("solo");
    expect(joinSegments([])).toBe("");
  });

  it("renders elastic segments as prefix+tail", () => {
    expect(joinSegments([{ prefix: "x=", tail: "y" }])).toBe("x=y");
    expect(joinSegments(["pre", { prefix: "", tail: "elastic" }])).toBe("pre · elastic");
  });
});

describe("fitLine", () => {
  it("joins segments with ' · ' and passes through when it fits", () => {
    const segs: Segment[] = ["🅑", "◧□□□□", "build", "ctx 142K/200K"];
    expect(fitLine(segs, 200)).toBe("🅑 · ◧□□□□ · build · ctx 142K/200K");
  });

  it("leaves fixed-only segments untouched at any width (no elastic to trim)", () => {
    const segs: Segment[] = ["a", "bb", "ccc"];
    expect(fitLine(segs, 5)).toBe("a · bb · ccc"); // no elastic → not trimmed even if overflow
  });

  it("middle-elides the elastic tail when the assembled line overflows", () => {
    // fixed prefix + elastic tail that's far too long for a narrow terminal.
    const segs: Segment[] = ["🅑 1/5", { prefix: "", tail: "memkeeper-builder-very-long-tool-name" }, "◧□□□□ resume"];
    const out = fitLine(segs, 30);
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(30);
    // fixed segments survive (never shortened).
    expect(out).toContain("🅑 1/5");
    expect(out).toContain("resume");
  });

  it("keeps the elastic segment's fixed prefix when eliding its tail", () => {
    const segs: Segment[] = ["pre", { prefix: "tool=", tail: "memkeeper-builder-selector-xyz" }, "post"];
    const out = fitLine(segs, 24);
    expect(out).toContain("tool=");
    expect(out).toContain("…");
    expect(out).toContain("pre");
    expect(out).toContain("post");
  });

  it("distributes width across multiple elastic tails proportionally", () => {
    const segs: Segment[] = [
      { prefix: "", tail: "aaaaaaaaaa" },
      { prefix: "", tail: "bbbbbbbbbb" },
    ];
    const out = fitLine(segs, 15); // 2 elastic + 1 sep(3) = need elision
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(15);
  });
});
