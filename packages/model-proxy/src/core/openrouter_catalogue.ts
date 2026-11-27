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
//   and a forced one then runs its own. A plain one answers only a sync that ENDED after it began
//   waiting, with a state written: one that ended writing nothing (its store was down) is no
//   answer, and neither is a state no sync has written yet
// - in this process a second caller joins the sync in flight rather than asking the store again,
//   and a second forced one joins the forced one waiting its turn
// - a sync someone waits on is answered within `SYNC_WAIT_MS` of its call, whatever it waits for:
//   the syncs in flight here and the claim another replica holds. Past that it answers the state
//   as it stands, as still running (`OPENROUTER_SYNC_STILL_RUNNING`), and what it waited for runs
//   on in the background; the picker reads again while a sync runs
// - a sync's time is the STORE's clock, taken with the claim, never this replica's: the miss count
//   tells this sync's rows from the last one's by it, and the state's times are what every
//   replica judges staleness by. A replica whose clock runs fast would otherwise stamp a time in
//   the future, and every replica would think the catalogue fresh until that time came
// - a sync whose time is in the future, by this replica's clock or the store's, is stale: a state
//   that some clock stamped wrong never stops the next sync
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

/** How long a sync someone waits on may take to answer, from the call: one whole claim of
 * another replica's, and a margin. */
export const SYNC_WAIT_MS = SYNC_CLAIM_MS + 30_000;

