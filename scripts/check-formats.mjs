// Fails the build when the format plugins and the bundle's file associations
// disagree about which extensions edit2 opens. Run by `npm run build`.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url);
const formats = new URL("src/formats/", root);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const plugins = new Set();
for (const dir of readdirSync(formats, { withFileTypes: true })) {
  const index = new URL(`${dir.name}/index.ts`, formats);
  if (!dir.isDirectory() || !existsSync(index)) continue;
  const m = /extensions:\s*\[([^\]]*)\]/.exec(readFileSync(index, "utf8"));
  if (!m) continue;
  for (const ext of m[1].matchAll(/"([^"]+)"/g)) plugins.add(ext[1]);
}

const associated = (file) => JSON.parse(read(file)).bundle.fileAssociations.flatMap((a) => a.ext);

// Windows associates only some formats and lists the rest under "Open with"
// from the installer hooks.
const openWith = [...read("src-tauri/windows/installer-hooks.nsh").matchAll(/^\s*!insertmacro \$\{MACRO\} "([^"]+)"/gm)].map((m) => m[1]);

let failed = false;
const check = (where, exts) => {
  const listed = new Set(exts);
  const missing = [...plugins].filter((e) => !listed.has(e));
  const extra = [...listed].filter((e) => !plugins.has(e));
  if (missing.length) console.error(`Not in ${where}: ${missing.join(", ")}`);
  if (extra.length) console.error(`In ${where} but no plugin claims them: ${extra.join(", ")}`);
  failed ||= missing.length > 0 || extra.length > 0;
};

check("tauri.conf.json fileAssociations", associated("src-tauri/tauri.conf.json"));
check(
  "tauri.windows.conf.json fileAssociations + windows/installer-hooks.nsh",
  [...associated("src-tauri/tauri.windows.conf.json"), ...openWith],
);
if (failed) process.exit(1);
console.log(`formats: ${plugins.size} extensions, file associations match`);
