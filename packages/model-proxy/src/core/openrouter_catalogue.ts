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
// - AT MOST ONE SYNC RUNS DEPLOYMENT-WIDE, and a sync's writes land only while it holds the claim.
//   A sync takes the store's one claim (`claimOpenRouterSync`) before it reads OpenRouter, and
//   writes the catalogue and its state only under that claim: the store refuses a write for a
//   claim that lapsed. Two syncs at once would each count a miss for the same short list (and an
//   enabled model would be unlisted on one bad answer), and the one that ended last would write
//   its older state over the newer
// - the claim lapses on its own (`SYNC_CLAIM_MS`), so a holder that died mid-sync blocks the
//   next one for that long and no longer. It is timed on the store's clock, which every replica
//   shares
// - `syncing` is the claim's: true on every replica while any replica syncs
// - who cannot claim: a background or lazy sync leaves it to the holder; a sync someone waits on
//   (an admin's "Sync now", a first key's save) waits the holder out and answers what it found,
//   and a forced one then runs its own
// - in this process a second caller joins the sync in flight rather than asking the store again
// - each sync's time is later than the last one's, whatever this replica's clock says: the miss
//   count tells this sync's rows from the last one's by it, and a state never goes back in time
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
// - `sync` never throws, a store that fails its first read included: every step is inside the
//   one try, and a failure is recorded like any other

import {
  catalogueOf,
  MAX_CATALOGUE_MODELS,
  OPENROUTER_SYNC_SHRUNK,
  type OpenRouterSync,
  OpenRouterSyncClaimLost,
  type OpenRouterSyncEnd,
} from "./openrouter.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { type OpenRouterApi, OpenRouterApiError } from "../ports/openrouter_api.ts";

/** How old a sync may get before a read starts another. */
export const OPENROUTER_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How soon after a failed attempt a read may try again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/** How long a sync's claim holds. Well past the model list's own timeout and a write of the
 * largest list, so a live sync never outlives it; and what a holder that died costs the next. */
export const SYNC_CLAIM_MS = 2 * 60 * 1000;

/** How often a sync that waits out another's claim looks again. */
const CLAIM_POLL_MS = 250;

/** How long a sync waits out others' claims before it gives up: one whole claim, and a margin. */
const CLAIM_WAIT_MS = SYNC_CLAIM_MS + 30_000;

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
  /** Resolves after `ms`: between looks at another replica's claim. Injectable for tests. */
  sleep?(ms: number): Promise<void>;
}

export interface OpenRouterCatalogue {
  /** Syncs now — or, when a sync is running anywhere, waits for it and answers the state it
   * left — and answers that state. Never throws for OpenRouter's sake: a failure is in the
   * state's `error`. `force` takes a list that lost more than half the models the last one
   * listed; only an admin's "Sync now" passes it, and it waits out a sync in flight and then runs
   * its own, rather than answering the other's. */
  sync(opts?: { force?: boolean }): Promise<OpenRouterSync>;
  /** Starts a sync when the last one is older than `maxAgeMs` and no attempt failed in the last
   * few minutes. Resolves once that is decided, with whether a sync is now running anywhere: from
   * then on the store's state says so, which is what lets a read that started one answer that
   * it did. The sync itself runs on in the background. */
  startIfStale(maxAgeMs?: number): Promise<boolean>;
  /** `startIfStale`, resolving when the sync it started in this process ends (or at once when
   * none was needed, or another replica's runs). */
  syncIfStale(maxAgeMs?: number): Promise<void>;
  /** Whether a sync is running in this process. The store's state says it for every process. */
  syncing(): boolean;
}

