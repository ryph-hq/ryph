// OpenRouter as a built-in: its model list turned into catalogue rows, the sync that keeps them,
// the admin's enabled set, a key's live credit read, and the provider list that offers the
// enabled models. OpenRouter itself is a fake (tests/fake_openrouter.ts) throughout.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { Route } from "@ryph/shared/http";
import { unauthorized } from "@ryph/sealed";
import { forbidden } from "@ryph/auth";
import { catalogueOf, OPENROUTER, openRouterModelForRun } from "../src/core/openrouter.ts";
import { makeOpenRouterCatalogue } from "../src/core/openrouter_catalogue.ts";
import { openRouterApi } from "../src/adapters/openrouter/api.ts";
import { OpenRouterApiError } from "../src/ports/openrouter_api.ts";
import { openRouterRoutes } from "../src/http/openrouter.ts";
import { disabledProviderKeyRoutes, providerKeyRoutes } from "../src/http/routes.ts";
import { listProviderSpecs } from "../src/core/service.ts";
import { toPublicProviderSpec } from "../src/core/registry.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { fakeOpenRouter, KEY_INFO, listedModel, MODELS_BODY } from "./fake_openrouter.ts";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const quiet = { debug() {}, warn() {} };

// ── the model list as rows ──────────────────────────────────────────────────────────────────

