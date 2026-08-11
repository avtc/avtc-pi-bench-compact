// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Pin the test process to UTC so any LOCAL-time renders are deterministic
    // (timestamps render in the host timezone). Production is unaffected.
    //
    // NOTE: `isolate: false` (memkeeper's perf + centralized-reset pattern) is
    // NOT set yet — it is paired with a `setupFiles` reset of module singletons
    // (e.g. the bench config singleton introduced in Task 2). Adding isolate:false
    // without that reset is a latent cross-test state leak. Default isolation is
    // safe; Task 2 introduces the full pattern together.
    env: { TZ: "UTC" },
  },
});
