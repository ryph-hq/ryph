// A stand-in for OpenRouter behind the `OpenRouterApi` port: a model list and a key-status read
// a test sets up, every call counted. Nothing in the suite ever reaches openrouter.ai.

import type { OpenRouterApi, OpenRouterKeyInfo } from "../src/ports/openrouter_api.ts";
import { OpenRouterApiError } from "../src/ports/openrouter_api.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { OpenRouterCatalogueEntry, OpenRouterSyncEnd } from "../src/core/openrouter.ts";

/** One model as OpenRouter's `GET /api/v1/models` lists it. */
export function listedModel(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Model ${id}`,
    context_length: 200_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015", request: "0" },
    top_provider: { context_length: 200_000, max_completion_tokens: 32_000 },
    supported_parameters: ["max_tokens", "tools", "tool_choice"],
    ...over,
  };
}

/** A small catalogue: a tool model, a reasoning vision model, one without tools, a router. */
export const MODELS_BODY = {
  data: [
    listedModel("anthropic/claude-sonnet-5"),
    listedModel("openai/gpt-6", {
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools", "reasoning"],
      pricing: {
        prompt: "0.0000025",
        completion: "0.00001",
        input_cache_read: "0.00000025",
      },
    }),
    listedModel("acme/no-tools", { supported_parameters: ["max_tokens"] }),
    listedModel("openrouter/auto", { pricing: { prompt: "-1", completion: "-1" } }),
  ],
};

export interface FakeOpenRouter extends OpenRouterApi {
  /** What `listModels` answers; an Error is thrown instead. */
  models: unknown;
  /** Secret → its status; an Error is thrown instead; a secret not here is a 401. */
  keys: Map<string, OpenRouterKeyInfo | Error>;
  calls: { models: number; keys: string[] };
}

export const KEY_INFO: OpenRouterKeyInfo = {
  limit: 20,
  limitRemaining: 12.5,
  usage: 7.5,
  isFreeTier: false,
};

export function fakeOpenRouter(over: Partial<Pick<FakeOpenRouter, "models">> = {}): FakeOpenRouter {
  const fake: FakeOpenRouter = {
    models: over.models ?? MODELS_BODY,
    keys: new Map(),
    calls: { models: 0, keys: [] },
    listModels() {
      fake.calls.models += 1;
      if (fake.models instanceof Error) return Promise.reject(fake.models);
      return Promise.resolve(structuredClone(fake.models));
    },
    keyInfo(secret) {
      fake.calls.keys.push(secret);
      const info = fake.keys.get(secret);
      if (info === undefined) {
        return Promise.reject(new OpenRouterApiError("OpenRouter answered 401", 401));
      }
      if (info instanceof Error) return Promise.reject(info);
      return Promise.resolve({ ...info });
    },
  };
  return fake;
}

/** Writes a catalogue straight into `store`, under a claim of its own, as one sync would. */
export async function seedCatalogue(
  store: KeyStore,
  models: OpenRouterCatalogueEntry[],
  at: string,
): Promise<void> {
  const claim = crypto.randomUUID();
  if (!(await store.claimOpenRouterSync(claim, 60_000))) throw new Error("sync claim held");
  await store.upsertOpenRouterCatalogue(models, at, claim);
  await store.endOpenRouterSync(claim, null);
}

/** Writes a sync state straight into `store`, under a claim of its own. */
export async function seedSyncState(store: KeyStore, state: OpenRouterSyncEnd): Promise<void> {
  const claim = crypto.randomUUID();
  if (!(await store.claimOpenRouterSync(claim, 60_000))) throw new Error("sync claim held");
  await store.endOpenRouterSync(claim, state);
}
