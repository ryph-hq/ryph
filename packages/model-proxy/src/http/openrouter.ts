// OpenRouter's management routes, beside the provider-key CRUD: the synced catalogue and which of
// its models agents may use, a sync on demand, and what one key's credit looks like.
//
// Invariants:
// - choosing the enabled models is a spending decision, so it is ADMIN-gated, like registering a
//   key; so is reading the whole catalogue, which only the admin's picker needs, and a key's
//   credit, which is the account's. Every signed-in user still sees the ENABLED models, in the
//   provider list
// - a change to the enabled set that changes what the platform's policy may call kills the
//   platform's credentials, as saving the policy does: each consumer re-mints under the new set
// - only a model OpenRouter lists, that takes tools, can be NEWLY enabled: pi drives an agent
//   through tool calls, and a model without them would fail every run on its first turn. One
//   already enabled may stay in the set it is saved with even after it stops qualifying, so a
//   change elsewhere in the list still saves; the proxy keeps it away from runs regardless (it
//   serves only enabled models that are still listed), and the picker shows it to be turned off
// - a sync that refused a list for shrinking says so by code (`errorCode`), on its 502 and in
//   the catalogue's sync state, so the admin can be offered to take the list anyway
// - a key's credit is read live from OpenRouter with the key itself, and never stored
// - nothing here sends a key anywhere but OpenRouter

import { json, parseBody, type Route, route } from "@ryph/shared/http";
import type { SealBinding } from "@ryph/sealed";
import { BUILTIN_PROVIDERS } from "../core/registry.ts";
import { narrowedModels, OPENROUTER, type OpenRouterModel } from "../core/openrouter.ts";
import type { OpenRouterCatalogue } from "../core/openrouter_catalogue.ts";
import { providerKeyBinding } from "../core/sealing.ts";
import { NO_SECRET } from "../core/types.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { type OpenRouterApi, OpenRouterApiError } from "../ports/openrouter_api.ts";
import { SetOpenRouterEnabledSchema, SyncOpenRouterSchema } from "../schema.ts";

/** OpenRouter's paths, shared by the live routes and their disabled stand-ins. */
export const OPENROUTER_PATHS = {
  models: "/v1/openrouter/models",
  enabled: "/v1/openrouter/models/enabled",
  sync: "/v1/openrouter/sync",
  keyStatus: "/v1/provider-keys/:id/openrouter",
} as const;

/** The marker on a key OpenRouter refused: what the key form says as "didn't accept this key". */
export const OPENROUTER_KEY_REFUSED = "openrouter_key_refused";

/** The marker on "the secret must be entered again"; the same value routes.ts answers with. */
const SECRET_REQUIRED = "secret_required";

/** One catalogue model as the admin's picker reads it: everything but the sync's bookkeeping. */
export type OpenRouterModelView = Omit<OpenRouterModel, "missedSyncs" | "updatedAt">;

function viewOf({ missedSyncs: _missed, updatedAt: _at, ...model }: OpenRouterModel) {
  return model satisfies OpenRouterModelView;
}

/** Whether the deployment holds a live OpenRouter key: what lets a read start a stale sync. */
export async function liveOpenRouterKey(store: KeyStore): Promise<boolean> {
  return (await store.listProviderKeys())
    .some((key) => key.provider === OPENROUTER && key.archivedAt === null);
}

/**
 * Starts a sync when the catalogue is stale and a live OpenRouter key exists. Resolves once that
 * is decided, never waiting out the sync itself, and never rejects: from then on
 * `catalogue.syncing()` says whether one runs.
 */
export async function startStaleSync(
  store: KeyStore,
  catalogue: OpenRouterCatalogue,
  diag: { warn(event: string, data?: Record<string, unknown>): void },
): Promise<void> {
  try {
    if (catalogue.syncing() || !(await liveOpenRouterKey(store))) return;
    await catalogue.startIfStale();
  } catch (err) {
    diag.warn("openrouter.background_sync_failed", { err: String(err) });
  }
}

/** `startStaleSync` for a read that says nothing of syncing: never holds it at all. */
export function syncStaleInBackground(
  store: KeyStore,
  catalogue: OpenRouterCatalogue,
  diag: { warn(event: string, data?: Record<string, unknown>): void },
): void {
  void startStaleSync(store, catalogue, diag);
}

/**
 * The answer for a key OpenRouter refused, at the status the caller picks (a save is the caller's
 * mistake, a 400; a read of a saved key is OpenRouter's answer, a 502); null when the failure was
 * anything else, which says nothing about the key.
 */
export function openRouterKeyRefusal(err: unknown, status: number): Response | null {
  if (err instanceof OpenRouterApiError && (err.status === 401 || err.status === 403)) {
    return json(status, {
      error: "OpenRouter didn't accept this key",
      code: OPENROUTER_KEY_REFUSED,
    });
  }
  return null;
}

/** How a key-status read went wrong, as the answer to send. */
export function keyInfoRefusal(err: unknown): Response {
  const refused = openRouterKeyRefusal(err, 502);
  if (refused !== null) return refused;
  if (err instanceof OpenRouterApiError && err.status === null) {
    return json(503, { error: "could not reach OpenRouter" });
  }
  return json(502, {
    error: `OpenRouter did not answer the key's status: ${
      err instanceof Error ? err.message : String(err)
    }`,
  });
}

