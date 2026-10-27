import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;

// PORT/BASE_PATH are required on Replit; fall back to sane local defaults for
// development on non-Replit machines (e.g. Windows local dev).
// A non-numeric or non-positive PORT ("0" is a common "pick any port"
// sentinel that some shells/CI inject) must never abort the build — it just
// falls back to the default port.
const parsedPort = Number(rawPort);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

const basePath = process.env.BASE_PATH ?? "/";

/* Local entry alias for the standalone admin portal. Vercel serves /admin via a
 * rewrite in vercel.json; in dev/preview we fall back to a URL rewrite so the
 * same entry (/admin) works locally instead of the SPA serving index.html. */
function adminEntryAlias(): Plugin {
  const middleware = (req: IncomingMessage, _res: ServerResponse, next: () => void): void => {
    const url = req.originalUrl ?? req.url ?? "";
    if (url === "/admin" || url.startsWith("/admin?") || url.startsWith("/admin/")) {
      req.url = url.replace(/^\/admin(?=$|\?|\/)/, "/admin.html");
    }
    next();
  };
  return {
    name: "admin-entry-alias",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    adminEntryAlias(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        admin: path.resolve(import.meta.dirname, "admin.html"),
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Local dev proxy: the frontend calls relative /api paths. On Replit the
    // deployment router forwards these to the api-server; locally we proxy
    // them to the api-server dev port (8080).
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
