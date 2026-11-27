// OpenRouter as a built-in: its model list turned into catalogue rows, the sync that keeps them,
// the admin's enabled set, a key's live credit read, and the provider list that offers the
// enabled models. OpenRouter itself is a fake (tests/fake_openrouter.ts) throughout.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { Route } from "@ryph/shared/http";
import { unauthorized } from "@ryph/sealed";
import { forbidden } from "@ryph/auth";
import { catalogueOf, OPENROUTER, openRouterModelForRun } from "../src/core/openrouter.ts";
import { makeOpenRouterCatalogue, SYNC_CLAIM_MS } from "../src/core/openrouter_catalogue.ts";
import { openRouterApi } from "../src/adapters/openrouter/api.ts";
import { OpenRouterApiError } from "../src/ports/openrouter_api.ts";
import { openRouterRoutes } from "../src/http/openrouter.ts";
import { disabledProviderKeyRoutes, providerKeyRoutes } from "../src/http/routes.ts";
import {
  listProviderSpecs,
  makeCredentialIssuer,
  makePlatformCredentialIssuer,
} from "../src/core/service.ts";
import { sha256Hex } from "@ryph/sealed";
import { toPublicProviderSpec } from "../src/core/registry.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { memoryKeyStore } from "./memory_store.ts";
import {
  fakeOpenRouter,
  KEY_INFO,
  listedModel,
  MODELS_BODY,
  seedSyncState,
} from "./fake_openrouter.ts";

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

