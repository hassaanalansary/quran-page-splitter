import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  server: {
    // `changeOrigin: false` is load-bearing, and must be explicit: Vite 7
    // defaults it to **true**, which rewrites Host to localhost:8000. Django
    // then sees Host localhost:8000 while the browser sends
    // Origin: http://localhost:5173, the CSRF origin check fails, and every
    // POST/DELETE comes back 403 — login, logout, the lot.
    //
    // Keeping the original Host also makes allauth build its OAuth redirect_uri
    // on :5173, so the Google round trip returns to the dev server rather than
    // dumping the user on :8000's built bundle.
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: false },
      "/media": { target: "http://localhost:8000", changeOrigin: false },
      "/_allauth": { target: "http://localhost:8000", changeOrigin: false },
      "/accounts": { target: "http://localhost:8000", changeOrigin: false },
    },
  },
});
