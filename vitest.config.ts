// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    isolate: false,
    // Centralized module-singleton resets between tests (settings handle/seam,
    // logger, run-state globalThis) — the isolate:false leak fix, mirroring the
    // sibling-repo setupFiles pattern (avtc-pi-session-owl / avtc-pi-portrait).
    setupFiles: ["./tests/setup.ts"],
    // Real-git + temp-dir suites (storage/repo, latent-stage purge, phase-1 bases)
    // pay a fixed cost that grows with full-suite worker load — a 5s default turned
    // that into intermittent red gates. The sibling repos (session-owl, portrait)
    // run the same 30s cap; it is a ceiling, fast suites still finish in ms.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Pin the test process to UTC so LOCAL-time renders (timestamps render in
    // the host timezone) are deterministic: stored UTC instants render their
    // UTC clock values. Production is unaffected (no pin) — real users get
    // their own timezone. Node 26 respects TZ on this platform.
    env: { TZ: "UTC" },
  },
});
