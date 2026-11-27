// The bridge between the form's model-access fields and the API's ModelPolicy shape, shared by
// the create and edit flows so both compose and seed identically.

import {
  type Harness,
  type ModelPolicy,
  OPENROUTER_PROVIDER,
  type Provider,
  type ProviderKey,
  type ThinkingLevel,
} from "#lib/api/types.ts";
import { thinkingLevelsForKey } from "#lib/components/model-picker/models.ts";
import { thinkingToSend } from "#lib/components/model-picker/thinking.ts";

/** Builds the policy from the form fields; "" as the key id means no model access (null). */
export function composeModelPolicy(
  providerKeyId: string,
  allowedModels: ModelPolicy["allowedModels"],
  defaultModel: string,
  providerKeys: ProviderKey[],
  defaultThinking: ModelPolicy["defaultThinking"] = null,
): ModelPolicy | null {
  if (!providerKeyId) return null;
  const key = providerKeys.find((k) => k.id === providerKeyId);
  if (!key) return null;

  return {
    providerKeyId,
    provider: key.provider,
    allowedModels: allowedModels === "*" ? "*" : cleanList(allowedModels),
    defaultModel: defaultModel.trim() || null,
    defaultThinking,
  };
}

/** Seeds the form fields from an existing policy (the edit flow). */
export function policyToFields(policy: ModelPolicy | null): {
  providerKeyId: string;
  allowedModels: ModelPolicy["allowedModels"];
  defaultModel: string;
  defaultThinking: ModelPolicy["defaultThinking"];
} {
  if (!policy) {
    return { providerKeyId: "", allowedModels: "*", defaultModel: "", defaultThinking: null };
  }
  return {
    providerKeyId: policy.providerKeyId,
    allowedModels: policy.allowedModels === "*" ? "*" : cleanList(policy.allowedModels),
    defaultModel: policy.defaultModel ?? "",
    defaultThinking: policy.defaultThinking,
  };
}

/**
 * The thinking levels the default model takes, for the key's own model list. A key the list
 * cannot resolve that the stored policy names reads the policy's provider entry instead.
 */
export function defaultModelThinkingLevels(
  providers: Provider[],
  providerKeys: readonly ProviderKey[],
  providerKeyId: string,
  defaultModel: string,
  storedPolicy: ModelPolicy | null = null,
): readonly ThinkingLevel[] {
  const key = providerKeys.find((k) => k.id === providerKeyId);
  return thinkingLevelsForKey(
    providers,
    key,
    defaultModel,
    storedProvider(storedPolicy, providerKeyId),
  );
}

/** The provider the stored policy names, when it is the policy for this key; else nothing. */
export function storedProvider(
  storedPolicy: ModelPolicy | null,
  providerKeyId: string,
): string | undefined {
  return providerKeyId !== "" && storedPolicy?.providerKeyId === providerKeyId
    ? storedPolicy.provider
    : undefined;
}

/**
 * The default level the edit flow saves. While the key and the default model are the ones the
 * agent was loaded with, the level is sent as it stands, even where the model now offers no
 * level and the pick is hidden: hiding it must not clear what is stored. Once the person moves
 * either, a model that takes no level gets none.
 */
export function editedDefaultThinking(
  seeded: { providerKeyId: string; defaultModel: string },
  providerKeyId: string,
  defaultModel: string,
  defaultThinking: ThinkingLevel | null,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  const unmoved = providerKeyId === seeded.providerKeyId &&
    defaultModel.trim() === seeded.defaultModel.trim();
  return unmoved ? defaultThinking : thinkingToSend(defaultThinking, levels);
}

/**
 * What an OpenRouter key's agent may pick from: the ids enabled for agents, or null when the
 * provider list did not come back with OpenRouter in it and they are not known.
 */
export type OpenRouterChoices = { enabled: readonly string[] | null };

/**
 * The OpenRouter choices for the selected key, or null when the key is on another provider. A
 * key the list cannot resolve goes by the stored policy's provider (`storedProvider`).
 */
export function openRouterChoices(
  providers: readonly Provider[],
  providerKeys: readonly ProviderKey[],
  providerKeyId: string,
  storedPolicy: ModelPolicy | null = null,
): OpenRouterChoices | null {
  if (!providerKeyId) return null;
  const provider = providerKeys.find((k) => k.id === providerKeyId)?.provider ??
    storedProvider(storedPolicy, providerKeyId);
  if (provider !== OPENROUTER_PROVIDER) return null;
  const entry = providers.find((p) => p.id === OPENROUTER_PROVIDER);
  return { enabled: entry ? entry.models.map((m) => m.id) : null };
}

/**
 * Why the model fields cannot be saved as they stand, or null: the server's rules. Any key with
 * an allowlist needs a model on it, and a default from it. An OpenRouter key (`openRouter`) also
 * needs a default model, one of the models enabled for agents where those are known.
 */
export function modelPolicyProblem(
  providerKeyId: string,
  allowedModels: ModelPolicy["allowedModels"],
  defaultModel: string,
  openRouter: OpenRouterChoices | null = null,
): string | null {
  if (!providerKeyId) return null;
  const model = defaultModel.trim();
  const enabled = openRouter?.enabled ?? null;
  if (enabled !== null && enabled.length === 0) {
    return "Enable an OpenRouter model under Model keys first.";
  }
  if (allowedModels !== "*") {
    const list = cleanList(allowedModels);
    if (list.length === 0) return "Pick at least one allowed model.";
    if (model !== "" && !list.includes(model)) {
      return "The default model must be one of the allowed models.";
    }
  }
  if (openRouter === null) return null;
  if (model === "") return "Pick a default model.";
  if (enabled !== null && !enabled.includes(model)) {
    return "Pick one of the enabled OpenRouter models as the default.";
  }
  return null;
}

/** Trimmed, blank-free and each id once — what the server is sent and what a picker can key on. */
function cleanList(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model.length > 0))];
}

/**
 * The live keys an agent on this harness can be given, matched on the DIALECT their provider
 * speaks rather than on its name, which is what lets a custom endpoint registered five minutes ago
 * be offered without the form knowing anything about it.
 *
 * The two ways a provider can fail to answer here are deliberately NOT the same case:
 *
 * - ARCHIVED: the list says the endpoint exists and is switched off. That is a kill switch, so a
 *   policy naming it means every run on the agent dies at boot. Offering the key would be offering
 *   a broken agent, so it goes.
 * - MISSING from the list: model access is off, or the provider read did not come back. The form
 *   cannot tell whether the key is fine, so it stays offered and the orchestrator has the last
 *   word on save. Hiding it would read as "the key vanished", which is a worse lie than offering
 *   one the server may refuse.
 *
 * A harness that is not in the list at all (manual dev, no image map) is the same open case.
 *
 * A ChatGPT plan key is the exception: the proxy leaves the provider out on a deployment that is
 * not local, where every run on it would be refused. Missing means off, so it goes.
 */
export function usableProviderKeys(
  providerKeys: readonly ProviderKey[],
  providers: readonly Provider[],
  harness: Pick<Harness, "dialects"> | undefined,
): ProviderKey[] {
  const providerById = new Map(providers.map((p) => [p.id, p]));
  return providerKeys.filter((key) => {
    if (key.archivedAt !== null) return false;
    const provider = providerById.get(key.provider);
    if (key.plan !== undefined && provider === undefined) return false;
    if (provider !== undefined && provider.archivedAt !== null) return false;
    if (harness === undefined) return true;
    return provider === undefined || harness.dialects.includes(provider.dialect);
  });
}