test("catalogueOf: prices per million, flags from the parameters, routers left out", () => {
  const rows = catalogueOf(MODELS_BODY);
  assertEquals(rows.map((r) => r.id), [
    "anthropic/claude-sonnet-5",
    "openai/gpt-6",
    "acme/no-tools",
  ]);
  const [sonnet, gpt, noTools] = rows;
  // Per-token strings × 1e6, without the floating-point tail.
  assertEquals(sonnet.price, { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
  assertEquals(gpt.price, { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 });
  assertEquals(sonnet.label, "Model anthropic/claude-sonnet-5");
  assertEquals([sonnet.tools, sonnet.reasoning, sonnet.vision], [true, false, false]);
  assertEquals([gpt.tools, gpt.reasoning, gpt.vision], [true, true, true]);
  assertEquals(noTools.tools, false);
  assertEquals(sonnet.rawPricing, { prompt: "0.000003", completion: "0.000015", request: "0" });
});

test("catalogueOf: a price of -1 or one that is no number is unpriced, never free", () => {
  const rows = catalogueOf({
    data: [
      listedModel("a/minus", { pricing: { prompt: "-1", completion: "0.00001" } }),
      listedModel("b/garbage", { pricing: { prompt: "abc", completion: "0.00001" } }),
      listedModel("c/missing", { pricing: { prompt: "0.000001" } }),
      listedModel("d/free", { pricing: { prompt: "0", completion: "0" } }),
    ],
  });
  assertEquals(rows.map((r) => r.price), [
    null,
    null,
    null,
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test("catalogueOf: the output cap is the top provider's, at most 64k and half the context", () => {
  const capOf = (over: Record<string, unknown>) =>
    catalogueOf({ data: [listedModel("x/y", over)] })[0];
  assertEquals(capOf({}).maxOutputTokens, 32_000);
  assertEquals(
    capOf({ top_provider: { max_completion_tokens: 200_000 } }).maxOutputTokens,
    65_536,
  );
  assertEquals(
    capOf({ context_length: 16_000, top_provider: { max_completion_tokens: 16_000 } })
      .maxOutputTokens,
    8_000,
  );
  // OpenRouter says nothing: a modest default, still under half the context.
  assertEquals(capOf({ top_provider: { max_completion_tokens: null } }).maxOutputTokens, 16_384);
  assertEquals(capOf({ top_provider: null, context_length: 8_000 }).maxOutputTokens, 4_000);
});

test("catalogueOf: skips what it cannot describe instead of failing the sync", () => {
  assertEquals(catalogueOf(null), []);
  assertEquals(catalogueOf({ data: "no" }), []);
  const rows = catalogueOf({
    data: [
      { name: "no id" },
      listedModel("no/context", { context_length: null }),
      listedModel("has space"),
      listedModel("openrouter/free"),
      listedModel("dup/one"),
      listedModel("dup/one", { name: "the second" }),
      "not an object",
    ],
  });
  assertEquals(rows.map((r) => [r.id, r.label]), [["dup/one", "Model dup/one"]]);
});

test("openRouterModelForRun: tells pi the thinking format, the cap and the price", () => {
  const [, gpt] = catalogueOf(MODELS_BODY);
  assertEquals(openRouterModelForRun(gpt), {
    id: "openai/gpt-6",
    label: "Model openai/gpt-6",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    vision: true,
    compat: { thinkingFormat: "openrouter" },
    price: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
  });
  const unpriced = openRouterModelForRun({ ...gpt, price: null });
  assert(!("price" in unpriced));
});

// ── the HTTP adapter, over a fake fetch ─────────────────────────────────────────────────────

test("the adapter asks openrouter.ai's two routes with the attribution headers", async () => {
  const seen: Array<{ url: string; headers: Headers; redirect?: string }> = [];
  const api = openRouterApi({
    baseUrl: "https://openrouter.test/api/v1/",
    fetch: ((url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
      if (url.endsWith("/models")) return Promise.resolve(Response.json(MODELS_BODY));
      const auth = new Headers(init.headers).get("authorization");
      if (auth !== "Bearer sk-or-good") return Promise.resolve(new Response("no", { status: 401 }));
      return Promise.resolve(Response.json({
        data: { label: "x", limit: null, limit_remaining: null, usage: 1.25, is_free_tier: true },
      }));
    }) as typeof fetch,
  });
  assertEquals(await api.listModels(), MODELS_BODY);
  assertEquals(await api.keyInfo("sk-or-good"), {
    limit: null,
    limitRemaining: null,
    usage: 1.25,
    isFreeTier: true,
  });
  assertEquals(seen.map((s) => s.url), [
    "https://openrouter.test/api/v1/models",
    "https://openrouter.test/api/v1/key",
  ]);
  // The model list needs no key, and none is sent with it.
  assertEquals(seen[0].headers.get("authorization"), null);
  assertEquals(seen[0].headers.get("x-title"), "ryph");
  assertEquals(seen[0].headers.get("http-referer"), "https://ryph.ai");
  assertEquals(seen[1].redirect, "manual");

  const refused = await api.keyInfo("sk-or-bad").catch((err) => err);
  assert(refused instanceof OpenRouterApiError);
  assertEquals(refused.status, 401);
  assert(!refused.message.includes("sk-or-bad"), "the key never lands in a message");

  const down = openRouterApi({
    fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
  });
  const unreachable = await down.listModels().catch((err) => err);
  assert(unreachable instanceof OpenRouterApiError);
  assertEquals(unreachable.status, null);
});

// ── the sync ────────────────────────────────────────────────────────────────────────────────

test("a sync writes the catalogue; a failed one keeps it and says why", async () => {
  const store = memoryKeyStore();
  const api = fakeOpenRouter();
  let now = NOW;
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => now, diag: quiet });

  const first = await catalogue.sync();
  assertEquals(first, {
    syncedAt: NOW.toISOString(),
    attemptedAt: NOW.toISOString(),
    error: null,
  });
  assertEquals((await store.listOpenRouterModels()).length, 3);

  now = new Date(NOW.getTime() + 60_000);
  api.models = new OpenRouterApiError("OpenRouter answered 503 for its model list", 503);
  const failed = await catalogue.sync();
  assertEquals(failed.syncedAt, NOW.toISOString(), "the last good sync is kept");
  assertEquals(failed.attemptedAt, now.toISOString());
  assertEquals(failed.error, "OpenRouter answered 503 for its model list");
  assertEquals((await store.listOpenRouterModels()).every((m) => m.listed), true);

  // An empty list is a failure too: it would unlist every model.
  api.models = { data: [] };
  assert((await catalogue.sync()).error !== null);
  assertEquals((await store.listOpenRouterModels()).every((m) => m.listed), true);
});

test("syncs run one at a time, and a stale check syncs only when it should", async () => {
  const store = memoryKeyStore();
  const api = fakeOpenRouter();
  let now = NOW;
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => now, diag: quiet });

  await Promise.all([catalogue.sync(), catalogue.sync(), catalogue.syncIfStale()]);
  assertEquals(api.calls.models, 1);

  await catalogue.syncIfStale();
  assertEquals(api.calls.models, 1, "fresh");
  now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  await catalogue.syncIfStale();
  assertEquals(api.calls.models, 2, "a day old");

  // A failed attempt is not retried by every read: five minutes pass first.
  api.models = new Error("down");
  now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  await catalogue.syncIfStale();
  await catalogue.syncIfStale();
  assertEquals(api.calls.models, 3);
  now = new Date(now.getTime() + 6 * 60 * 1000);
  await catalogue.syncIfStale();
  assertEquals(api.calls.models, 4);
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────

const ADMIN = "admin-secret";
const USER = "user-secret";

function makeApi(opts: { store?: KeyStore; api?: ReturnType<typeof fakeOpenRouter> } = {}) {
  const store = opts.store ?? memoryKeyStore();
  const api = opts.api ?? fakeOpenRouter();
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => NOW, diag: quiet });
  const gate = (req: Request, adminsOnly: boolean): Response | null => {
    const presented = req.headers.get("authorization");
    if (presented === `Bearer ${ADMIN}`) return null;
    if (presented === `Bearer ${USER}`) {
      return adminsOnly
        ? new Response(JSON.stringify(forbidden("models:manage")), { status: 403 })
        : null;
    }
    return unauthorized();
  };
  const authenticate = (req: Request) => Promise.resolve(gate(req, false));
  const authenticateManage = (req: Request) => Promise.resolve(gate(req, true));
  const routes: Route[] = [
    ...providerKeyRoutes({
      store,
      encrypt: (plaintext) => Promise.resolve(`sealed:${plaintext}`),
      authenticate,
      authenticateManage,
      now: () => NOW,
      openRouter: { api, catalogue, diag: quiet },
    }),
    ...openRouterRoutes({
      store,
      catalogue,
      api,
      decrypt: (sealed) => Promise.resolve(sealed.replace(/^sealed:/, "")),
      authenticate,
      authenticateManage,
      now: () => NOW,
      diag: quiet,
    }),
  ];
  const handler = async (req: Request): Promise<Response> => {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = value;
      }
      return await r.handler(req, params);
    }
    return new Response("not found", { status: 404 });
  };
  const call = (method: string, path: string, body?: unknown, token: string = ADMIN) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, store, api, catalogue };
}