export function makeOpenRouterCatalogue(deps: OpenRouterCatalogueDeps): OpenRouterCatalogue {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let inFlight: Promise<OpenRouterSync> | null = null;

  /** A sync's failure, as the state records it. */
  class SyncRefused extends Error {
    constructor(message: string, readonly code: string | null = null) {
      super(message);
    }
  }

  const ageOf = (iso: string | null | undefined) =>
    iso === null || iso === undefined ? Infinity : deps.now().getTime() - Date.parse(iso);

  /** Whether `state` needs no sync: synced within `maxAgeMs`, or failed too recently to retry. */
  const fresh = (state: OpenRouterSync | null, maxAgeMs: number) =>
    ageOf(state?.syncedAt) < maxAgeMs ||
    (state?.error !== null && state?.error !== undefined &&
      ageOf(state.attemptedAt) < RETRY_AFTER_MS);

  /** One sync, under `claim`, which this has taken. `ifOlderThan` makes it a stale sync, which
   * gives the claim back unused when another replica synced between the look and the claim. */
  const runClaimed = async (
    claim: string,
    opts: { force: boolean; ifOlderThan?: number },
  ): Promise<OpenRouterSync> => {
    let at = deps.now().toISOString();
    // Undefined until the store answers: a sync whose first read failed has no state to keep.
    let previous: OpenRouterSync | null | undefined;
    try {
      previous = await deps.store.getOpenRouterSync();
      if (opts.ifOlderThan !== undefined && fresh(previous, opts.ifOlderThan)) {
        await deps.store.endOpenRouterSync(claim, null);
        return { ...previous!, syncing: false };
      }
      // Later than the last sync's, whichever replica's clock that was: see the invariants.
      const last = previous?.attemptedAt ? Date.parse(previous.attemptedAt) : -Infinity;
      if (!(Date.parse(at) > last)) at = new Date(last + 1).toISOString();
      const rows = catalogueOf(await deps.api.listModels());
      if (rows.length === 0) throw new SyncRefused("OpenRouter's model list had no model in it");
      if (rows.length > MAX_CATALOGUE_MODELS) {
        throw new SyncRefused(
          `OpenRouter's model list had ${rows.length} models, more than the ` +
            `${MAX_CATALOGUE_MODELS} a sync takes`,
        );
      }
      const listed = await deps.store.countListedOpenRouterModels();
      if (!opts.force && rows.length * 2 < listed) {
        throw new SyncRefused(
          `OpenRouter's model list had ${rows.length} usable models, down from ${listed}, so ` +
            "the old list was kept",
          OPENROUTER_SYNC_SHRUNK,
        );
      }
      try {
        await deps.store.upsertOpenRouterCatalogue(rows, at, claim);
      } catch (err) {
        if (err instanceof OpenRouterSyncClaimLost) throw err;
        deps.diag.warn("openrouter.sync_write_failed", { error: shortError(err) });
        throw new SyncRefused("could not save OpenRouter's model list");
      }
      deps.changed?.();
      const state: OpenRouterSyncEnd = {
        syncedAt: at,
        attemptedAt: at,
        error: null,
        errorCode: null,
      };
      if (!(await deps.store.endOpenRouterSync(claim, state))) {
        // The catalogue landed while the claim held; only the state's word on it did not.
        deps.diag.warn("openrouter.sync_claim_lapsed", { stage: "state" });
      }
      deps.diag.debug("openrouter.synced", { models: rows.length, forced: opts.force });
      return { ...state, syncing: false };
    } catch (err) {
      // OpenRouter's own failures and this file's say what happened in a line; anything else is
      // a store's, whose message is no business of the admin's.
      const error = err instanceof SyncRefused || err instanceof OpenRouterApiError
        ? err.message
        : err instanceof OpenRouterSyncClaimLost
        ? "the sync ran out of time before it could save OpenRouter's model list"
        : "the sync failed";
      deps.diag.warn("openrouter.sync_failed", { error, cause: shortError(err) });
      // The last good sync's time is kept, so it is read once more when the first read failed;
      // if the store still cannot say, the claim is given back with nothing written rather than
      // a state that forgets it.
      if (previous === undefined) {
        previous = await deps.store.getOpenRouterSync().catch(() => undefined);
      }
      const state: OpenRouterSyncEnd = {
        syncedAt: previous?.syncedAt ?? null,
        attemptedAt: at,
        error,
        errorCode: err instanceof SyncRefused ? err.code : null,
      };
      // A store that is down cannot hold the state either; the caller still gets it. A claim
      // that lapsed writes nothing: the end refuses it.
      await deps.store.endOpenRouterSync(claim, previous === undefined ? null : state)
        .catch(() => {});
      return { ...state, syncing: false };
    }
  };

  /** A sync someone waits on: this process's claim, or the end of another's. */
  const waitedSync = async (force: boolean): Promise<OpenRouterSync> => {
    const at = deps.now().toISOString();
    try {
      // The state as it stood when another sync was first seen holding the claim: once it has
      // moved on and the claim is free, that sync has ended, and what it found is the answer to
      // a plain sync. A forced one claims after it instead.
      let before: OpenRouterSync | null | undefined;
      for (let tries = 0;; tries++) {
        if (before !== undefined) {
          const state = await deps.store.getOpenRouterSync();
          if (!force && !state?.syncing && state?.attemptedAt !== before?.attemptedAt) {
            return state!;
          }
        }
        const claim = crypto.randomUUID();
        if (await deps.store.claimOpenRouterSync(claim, SYNC_CLAIM_MS)) {
          return await runClaimed(claim, { force });
        }
        if (before === undefined) {
          before = await deps.store.getOpenRouterSync();
          // The holder ended between the claim and the look: what it found is the answer.
          if (!force && before !== null && !before.syncing) return before;
        }
        if (tries * CLAIM_POLL_MS >= CLAIM_WAIT_MS) {
          const state = await deps.store.getOpenRouterSync();
          return {
            syncedAt: state?.syncedAt ?? null,
            attemptedAt: state?.attemptedAt ?? null,
            error: "another sync is still running",
            errorCode: null,
            syncing: state?.syncing ?? true,
          };
        }
        await sleep(CLAIM_POLL_MS);
      }
    } catch (err) {
      // The store failed the claim or a look at it: nothing was read from OpenRouter, and
      // nothing is written.
      deps.diag.warn("openrouter.sync_failed", {
        error: "the sync failed",
        cause: shortError(err),
      });
      const state = await deps.store.getOpenRouterSync().catch(() => null);
      return {
        syncedAt: state?.syncedAt ?? null,
        attemptedAt: at,
        error: "the sync failed",
        errorCode: null,
        syncing: state?.syncing ?? false,
      };
    }
  };

  const track = (sync: Promise<OpenRouterSync>): Promise<OpenRouterSync> => {
    const started = sync.finally(() => {
      if (inFlight === started) inFlight = null;
    });
    inFlight = started;
    return started;
  };

  const sync = async (opts: { force?: boolean } = {}): Promise<OpenRouterSync> => {
    if (opts.force !== true) return await (inFlight ?? track(waitedSync(false)));
    // A forced sync must be the one that runs: the one in flight may refuse the very list the
    // admin means to take.
    while (inFlight !== null) await inFlight;
    return await track(waitedSync(true));
  };

  const startIfStale = async (maxAgeMs = OPENROUTER_SYNC_MAX_AGE_MS): Promise<boolean> => {
    if (inFlight !== null) return true;
    const state = await deps.store.getOpenRouterSync();
    // Another caller may have started one while the state was read.
    if (inFlight !== null) return true;
    if (state?.syncing === true) return true;
    if (fresh(state, maxAgeMs)) return false;
    const claim = crypto.randomUUID();
    // Taken before this resolves, so the state reads `syncing` from here on, everywhere. One
    // that cannot be taken is another sync's, running now.
    if (!(await deps.store.claimOpenRouterSync(claim, SYNC_CLAIM_MS))) return true;
    // Nobody awaits it here, so its failure is logged rather than left unhandled.
    track(runClaimed(claim, { force: false, ifOlderThan: maxAgeMs })).catch((err) =>
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
