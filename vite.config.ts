import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
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

/**
 * Data files pdf.js loads at run time, served under /pdfjs/: Adobe CMaps (CJK
 * text in PDFs whose fonts are not embedded), the standard 14 fonts, the wasm
 * image decoders (JPEG 2000, JBIG2, CCITT) with their JS fallbacks, and the
 * colour profiles. The scripting engine (quickjs) is left out: PDF scripts never run.
 */
function pdfjsData(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const wanted = (dir: string, name: string) => dirs.includes(dir) && !name.startsWith("quickjs");
  return {
    name: "edit2-pdfjs-data",
    configureServer(server) {
      server.middlewares.use("/pdfjs", async (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "").split("?")[0])).replace(/^[\\/]+/, "");
        const [dir, name] = rel.split(sep);
        if (!name || rel.split(sep).length !== 2 || !wanted(dir, name)) return next();
        try {
          const body = await readFile(join(root, dir, name));
          res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of readdirSync(join(root, dir))) {
          if (!wanted(dir, name)) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [devFolders(), pdfjsData()],
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