test("the catalogue routes are the admin's, and the enabled set is held to the catalogue", async () => {
  const { call, catalogue } = makeApi();
  await catalogue.sync();

  assertEquals((await call("GET", "/v1/openrouter/models", undefined, USER)).status, 403);
  assertEquals((await call("GET", "/v1/openrouter/models", undefined, "")).status, 401);
  assertEquals((await call("PUT", "/v1/openrouter/models/enabled", { ids: [] }, USER)).status, 403);
  assertEquals((await call("POST", "/v1/openrouter/sync", undefined, USER)).status, 403);

  const listed = await call("GET", "/v1/openrouter/models");
  assertEquals(listed.status, 200);
  const body = await listed.json();
  assertEquals(body.models.length, 3);
  assertEquals(body.sync, {
    syncedAt: NOW.toISOString(),
    attemptedAt: NOW.toISOString(),
    error: null,
    syncing: false,
  });
  assert(!("rawPricing" in body.models[0]));

  const refused = await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["anthropic/claude-sonnet-5", "acme/no-tools", "nope/never", "openrouter/auto"],
  });
  assertEquals(refused.status, 400);
  const why = await refused.json();
  assertEquals(why.unknown, ["nope/never", "openrouter/auto"]);
  assertEquals(why.noTools, ["acme/no-tools"]);

  const set = await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["openai/gpt-6", "anthropic/claude-sonnet-5", "openai/gpt-6"],
  });
  assertEquals(set.status, 200);
  assertEquals(
    (await set.json()).models.filter((m: { enabled: boolean }) => m.enabled)
      .map((m: { id: string }) => m.id),
    ["anthropic/claude-sonnet-5", "openai/gpt-6"],
  );
});

test("an unlisted model cannot be enabled again, but an enabled one stays in the picker", async () => {
  const { call, catalogue, api } = makeApi();
  await catalogue.sync();
  await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  api.models = { data: [listedModel("anthropic/claude-sonnet-5")] };
  await catalogue.sync();

  const models = (await (await call("GET", "/v1/openrouter/models")).json()).models;
  assertEquals(models.map((m: { id: string; listed: boolean }) => [m.id, m.listed]), [
    ["anthropic/claude-sonnet-5", true],
    ["openai/gpt-6", false],
  ]);
  const refused = await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).unlisted, ["openai/gpt-6"]);
});

