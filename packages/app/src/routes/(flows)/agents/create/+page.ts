import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getEgress } from "#lib/api/egress.ts";
import { getForgeProviders } from "#lib/api/forge.ts";
import { getHarnesses } from "#lib/api/harnesses.ts";
import { getLimitsOrNull } from "#lib/api/limits.ts";
import { getMcpCatalogue, getToolAccess } from "#lib/api/mcp-servers.ts";
import { getModelAccess } from "#lib/api/provider-keys.ts";
import { getProvidersOrEmpty } from "#lib/api/providers.ts";
import { getConnectedRepos } from "#lib/api/repos.ts";
import { getSkillsOrNull } from "#lib/api/skills.ts";
import { safeBackTo } from "#lib/utils/safe-path.ts";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname)}`);

  const [
    harnesses,
    modelAccess,
    providers,
    toolAccess,
    connectedRepos,
    forgeProviders,
    egress,
    limits,
    skills,
    mcpCatalogue,
  ] = await Promise.all([
    getHarnesses(fetch),
    getModelAccess(fetch),
    getProvidersOrEmpty(fetch),
    getToolAccess(fetch),
    getConnectedRepos(fetch),
    // Which ways in exist, for whether issue and change request tools mean anything; null when
    // the list could not be read, which leaves them offered.
    getForgeProviders(fetch).catch(() => null),
    getEgress(fetch),
    getLimitsOrNull(fetch),
    getSkillsOrNull(fetch),
    // Brand marks and the tools an entry leaves off by default. Only a nicety for the Tools
    // section, so a catalogue that cannot be read is an empty one, never an error page.
    getMcpCatalogue(fetch).catch(() => null),
  ]);
  return {
    harnesses,
    ...modelAccess,
    providers,
    ...toolAccess,
    connectedRepos,
    forgeProviders,
    ...egress,
    limits,
    skills,
    catalogueEntries: mcpCatalogue?.entries ?? [],
    // Where the flow returns to when it was opened from another flow (the welcome); else /agents.
    backTo: safeBackTo(url.searchParams.get("backTo")),
  };
};
