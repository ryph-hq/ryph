// The drizzle adapter round-trips the same shapes the memory store does, on an in-memory db
// with the schema pushed straight from db/schema.ts (see tests/db.ts).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { drizzleKeyStore } from "../src/adapters/store/drizzle.ts";
import type { CustomProvider, PlanSignIn, ProviderKey, VirtualKey } from "../src/core/types.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { platformPrincipal } from "../src/core/types.ts";
import { makeTestDb } from "./db.ts";
import type { OpenRouterCatalogueEntry } from "../src/core/openrouter.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";

const key: ProviderKey = {
  id: "pk-1",
  provider: "anthropic",
  label: "team key",
  last4: "cret",
  encryptedSecret: "v1.aXY=.Y3Q=",
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
  // What a row of any provider but `chatgpt-plan` reads back as.
  plan: null,
  planStatus: null,
  planLimitedAt: null,
};

const virtualKey: VirtualKey = {
  id: "vk-1",
  runId: "r-1",
  agentId: "a-1",
  taskId: "t-1",
  providerKeyId: "pk-1",
  tokenHash: "hash-1",
  allowedModels: ["claude-sonnet-5"],
  spendUsd: 12.5,
  callsInFlight: 4,
  expiresAt: T1,
  revokedAt: null,
  createdAt: T0,
};

test("drizzle store round-trips provider keys, virtual keys, and usage", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    await store.createProviderKey(key);
    assertEquals(await store.getProviderKey("pk-1"), key);
    assertEquals((await store.listProviderKeys()).map((k) => k.id), ["pk-1"]);
    await store.saveProviderKey({ ...key, archivedAt: T1, updatedAt: T1 });
    assertEquals((await store.getProviderKey("pk-1"))?.archivedAt, T1);

    await store.createVirtualKey(virtualKey);
    await store.createVirtualKey({
      ...virtualKey,
      id: "vk-2",
      runId: "r-2",
      tokenHash: "hash-2",
      allowedModels: "*",
      spendUsd: null,
      callsInFlight: null,
    });
    // The lookup column round-trips, including both allowlist shapes and both cap shapes.
    assertEquals(await store.getVirtualKeyByTokenHash("hash-1"), virtualKey);
    const uncapped = await store.getVirtualKeyByTokenHash("hash-2");
    assertEquals(uncapped?.allowedModels, "*");
    assertEquals([uncapped?.spendUsd, uncapped?.callsInFlight], [null, null]);
    assertEquals(await store.getVirtualKeyByTokenHash("hash-none"), null);

    // Revocation is per run and stamps only live keys.
    await store.revokeVirtualKeysForRun("r-1", T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-2"))?.revokedAt, null);
    await store.revokeVirtualKeysForRun("r-1", "2026-01-01T02:00:00.000Z");
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1); // unchanged

    // The platform sweep matches on the principal prefix and leaves a run's credential alone.
    await store.createVirtualKey({
      ...virtualKey,
      id: "vk-3",
      runId: platformPrincipal("memory"),
      tokenHash: "hash-3",
    });
    await store.createVirtualKey({
      ...virtualKey,
      id: "vk-4",
      runId: platformPrincipal("ingest"),
      tokenHash: "hash-4",
    });
    await store.revokePlatformVirtualKeys(T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-3"))?.revokedAt, T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-4"))?.revokedAt, T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-2"))?.revokedAt, null, "r-2 is a run");
    await store.revokePlatformVirtualKeys("2026-01-01T02:00:00.000Z");
    assertEquals((await store.getVirtualKeyByTokenHash("hash-3"))?.revokedAt, T1); // unchanged

    await store.recordUsage({
      runId: "r-1",
      agentId: "a-1",
      taskId: "t-1",
      providerKeyId: "pk-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      status: 200,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheWrite1hTokens: null,
      reasoningTokens: null,
      estimated: false,
      costUsd: null,
      durationMs: 5,
      at: T0,
    });
    await store.recordUsage({
      runId: "r-1",
      agentId: "a-1",
      taskId: "t-1",
      providerKeyId: "pk-1",
      provider: "anthropic",
      model: null,
      status: 429,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheWrite1hTokens: null,
      reasoningTokens: null,
      estimated: false,
      costUsd: null,
      durationMs: 5,
      at: T1,
    });
    const usage = await store.listUsageForRun("r-1");
    assertEquals(usage.length, 2);

    // The platform policy: one row, replaced in place, cleared to none.
    assertEquals(await store.getPlatformPolicy(), null);
    const policy = {
      providerKeyId: "pk-1",
      provider: "anthropic",
      allowedModels: ["claude-sonnet-5"] as string[] | "*",
      model: "claude-sonnet-5",
      updatedAt: T0,
    };
    await store.savePlatformPolicy(policy);
    assertEquals(await store.getPlatformPolicy(), policy);
    await store.savePlatformPolicy({ ...policy, allowedModels: "*", updatedAt: T1 });
    assertEquals((await store.getPlatformPolicy())?.allowedModels, "*");
    await store.clearPlatformPolicy();
    assertEquals(await store.getPlatformPolicy(), null);
    assertEquals(usage[0].model, "claude-sonnet-5");
    assertEquals(usage[1].status, 429);
    assert(!("seq" in usage[0]), "the row's own counter stays an adapter detail");
    assertEquals(await store.listUsageForRun("r-none"), []);
  } finally {
    await store.close();
  }
});