test("Sync now answers the catalogue, or a 502 that says why and keeps it", async () => {
  const { call, api } = makeApi();
  const synced = await call("POST", "/v1/openrouter/sync");
  assertEquals(synced.status, 200);
  assertEquals((await synced.json()).models.length, 3);

  api.models = new OpenRouterApiError("OpenRouter answered 500 for its model list", 500);
  const failed = await call("POST", "/v1/openrouter/sync");
  assertEquals(failed.status, 502);
  const body = await failed.json();
  assert(body.error.includes("OpenRouter answered 500"));
  assertEquals(body.models.length, 3, "the last catalogue stands");
  assertEquals(body.sync.error, "OpenRouter answered 500 for its model list");
});

test("the provider list offers OpenRouter's enabled, listed models with their prices", async () => {
  const { call, store, catalogue } = makeApi();
  await catalogue.sync();
  await store.setOpenRouterEnabled(["openai/gpt-6", "acme/no-tools"], NOW.toISOString());

  const providers = (await (await call("GET", "/v1/providers", undefined, USER)).json()).providers;
  const openrouter = providers.find((p: { id: string }) => p.id === OPENROUTER);
  assertEquals(openrouter.builtin, true);
  assertEquals(openrouter.dialect, "openai-completions");
  assertEquals(openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assertEquals(openrouter.models.map((m: { id: string }) => m.id), [
    "acme/no-tools",
    "openai/gpt-6",
  ]);
  assertEquals(openrouter.models[1].compat, { thinkingFormat: "openrouter" });
  assertEquals(openrouter.models[1].price.input, 2.5);
  assert(!("extraHeaders" in openrouter), "the list never carries static headers");

  // A model OpenRouter stopped listing drops out of what agents are offered.
  const specs = await listProviderSpecs(store, { planOn: false });
  assertEquals(
    toPublicProviderSpec(specs.find((s) => s.id === OPENROUTER)!).models.length,
    2,
  );
});

test("the provider list syncs a stale catalogue in the background, only with a live key", async () => {
  const { call, store, api } = makeApi();
  await call("GET", "/v1/providers", undefined, USER);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(api.calls.models, 0, "no OpenRouter key, no call to OpenRouter");

  await store.createProviderKey({
    id: "pk-or",
    provider: OPENROUTER,
    label: "or",
    last4: "abcd",
    encryptedSecret: "sealed:sk-or-v1-abcd",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await call("GET", "/v1/providers", undefined, USER);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(api.calls.models, 1);
  await call("GET", "/v1/providers", undefined, USER);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(api.calls.models, 1, "fresh now");
});

test("a key's credit is read live with the key itself, and refusals say which kind", async () => {
  const { call, store, api } = makeApi();
  const at = NOW.toISOString();
  const key = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    provider: OPENROUTER,
    label: id,
    last4: "abcd",
    encryptedSecret: `sealed:sk-or-${id}`,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  });
  await store.createProviderKey(key("good"));
  await store.createProviderKey(key("bad"));
  await store.createProviderKey(key("down"));
  await store.createProviderKey(key("cleared", { encryptedSecret: "" }));
  await store.createProviderKey({ ...key("anth"), provider: "anthropic" });
  api.keys.set("sk-or-good", KEY_INFO);
  api.keys.set("sk-or-down", new OpenRouterApiError("could not reach", null));

  const good = await call("GET", "/v1/provider-keys/good/openrouter", undefined, USER);
  assertEquals(good.status, 200);
  assertEquals(await good.json(), KEY_INFO);
  assertEquals(api.calls.keys, ["sk-or-good"]);

  const bad = await call("GET", "/v1/provider-keys/bad/openrouter");
  assertEquals(bad.status, 502);
  assertEquals((await bad.json()).error, "OpenRouter didn't accept this key");
  assertEquals((await call("GET", "/v1/provider-keys/down/openrouter")).status, 503);
  assertEquals((await call("GET", "/v1/provider-keys/cleared/openrouter")).status, 409);
  assertEquals((await call("GET", "/v1/provider-keys/anth/openrouter")).status, 400);
  assertEquals((await call("GET", "/v1/provider-keys/nope/openrouter")).status, 404);
  assertEquals((await call("GET", "/v1/provider-keys/good/openrouter", undefined, "")).status, 401);
});

test("without model access the OpenRouter paths answer the disabled refusal", async () => {
  const routes = disabledProviderKeyRoutes({ authenticate: () => Promise.resolve(null) });
  for (
    const [method, path] of [
      ["GET", "/v1/openrouter/models"],
      ["PUT", "/v1/openrouter/models/enabled"],
      ["POST", "/v1/openrouter/sync"],
      ["GET", "/v1/provider-keys/pk-1/openrouter"],
    ]
  ) {
    const r = routes.find((r) => r.method === method && r.pattern.test(`http://x${path}`));
    assert(r !== undefined, `${method} ${path}`);
    const res = await r.handler(new Request(`http://x${path}`, { method }), {});
    assertEquals(res.status, 503);
  }
});

// ── saving a key ────────────────────────────────────────────────────────────────────────────

test("an OpenRouter key is checked with OpenRouter before it is saved", async () => {
  const { call, store, api } = makeApi();
  api.keys.set("sk-or-v1-good-secret", KEY_INFO);

  const refused = await call("POST", "/v1/provider-keys", {
    provider: OPENROUTER,
    label: "nope",
    secret: "sk-or-v1-wrong-secret",
  });
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).error, "OpenRouter didn't accept this key");
  assertEquals(await store.listProviderKeys(), [], "a refused key is never saved");

  const created = await call("POST", "/v1/provider-keys", {
    provider: OPENROUTER,
    label: "team",
    secret: "sk-or-v1-good-secret",
  });
  assertEquals(created.status, 201);
  const body = await created.json();
  assertEquals(body.provider, OPENROUTER);
  assertEquals(body.openrouter, KEY_INFO);
  assert(!("warning" in body));
  assert(!JSON.stringify(body).includes("good-secret"), "the secret never comes back");
  // The first key synced the catalogue before answering, so the picker has something to show.
  assertEquals(api.calls.models, 1);
  assertEquals((await store.listOpenRouterModels()).length, 3);

  // A second key finds the catalogue there and does not sync again.
  api.keys.set("sk-or-v1-other-secret", KEY_INFO);
  await call("POST", "/v1/provider-keys", {
    provider: OPENROUTER,
    label: "second",
    secret: "sk-or-v1-other-secret",
  });
  assertEquals(api.calls.models, 1);

  // Any other provider's key is not OpenRouter's to check.
  const anthropic = await call("POST", "/v1/provider-keys", {
    provider: "anthropic",
    label: "a",
    secret: "sk-ant-whatever",
  });
  assertEquals(anthropic.status, 201);
  assertEquals(api.calls.keys, [
    "sk-or-v1-wrong-secret",
    "sk-or-v1-good-secret",
    "sk-or-v1-other-secret",
  ]);
});

