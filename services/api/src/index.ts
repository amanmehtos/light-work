/**
 * Light Week on Cloudflare.
 *
 * Everything this file does is choose implementations. The routing, auth, sync
 * and MCP all live in `@light/server-core` and know nothing about Cloudflare;
 * what is left here is the wiring, which is the entire point — the decision to
 * run on Cloudflare should be reversible, and the way to prove that is for the
 * Cloudflare-specific code to be small enough to read in one sitting.
 */

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createApp, pruneExpired } from "@light/server-core";
import {
  D1AuthStore,
  DurableObjectAccountStores,
  DurableObjectRealtime,
  googleFor,
  mailerFor,
} from "./adapters.js";

export { Account } from "./account.js";

function appFor(env: Env, origin: string) {
  const auth = new D1AuthStore(env.AUTH_DB);
  const google = googleFor(env, origin);
  return {
    auth,
    app: createApp({
      accounts: new DurableObjectAccountStores(env.ACCOUNT),
      auth,
      realtime: new DurableObjectRealtime(env.ACCOUNT),
      mailer: mailerFor(env),
      ...(google !== undefined ? { google } : {}),
      ...(env.PUBLIC_URL !== undefined && env.PUBLIC_URL !== ""
        ? { appUrl: env.PUBLIC_URL.replace(/\/+$/, "") }
        : {}),
      platform: "cloudflare",
      // The SDK's default validator compiles schemas with `new Function`,
      // which Workers forbid.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    }),
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return appFor(env, new URL(request.url).origin).app.fetch(request, env, ctx);
  },

  /** Housekeeping: expire sessions and sign-in codes. Wire to a cron trigger. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await pruneExpired(new D1AuthStore(env.AUTH_DB));
  },
} satisfies ExportedHandler<Env>;