const endpoint: CustomProvider = {
  id: "groq",
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  authHeader: "authorization",
  authScheme: "Bearer",
  extraHeaders: { "x-org": "acme" },
  models: [{ id: "llama-4", price: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } }],
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

test("custom endpoints round-trip through both stores identically", async () => {
  const handle = await makeTestDb();
  const stores = { drizzle: drizzleKeyStore(handle), memory: memoryKeyStore() };
  try {
    for (const [name, store] of Object.entries(stores)) {
      await store.createCustomProvider(endpoint);
      // Both JSONB columns survive the trip, and a null scheme stays null rather than becoming "".
      assertEquals(await store.getCustomProvider("groq"), endpoint, name);
      await store.createCustomProvider({
        ...endpoint,
        id: "azure",
        authHeader: "api-key",
        authScheme: null,
        extraHeaders: {},
        createdAt: T1,
        updatedAt: T1,
      });
      assertEquals((await store.getCustomProvider("azure"))?.authScheme, null, name);
      assertEquals(await store.getCustomProvider("nope"), null, name);
      // Oldest first, so the list reads in registration order under the built-ins.
      assertEquals((await store.listCustomProviders()).map((p) => p.id), ["groq", "azure"], name);

      // A partial patch leaves everything it did not name alone.
      const patched = await store.updateCustomProvider("groq", {
        label: "Groq (EU)",
        models: [{ id: "llama-4-eu" }],
        updatedAt: T1,
      });
      assertEquals(patched?.provider.label, "Groq (EU)", name);
      assertEquals(patched?.provider.models, [{ id: "llama-4-eu" }], name);
      assertEquals(patched?.provider.baseUrl, endpoint.baseUrl, name);
      assertEquals(patched?.provider.authScheme, "Bearer", name);
      assertEquals(await store.updateCustomProvider("nope", { updatedAt: T1 }), null, name);

      // Archiving is the kill switch, idempotent, and never a delete.
      await store.archiveCustomProvider("groq", T1);
      await store.archiveCustomProvider("groq", T0); // a second call keeps the first stamp
      assertEquals((await store.getCustomProvider("groq"))?.archivedAt, T1, name);
      assertEquals((await store.listCustomProviders()).length, 2, name);
      await store.archiveCustomProvider("nope", T1); // quiet about a row that is not there
    }
  } finally {
    await stores.drizzle.close();
  }
});

// ── OpenRouter's catalogue ──────────────────────────────────────────────────────────────────

