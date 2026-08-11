// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveBenchModel } from "../../src/runtime/model.js";

/** Build a fake ExtensionContext with a controllable modelRegistry + session model. */
function fakeCtx(opts: {
  find?: (provider: string, id: string) => unknown;
  auth?: (model: unknown) => { ok: true; apiKey: string | undefined } | { ok: false; error: string };
  model?: unknown;
}): ExtensionContext {
  return {
    model: opts.model,
    modelRegistry: {
      find: opts.find ?? (() => undefined),
      getApiKeyAndHeaders: opts.auth ?? (() => ({ ok: true, apiKey: "default-key" })),
    },
  } as unknown as ExtensionContext;
}

const STUB_MODEL = { id: "zai/glm-4.6", provider: "zai" };

describe("resolveBenchModel", () => {
  it("resolves a provider/id via the registry + api key", async () => {
    const ctx = fakeCtx({
      find: () => STUB_MODEL,
      auth: () => ({ ok: true, apiKey: "secret" }),
    });
    const r = await resolveBenchModel(ctx, "zai/glm-4.6");
    expect(r).toEqual({ ok: true, model: STUB_MODEL, apiKey: "secret" });
  });

  it("rejects a model string with no provider/id slash", async () => {
    const r = await resolveBenchModel(fakeCtx({}), "just-an-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/provider\/id/i);
  });

  it("rejects an empty provider or id", async () => {
    expect((await resolveBenchModel(fakeCtx({}), "/glm")).ok).toBe(false);
    expect((await resolveBenchModel(fakeCtx({}), "zai/")).ok).toBe(false);
  });

  it("returns {ok:false} for an unknown model (registry miss)", async () => {
    const r = await resolveBenchModel(fakeCtx({ find: () => undefined }), "zai/missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not available/i);
  });

  it("falls through to ctx.model when modelSetting is null", async () => {
    const ctx = fakeCtx({ model: STUB_MODEL, auth: () => ({ ok: true, apiKey: "ctx-key" }) });
    const r = await resolveBenchModel(ctx, null);
    expect(r).toEqual({ ok: true, model: STUB_MODEL, apiKey: "ctx-key" });
  });

  it("rejects when modelSetting is null but no session model is configured", async () => {
    const r = await resolveBenchModel(fakeCtx({ model: undefined }), null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no model configured/i);
  });

  it("propagates the api-key resolution failure", async () => {
    const ctx = fakeCtx({ find: () => STUB_MODEL, auth: () => ({ ok: false, error: "no api key for zai" }) });
    const r = await resolveBenchModel(ctx, "zai/glm-4.6");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no api key/i);
  });
});
