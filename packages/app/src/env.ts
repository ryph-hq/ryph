// Every variable the app reads at runtime, for `$app/env/private` and `$app/env/public`. All are
// optional, as they were under `$env/dynamic/*`: the code that reads one says what its absence
// means (`checkProxySecret` refuses to start without the proxy secret, the OAuth providers hide
// without a client id), so nothing here fails the build or the start on its own.
import { defineEnvVars } from "@sveltejs/kit/env";

const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
  RYPH_PROXY_SECRET: { schema: optional },
  RYPH_API_URL: { schema: optional },
  RYPH_HISTORY_URL: { schema: optional },
  RYPH_MODEL_PROXY_CONTROL_URL: { schema: optional },
  RYPH_MCP_GATEWAY_CONTROL_URL: { schema: optional },
  RYPH_AUTOMATIONS_URL: { schema: optional },
  RYPH_MEMORY_URL: { schema: optional },
  RYPH_CHAT_URL: { schema: optional },
  RYPH_ASSET_FALLBACK_URL: { schema: optional },
  RYPH_ASSET_ACCESS_KEY_ID: { schema: optional },
  RYPH_ASSET_SECRET_ACCESS_KEY: { schema: optional },
  RYPH_ASSET_REGION: { schema: optional },
  PUBLIC_AUTOMATIONS_ORIGIN: { public: true, schema: optional },
  PUBLIC_GITHUB_APP_NAME: { public: true, schema: optional },
  PUBLIC_GITHUB_CLIENT_ID: { public: true, schema: optional },
  PUBLIC_GITLAB_CLIENT_ID: { public: true, schema: optional },
  PUBLIC_GITLAB_URL: { public: true, schema: optional },
});