test("catalogueOf: one absurd figure is clamped, never a row the store cannot hold", () => {
  const [row] = catalogueOf({
    data: [listedModel("x/huge", {
      context_length: 1e15,
      top_provider: { max_completion_tokens: 1e12 },
    })],
  });
  assertEquals(row.contextLength, 100_000_000);
  assertEquals(row.maxOutputTokens, 65_536);
  // Under one token is no context length at all.
  assertEquals(catalogueOf({ data: [listedModel("x/tiny", { context_length: 0.5 })] }), []);
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

test("the adapter reads at most 16 MB of an answer", async () => {
  const api = openRouterApi({
    fetch: (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch,
  });
  const err = await api.listModels().catch((e) => e);
  assert(err instanceof OpenRouterApiError);
  assertEquals(
    err.message,
    `OpenRouter answered its model list with more than ${16 * 1024 * 1024} bytes`,
  );
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
    errorCode: null,
    syncing: false,
  });
  assertEquals((await store.listOpenRouterModels()).length, 3);

  now = new Date(NOW.getTime() + 60_000);
  api.models = new OpenRouterApiError("OpenRouter answered 503 for its model list", 503);
  const failed = await catalogue.sync();
  assertEquals(failed.syncedAt, NOW.toISOString(), "the last good sync is kept");
  assertEquals(failed.attemptedAt, now.toISOString());
  assertEquals(failed.error, "OpenRouter answered 503 for its model list");
  assertEquals(failed.errorCode, null, "only a shrunk list carries a code");
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

test("a short list keeps enabled models; one half gone fails unless forced", async () => {
  const store = memoryKeyStore();
  const ten = Array.from({ length: 10 }, (_, i) => listedModel(`m/${i}`));
  const api = fakeOpenRouter({ models: { data: ten } });
  let now = NOW;
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => now, diag: quiet });
  await catalogue.sync();
  await store.setOpenRouterEnabled(["m/0", "m/1"], NOW.toISOString());
  const usable = async () => (await store.listUsableOpenRouterModels()).map((m) => m.id);
  const listed = async () =>
    (await store.listOpenRouterModels()).filter((m) => m.listed).map((m) => m.id);

  // A list that left out the two enabled models and two others: the others are unlisted, the
  // enabled ones stay for now.
  now = new Date(NOW.getTime() + 1_000);
  api.models = { data: ten.slice(2, 8) };
  assertEquals((await catalogue.sync()).error, null);
  assertEquals(await usable(), ["m/0", "m/1"]);
  assertEquals((await listed()).length, 8);

  // A list of two after eight listed is a failed sync: nothing is written.
  now = new Date(NOW.getTime() + 2_000);
  api.models = { data: ten.slice(2, 4) };
  const refused = await catalogue.sync();
  assertEquals(refused.syncedAt, new Date(NOW.getTime() + 1_000).toISOString());
  assertEquals(
    refused.error,
    "OpenRouter's model list had 2 usable models, down from 8, so the old list was kept",
  );
  assertEquals(refused.errorCode, "openrouter_sync_shrunk");
  assertEquals((await store.getOpenRouterSync())?.errorCode, "openrouter_sync_shrunk");
  assertEquals((await listed()).length, 8);

  // Forced, the list is taken: the enabled models' second miss in a row unlists them.
  const forced = await catalogue.sync({ force: true });
  assertEquals(forced.error, null);
  assertEquals(forced.errorCode, null);
  assertEquals(await usable(), []);
  assertEquals(await listed(), ["m/2", "m/3"]);
});

test("a list past the cap fails, and so does a write, with a short error", async () => {
  const store = memoryKeyStore();
  const api = fakeOpenRouter({
    models: { data: Array.from({ length: 5_001 }, (_, i) => listedModel(`m/${i}`)) },
  });
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => NOW, diag: quiet });
  const tooMany = await catalogue.sync();
  assertEquals(
    tooMany.error,
    "OpenRouter's model list had 5001 models, more than the 5000 a sync takes",
  );
  assertEquals(await store.listOpenRouterModels(), []);

  // A store whose write fails with the whole statement in its message: the admin is told the
  // write failed, and nothing of the statement.
  const failing: KeyStore = {
    ...store,
    upsertOpenRouterCatalogue: () =>
      Promise.reject(
        new Error('insert into "openrouter_models" ("id", ...) values ($1, ...) params: a/b,...'),
      ),
  };
  api.models = MODELS_BODY;
  const { call } = makeApi({ store: failing, api });
  const res = await call("POST", "/v1/openrouter/sync");
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(
    body.error,
    "could not sync OpenRouter's models: could not save OpenRouter's model list",
  );
  assertEquals(
    (await failing.getOpenRouterSync())?.error,
    "could not save OpenRouter's model list",
  );
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────

const ADMIN = "admin-secret";
const USER = "user-secret";

function makeApi(
  opts: { store?: KeyStore; api?: ReturnType<typeof fakeOpenRouter>; changed?: () => void } = {},
) {
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
      authenticateManage,
      now: () => NOW,
      diag: quiet,
      ...(opts.changed === undefined ? {} : { changed: opts.changed }),
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
    errorCode: null,
    syncing: false,
  });
  // The sync's bookkeeping stays out of the picker.
  assert(!("missedSyncs" in body.models[0]));
  assert(!("updatedAt" in body.models[0]));

  const refused = await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["anthropic/claude-sonnet-5", "acme/no-tools", "nope/never", "openrouter/auto"],
  });
  assertEquals(refused.status, 400);
  const why = await refused.json();
  assertEquals(why.error, "Some models can't be enabled");
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
  await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["openai/gpt-6", "anthropic/claude-sonnet-5"],
  });
  // Gone from two lists in a row, the enabled model is unlisted. (The lists are a third of the
  // last one, which only a forced sync takes.)
  api.models = { data: [listedModel("anthropic/claude-sonnet-5")] };
  await catalogue.sync({ force: true });
  await catalogue.sync({ force: true });

  const models = (await (await call("GET", "/v1/openrouter/models")).json()).models;
  assertEquals(models.map((m: { id: string; listed: boolean }) => [m.id, m.listed]), [
    ["anthropic/claude-sonnet-5", true],
    ["openai/gpt-6", false],
  ]);
  // Still enabled, it may stay in the set a save carries: one model OpenRouter dropped must not
  // block every later save of the rest.
  const kept = await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["openai/gpt-6", "anthropic/claude-sonnet-5"],
  });
  assertEquals(kept.status, 200);

  // Once turned off, it cannot be turned on again.
  assertEquals(
    (await call("PUT", "/v1/openrouter/models/enabled", { ids: ["anthropic/claude-sonnet-5"] }))
      .status,
    200,
  );
  const refused = await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).unlisted, ["openai/gpt-6"]);
});

