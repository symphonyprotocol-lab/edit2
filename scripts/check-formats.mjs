// Fails the build when the format plugins and the bundle's file associations
// disagree about which extensions edit2 opens. Run by `npm run build`.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url);
const formats = new URL("src/formats/", root);

const plugins = new Set();
for (const dir of readdirSync(formats, { withFileTypes: true })) {
  const index = new URL(`${dir.name}/index.ts`, formats);
  if (!dir.isDirectory() || !existsSync(index)) continue;
  const m = /extensions:\s*\[([^\]]*)\]/.exec(readFileSync(index, "utf8"));
  if (!m) continue;
  for (const ext of m[1].matchAll(/"([^"]+)"/g)) plugins.add(ext[1]);
}

const conf = JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const bundled = new Set(conf.bundle.fileAssociations.flatMap((a) => a.ext));

const missing = [...plugins].filter((e) => !bundled.has(e));
const extra = [...bundled].filter((e) => !plugins.has(e));
if (missing.length || extra.length) {
  if (missing.length) console.error(`Not in tauri.conf.json fileAssociations: ${missing.join(", ")}`);
  if (extra.length) console.error(`In fileAssociations but no plugin claims them: ${extra.join(", ")}`);
  process.exit(1);
}
console.log(`formats: ${plugins.size} extensions, file associations match`);
