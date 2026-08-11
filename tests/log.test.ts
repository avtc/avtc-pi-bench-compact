// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, describe, expect, it, vi } from "vitest";
import { _setBaseLoggerForTest, type LogSink, log } from "../src/log.js";

function fakeSink(): LogSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("log", () => {
  afterEach(() => {
    // restore the real sink between tests
    _setBaseLoggerForTest(null);
  });

  it("info/warn/error always delegate to the sink", () => {
    const sink = fakeSink();
    _setBaseLoggerForTest(sink);

    log.info("an info");
    log.warn("a warn");
    log.error("an error", new Error("boom"));

    expect(sink.info).toHaveBeenCalledWith("an info");
    expect(sink.warn).toHaveBeenCalledWith("a warn");
    expect(sink.error).toHaveBeenCalledWith("an error", expect.any(Error));
  });

  it("error delegates with null when no cause is given", () => {
    const sink = fakeSink();
    _setBaseLoggerForTest(sink);

    log.error("no cause");

    expect(sink.error).toHaveBeenCalledWith("no cause", null);
  });

  it("debug does NOT delegate when BENCH_COMPACT_DEBUG is unset (gate)", () => {
    const sink = fakeSink();
    _setBaseLoggerForTest(sink);

    log.debug("should be gated");

    expect(sink.debug).not.toHaveBeenCalled();
  });
});