test("an enabled model that stops taking tools does not block a save, and stays away from runs", async () => {
  const { call, catalogue, api, store } = makeApi();
  await catalogue.sync();
  const set = (ids: string[]) => call("PUT", "/v1/openrouter/models/enabled", { ids });
  assertEquals((await set(["openai/gpt-6"])).status, 200);
  // OpenRouter stops saying the model takes tools.
  api.models = {
    data: [
      ...MODELS_BODY.data.filter((m) => m.id !== "openai/gpt-6"),
      listedModel("openai/gpt-6", { supported_parameters: ["reasoning"] }),
    ],
  };
  await catalogue.sync();
  // Adding another model still saves with it in the set...
  assertEquals((await set(["openai/gpt-6", "anthropic/claude-sonnet-5"])).status, 200);
  // ...but once turned off, it is a model newly enabled, which must take tools.
  assertEquals((await set(["anthropic/claude-sonnet-5"])).status, 200);
  const again = await set(["openai/gpt-6", "anthropic/claude-sonnet-5"]);
  assertEquals(again.status, 400);
  assertEquals((await again.json()).noTools, ["openai/gpt-6"]);
  assertEquals((await store.listUsableOpenRouterModels()).map((m) => m.id), [
    "anthropic/claude-sonnet-5",
  ]);
});

test("an enabled model that stops taking tools leaves the usable set at that sync", async () => {
  const { call, catalogue, api, store } = makeApi();
  await catalogue.sync();
  await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["openai/gpt-6", "anthropic/claude-sonnet-5"],
  });
  await store.createProviderKey({
    id: "pk-or",
    provider: OPENROUTER,
    label: "team",
    last4: "abcd",
    encryptedSecret: "sealed:sk-or-team",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  api.models = {
    data: [
      ...MODELS_BODY.data.filter((m) => m.id !== "openai/gpt-6"),
      listedModel("openai/gpt-6", { supported_parameters: ["reasoning"] }),
    ],
  };
  assertEquals((await catalogue.sync()).error, null);

  // Still enabled, so the admin's set saves with it...
  const enabled = (await store.listOpenRouterModels()).filter((m) => m.enabled).map((m) => m.id);
  assertEquals(enabled, ["anthropic/claude-sonnet-5", "openai/gpt-6"]);
  // ...but straight after the sync, nothing hands it to a run.
  const usable = (await store.listUsableOpenRouterModels()).map((m) => m.id);
  assertEquals(usable, ["anthropic/claude-sonnet-5"]);
  const providers = (await (await call("GET", "/v1/providers", undefined, USER)).json()).providers;
  assertEquals(
    providers.find((p: { id: string }) => p.id === OPENROUTER).models.map((m: { id: string }) =>
      m.id
    ),
    ["anthropic/claude-sonnet-5"],
  );
  const issuer = makeCredentialIssuer({
    store,
    now: () => NOW,
    proxyUrl: "http://model-proxy.internal:7420",
    ttlMs: 60_000,
  });
  const env = await issuer.issue({
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-or",
    provider: OPENROUTER,
    allowedModels: "*",
    model: "anthropic/claude-sonnet-5",
  });
  const blob = JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG);
  assertEquals(blob.models.map((m: { id: string }) => m.id), ["anthropic/claude-sonnet-5"]);
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
  assertEquals(body.code, undefined, "only a shrunk list's failure carries a code");
  assertEquals(body.sync.errorCode, null);
});

