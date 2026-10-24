import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Supplied by vitest.config.ts, which reads ./migrations at config time. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