/** The error of a sync that was still waiting when its time to answer ran out. */
export const OPENROUTER_SYNC_STILL_RUNNING = "another sync is still running";

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
   * left — and answers that state, within `SYNC_WAIT_MS` (past it, the state as it stands, as
   * still running). Never throws for OpenRouter's sake: a failure is in the state's `error`.
   * `force` takes a list that lost more than half the models the last one listed; only an
   * admin's "Sync now" passes it, and it waits out a sync in flight and then runs its own, rather
   * than answering the other's. */
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
  /** A forced sync waiting in this process for `inFlight` to end, which later ones join. */
  let queuedForce: Promise<OpenRouterSync> | null = null;

  /** A sync's failure, as the state records it. */
  class SyncRefused extends Error {
    constructor(message: string, readonly code: string | null = null) {
      super(message);
    }
  }

  /** How long ago `iso` was at `nowMs`. A time in the future, or none, is infinitely long ago:
   * a clock that stamped it wrong must not hold the next sync off until it comes. */
  const ageOf = (iso: string | null | undefined, nowMs: number) => {
    const age = iso === null || iso === undefined ? NaN : nowMs - Date.parse(iso);
    return Number.isFinite(age) && age >= 0 ? age : Infinity;
  };

  /** Whether `state` needs no sync at `nowMs`: synced within `maxAgeMs`, or failed too recently
   * to retry. */
  const fresh = (state: OpenRouterSync | null, maxAgeMs: number, nowMs: number) =>
    ageOf(state?.syncedAt, nowMs) < maxAgeMs ||
    (state?.error !== null && state?.error !== undefined &&
      ageOf(state.attemptedAt, nowMs) < RETRY_AFTER_MS);

  /**
   * One sync, under `claim`, which this has taken at `at` by the store's clock. `ifOlderThan`
   * makes it a stale sync, which gives the claim back unused when another replica synced between
   * the look and the claim. `answerIfMovedFrom` makes it a plain sync someone waits on, which
   * gives the claim back and answers the state when a sync ended, with a state written, since
   * the caller first looked (when it saw `attemptedAt`).
   */
  const runClaimed = async (
    claim: string,
    at: string,
    opts: { force: boolean; ifOlderThan?: number; answerIfMovedFrom?: string | null },
  ): Promise<OpenRouterSync> => {
    // Undefined until the store answers: a sync whose first read failed has no state to keep.
    let previous: OpenRouterSync | null | undefined;
    try {
      previous = await deps.store.getOpenRouterSync();
      if (opts.ifOlderThan !== undefined && fresh(previous, opts.ifOlderThan, Date.parse(at))) {
        await deps.store.endOpenRouterSync(claim, null);
        return { ...previous!, syncing: false };
      }
      if (
        opts.answerIfMovedFrom !== undefined && previous !== null &&
        previous.attemptedAt !== null && previous.attemptedAt !== opts.answerIfMovedFrom
      ) {
        await deps.store.endOpenRouterSync(claim, null);
        return { ...previous, syncing: false };
      }
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

  /** The state as it stands, answered as a sync still running: what a caller whose time ran out
   * is told. */
  const stillRunning = async (): Promise<OpenRouterSync> => {
    const state = await deps.store.getOpenRouterSync().catch(() => null);
    return {
      syncedAt: state?.syncedAt ?? null,
      attemptedAt: state?.attemptedAt ?? null,
      error: OPENROUTER_SYNC_STILL_RUNNING,
      errorCode: null,
      syncing: true,
    };
  };

  /** A sync someone waits on, until `deadlineMs`: this process's claim, or the end of another's. */
  const waitedSync = async (force: boolean, deadlineMs: number): Promise<OpenRouterSync> => {
    try {
      // The state as it stood before this tried for the claim: once a sync has ended since,
      // having written a state, what it found is the answer to a plain sync. A forced one claims
      // after it instead.
      const seen = force ? undefined : (await deps.store.getOpenRouterSync())?.attemptedAt ?? null;
      for (;;) {
        const claim = crypto.randomUUID();
        const at = await deps.store.claimOpenRouterSync(claim, SYNC_CLAIM_MS);
        if (at !== null) return await runClaimed(claim, at, { force, answerIfMovedFrom: seen });
        if (seen !== undefined) {
          const state = await deps.store.getOpenRouterSync();
          const ended = state !== null && !state.syncing && state.attemptedAt !== null;
          if (ended && state.attemptedAt !== seen) return state;
        }
        if (deps.now().getTime() >= deadlineMs) return await stillRunning();
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
        attemptedAt: state?.attemptedAt ?? null,
        error: "the sync failed",
        errorCode: null,
        syncing: state?.syncing ?? false,
      };
    }
  };

  /** `work`'s answer, or, once `deadlineMs` passes first, the state as still running. Looks at
   * the time every `CLAIM_POLL_MS`, so a test's clock can move it. */
  const within = async (
    work: Promise<OpenRouterSync>,
    deadlineMs: number,
  ): Promise<OpenRouterSync> => {
    const done = work.then((state) => ({ state }));
    for (;;) {
      const left = deadlineMs - deps.now().getTime();
      if (left <= 0) return await stillRunning();
      const first = await Promise.race([
        done,
        sleep(Math.min(left, CLAIM_POLL_MS)).then(() => null),
      ]);
      if (first !== null) return first.state;
    }
  };

  const track = (sync: Promise<OpenRouterSync>): Promise<OpenRouterSync> => {
    const started = sync.finally(() => {
      if (inFlight === started) inFlight = null;
    });
    inFlight = started;
    return started;
  };

  /** A forced sync, run once the one in flight here ends (it may refuse the very list the admin
   * means to take), or the forced one already waiting for that, which takes the same next list. */
  const forced = (deadlineMs: number): Promise<OpenRouterSync> => {
    if (queuedForce !== null) return queuedForce;
    if (inFlight === null) return track(waitedSync(true, deadlineMs));
    queuedForce = (async () => {
      while (inFlight !== null) await inFlight;
      queuedForce = null;
      return await track(waitedSync(true, deadlineMs));
    })();
    return queuedForce;
  };

  const sync = async (opts: { force?: boolean } = {}): Promise<OpenRouterSync> => {
    const deadlineMs = deps.now().getTime() + SYNC_WAIT_MS;
    const work = opts.force === true
      ? forced(deadlineMs)
      : inFlight ?? queuedForce ?? track(waitedSync(false, deadlineMs));
    return await within(work, deadlineMs);
  };

  const startIfStale = async (maxAgeMs = OPENROUTER_SYNC_MAX_AGE_MS): Promise<boolean> => {
    if (inFlight !== null || queuedForce !== null) return true;
    const state = await deps.store.getOpenRouterSync();
    // Another caller may have started one while the state was read.
    if (inFlight !== null || queuedForce !== null) return true;
    if (state?.syncing === true) return true;
    // This replica's clock decides only whether to look closer: the sync checks again by the
    // store's, once it holds the claim.
    if (fresh(state, maxAgeMs, deps.now().getTime())) return false;
    const claim = crypto.randomUUID();
    // Taken before this resolves, so the state reads `syncing` from here on, everywhere. One
    // that cannot be taken is another sync's, running now.
    const at = await deps.store.claimOpenRouterSync(claim, SYNC_CLAIM_MS);
    if (at === null) return true;
    // Nobody awaits it here, so its failure is logged rather than left unhandled.
    track(runClaimed(claim, at, { force: false, ifOlderThan: maxAgeMs })).catch((err) =>
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
    syncing: () => inFlight !== null || queuedForce !== null,
  };
}

/** An error's first line, cut short: enough for a log, never a whole statement and its values. */
function shortError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = text.split("\n", 1)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
