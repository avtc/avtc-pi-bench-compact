// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Pin the test process to UTC so any LOCAL-time renders are deterministic
    // (timestamps render in the host timezone). Production is unaffected.
    isolate: false,
    env: { TZ: "UTC" },
  },
});
