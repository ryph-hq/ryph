// The `OpenRouterApi` port over HTTP, to openrouter.ai. The base URL and the fetch are parameters,
// so tests point it at a fake and nothing in a test run ever reaches OpenRouter.
//
// Invariants:
// - every call is bounded (CALL_TIMEOUT_MS), and so is what it reads (MAX_BODY_BYTES): a key save
//   and a catalogue sync must not hang on it, nor hold a body of any size in memory
// - a failure says whether OpenRouter answered (`status`) or was never reached (null)
// - the key is never put in an error message
// - no redirect is followed: the key is on the request

import { readCappedBytes } from "@ryph/shared/http";
import { OPENROUTER_API, OPENROUTER_HEADERS } from "../../core/openrouter.ts";
import {
  type OpenRouterApi,
  OpenRouterApiError,
  type OpenRouterKeyInfo,
} from "../../ports/openrouter_api.ts";

export interface OpenRouterApiOptions {
  fetch?: typeof fetch;
  /** OpenRouter's API, path included; the real one unless a test points elsewhere. */
  baseUrl?: string;
}

const CALL_TIMEOUT_MS = 15_000;

/** The most of an answer a call reads. OpenRouter's whole model list, descriptions and all, is a
 * few megabytes. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const usd = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function openRouterApi(opts: OpenRouterApiOptions = {}): OpenRouterApi {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? OPENROUTER_API).replace(/\/+$/, "");

  /** One bounded GET, its JSON body, or the OpenRouterApiError it amounts to. */
  const get = async (path: string, what: string, secret?: string): Promise<unknown> => {
    const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: {
          accept: "application/json",
          ...OPENROUTER_HEADERS,
          ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
        },
        redirect: "manual",
        signal: deadline,
      });
    } catch (err) {
      throw new OpenRouterApiError(
        `could not reach OpenRouter for ${what}: ${err instanceof Error ? err.name : "error"}`,
        null,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new OpenRouterApiError(`OpenRouter answered ${res.status} for ${what}`, res.status);
    }
    let read: Awaited<ReturnType<typeof readCappedBytes>>;
    try {
      read = await readCappedBytes(res, MAX_BODY_BYTES, deadline);
    } catch {
      throw new OpenRouterApiError(`OpenRouter broke off ${what}`, null);
    }
    if (!read.ok) {
      throw new OpenRouterApiError(
        read.reason === "too_large"
          ? `OpenRouter answered ${what} with more than ${MAX_BODY_BYTES} bytes`
          : `OpenRouter took too long to answer ${what}`,
        res.status,
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      throw new OpenRouterApiError(`OpenRouter answered ${what} with no JSON`, res.status);
    }
  };

  return {
    listModels: () => get("/models", "its model list"),
    async keyInfo(secret) {
      const body = await get("/key", "the key's status", secret);
      const data = isObject(body) && isObject(body.data) ? body.data : null;
      if (data === null) {
        throw new OpenRouterApiError(
          "OpenRouter answered the key's status in a shape not known",
          200,
        );
      }
      const info: OpenRouterKeyInfo = {
        limit: usd(data.limit),
        limitRemaining: usd(data.limit_remaining),
        usage: usd(data.usage) ?? 0,
        isFreeTier: data.is_free_tier === true,
      };
      return info;
    },
  };
}