const catalogueEntry = (id: string, over: Partial<OpenRouterCatalogueEntry> = {}) => ({
  id,
  label: id,
  contextLength: 128_000,
  maxOutputTokens: 16_384,
  vision: false,
  reasoning: false,
  tools: true,
  price: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  ...over,
});

test("the OpenRouter catalogue round-trips through both stores identically", async () => {
  const handle = await makeTestDb();
  const stores = { drizzle: drizzleKeyStore(handle), memory: memoryKeyStore() };
  try {
    for (const [name, store] of Object.entries(stores)) {
      assertEquals(await store.listOpenRouterModels(), [], name);
      assertEquals(await store.getOpenRouterSync(), null, name);

      await store.upsertOpenRouterCatalogue([
        catalogueEntry("a/one"),
        catalogueEntry("b/two", { price: null }),
        catalogueEntry("c/three"),
      ], T0);
      await store.setOpenRouterEnabled(["a/one", "b/two"], T0);
      let rows = await store.listOpenRouterModels();
      assertEquals(rows.map((r) => [r.id, r.listed, r.enabled]), [
        ["a/one", true, true],
        ["b/two", true, true],
        ["c/three", true, false],
      ], name);
      // A null price stays null — unpriced, never a zero rate.
      assertEquals(rows[1].price, null, name);
      assertEquals(rows[0].price, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, name);

      assertEquals(await store.countListedOpenRouterModels(), 3, name);
      assertEquals((await store.listUsableOpenRouterModels()).map((r) => r.id), [
        "a/one",
        "b/two",
      ], name);
      // Only what has a price is priced.
      assertEquals((await store.listOpenRouterPrices()).map((r) => r.id).sort(), [
        "a/one",
        "c/three",
      ], name);

      // The next sync drops `b/two` and `c/three` and re-prices `a/one`. Enabled, `b/two` stays
      // listed through one miss; `c/three`, which nobody enabled, is unlisted at once. Nothing is
      // deleted, and what an admin enabled survives the sync.
      await store.upsertOpenRouterCatalogue([
        catalogueEntry("a/one", {
          label: "One",
          price: { ...catalogueEntry("").price!, input: 3 },
        }),
      ], T1);
      rows = await store.listOpenRouterModels();
      assertEquals(rows.map((r) => [r.id, r.listed, r.enabled, r.missedSyncs]), [
        ["a/one", true, true, 0],
        ["b/two", true, true, 1],
        ["c/three", false, false, 1],
      ], name);
      assertEquals(rows[0].label, "One", name);
      assertEquals(rows[0].price?.input, 3, name);
      assertEquals(rows[0].updatedAt, T1, name);

      // A second miss in a row unlists `b/two`; `c/three` coming back is listed again.
      await store.upsertOpenRouterCatalogue(
        [catalogueEntry("a/one"), catalogueEntry("c/three")],
        T2,
      );
      rows = await store.listOpenRouterModels();
      assertEquals(rows.map((r) => [r.id, r.listed, r.missedSyncs]), [
        ["a/one", true, 0],
        ["b/two", false, 2],
        ["c/three", true, 0],
      ], name);
      assertEquals((await store.listUsableOpenRouterModels()).map((r) => r.id), ["a/one"], name);

      // A sync that says `a/one` no longer takes tools leaves it enabled but unusable.
      await store.upsertOpenRouterCatalogue(
        [catalogueEntry("a/one", { tools: false }), catalogueEntry("c/three")],
        T2,
      );
      assertEquals((await store.listOpenRouterModels())[0].enabled, true, name);
      assertEquals(await store.listUsableOpenRouterModels(), [], name);

      // The enabled set is replaced whole; an empty set disables everything.
      await store.setOpenRouterEnabled(["c/three"], T1);
      assertEquals(
        (await store.listOpenRouterModels()).filter((r) => r.enabled).map((r) => r.id),
        ["c/three"],
        name,
      );
      await store.setOpenRouterEnabled([], T1);
      assertEquals((await store.listOpenRouterModels()).filter((r) => r.enabled), [], name);

      const state = {
        syncedAt: T0,
        attemptedAt: T1,
        error: "the list shrank",
        errorCode: "openrouter_sync_shrunk",
      };
      await store.putOpenRouterSync(state);
      assertEquals(await store.getOpenRouterSync(), { ...state, startedAt: null }, name);
      await store.putOpenRouterSync({ ...state, error: null, errorCode: null });
      assertEquals((await store.getOpenRouterSync())?.error, null, name);
      assertEquals((await store.getOpenRouterSync())?.errorCode, null, name);

      // A sync's start is stamped on its own, and the end of an earlier one leaves it standing.
      await store.markOpenRouterSyncStarted(T2);
      await store.putOpenRouterSync({ ...state, attemptedAt: T1 });
      assertEquals(await store.getOpenRouterSync(), { ...state, startedAt: T2 }, name);
    }
  } finally {
    await stores.drizzle.close();
  }
});