export interface OpenRouterRoutesDeps {
  store: KeyStore;
  catalogue: OpenRouterCatalogue;
  api: OpenRouterApi;
  /** Opens a provider key's sealed secret, bound to it (`providerKeyBinding`). */
  decrypt(sealed: string, binding: SealBinding): Promise<string>;
  /** The admin gate (`models:manage`), which every route here is behind. */
  authenticateManage(req: Request): Promise<Response | null>;
  now(): Date;
  diag: { warn(event: string, data?: Record<string, unknown>): void };
  /** Told after the enabled set was saved: what agents may use can have changed with it. */
  changed?(): void;
}

export function openRouterRoutes(deps: OpenRouterRoutesDeps): Route[] {
  const { store, catalogue } = deps;

  /** The catalogue as the picker reads it: every listed model, and every enabled one OpenRouter
   * no longer lists (so the admin sees it and can turn it off), with the sync's state. */
  const catalogueBody = async () => {
    const [models, sync] = await Promise.all([
      store.listOpenRouterModels(),
      store.getOpenRouterSync(),
    ]);
    return {
      models: models.filter((m) => m.listed || m.enabled).map(viewOf),
      sync: {
        syncedAt: sync?.syncedAt ?? null,
        attemptedAt: sync?.attemptedAt ?? null,
        error: sync?.error ?? null,
        errorCode: sync?.errorCode ?? null,
        syncing: catalogue.syncing(),
      },
    };
  };

  const list = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    // Decided before the answer is built, so a read that starts a sync says `syncing: true` and
    // the picker knows to read again.
    await startStaleSync(store, catalogue, deps.diag);
    return json(200, await catalogueBody());
  };

  const setEnabled = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, SetOpenRouterEnabledSchema);
    if (!body.ok) return body.res;
    const byId = new Map((await store.listOpenRouterModels()).map((m) => [m.id, m]));
    const unknown: string[] = [];
    const unlisted: string[] = [];
    const noTools: string[] = [];
    for (const id of body.data.ids) {
      const model = byId.get(id);
      // Already enabled: kept whatever became of it, or one model OpenRouter changed would block
      // every later save. Only enabled AND listed models reach runs either way.
      if (model?.enabled === true) continue;
      if (model === undefined) unknown.push(id);
      else if (!model.listed) unlisted.push(id);
      else if (!model.tools) noTools.push(id);
    }
    // Which ids, and why, are in the three lists, for a client to name them each.
    if (unknown.length + unlisted.length + noTools.length > 0) {
      return json(400, {
        error: "Some models can't be enabled",
        unknown,
        unlisted,
        noTools,
      });
    }
    const at = deps.now().toISOString();
    const platform = await store.getPlatformPolicy();
    const before = platform?.provider === OPENROUTER
      ? await platformModels(platform.allowedModels)
      : null;
    await store.setOpenRouterEnabled(body.data.ids, at);
    deps.changed?.();
    // The platform's credentials carry the enabled set as it was when they were minted. When the
    // change moves what its policy may call, they are killed, as a policy edit kills them: the
    // consumers re-mint under the new set — or are refused, saying which model is off.
    if (platform !== null && before !== null) {
      const after = await platformModels(platform.allowedModels);
      if (after.join("\n") !== before.join("\n")) {
        await store.revokePlatformVirtualKeys(at);
      }
    }
    return json(200, await catalogueBody());
  };

  /** What the platform policy's allowlist comes to under the enabled set as it stands. */
  const platformModels = async (allowed: readonly string[] | "*"): Promise<string[]> => {
    const usable = (await store.listUsableOpenRouterModels()).map((m) => ({ id: m.id }));
    return narrowedModels(usable, allowed).map((m) => m.id);
  };

  const syncNow = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    // An empty body is a plain sync; `{"force": true}` takes a list the sync would refuse for
    // shrinking by more than half.
    const body = await parseBody(req, SyncOpenRouterSchema, { emptyIs: {} });
    if (!body.ok) return body.res;
    const state = await catalogue.sync({ force: body.data.force });
    const answer = await catalogueBody();
    if (state.error !== null) {
      return json(502, {
        error: `could not sync OpenRouter's models: ${state.error}`,
        ...(state.errorCode === null ? {} : { code: state.errorCode }),
        ...answer,
      });
    }
    return json(200, answer);
  };

  const keyStatus = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const key = await store.getProviderKey(params.id);
    if (key === null) return json(404, { error: "no such provider key" });
    if (key.provider !== OPENROUTER) return json(400, { error: "not an OpenRouter key" });
    if (key.archivedAt !== null) return json(400, { error: "that provider key is archived" });
    let secret: string | null = null;
    if (key.encryptedSecret !== NO_SECRET) {
      secret = await deps.decrypt(
        key.encryptedSecret,
        providerKeyBinding(key, BUILTIN_PROVIDERS[OPENROUTER]),
      ).catch(() => null);
    }
    if (secret === null) {
      return json(409, {
        error: "this key has no usable secret: enter it again",
        code: SECRET_REQUIRED,
      });
    }
    try {
      return json(200, await deps.api.keyInfo(secret));
    } catch (err) {
      return keyInfoRefusal(err);
    }
  };

  return [
    route("GET", OPENROUTER_PATHS.models, list),
    route("PUT", OPENROUTER_PATHS.enabled, setEnabled),
    route("POST", OPENROUTER_PATHS.sync, syncNow),
    route("GET", OPENROUTER_PATHS.keyStatus, keyStatus),
  ];
}