test("a catalogue read that starts a sync answers that one is running", async () => {
  const api = fakeOpenRouter();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const listModels = api.listModels;
  let asked = 0;
  api.listModels = async () => {
    asked += 1;
    await held;
    return await listModels();
  };
  const { call, store } = makeApi({ api });
  await store.createProviderKey({
    id: "pk-or",
    provider: OPENROUTER,
    label: "team",
    last4: "abcd",
    encryptedSecret: "sealed:sk-or-team",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  // Never synced, with a live key: the read starts one, and says so, so the picker reads again.
  const first = await (await call("GET", "/v1/openrouter/models")).json();
  assertEquals(first.sync.syncing, true);
  assertEquals(first.models, []);
  assertEquals(asked, 1);

  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = await (await call("GET", "/v1/openrouter/models")).json();
  assertEquals(after.sync.syncing, false);
  assertEquals(after.models.length, 3);
  assertEquals(asked, 1, "fresh now: no second sync");
});

/** A model list held open until `release`: a sync that is running, for as long as a test likes. */
function heldOpenRouter(over: Parameters<typeof fakeOpenRouter>[0] = {}) {
  const api = fakeOpenRouter(over);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const listModels = api.listModels;
  api.listModels = async () => {
    const answer = listModels();
    await held;
    return await answer;
  };
  return { api, release: () => release() };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

test("a sync another replica runs is reported as running, until it ends", async () => {
  const store = memoryKeyStore();
  // The other replica: its own catalogue over the same store, its model list held open.
  const { api, release } = heldOpenRouter();
  const there = makeOpenRouterCatalogue({ store, api, now: () => NOW, diag: quiet });
  const running = there.sync();
  await tick();

  // This replica runs no sync of its own, and still answers that one runs.
  const { call, catalogue } = makeApi({ store });
  assertEquals(catalogue.syncing(), false);
  const during = await (await call("GET", "/v1/openrouter/models")).json();
  assertEquals(during.sync.syncing, true);

  release();
  await running;
  const after = await (await call("GET", "/v1/openrouter/models")).json();
  assertEquals(after.sync.syncing, false);
  assertEquals(after.models.length, 3);
});

test("two replicas syncing at once make one sync, and the state never goes back", async () => {
  const store = memoryKeyStore();
  const { api, release } = heldOpenRouter();
  // Two replicas, the second's clock a minute behind the first's.
  const here = makeOpenRouterCatalogue({ store, api, now: () => NOW, diag: quiet, sleep: tick });
  const there = makeOpenRouterCatalogue({
    store,
    api,
    now: () => new Date(NOW.getTime() - 60_000),
    diag: quiet,
    sleep: tick,
  });
  // Every way a sync starts, on both at once: a key's save or an admin's "Sync now", and a read
  // of the provider list or the catalogue.
  const states: Array<string | null> = [];
  const watch = setInterval(async () => {
    states.push((await store.getOpenRouterSync())?.attemptedAt ?? null);
  }, 1);
  const syncs = Promise.all([here.sync(), there.sync(), here.syncIfStale(), there.syncIfStale()]);
  await tick();
  assertEquals(await here.startIfStale(), true, "one runs");
  assertEquals(await there.startIfStale(), true, "one runs");
  release();
  const [a, b] = await syncs;
  clearInterval(watch);

  assertEquals(api.calls.models, 1, "one read of OpenRouter between them");
  assertEquals(a, b, "the waiting one answers what the other found");
  assertEquals(a.error, null);
  const synced = await store.getOpenRouterSync();
  assertEquals(synced?.syncing, false);
  assertEquals(synced?.syncedAt, a.syncedAt);
  const seen = states.filter((at) => at !== null);
  assertEquals(seen, [...seen].sort(), "attemptedAt only moves forward");

  // A sync on the replica whose clock is behind is still later than the last.
  await there.sync({ force: true });
  const later = await store.getOpenRouterSync();
  assert(later!.attemptedAt! > synced!.attemptedAt!, "a later sync is later");
  assert(later!.syncedAt! > synced!.syncedAt!);
});

test("one short list counts one miss, however many replicas sync on it at once", async () => {
  const store = memoryKeyStore();
  const ten = Array.from({ length: 10 }, (_, i) => listedModel(`m/${i}`));
  const first = fakeOpenRouter({ models: { data: ten } });
  await makeOpenRouterCatalogue({ store, api: first, now: () => NOW, diag: quiet }).sync();
  await store.setOpenRouterEnabled(["m/0"], NOW.toISOString());

  // One short answer, without the enabled model, that three replicas would all act on.
  const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  const { api, release } = heldOpenRouter({ models: { data: ten.slice(1) } });
  const replicas = [0, 1, 2].map(() =>
    makeOpenRouterCatalogue({ store, api, now: () => later, diag: quiet, sleep: tick })
  );
  const syncs = Promise.all([
    replicas[0].sync(),
    replicas[1].syncIfStale(),
    replicas[2].sync(),
    replicas[0].syncIfStale(),
  ]);
  await tick();
  release();
  await syncs;

  assertEquals(api.calls.models, 1);
  const enabled = (await store.listOpenRouterModels()).find((m) => m.id === "m/0")!;
  assertEquals([enabled.listed, enabled.missedSyncs], [true, 1], "one miss, still listed");
  assertEquals((await store.listUsableOpenRouterModels()).map((m) => m.id), ["m/0"]);
});

test("a background sync that cannot claim leaves it to the holder", async () => {
  const store = memoryKeyStore();
  const { api, release } = heldOpenRouter();
  const there = makeOpenRouterCatalogue({ store, api, now: () => NOW, diag: quiet });
  const running = there.sync();
  await tick();

  const otherApi = fakeOpenRouter();
  const here = makeOpenRouterCatalogue({ store, api: otherApi, now: () => NOW, diag: quiet });
  assertEquals(await here.startIfStale(), true, "a sync runs");
  assertEquals(here.syncing(), false, "but not here");
  await here.syncIfStale();
  assertEquals(otherApi.calls.models, 0, "OpenRouter is not read twice");
  release();
  await running;
});

test("a forced sync waits out another replica's and then runs its own", async () => {
  const ten = Array.from({ length: 10 }, (_, i) => listedModel(`m/${i}`));
  const store = memoryKeyStore();
  await makeOpenRouterCatalogue({
    store,
    api: fakeOpenRouter({ models: { data: ten } }),
    now: () => NOW,
    diag: quiet,
  }).sync();

  // The other replica's sync, held open, is about to refuse a list of two as shrunk.
  const later = new Date(NOW.getTime() + 1_000);
  const { api, release } = heldOpenRouter({ models: { data: ten.slice(0, 2) } });
  const there = makeOpenRouterCatalogue({ store, api, now: () => later, diag: quiet });
  const running = there.sync();
  await tick();

  const here = makeOpenRouterCatalogue({ store, api, now: () => later, diag: quiet, sleep: tick });
  const forced = here.sync({ force: true });
  await tick();
  assertEquals(api.calls.models, 1, "the force waits");
  release();
  assertEquals((await running).errorCode, "openrouter_sync_shrunk");
  const taken = await forced;
  assertEquals(taken.error, null, "and then takes the list");
  assertEquals(api.calls.models, 2);
  assertEquals(await store.countListedOpenRouterModels(), 2);
});

test("a holder that died mid-sync blocks the next sync for one claim, and no longer", async () => {
  let now = NOW;
  const store = memoryKeyStore({ now: () => now });
  // A replica claimed and died: nothing ever ends its claim.
  assert(await store.claimOpenRouterSync("dead", SYNC_CLAIM_MS));

  const api = fakeOpenRouter();
  // Each look at the claim moves the clock along, as waiting would.
  const sleep = (ms: number) => {
    now = new Date(now.getTime() + ms);
    return Promise.resolve();
  };
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => now, diag: quiet, sleep });
  assertEquals(await catalogue.startIfStale(), true, "a sync is said to run");
  assertEquals(api.calls.models, 0, "but none starts beside it");
  assertEquals((await store.getOpenRouterSync())?.syncing, true);

  // An admin's "Sync now" waits it out, then syncs.
  const state = await catalogue.sync();
  assertEquals(state.error, null);
  assertEquals(api.calls.models, 1);
  assert(now.getTime() - NOW.getTime() >= SYNC_CLAIM_MS, "after the claim lapsed");
  assertEquals((await store.getOpenRouterSync())?.syncing, false);
  assertEquals((await store.listOpenRouterModels()).length, 3);

  // A read after another lapse starts one at once.
  assert(await store.claimOpenRouterSync("dead again", SYNC_CLAIM_MS));
  now = new Date(now.getTime() + SYNC_CLAIM_MS + 25 * 60 * 60 * 1000);
  assertEquals((await store.getOpenRouterSync())?.syncing, false);
  await catalogue.syncIfStale();
  assertEquals(api.calls.models, 2);
});

test("a sync that outlives its claim writes nothing", async () => {
  let now = NOW;
  const store = memoryKeyStore({ now: () => now });
  const api = fakeOpenRouter();
  const listModels = api.listModels;
  // The model list takes so long the claim lapses, and another sync takes it meanwhile.
  api.listModels = async () => {
    now = new Date(now.getTime() + SYNC_CLAIM_MS + 1);
    assert(await store.claimOpenRouterSync("the next", SYNC_CLAIM_MS));
    return await listModels();
  };
  const catalogue = makeOpenRouterCatalogue({ store, api, now: () => now, diag: quiet });
  const state = await catalogue.sync();
  assertEquals(
    state.error,
    "the sync ran out of time before it could save OpenRouter's model list",
  );
  assertEquals(await store.listOpenRouterModels(), []);
  const stored = await store.getOpenRouterSync();
  assertEquals([stored?.attemptedAt, stored?.syncing], [null, true], "the next one's claim stands");
});

test("a store that fails the sync's first read is a recorded failure, never a throw", async () => {
  const store = memoryKeyStore();
  await seedSyncState(store, {
    syncedAt: "2026-11-26T12:00:00.000Z",
    attemptedAt: "2026-11-26T12:00:00.000Z",
    error: null,
    errorCode: null,
  });
  let failReads = 1;
  const blipping: KeyStore = {
    ...store,
    getOpenRouterSync: () => {
      if (failReads-- > 0) return Promise.reject(new Error("connection reset: select ..."));
      return store.getOpenRouterSync();
    },
  };
  const { call } = makeApi({ store: blipping });
  const res = await call("POST", "/v1/openrouter/sync");
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, "could not sync OpenRouter's models: the sync failed");
  // Recorded like any failure, the last good sync's time kept.
  const state = await store.getOpenRouterSync();
  assertEquals(state?.error, "the sync failed");
  assertEquals(state?.syncedAt, "2026-11-26T12:00:00.000Z");
  assertEquals(state?.attemptedAt, NOW.toISOString());

  // A store that cannot answer at all: the caller still gets the state, and nothing is written
  // that would forget the last good sync.
  const down: KeyStore = {
    ...store,
    getOpenRouterSync: () => Promise.reject(new Error("down")),
  };
  const catalogue = makeOpenRouterCatalogue({
    store: down,
    api: fakeOpenRouter(),
    now: () => new Date(NOW.getTime() + 1_000),
    diag: quiet,
  });
  const failed = await catalogue.sync();
  assertEquals(failed.error, "the sync failed");
  assertEquals((await store.getOpenRouterSync())?.syncedAt, "2026-11-26T12:00:00.000Z");
  assertEquals((await store.getOpenRouterSync())?.attemptedAt, NOW.toISOString());
});

