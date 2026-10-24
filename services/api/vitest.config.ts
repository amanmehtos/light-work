import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  // Migrations are read at config time and handed to the test setup, so tests
  // run against exactly the schema a deploy would apply.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        // One worker instance: the Durable Object is the unit under test and
        // sharding it across workers would hide ordering bugs.
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Lets tests read sign-in codes back instead of sending mail.
            DEV_LOGIN: "1",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
