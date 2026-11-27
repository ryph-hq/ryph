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
// - so is a list with less than half the models the last one listed, unless an admin's "Sync now"
//   says to take it anyway (`force`): a short answer is likelier than half of OpenRouter vanishing.
//   That failure carries a code (OPENROUTER_SYNC_SHRUNK), so the admin is offered the force
// - an enabled model one list leaves out stays listed until a second leaves it out too
//   (`MISSES_BEFORE_UNLISTED`, the store's to count)
// - the error a failed sync records is short and says nothing of the store's internals: it is
//   shown to the admin, and a failed write's message can carry the whole statement

import {
  catalogueOf,
  MAX_CATALOGUE_MODELS,
  OPENROUTER_SYNC_SHRUNK,
  type OpenRouterSync,
} from "./openrouter.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { type OpenRouterApi, OpenRouterApiError } from "../ports/openrouter_api.ts";

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
  /** Told after a sync wrote the catalogue: what agents may use can have changed with it. */
  changed?(): void;
}

export interface OpenRouterCatalogue {
  /** Syncs now — or joins the sync already running — and answers the state it left. Never
   * throws for OpenRouter's sake: a failure is in the state's `error`. `force` takes a list that
   * lost more than half the models the last one listed; only an admin's "Sync now" passes it,
   * and it waits out a sync in flight rather than joining it. */
  sync(opts?: { force?: boolean }): Promise<OpenRouterSync>;
  /** Starts a sync when the last one is older than `maxAgeMs` and no attempt failed in the last
   * few minutes. Resolves once that is decided, with whether a sync is now running: from then on
   * `syncing()` says so, which is what lets a read that started one answer that it did. The sync
   * itself runs on in the background. */
  startIfStale(maxAgeMs?: number): Promise<boolean>;
  /** `startIfStale`, resolving when the sync it started ends (or at once when none was needed). */
  syncIfStale(maxAgeMs?: number): Promise<void>;
  /** Whether a sync is running in this process. */
  syncing(): boolean;
}

export function makeOpenRouterCatalogue(deps: OpenRouterCatalogueDeps): OpenRouterCatalogue {
  let inFlight: Promise<OpenRouterSync> | null = null;

  /** A sync's failure, as the state records it. */
  class SyncRefused extends Error {
    constructor(message: string, readonly code: string | null = null) {
      super(message);
    }
  }

  const run = async (force: boolean): Promise<OpenRouterSync> => {
    const previous = await deps.store.getOpenRouterSync();
    const at = deps.now().toISOString();
    try {
      const rows = catalogueOf(await deps.api.listModels());
      if (rows.length === 0) throw new SyncRefused("OpenRouter's model list had no model in it");
      if (rows.length > MAX_CATALOGUE_MODELS) {
        throw new SyncRefused(
          `OpenRouter's model list had ${rows.length} models, more than the ` +
            `${MAX_CATALOGUE_MODELS} a sync takes`,
        );
      }
      const listed = await deps.store.countListedOpenRouterModels();
      if (!force && rows.length * 2 < listed) {
        throw new SyncRefused(
          `OpenRouter's model list had ${rows.length} usable models, down from ${listed}, so ` +
            "the old list was kept",
          OPENROUTER_SYNC_SHRUNK,
        );
      }
      try {
        await deps.store.upsertOpenRouterCatalogue(rows, at);
      } catch (err) {
        deps.diag.warn("openrouter.sync_write_failed", { error: shortError(err) });
        throw new SyncRefused("could not save OpenRouter's model list");
      }
      deps.changed?.();
      const state = { syncedAt: at, attemptedAt: at, error: null, errorCode: null };
      await deps.store.putOpenRouterSync(state);
      deps.diag.debug("openrouter.synced", { models: rows.length, forced: force });
      return state;
    } catch (err) {
      // OpenRouter's own failures and this file's say what happened in a line; anything else is
      // a store's, whose message is no business of the admin's.
      const error = err instanceof SyncRefused || err instanceof OpenRouterApiError
        ? err.message
        : "the sync failed";
      deps.diag.warn("openrouter.sync_failed", { error, cause: shortError(err) });
      const state = {
        syncedAt: previous?.syncedAt ?? null,
        attemptedAt: at,
        error,
        errorCode: err instanceof SyncRefused ? err.code : null,
      };
      // A store that is down cannot hold the state either; the caller still gets it.
      await deps.store.putOpenRouterSync(state).catch(() => {});
      return state;
    }
  };

  const start = (force: boolean): Promise<OpenRouterSync> => {
    const started = run(force).finally(() => {
      if (inFlight === started) inFlight = null;
    });
    inFlight = started;
    return started;
  };

  const sync = async (opts: { force?: boolean } = {}): Promise<OpenRouterSync> => {
    if (opts.force !== true) return inFlight ?? start(false);
    // A forced sync must be the one that runs: the one in flight may refuse the very list the
    // admin means to take.
    while (inFlight !== null) await inFlight;
    return start(true);
  };

  const startIfStale = async (maxAgeMs = OPENROUTER_SYNC_MAX_AGE_MS): Promise<boolean> => {
    if (inFlight !== null) return true;
    const state = await deps.store.getOpenRouterSync();
    // Another caller may have started one while the state was read.
    if (inFlight !== null) return true;
    const nowMs = deps.now().getTime();
    const age = (iso: string | null | undefined) =>
      iso === null || iso === undefined ? Infinity : nowMs - Date.parse(iso);
    if (age(state?.syncedAt) < maxAgeMs) return false;
    if (
      state?.error !== null && state?.error !== undefined &&
      age(state.attemptedAt) < RETRY_AFTER_MS
    ) {
      return false;
    }
    // Marked in flight before this resolves; nobody awaits it here, so its failure is logged
    // rather than left unhandled.
    start(false).catch((err) =>
      deps.diag.warn("openrouter.sync_failed", { error: shortError(err) })
    );
    return true;
  };

  return {
    sync,
    startIfStale,
    async syncIfStale(maxAgeMs) {
      if (await startIfStale(maxAgeMs)) await inFlight?.catch(() => {});
    },
    syncing: () => inFlight !== null,
  };
}

/** An error's first line, cut short: enough for a log, never a whole statement and its values. */
function shortError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = text.split("\n", 1)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