test("saving the enabled set and a sync that writes tell the proxy's cache", async () => {
  let changes = 0;
  const { call, api } = makeApi({ changed: () => changes++ });
  await call("POST", "/v1/openrouter/sync");
  await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  assertEquals(changes, 1, "the routes tell it of a save");
  // A refused save changes nothing, and says nothing.
  await call("PUT", "/v1/openrouter/models/enabled", { ids: ["nope/never"] });
  assertEquals(changes, 1);

  let synced = 0;
  const catalogue = makeOpenRouterCatalogue({
    store: memoryKeyStore(),
    api,
    now: () => NOW,
    diag: quiet,
    changed: () => synced++,
  });
  await catalogue.sync();
  assertEquals(synced, 1);
  api.models = new Error("down");
  await catalogue.sync();
  assertEquals(synced, 1, "a failed sync wrote nothing");
});

test("a sync refused for a shrunk list says so by code, until a forced one takes the list", async () => {
  const { call, api } = makeApi();
  assertEquals((await call("POST", "/v1/openrouter/sync")).status, 200);

  api.models = { data: [listedModel("anthropic/claude-sonnet-5")] };
  const shrunk = await call("POST", "/v1/openrouter/sync");
  assertEquals(shrunk.status, 502);
  const body = await shrunk.json();
  assertEquals(body.code, "openrouter_sync_shrunk");
  assertEquals(body.sync.errorCode, "openrouter_sync_shrunk");
  assertEquals(body.models.length, 3, "the old list stands");
  // The catalogue read carries it too, for a picker that never saw the 502.
  const read = await (await call("GET", "/v1/openrouter/models")).json();
  assertEquals(read.sync.errorCode, "openrouter_sync_shrunk");

  const forced = await call("POST", "/v1/openrouter/sync", { force: true });
  assertEquals(forced.status, 200);
  const taken = await forced.json();
  assertEquals(taken.sync.errorCode, null);
  assertEquals(taken.sync.error, null);
});