test("an OpenRouter key OpenRouter cannot be asked about is saved, with a warning", async () => {
  const { call, store, api } = makeApi();
  api.keys.set("sk-or-v1-good-secret", new OpenRouterApiError("could not reach", null));
  api.models = new OpenRouterApiError("could not reach", null);
  const created = await call("POST", "/v1/provider-keys", {
    provider: OPENROUTER,
    label: "team",
    secret: "sk-or-v1-good-secret",
  });
  // A failed first sync does not fail the save either.
  assertEquals(created.status, 201);
  const body = await created.json();
  assert(typeof body.warning === "string");
  assert(!("openrouter" in body));
  assertEquals((await store.listProviderKeys()).length, 1);
  assert((await store.getOpenRouterSync())?.error !== null);
});

test("rotating an OpenRouter key's secret checks the new one", async () => {
  const { call, store, api } = makeApi();
  api.keys.set("sk-or-v1-first-secret", KEY_INFO);
  const created = await (await call("POST", "/v1/provider-keys", {
    provider: OPENROUTER,
    label: "team",
    secret: "sk-or-v1-first-secret",
  })).json();

  const refused = await call("PATCH", `/v1/provider-keys/${created.id}`, {
    secret: "sk-or-v1-revoked-secret",
  });
  assertEquals(refused.status, 400);
  assertEquals(
    (await store.getProviderKey(created.id))?.encryptedSecret,
    "sealed:sk-or-v1-first-secret",
    "the old secret stands",
  );

  api.keys.set("sk-or-v1-second-secret", { ...KEY_INFO, limitRemaining: 0 });
  const rotated = await call("PATCH", `/v1/provider-keys/${created.id}`, {
    secret: "sk-or-v1-second-secret",
  });
  assertEquals(rotated.status, 200);
  assertEquals((await rotated.json()).openrouter.limitRemaining, 0);

  // A relabel does not ask OpenRouter anything.
  const asked = api.calls.keys.length;
  assertEquals(
    (await call("PATCH", `/v1/provider-keys/${created.id}`, { label: "renamed" })).status,
    200,
  );
  assertEquals(api.calls.keys.length, asked);
});
