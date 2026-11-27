import { z } from "zod";
import { apiCall, ApiError } from "./call";

// OpenRouter as a built-in provider: its synced catalogue, the models an admin enabled out of it,
// a sync on demand, and one key's credit. The catalogue and the enabled set are admin-only; the
// models agents may use reach every picker through `GET /v1/providers` like any provider's.

/** USD per million tokens. */
const priceSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

export const openRouterModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextLength: z.number(),
  maxOutputTokens: z.number(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  /** Only a model that takes tools can be enabled: agents work through tool calls. */
  tools: z.boolean(),
  /** Null when OpenRouter's pricing could not be read: a run with a spend cap can't use it. */
  price: priceSchema.nullable(),
  /** False once OpenRouter no longer lists it. Kept while it is still enabled. */
  listed: z.boolean(),
  enabled: z.boolean(),
});
export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

export const openRouterSyncSchema = z.object({
  syncedAt: z.string().nullable(),
  attemptedAt: z.string().nullable(),
  /** Why the last attempt failed; null once one works. */
  error: z.string().nullable(),
  /** The failure's code when the admin can act on it: `openrouter_sync_shrunk`. */
  errorCode: z.string().nullable().default(null),
  syncing: z.boolean(),
});
export type OpenRouterSync = z.infer<typeof openRouterSyncSchema>;

/** Every listed model, every enabled one OpenRouter no longer lists, and where the sync stands. */
export const openRouterCatalogueSchema = z.object({
  models: z.array(openRouterModelSchema),
  sync: openRouterSyncSchema,
});
export type OpenRouterCatalogue = z.infer<typeof openRouterCatalogueSchema>;

/** One key's credit as OpenRouter reports it, in USD. Read live; never stored. */
export const openRouterKeyInfoSchema = z.object({
  /** Null for a key without a credit limit. */
  limit: z.number().nullable(),
  limitRemaining: z.number().nullable(),
  usage: z.number(),
  isFreeTier: z.boolean(),
});
export type OpenRouterKeyInfo = z.infer<typeof openRouterKeyInfoSchema>;

/**
 * The code on a key OpenRouter refused: a 400 when saving one, a 502 when reading its credit.
 * The model proxy's `OPENROUTER_KEY_REFUSED`; the app keeps its own copy of the value.
 */
export const OPENROUTER_KEY_REFUSED = "openrouter_key_refused";

/** True when OpenRouter refused the key a call was made with. */
export function isOpenRouterKeyRefused(e: unknown): e is ApiError {
  return e instanceof ApiError && typeof e.body === "object" && e.body !== null &&
    (e.body as { code?: unknown }).code === OPENROUTER_KEY_REFUSED;
}

export async function getOpenRouterCatalogue(f = fetch): Promise<OpenRouterCatalogue> {
  return openRouterCatalogueSchema.parse(await apiCall(f, "/v1/openrouter/models"));
}

/** Why saving the enabled set was refused, model by model. */
export type EnableRefusal = {
  message: string;
  /** Not in OpenRouter's catalogue at all. */
  unknown: string[];
  /** No longer listed by OpenRouter. */
  unlisted: string[];
  /** Listed, but takes no tools. */
  noTools: string[];
};

const enableRefusalSchema = z.object({
  error: z.string(),
  unknown: z.array(z.string()).default([]),
  unlisted: z.array(z.string()).default([]),
  noTools: z.array(z.string()).default([]),
});

/** The 400 from saving the enabled set, read into its lists; null for any other failure. */
export function enableRefusal(e: unknown): EnableRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const parsed = enableRefusalSchema.safeParse(e.body);
  if (!parsed.success) return null;
  const { error, ...lists } = parsed.data;
  return { message: error, ...lists };
}

/** Replaces the whole enabled set. A 400 throws an `ApiError`; read it with `enableRefusal`. */
export async function setOpenRouterEnabled(
  f = fetch,
  ids: readonly string[],
): Promise<OpenRouterCatalogue> {
  return openRouterCatalogueSchema.parse(
    await apiCall(f, "/v1/openrouter/models/enabled", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),
  );
}

export type SyncOptions = {
  /** Accept a catalogue that shrank a lot since the last sync. Sent only when true. */
  force?: boolean;
};

/** A sync's answer: the catalogue either way, and the reason when the sync failed. */
export type SyncResult = { catalogue: OpenRouterCatalogue; error: string | null };

/**
 * Syncs the catalogue now. A failed sync (a 502 carrying the catalogue as it stands) comes back
 * as a result with its error, so the page can show both; any other failure throws.
 */
export async function syncOpenRouter(f = fetch, options: SyncOptions = {}): Promise<SyncResult> {
  const init: RequestInit = { method: "POST" };
  if (options.force) init.body = JSON.stringify({ force: true });
  try {
    return {
      catalogue: openRouterCatalogueSchema.parse(await apiCall(f, "/v1/openrouter/sync", init)),
      error: null,
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 502) {
      const parsed = openRouterCatalogueSchema.safeParse(e.body);
      if (parsed.success) return { catalogue: parsed.data, error: e.message };
    }
    throw e;
  }
}

/** One OpenRouter key's credit, read live with the key itself. */
export async function getOpenRouterKeyInfo(f = fetch, keyId: string): Promise<OpenRouterKeyInfo> {
  return openRouterKeyInfoSchema.parse(
    await apiCall(f, `/v1/provider-keys/${encodeURIComponent(keyId)}/openrouter`),
  );
}
