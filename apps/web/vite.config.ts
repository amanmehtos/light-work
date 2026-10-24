import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs on wrangler dev locally; proxying keeps the app's own
    // origin on the token so there is no CORS dance in development.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
