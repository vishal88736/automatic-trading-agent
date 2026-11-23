import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

function redirectLocalAliases(): Plugin {
  return {
    name: "krono-local-origin",
    configureServer({ config, middlewares }) {
      const { host, port, https } = config.server;
      if (host !== "127.0.0.1" || !port || https) return;
      const canonical = new URL(`http://127.0.0.1:${port}`);
      const configured = process.env.KRONO_PUBLIC_ORIGIN;
      if (configured && configured !== canonical.origin) return;
      const aliases = new Set(
        ["localhost", "0.0.0.0"].map(
          (hostname) => new URL(`http://${hostname}:${port}`).host,
        ),
      );

      middlewares.use((request, response, next) => {
        const path = request.url ?? "/";
        const [pathname] = path.split("?", 1);
        if (
          request.method !== "GET" ||
          !aliases.has(request.headers.host ?? "") ||
          !request.headers.accept?.includes("text/html") ||
          !pathname.startsWith("/") ||
          pathname === "/platform" ||
          pathname.startsWith("/platform/")
        )
          return next();

        response.writeHead(307, {
          location: canonical.origin + path,
          "cache-control": "no-store",
        });
        response.end();
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [redirectLocalAliases(), react(), tailwindcss()],
  server: {
    port: Number(process.env.TERMINAL_UI_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/platform": process.env.KRONO_PLATFORM_URL ?? "http://127.0.0.1:8790",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
