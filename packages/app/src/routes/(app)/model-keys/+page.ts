import type { PageLoad } from "./$types";
import { browser } from "$app/env";
import { getAgents } from "#lib/api/agents.ts";
import { getHarnesses } from "#lib/api/harnesses.ts";
import { getModelAccess } from "#lib/api/provider-keys.ts";
import { getProvidersOrEmpty } from "#lib/api/providers.ts";
import { OPENROUTER_PROVIDER } from "#lib/api/types.ts";
import {
  type CatalogueRead,
  catalogueReader,
} from "#lib/components/model-keys/openrouter-models.ts";
import { can } from "#lib/utils/auth/capabilities.ts";

// Browser only: module state on the server is shared by every request it handles.
const readCatalogue = catalogueReader(browser);

export const load: PageLoad = async ({ fetch, depends, parent }) => {
  depends("app:model-keys");
  const accessRead = getModelAccess(fetch);
  const [modelAccess, harnesses, providers, agents, openrouter] = await Promise.all([
    accessRead,
    getHarnesses(fetch),
    getProvidersOrEmpty(fetch),
    // Only to say which agents use each key; a list that will not load costs the cards that line.
    getAgents(fetch).catch(() => []),
    // An admin picks OpenRouter's models, from a key's menu or after adding one, once the
    // deployment holds a live OpenRouter key; the cards say how many are on. The read waits only
    // on the keys, alongside the rest.
    accessRead.then(async (access): Promise<CatalogueRead | null> => {
      const { user } = await parent();
      const offered = access.modelAccessEnabled && can(user, "models:manage") &&
        access.providerKeys.some((k) =>
          k.provider === OPENROUTER_PROVIDER && k.archivedAt === null
        );
      return offered ? await readCatalogue(fetch) : null;
    }),
  ]);
  // Read by the layout before the page's own effect hands the header its switch: a header
  // that is to carry it must not render folded first.
  return {
    ...modelAccess,
    harnesses,
    providers,
    agents,
    openrouter,
    headerControls: modelAccess.providerKeys.some((k) => k.archivedAt !== null),
  };
};
