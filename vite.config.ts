import { readdir, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** Same rule as `fstree::is_hidden` in the backend. */
const HEAVY_DIRS = ["node_modules", "__pycache__"];

/**
 * `npm run dev` in a plain browser has no backend: answer the folder sidebar's
 * listing and stat calls here so the tree can be tried with real folders.
 */
function devFolders(): Plugin {
  return {
    name: "edit2-dev-folders",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__edit2", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.searchParams.get("path") ?? "";
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", status === 200 ? "application/json" : "text/plain; charset=utf-8");
          res.end(status === 200 ? JSON.stringify(body) : String(body));
        };
        try {
          if (url.pathname === "/stat") {
            const info = await stat(path).catch(() => null);
            return send(200, info && { path: await realpath(path), dir: info.isDirectory() });
          }
          if (url.pathname !== "/ls") return send(404, "unknown");
          const hidden = url.searchParams.has("hidden");
          const out: { name: string; path: string; dir: boolean }[] = [];
          for (const d of await readdir(path, { withFileTypes: true })) {
            const full = join(path, d.name);
            const dir = d.isSymbolicLink() ? (await stat(full).catch(() => null))?.isDirectory() : d.isDirectory();
            if (dir === undefined) continue; // dangling link
            if (!hidden && (d.name.startsWith(".") || (dir && HEAVY_DIRS.includes(d.name)))) continue;
            out.push({ name: d.name, path: full, dir });
          }
          out.sort(
            (a, b) =>
              Number(b.dir) - Number(a.dir) ||
              (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) ||
              (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          );
          send(200, out);
        } catch (err) {
          send(500, err instanceof Error ? err.message : err);
        }
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [devFolders()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 2000,
  },
});