test("the provider list offers OpenRouter's enabled, listed models with their prices", async () => {
  const { call, store, catalogue } = makeApi();
  await catalogue.sync();
  await store.setOpenRouterEnabled(
    ["openai/gpt-6", "anthropic/claude-sonnet-5", "acme/no-tools"],
    NOW.toISOString(),
  );

  const providers = (await (await call("GET", "/v1/providers", undefined, USER)).json()).providers;
  const openrouter = providers.find((p: { id: string }) => p.id === OPENROUTER);
  assertEquals(openrouter.builtin, true);
  assertEquals(openrouter.dialect, "openai-completions");
  assertEquals(openrouter.baseUrl, "https://openrouter.ai/api/v1");
  // Enabled without tools (only the store lets that happen): never offered.
  assertEquals(openrouter.models.map((m: { id: string }) => m.id), [
    "anthropic/claude-sonnet-5",
    "openai/gpt-6",
  ]);
  assertEquals(openrouter.models[1].compat, { thinkingFormat: "openrouter" });
  assertEquals(openrouter.models[1].price.input, 2.5);
  assert(!("extraHeaders" in openrouter), "the list never carries static headers");

  const specs = await listProviderSpecs(store, { planOn: false });
  assertEquals(
    toPublicProviderSpec(specs.find((s) => s.id === OPENROUTER)!).models.length,
    2,
  );
});

