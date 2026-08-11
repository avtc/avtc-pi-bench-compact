// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Persists the full run config (the run-condition fingerprint) at `configs/<cfgId>.json` —
// the single source of truth that makes runs comparable (one model vs another, one tool version vs
// another). The path is structurally under `<root>/configs/`, a sibling of `scenarios/`, so a
// config can never land inside a scenario repo (the agent's cwd) — the contamination rule holds by
// construction. Callers that mix repo + bench paths use `assertNotInRepo` (paths.ts) defensively.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunConfig } from "./branches.js";
import { configPath } from "./paths.js";

/** Write the full run config for `cfgId` under `<root>/configs/<cfgId>.json`. Returns the path. */
export function writeRunConfig(cfgId: string, rc: RunConfig, root: string): string {
  const file = configPath(root, cfgId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rc, null, 2)}\n`, "utf8");
  return file;
}
