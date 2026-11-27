import { redirect } from "@sveltejs/kit";
import { can } from "#lib/utils/auth/capabilities.ts";
import type { PageLoad } from "./$types";
import { listResetRequests } from "#lib/api/admin.ts";
import { getAuthSettings } from "#lib/api/auth.ts";
import { listProviders } from "#lib/api/identities.ts";

export const load: PageLoad = async ({ fetch, depends, parent }) => {
  const { user } = await parent();
  if (!can(user, "settings:manage")) redirect(302, "/instance/platform");
  depends("app:admin-authentication");
  const [settings, providers, resetRequests] = await Promise.all([
    getAuthSettings(fetch),
    listProviders(fetch).catch(() => []),
    listResetRequests(fetch),
  ]);
  return { settings, providers, resetRequests };
};
