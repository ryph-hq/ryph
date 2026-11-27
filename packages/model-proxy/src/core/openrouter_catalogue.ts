// Keeping OpenRouter's catalogue in the store: one sync reads its public model list and writes it
// (core/openrouter.ts turns the JSON into rows), and the sync's state says when that last worked.
//
// What starts a sync, and why there is no timer: the first OpenRouter key saved (awaited, briefly,
// so the model list is there when the admin goes to pick), an admin's "Sync now", and a read of the
// provider list or the catalogue while a live OpenRouter key exists and the last sync is a day old
// (in the background, never holding the read). A deployment with no OpenRouter key never dials
// OpenRouter at all.
//
// Invariants:
// - ONE sync at a time in this process: a second caller waits for the one in flight
// - a failed sync changes no model row: the old catalogue stands, and the state says what failed
// - a list with no model in it is a failure, not an empty catalogue: it would mark every model
//   unlisted, and with that take every enabled one away from agents

import { catalogueOf, type OpenRouterSync } from "./openrouter.ts";
import type { KeyStore } from "../ports/key_store.ts";
import type { OpenRouterApi } from "../ports/openrouter_api.ts";

/** How old a sync may get before a read starts another. */
export const OPENROUTER_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How soon after a failed attempt a read may try again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export interface OpenRouterCatalogueDeps {
  store: KeyStore;
  api: OpenRouterApi;
  now(): Date;
  diag: {
    debug(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
}

export interface OpenRouterCatalogue {
  /** Syncs now — or joins the sync already running — and answers the state it left. Never
   * throws for OpenRouter's sake: a failure is in the state's `error`. */
  sync(): Promise<OpenRouterSync>;
  /** Starts a sync when the last one is older than `maxAgeMs` and no attempt failed in the last
   * few minutes; resolves when that sync ends (or at once when none was needed). */
  syncIfStale(maxAgeMs?: number): Promise<void>;
  /** Whether a sync is running in this process. */
  syncing(): boolean;
}

export function makeOpenRouterCatalogue(deps: OpenRouterCatalogueDeps): OpenRouterCatalogue {
  let inFlight: Promise<OpenRouterSync> | null = null;

  const run = async (): Promise<OpenRouterSync> => {
    const previous = await deps.store.getOpenRouterSync();
    const at = deps.now().toISOString();
    try {
      const rows = catalogueOf(await deps.api.listModels());
      if (rows.length === 0) throw new Error("OpenRouter's model list had no model in it");
      await deps.store.upsertOpenRouterCatalogue(rows, at);
      const state = { syncedAt: at, attemptedAt: at, error: null };
      await deps.store.putOpenRouterSync(state);
      deps.diag.debug("openrouter.synced", { models: rows.length });
      return state;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.diag.warn("openrouter.sync_failed", { error });
      const state = { syncedAt: previous?.syncedAt ?? null, attemptedAt: at, error };
      // A store that is down cannot hold the state either; the caller still gets it.
      await deps.store.putOpenRouterSync(state).catch(() => {});
      return state;
    }
  };

  const sync = (): Promise<OpenRouterSync> => {
    if (inFlight !== null) return inFlight;
    const started = run().finally(() => {
      inFlight = null;
    });
    inFlight = started;
    return started;
  };

  return {
    sync,
    async syncIfStale(maxAgeMs = OPENROUTER_SYNC_MAX_AGE_MS) {
      if (inFlight !== null) return;
      const state = await deps.store.getOpenRouterSync();
      const nowMs = deps.now().getTime();
      const age = (iso: string | null | undefined) =>
        iso === null || iso === undefined ? Infinity : nowMs - Date.parse(iso);
      if (age(state?.syncedAt) < maxAgeMs) return;
      if (
        state?.error !== null && state?.error !== undefined &&
        age(state.attemptedAt) < RETRY_AFTER_MS
      ) {
        return;
      }
      await sync();
    },
    syncing: () => inFlight !== null,
  };
}
