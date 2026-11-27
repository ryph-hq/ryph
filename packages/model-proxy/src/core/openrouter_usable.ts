// The OpenRouter models agents may use right now (enabled, still listed, and taking tools), as the
// proxy reads them on every OpenRouter call.
//
// The proxy holds each call to this set as well as to its credential's allowlist, so a model an
// admin turns off, or one a sync unlists or finds no longer takes tools, stops working at once, in
// runs already going too: the allowlist was narrowed when the credential was issued, and a run can
// hold one for hours. Reading
// every enabled row per call would put a query on the hot path, so the set is cached the way the
// price overlay is.
//
// Invariants:
// - a cached set is at most `USABLE_TTL_MS` old. That is the window in which a model turned off in
//   ANOTHER process (a second proxy replica) still answers; a change made in this process (the
//   enabled set saved, a sync written) drops the cache at once (`invalidate`)
// - a model turned ON in another process answers within a second: the proxy rereads the store
//   (`reread`) before it refuses a model the cached set lacks. Only refusals pay that query, and
//   they cannot be made to pay it on every call: rereads in flight are shared, at most one starts
//   per `REREAD_EVERY_MS`, and a reread never drops the cache first, so a run looping on a model
//   that is off costs the store one query a second and costs every other caller nothing
// - a read that began before an invalidation never puts its answer in the cache: it may predate
//   the change
// - issuing a credential never reads this: it reads the store, so a run is never issued a model
//   that was turned off a minute ago

import type { OpenRouterModel } from "./openrouter.ts";
import type { KeyStore } from "../ports/key_store.ts";

/** How long one reading of the usable set is trusted; the price overlay's TTL. */
export const USABLE_TTL_MS = 60_000;

/** The least time between the starts of two rereads: how late a model enabled in another process
 * can be served after a refusal, and how often refusals can make the store answer. */
export const REREAD_EVERY_MS = 1_000;

export interface UsableOpenRouterModels {
  /** The usable set, read from the store at most `USABLE_TTL_MS` ago. */
  get(): Promise<OpenRouterModel[]>;
  /** Drops the cached set, so the next `get` reads the store. */
  invalidate(): void;
  /** The set as the store holds it now, cached afresh once the read completes; the cache stands
   * meanwhile. Shares a reread in flight, and answers the cache (`get`) when one started less than
   * `REREAD_EVERY_MS` ago. */
  reread(): Promise<OpenRouterModel[]>;
}

export function makeUsableOpenRouterModels(deps: {
  store: KeyStore;
  now(): Date;
  ttlMs?: number;
}): UsableOpenRouterModels {
  const ttlMs = deps.ttlMs ?? USABLE_TTL_MS;
  let cached: { models: OpenRouterModel[]; freshUntilMs: number } | null = null;
  let generation = 0;
  /** Reads the store, and caches the answer unless an invalidation came while it was out. */
  const read = async (nowMs: number) => {
    const started = generation;
    const models = await deps.store.listUsableOpenRouterModels();
    if (started === generation) cached = { models, freshUntilMs: nowMs + ttlMs };
    return models;
  };
  const get = async () => {
    const nowMs = deps.now().getTime();
    if (cached !== null && nowMs < cached.freshUntilMs) return cached.models;
    return await read(nowMs);
  };
  const invalidate = () => {
    generation += 1;
    cached = null;
  };
  let rereading: Promise<OpenRouterModel[]> | null = null;
  let lastRereadMs = -Infinity;
  const reread = (): Promise<OpenRouterModel[]> => {
    if (rereading !== null) return rereading;
    const nowMs = deps.now().getTime();
    if (nowMs - lastRereadMs < REREAD_EVERY_MS) return get();
    lastRereadMs = nowMs;
    const pending = read(nowMs).finally(() => {
      if (rereading === pending) rereading = null;
    });
    rereading = pending;
    return pending;
  };
  return { get, invalidate, reread };
}