// ── ChatGPT plan keys ───────────────────────────────────────────────────────────────────────

const signIn = (over: Partial<PlanSignIn> = {}): PlanSignIn => ({
  id: "si-1",
  state: "state-1",
  nonce: "nonce-1",
  encryptedVerifier: "v1.x.y",
  clientId: null,
  keyId: null,
  label: null,
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  status: "pending",
  error: null,
  resultKeyId: null,
  createdAt: T0,
  expiresAt: T1,
  updatedAt: T0,
  ...over,
});

test("drizzle store: a plan key's partial writes leave each other's fields alone", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    const plan = {
      clientId: "oaiapp_1",
      subject: "sub",
      email: "a@b.c",
      planType: "plus",
      scopes: ["openid"],
      models: [{ id: "gpt-6.1-sol", reasoning: true }],
      modelsFetchedAt: T0,
    };
    await store.createProviderKey({
      ...key,
      provider: "chatgpt-plan",
      plan,
      planStatus: "active",
      planLimitedAt: null,
    });
    // The data plane marks it limited while a refresh rewrites the secret: both stick.
    await store.updateProviderKey("pk-1", {
      planStatus: "limited",
      planLimitedAt: T1,
      updatedAt: T1,
    });
    const updated = await store.updateProviderKey("pk-1", {
      encryptedSecret: "v1.new.secret",
      updatedAt: T1,
    });
    assertEquals(updated?.planStatus, "limited");
    assertEquals(updated?.planLimitedAt, T1);
    assertEquals(updated?.encryptedSecret, "v1.new.secret");
    assertEquals(updated?.plan, plan, "the registration round-trips as JSON");
    assertEquals(await store.updateProviderKey("pk-nope", { updatedAt: T1 }), null);
  } finally {
    await store.close();
  }
});

test("drizzle store: the agent host id is minted once", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    assertEquals(await store.claimAgentHostId("urn:uuid:first", T0), "urn:uuid:first");
    assertEquals(await store.claimAgentHostId("urn:uuid:second", T1), "urn:uuid:first");
  } finally {
    await store.close();
  }
});

test("drizzle store: a sign-in is claimed once, never after expiry, and pruned", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    await store.createSignIn(signIn());
    assertEquals((await store.getSignInByState("state-1"))?.id, "si-1");
    const [a, b] = await Promise.all([
      store.claimSignIn("si-1", T0),
      store.claimSignIn("si-1", T0),
    ]);
    assertEquals([a, b].filter((claimed) => claimed !== null).length, 1, "one claim wins");
    assertEquals((await store.getSignIn("si-1"))?.status, "exchanging");
    await store.finishSignIn("si-1", { status: "done", error: null, resultKeyId: "pk-1", at: T1 });
    assertEquals((await store.getSignIn("si-1"))?.resultKeyId, "pk-1");

    await store.createSignIn(signIn({ id: "si-2", state: "state-2" }));
    assertEquals(await store.claimSignIn("si-2", T1), null, "expired: nothing to claim");
    await store.pruneSignIns("2026-01-02T00:00:00.000Z");
    assertEquals(await store.getSignIn("si-1"), null);
    assertEquals(await store.getSignIn("si-2"), null);
  } finally {
    await store.close();
  }
});

