// OpenRouter as a built-in provider: what its public model list says, turned into the rows this
// package keeps, and those rows turned into what a run is told.
//
// OpenRouter serves hundreds of models from one key, and its catalogue moves weekly, so neither of
// the two answers the other providers have fits it: pi's built-in catalogue is a snapshot of one
// release, and a hand-declared list (a custom endpoint's) is a chore nobody would keep up. The
// catalogue is instead synced from `GET /api/v1/models` (core/openrouter_catalogue.ts), which
// needs no key and says what every model costs, and an admin picks which of those models agents
// may use. That set is the deployment's, not a key's: the catalogue is the same for every
// OpenRouter account.
//
// Invariants:
// - pure: the JSON comes in as `unknown`, and nothing here reaches a network or a store
// - a model whose price cannot be read is UNPRICED (`price: null`), never free
// - OpenRouter's own routers (`openrouter/auto` and the like) are left out: they pick a model at
//   request time, which no allowlist can hold to an id
// - only models that take tools are worth enabling: pi's agent loop is tool calls

import type { DeclaredModel } from "./registry.ts";
import type { PriceRates } from "./pricing.ts";

/** The provider id, as a key's, a policy's and pi's argv's `provider` carries it. */
export const OPENROUTER = "openrouter";

/** Where OpenRouter's OpenAI-compatible API lives, path included. */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/**
 * The attribution headers OpenRouter reads (its app ranking keys on them). Fixed values on
 * purpose: the deployment's own URL here would hand its hostname to OpenRouter on every call.
 */
export const OPENROUTER_HEADERS: Readonly<Record<string, string>> = {
  "http-referer": "https://ryph.ai",
  "x-title": "ryph",
};

/** The prefix of OpenRouter's own routers, which choose a model per request. */
const ROUTER_PREFIX = "openrouter/";

/** The output cap a model gets when OpenRouter does not say what its top provider allows. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * The most output a run asks one call for. pi sends a model's `maxTokens` as `max_tokens` on every
 * call, and OpenRouter refuses (402) a call the account's credit cannot cover at that many tokens,
 * so a model's full advertised output would lock a low-credit account out of it. The proxy's
 * estimate for a call that never reported its usage charges this much too.
 */
const MAX_OUTPUT_TOKENS_CAP = 65_536;

/** One model as the sync writes it. */
export interface OpenRouterCatalogueEntry {
  id: string;
  label: string;
  contextLength: number;
  /** Clamped: see `MAX_OUTPUT_TOKENS_CAP`. */
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
  /** USD per million tokens; null when OpenRouter's pricing could not be read. */
  price: PriceRates | null;
  /** OpenRouter's `pricing` object as it came, per-token USD strings. */
  rawPricing: Record<string, string> | null;
}

/** One model as the store holds it. Rows are never deleted: old usage keeps its price. */
export interface OpenRouterModel extends OpenRouterCatalogueEntry {
  /** False once a sync no longer lists it. */
  listed: boolean;
  /** Whether an admin picked it for agents. */
  enabled: boolean;
  updatedAt: string;
}

/** Where the catalogue sync stands: when it last worked, when it was last tried, and why that
 * try failed. */
export interface OpenRouterSync {
  syncedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

/** A per-token USD string as USD per million tokens; null for OpenRouter's `-1` (a price it does
 * not know) or anything that is not a number. */
function perMillion(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Twelve significant digits: "0.0000025" × 1e6 is 2.4999999999999996 in floating point.
  return Number((n * 1_000_000).toPrecision(12));
}

/** A model's rates, or null when its input or output price is not one. A cache rate it does not
 * name is its input rate: such a model reports no cached tokens anyway. */
function priceOf(pricing: unknown): PriceRates | null {
  if (!isObject(pricing)) return null;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: perMillion(pricing.input_cache_read) ?? input,
    cacheWrite: perMillion(pricing.input_cache_write) ?? input,
  };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * `GET /api/v1/models` as catalogue rows. An entry that is not a model this can describe (no id,
 * no context length) is skipped rather than failing the sync, and so is every router.
 */
export function catalogueOf(body: unknown): OpenRouterCatalogueEntry[] {
  const data = isObject(body) ? body.data : null;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const rows: OpenRouterCatalogueEntry[] = [];
  for (const entry of data) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (id === "" || id.length > 200 || /\s/.test(id) || id.startsWith(ROUTER_PREFIX)) continue;
    if (seen.has(id)) continue;
    const contextLength = positiveInt(entry.context_length);
    if (contextLength === null) continue;
    seen.add(id);
    const architecture = isObject(entry.architecture) ? entry.architecture : {};
    const parameters = stringsOf(entry.supported_parameters);
    const top = isObject(entry.top_provider) ? entry.top_provider : {};
    const maxOutputTokens = Math.max(
      1,
      Math.min(
        positiveInt(top.max_completion_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
        MAX_OUTPUT_TOKENS_CAP,
        Math.floor(contextLength / 2),
      ),
    );
    const rawPricing = isObject(entry.pricing)
      ? Object.fromEntries(
        Object.entries(entry.pricing)
          .filter(([, v]) => typeof v === "string" || typeof v === "number")
          .map(([k, v]) => [k, String(v)]),
      )
      : null;
    rows.push({
      id,
      label: typeof entry.name === "string" && entry.name.trim() !== ""
        ? entry.name.trim().slice(0, 200)
        : id,
      contextLength,
      maxOutputTokens,
      vision: stringsOf(architecture.input_modalities).includes("image"),
      reasoning: parameters.includes("reasoning"),
      tools: parameters.includes("tools"),
      price: priceOf(entry.pricing),
      rawPricing,
    });
  }
  return rows;
}

/**
 * One enabled model as a run is told about it, in the config blob and the provider list. pi
 * detects OpenRouter by its base URL, which is the proxy's here, so the thinking format is said
 * outright: without it pi sends OpenAI's `reasoning_effort`, which OpenRouter's models do not
 * all read.
 */
export function openRouterModelForRun(row: OpenRouterCatalogueEntry): DeclaredModel {
  return {
    id: row.id,
    label: row.label,
    contextWindow: row.contextLength,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    vision: row.vision,
    compat: { thinkingFormat: "openrouter" },
    ...(row.price === null ? {} : { price: { ...row.price } }),
  };
}

/** The models agents may use: enabled, and still in OpenRouter's list. */
export function usableOpenRouterModels(rows: readonly OpenRouterModel[]): OpenRouterModel[] {
  return rows.filter((row) => row.enabled && row.listed);
}