test("the platform policy is held to the enabled set, and a change to the set revokes its keys", async () => {
  const { call, store, catalogue } = makeApi();
  await catalogue.sync();
  await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  await store.createProviderKey({
    id: "pk-or",
    provider: OPENROUTER,
    label: "team",
    last4: "abcd",
    encryptedSecret: "sealed:sk-or-team",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  // The default model, or one the allowlist names, that is not enabled: refused, named.
  for (
    const policy of [
      { allowedModels: "*", model: "anthropic/claude-sonnet-5" },
      { allowedModels: ["openai/gpt-6", "anthropic/claude-sonnet-5"], model: "openai/gpt-6" },
    ]
  ) {
    const res = await call("PUT", "/v1/platform-model-policy", {
      providerKeyId: "pk-or",
      ...policy,
    });
    assertEquals(res.status, 400, JSON.stringify(policy));
    assertEquals(
      (await res.json()).error,
      'model "anthropic/claude-sonnet-5" isn\'t enabled for OpenRouter — enable it under Model keys',
    );
  }
  const saved = await call("PUT", "/v1/platform-model-policy", {
    providerKeyId: "pk-or",
    allowedModels: "*",
    model: "openai/gpt-6",
  });
  assertEquals(saved.status, 200);

  const issuer = makePlatformCredentialIssuer({ store, now: () => NOW });
  const live = async (token: string) =>
    (await store.getVirtualKeyByTokenHash(await sha256Hex(token)))?.revokedAt === null;

  // "*" is the enabled set: enabling another model changes what the platform may call, and the
  // credential minted under the old set is killed.
  const first = await issuer.issue("memory");
  assertEquals(first.allowedModels, ["openai/gpt-6"]);
  await call("PUT", "/v1/openrouter/models/enabled", {
    ids: ["openai/gpt-6", "anthropic/claude-sonnet-5"],
  });
  assert(!(await live(first.token)));

  // A policy that names its models is moved only by a change to those.
  await store.savePlatformPolicy({
    providerKeyId: "pk-or",
    provider: OPENROUTER,
    allowedModels: ["openai/gpt-6"],
    model: "openai/gpt-6",
    updatedAt: NOW.toISOString(),
  });
  const second = await issuer.issue("memory");
  await call("PUT", "/v1/openrouter/models/enabled", { ids: ["openai/gpt-6"] });
  assert(await live(second.token), "sonnet was never the policy's");
  await call("PUT", "/v1/openrouter/models/enabled", { ids: [] });
  assert(!(await live(second.token)));
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

  // The account's credit is the admin's to read.
  const user = await call("GET", "/v1/provider-keys/good/openrouter", undefined, USER);
  assertEquals(user.status, 403);
  assertEquals(api.calls.keys, []);
  const good = await call("GET", "/v1/provider-keys/good/openrouter");
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
  assertEquals(body.warning, "Key saved. OpenRouter couldn't check it.");
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
