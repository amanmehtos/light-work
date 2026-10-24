import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Diurnal UI has no build step and is not published to npm — it is a folder of
 * CSS and ES modules you copy or clone. It lives here as a git submodule at
 * `vendor/diurnal-ui`, kept pristine so it can be updated from upstream, and is
 * reached through this alias rather than by relative paths climbing out of the
 * app.
 */
const diurnal = fileURLToPath(new URL("../../vendor/diurnal-ui", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "diurnal-ui": diurnal } },
  server: {
    port: 5173,
    // The submodule sits outside the app root, so Vite has to be told it may
    // serve from there.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    // The API runs on wrangler dev locally; proxying keeps the app's own
    // origin on the token so there is no CORS dance in development.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