test("drizzle store: the provider key lock runs its holder and lets go after a throw", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    assertEquals(await store.withProviderKeyLock("pk-1", () => Promise.resolve(42)), 42);
    let threw = false;
    try {
      await store.withProviderKeyLock("pk-1", () => Promise.reject(new Error("boom")));
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals(await store.withProviderKeyLock("pk-1", () => Promise.resolve("again")), "again");
  } finally {
    await store.close();
  }
});

test("drizzle store: each lock takes its own connection, one at a time, and gives it back", async () => {
  const handle = await makeTestDb();
  let opened = 0;
  let closed = 0;
  let failNext = true;
  const store = drizzleKeyStore({
    ...handle,
    lockSession: async () => {
      // The first connection cannot be had: that acquisition fails, and only that one.
      if (failNext) {
        failNext = false;
        throw new Error("pool exhausted");
      }
      opened++;
      const session = await handle.lockSession();
      return {
        ...session,
        close: () => {
          closed++;
          return session.close();
        },
      };
    },
  });
  try {
    let threw = false;
    try {
      await store.withProviderKeyLock("pk-1", () => Promise.resolve(1));
    } catch {
      threw = true;
    }
    assert(threw);
    // Two keys at once still run one after the other, never two connections held together.
    let inside = 0;
    let most = 0;
    const hold = async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inside--;
    };
    await Promise.all([
      store.withProviderKeyLock("pk-1", hold),
      store.withProviderKeyLock("pk-2", hold),
      store.withProviderKeyLock("pk-1", hold),
    ]);
    assertEquals(most, 1);
    assertEquals([opened, closed], [3, 3], "a connection per acquisition, each given back");
  } finally {
    await store.close();
  }
});

test("drizzle store: the secret swap and the status marks are conditional writes", async () => {
  const store = drizzleKeyStore(await makeTestDb());
  try {
    await store.createProviderKey({ ...key, provider: "chatgpt-plan", planStatus: "active" });
    assertEquals(await store.replaceProviderKeySecret("pk-1", "not-this", "next", T1), false);
    assertEquals((await store.getProviderKey("pk-1"))?.encryptedSecret, key.encryptedSecret);
    assertEquals(
      await store.replaceProviderKeySecret("pk-1", key.encryptedSecret, "next", T1),
      true,
    );
    assertEquals((await store.getProviderKey("pk-1"))?.encryptedSecret, "next");

    assertEquals(await store.clearPlanLimited("pk-1", T1), false, "active: nothing to clear");
    assertEquals(await store.markPlanLimited("pk-1", T1), true);
    const limited = (await store.getProviderKey("pk-1"))!;
    assertEquals([limited.planStatus, limited.planLimitedAt], ["limited", T1]);
    assertEquals(await store.clearPlanLimited("pk-1", T1), true);
    assertEquals((await store.getProviderKey("pk-1"))?.planStatus, "active");

    // Only over the secret found unreadable: a token set written since is not marked.
    assertEquals(await store.markPlanNeedsReauth("pk-1", key.encryptedSecret, T1), false);
    assertEquals((await store.getProviderKey("pk-1"))?.planStatus, "active");
    assertEquals(await store.markPlanNeedsReauth("pk-1", "next", T1), true);
    assertEquals((await store.getProviderKey("pk-1"))?.planStatus, "needs_reauth");
    await store.updateProviderKey("pk-1", { planStatus: "active", updatedAt: T1 });

    await store.updateProviderKey("pk-1", { planStatus: "needs_reauth", updatedAt: T1 });
    assertEquals(await store.markPlanLimited("pk-1", T1), false, "needs_reauth says more");
    assertEquals(await store.clearPlanLimited("pk-1", T1), false);
    assertEquals((await store.getProviderKey("pk-1"))?.planStatus, "needs_reauth");
  } finally {
    await store.close();
  }
});
