import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { browser } from "$app/env";
import { getAgents } from "#lib/api/agents.ts";
import { getForges } from "#lib/api/forge.ts";
import { getHarnesses } from "#lib/api/harnesses.ts";
import { getModelAccess, getPlatformModelPolicyOrNull } from "#lib/api/provider-keys.ts";
import { getProvidersOrEmpty } from "#lib/api/providers.ts";
import { getConnectedRepos } from "#lib/api/repos.ts";
import { OPENROUTER_PROVIDER } from "#lib/api/types.ts";
import {
  type CatalogueRead,
  catalogueReader,
} from "#lib/components/model-keys/openrouter-models.ts";
import { mayBeWelcomed } from "#lib/utils/welcome.ts";

// Browser only: module state on the server is shared by every request it handles.
const readCatalogue = catalogueReader(browser);

export const load: PageLoad = async ({ parent, url, fetch, depends }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);
  // Every step registers or creates something only an admin may; anyone else has nothing to do here.
  if (!mayBeWelcomed(user)) redirect(302, "/agents");
  depends("app:welcome");

  // Every read degrades on its own: a step whose read failed says so, and the rest of the flow
  // still works. A load that threw would strand an admin here, since (app) sends them back until
  // the flow is finished or skipped.
  const accessRead = getModelAccess(fetch).catch(() => null);
  const [
    modelAccess,
    providers,
    harnesses,
    agents,
    connectedRepos,
    forges,
    background,
    openrouter,
  ] = await Promise.all([
    accessRead,
    getProvidersOrEmpty(fetch).catch(() => []),
    // Without the list the quick agent gets pi, as the full flow sends.
    getHarnesses(fetch).catch(() => []),
    getAgents(fetch).catch(() => null),
    getConnectedRepos(fetch).catch(() => null),
    // Which ways in a repository has; null when they could not be read, which leaves the step
    // pointing at the full connect flow.
    getForges(fetch).catch(() => null),
    getPlatformModelPolicyOrNull(fetch).then((policy) => ({ policy })).catch(() => null),
    // With an OpenRouter key, the agent step has its models picked here before it is created.
    accessRead.then((access): Promise<CatalogueRead> | null =>
      access?.providerKeys.some((key) =>
          key.provider === OPENROUTER_PROVIDER && key.archivedAt === null
        )
        ? readCatalogue(fetch)
        : null
    ),
  ]);
  return {
    modelAccessEnabled: modelAccess?.modelAccessEnabled ?? true,
    providerKeys: modelAccess?.providerKeys ?? [],
    providers,
    harnesses,
    agents: (agents ?? []).filter((agent) => agent.archivedAt === null),
    connectedRepos: (connectedRepos ?? []).filter((repo) => repo.archivedAt === null),
    forges,
    platformPolicy: background?.policy ?? null,
    /** OpenRouter's models, read while there is a live OpenRouter key; null without one. */
    openrouter,
    /** The reads that failed, so their step says it could not show what is there. */
    unread: {
      keys: modelAccess === null,
      agents: agents === null,
      repos: connectedRepos === null,
      background: background === null,
    },
  };
};
