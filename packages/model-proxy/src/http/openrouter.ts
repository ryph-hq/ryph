// OpenRouter's management routes, beside the provider-key CRUD: the synced catalogue and which of
// its models agents may use, a sync on demand, and what one key's credit looks like.
//
// Invariants:
// - choosing the enabled models is a spending decision, so it is ADMIN-gated, like registering a
//   key; so is reading the whole catalogue, which only the admin's picker needs. Every signed-in
//   user still sees the ENABLED models, in the provider list
// - only a model OpenRouter lists, that takes tools, can be enabled: pi drives an agent through
//   tool calls, and a model without them would fail every run on its first turn
// - a key's credit is read live from OpenRouter with the key itself, and never stored
// - nothing here sends a key anywhere but OpenRouter

import { json, parseBody, type Route, route } from "@ryph/shared/http";
import type { SealBinding } from "@ryph/sealed";
import { BUILTIN_PROVIDERS } from "../core/registry.ts";
import { OPENROUTER, type OpenRouterModel } from "../core/openrouter.ts";
import type { OpenRouterCatalogue } from "../core/openrouter_catalogue.ts";
import { providerKeyBinding } from "../core/sealing.ts";
import { NO_SECRET } from "../core/types.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { type OpenRouterApi, OpenRouterApiError } from "../ports/openrouter_api.ts";
import { SetOpenRouterEnabledSchema } from "../schema.ts";

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

/** One catalogue model as the admin's picker reads it: everything but OpenRouter's raw pricing. */
export type OpenRouterModelView = Omit<OpenRouterModel, "rawPricing" | "updatedAt">;

function viewOf({ rawPricing: _raw, updatedAt: _at, ...model }: OpenRouterModel) {
  return model satisfies OpenRouterModelView;
}

/** Whether the deployment holds a live OpenRouter key: what lets a read start a stale sync. */
export async function liveOpenRouterKey(store: KeyStore): Promise<boolean> {
  return (await store.listProviderKeys())
    .some((key) => key.provider === OPENROUTER && key.archivedAt === null);
}

/**
 * Starts a sync in the background when the catalogue is stale and a live OpenRouter key exists.
 * Never holds the read that asked, and never fails it.
 */
export function syncStaleInBackground(
  store: KeyStore,
  catalogue: OpenRouterCatalogue,
  diag: { warn(event: string, data?: Record<string, unknown>): void },
): void {
  void (async () => {
    if (catalogue.syncing() || !(await liveOpenRouterKey(store))) return;
    await catalogue.syncIfStale();
  })().catch((err) => diag.warn("openrouter.background_sync_failed", { err: String(err) }));
}

/** How a key-status read went wrong, as the answer to send. */
export function keyInfoRefusal(err: unknown): Response {
  if (err instanceof OpenRouterApiError && (err.status === 401 || err.status === 403)) {
    return json(502, { error: "OpenRouter didn't accept this key", code: OPENROUTER_KEY_REFUSED });
  }
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
  /** The user-surface gate (`models:read`). */
  authenticate(req: Request): Promise<Response | null>;
  /** The admin gate (`models:manage`). */
  authenticateManage(req: Request): Promise<Response | null>;
  now(): Date;
  diag: { warn(event: string, data?: Record<string, unknown>): void };
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
        syncing: catalogue.syncing(),
      },
    };
  };

  const list = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    syncStaleInBackground(store, catalogue, deps.diag);
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
      if (model === undefined) unknown.push(id);
      else if (!model.listed) unlisted.push(id);
      else if (!model.tools) noTools.push(id);
    }
    const problems = [
      ...(unknown.length === 0 ? [] : [`not in OpenRouter's catalogue: ${unknown.join(", ")}`]),
      ...(unlisted.length === 0 ? [] : [`no longer listed by OpenRouter: ${unlisted.join(", ")}`]),
      ...(noTools.length === 0 ? [] : [`does not take tools: ${noTools.join(", ")}`]),
    ];
    if (problems.length > 0) {
      return json(400, {
        error: `these models cannot be enabled — ${problems.join("; ")}`,
        unknown,
        unlisted,
        noTools,
      });
    }
    await store.setOpenRouterEnabled(body.data.ids, deps.now().toISOString());
    return json(200, await catalogueBody());
  };

  const syncNow = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const state = await catalogue.sync();
    const answer = await catalogueBody();
    if (state.error !== null) {
      return json(502, { error: `could not sync OpenRouter's models: ${state.error}`, ...answer });
    }
    return json(200, answer);
  };

  const keyStatus = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
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
