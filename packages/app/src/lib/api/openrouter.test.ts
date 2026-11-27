import { describe, expect, it } from "vitest";
import { ApiError } from "./call";
import {
  enableRefusal,
  getOpenRouterCatalogue,
  getOpenRouterKeyInfo,
  isOpenRouterKeyRefused,
  OPENROUTER_SYNC_SHRUNK,
  setOpenRouterEnabled,
  syncOpenRouter,
  syncShrunk,
} from "./openrouter";
import { createProviderKey } from "./provider-keys";

type Seen = { url: string; init: RequestInit | undefined };

/** A fetch that answers every call with `body` and records what it was asked. */
function answering(status: number, body: unknown) {
  const seen: Seen[] = [];
  const f = ((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { f, seen };
}

const sonnet = {
  id: "anthropic/claude-sonnet-4.5",
  label: "Anthropic: Claude Sonnet 4.5",
  contextLength: 1_000_000,
  maxOutputTokens: 64_000,
  vision: true,
  reasoning: true,
  tools: true,
  price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  listed: true,
  enabled: true,
};

const catalogue = {
  models: [sonnet, { ...sonnet, id: "x/unpriced", label: "X", price: null, enabled: false }],
  sync: {
    syncedAt: "2026-11-27T10:00:00.000Z",
    attemptedAt: "2026-11-27T10:00:00.000Z",
    error: null,
    errorCode: null,
    syncing: false,
  },
};

describe("the catalogue", () => {
  it("reads models, unpriced ones included, and the sync", async () => {
    const { f, seen } = answering(200, catalogue);
    const read = await getOpenRouterCatalogue(f);
    expect(seen[0].url).toBe("/api/v1/openrouter/models");
    expect(read.models[1].price).toBeNull();
    expect(read.sync.syncedAt).toBe("2026-11-27T10:00:00.000Z");
    expect(read.sync.errorCode).toBeNull();
  });

  it("reads a sync with no code as null", async () => {
    const { errorCode: _, ...sync } = catalogue.sync;
    const { f } = answering(200, { ...catalogue, sync });
    expect((await getOpenRouterCatalogue(f)).sync.errorCode).toBeNull();
  });

  it("reads the code of a sync refused for a shrunk list", async () => {
    const shrunk = {
      ...catalogue,
      sync: { ...catalogue.sync, error: "down from 300", errorCode: "openrouter_sync_shrunk" },
    };
    const { f } = answering(200, shrunk);
    expect((await getOpenRouterCatalogue(f)).sync.errorCode).toBe("openrouter_sync_shrunk");
  });

  it("reads a sync without an error code as having none, and keeps one it carries", async () => {
    expect((await getOpenRouterCatalogue(answering(200, catalogue).f)).sync.errorCode).toBeNull();
    const shrunk = {
      ...catalogue,
      sync: { ...catalogue.sync, error: "the list shrank", errorCode: OPENROUTER_SYNC_SHRUNK },
    };
    const read = await getOpenRouterCatalogue(answering(200, shrunk).f);
    expect(read.sync.errorCode).toBe(OPENROUTER_SYNC_SHRUNK);
    expect(syncShrunk(read.sync)).toBe(true);
  });

  it("offers forcing only while the shrunk sync is the last failure", () => {
    const sync = { ...catalogue.sync, errorCode: OPENROUTER_SYNC_SHRUNK };
    expect(syncShrunk({ ...sync, error: "the list shrank" })).toBe(true);
    expect(syncShrunk({ ...sync, error: null })).toBe(false);
    expect(syncShrunk({ ...sync, error: "timed out", errorCode: null })).toBe(false);
  });

  it("refuses a model missing a field", async () => {
    const { tools: _, ...broken } = sonnet;
    const { f } = answering(200, { ...catalogue, models: [broken] });
    await expect(getOpenRouterCatalogue(f)).rejects.toThrow();
  });
});

describe("saving the enabled set", () => {
  it("puts the whole set", async () => {
    const { f, seen } = answering(200, catalogue);
    await setOpenRouterEnabled(f, ["a/b", "c/d"]);
    expect(seen[0].url).toBe("/api/v1/openrouter/models/enabled");
    expect(seen[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ ids: ["a/b", "c/d"] });
  });

  it("reads a 400 into its lists", async () => {
    const body = { error: "these models cannot be enabled", unknown: ["a"], unlisted: ["b"] };
    const { f } = answering(400, body);
    const err = await setOpenRouterEnabled(f, ["a", "b"]).catch((e: unknown) => e);
    expect(enableRefusal(err)).toEqual({
      message: "these models cannot be enabled",
      unknown: ["a"],
      unlisted: ["b"],
      noTools: [],
    });
  });

  it("reads nothing into any other failure", () => {
    expect(enableRefusal(new ApiError(500, { error: "x" }, "x"))).toBeNull();
    expect(enableRefusal(new ApiError(400, "nope", "nope"))).toBeNull();
    expect(enableRefusal(new Error("x"))).toBeNull();
  });
});

describe("syncing", () => {
  it("posts with no body unless forced", async () => {
    const plain = answering(200, catalogue);
    expect(await syncOpenRouter(plain.f)).toEqual({
      catalogue: { ...catalogue, sync: { ...catalogue.sync, errorCode: null } },
      failed: false,
    });
    expect(plain.seen[0].url).toBe("/api/v1/openrouter/sync");
    expect(plain.seen[0].init?.method).toBe("POST");
    expect(plain.seen[0].init?.body).toBeUndefined();

    const forced = answering(200, catalogue);
    await syncOpenRouter(forced.f, { force: true });
    expect(JSON.parse(String(forced.seen[0].init?.body))).toEqual({ force: true });
  });

  it("returns the catalogue from a failed sync, with the stored reason", async () => {
    const failed = { ...catalogue, sync: { ...catalogue.sync, error: "timed out" } };
    const { f } = answering(502, { error: "could not sync OpenRouter's models", ...failed });
    expect(await syncOpenRouter(f)).toEqual({
      catalogue: { ...failed, sync: { ...failed.sync, errorCode: null } },
      failed: true,
    });
  });

  it("takes the 502's code when the catalogue carries none", async () => {
    const failed = { ...catalogue, sync: { ...catalogue.sync, error: "the list shrank" } };
    const { f } = answering(502, {
      error: "could not sync OpenRouter's models",
      code: OPENROUTER_SYNC_SHRUNK,
      ...failed,
    });
    const { catalogue: read } = await syncOpenRouter(f);
    expect(read.sync.error).toBe("the list shrank");
    expect(syncShrunk(read.sync)).toBe(true);
  });

  it("throws a 502 that carries no catalogue", async () => {
    const { f } = answering(502, { error: "bad gateway" });
    await expect(syncOpenRouter(f)).rejects.toThrow("bad gateway");
  });
});

describe("a key's credit", () => {
  it("reads the key-status route", async () => {
    const info = { limit: 10, limitRemaining: 4.2, usage: 5.8, isFreeTier: false };
    const { f, seen } = answering(200, info);
    expect(await getOpenRouterKeyInfo(f, "pk 1")).toEqual(info);
    expect(seen[0].url).toBe("/api/v1/provider-keys/pk%201/openrouter");
  });

  it("knows a refused key by its code", async () => {
    const { f } = answering(502, {
      error: "OpenRouter didn't accept this key",
      code: "openrouter_key_refused",
    });
    const err = await getOpenRouterKeyInfo(f, "pk-1").catch((e: unknown) => e);
    expect(isOpenRouterKeyRefused(err)).toBe(true);
    expect(isOpenRouterKeyRefused(new ApiError(400, { code: "other" }, "x"))).toBe(false);
  });
});

describe("saving an OpenRouter key", () => {
  const key = {
    id: "pk-1",
    provider: "openrouter",
    label: "OpenRouter",
    last4: "abcd",
    archivedAt: null,
    createdAt: "2026-11-27T10:00:00.000Z",
    updatedAt: "2026-11-27T10:00:00.000Z",
  };
  const input = { provider: "openrouter", label: "OpenRouter", secret: "sk-or-x" };

  it("keeps the credit or the warning the save answered with", async () => {
    const info = { limit: null, limitRemaining: null, usage: 0, isFreeTier: false };
    const checked = await createProviderKey(answering(201, { ...key, openrouter: info }).f, input);
    expect(checked.openrouter).toEqual(info);
    const unchecked = await createProviderKey(
      answering(201, { ...key, warning: "saved unchecked" }).f,
      input,
    );
    expect(unchecked.warning).toBe("saved unchecked");
  });

  it("throws a refused key with its code", async () => {
    const { f } = answering(400, {
      error: "OpenRouter didn't accept this key",
      code: "openrouter_key_refused",
    });
    const err = await createProviderKey(f, input).catch((e: unknown) => e);
    expect(isOpenRouterKeyRefused(err)).toBe(true);
    expect((err as Error).message).toBe("OpenRouter didn't accept this key");
  });
});
