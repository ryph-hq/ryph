import { error, json, type RequestHandler } from "@sveltejs/kit";
import { passkeyLoginOptions, UpstreamAuthError } from "#lib/server/auth.ts";

export const POST: RequestHandler = async () => {
  try {
    return json(await passkeyLoginOptions());
  } catch (e) {
    if (e instanceof UpstreamAuthError) error(e.status, e.message);
    throw e;
  }
};
