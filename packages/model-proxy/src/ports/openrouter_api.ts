// OpenRouter's account-side API, as this package needs it: the public model list the catalogue is
// synced from, and what a key's own credit looks like. The one adapter speaks HTTP to openrouter.ai
// (adapters/openrouter/api.ts); tests drive a fake, and the core never sees a URL.

/** What `GET /api/v1/key` says about a key. Read live, never stored. */
export interface OpenRouterKeyInfo {
  /** The key's credit limit in USD; null for no limit. */
  limit: number | null;
  /** What is left of that limit in USD; null for no limit. */
  limitRemaining: number | null;
  /** What the key has spent in USD, all time. */
  usage: number;
  isFreeTier: boolean;
}

/**
 * A call to OpenRouter that did not answer with what was asked. `status` is the HTTP status it
 * answered with, null when it was not reached at all (network, timeout) — which says nothing
 * about the key, so a caller must not treat it as a refusal.
 */
export class OpenRouterApiError extends Error {
  override readonly name = "OpenRouterApiError";
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export interface OpenRouterApi {
  /** `GET /api/v1/models`, no credential: the body as JSON. Throws OpenRouterApiError. */
  listModels(): Promise<unknown>;
  /** `GET /api/v1/key` with the key itself. Throws OpenRouterApiError (401 for a key OpenRouter
   * does not accept). */
  keyInfo(secret: string): Promise<OpenRouterKeyInfo>;
}
