#!/usr/bin/env node
// Uploads a built, signed update to a GitHub release and adds it to the
// release's latest.json, the manifest installed copies of edit2 check
// (plugins.updater.endpoints in src-tauri/tauri.conf.json).
//
//   node scripts/publish-update.mjs <tag> mac       # after a universal macOS build
//   node scripts/publish-update.mjs <tag> windows   # after a Windows build
//
// Build with `--config src-tauri/tauri.release.conf.json` and the signing key in
// TAURI_SIGNING_PRIVATE_KEY(_PASSWORD), so the bundle comes with its .sig file.
// macOS and Windows are built on different machines: each run keeps the other
// platform's entries already in latest.json.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "symphonyprotocol-lab/edit2";
const root = fileURLToPath(new URL("..", import.meta.url));

const [tag, platform] = process.argv.slice(2);
if (!tag || !["mac", "windows"].includes(platform)) {
  console.error("usage: node scripts/publish-update.mjs <tag> mac|windows");
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
if (tag.replace(/^v/, "") !== version) {
  console.error(`${tag} does not match the version being built (${version})`);
  process.exit(1);
}

// What to upload, as which asset, and the updater targets it serves.
const builds = {
  mac: {
    file: "src-tauri/target/universal-apple-darwin/release/bundle/macos/edit2.app.tar.gz",
    asset: `edit2_${version}_universal.app.tar.gz`,
    targets: ["darwin-aarch64", "darwin-x86_64"],
    extra: [`src-tauri/target/universal-apple-darwin/release/bundle/dmg/edit2_${version}_universal.dmg`],
  },
  windows: {
    file: `src-tauri/target/release/bundle/nsis/edit2_${version}_x64-setup.exe`,
    asset: `edit2_${version}_x64-setup.exe`,
    targets: ["windows-x86_64"],
    extra: [],
  },
};
const build = builds[platform];

const file = join(root, build.file);
for (const f of [file, `${file}.sig`]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}: build with --config src-tauri/tauri.release.conf.json and the signing key set`);
    process.exit(1);
  }
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// Release assets are named after the file uploaded: copy under the asset names.
const dir = mkdtempSync(join(tmpdir(), "edit2-update-"));
const asset = join(dir, build.asset);
copyFileSync(file, asset);
copyFileSync(`${file}.sig`, `${asset}.sig`);
const extras = build.extra.map((f) => join(root, f)).filter(existsSync);
gh("release", "upload", tag, asset, `${asset}.sig`, ...extras, "--repo", REPO, "--clobber");
console.log(`uploaded ${[asset, `${asset}.sig`, ...extras].map((f) => basename(f)).join(", ")}`);

const entry = {
  signature: readFileSync(`${file}.sig`, "utf8").trim(),
  url: `https://github.com/${REPO}/releases/download/${tag}/${build.asset}`,
};

function currentManifest() {
  try {
    return JSON.parse(gh("release", "download", tag, "--repo", REPO, "--pattern", "latest.json", "--output", "-"));
  } catch {
    return null; // first platform for this release
  }
}

// The other platform may be publishing at the same moment: write, read back,
// and merge again if its write replaced ours.
const manifest = join(dir, "latest.json");
for (let attempt = 1; ; attempt++) {
  const old = currentManifest();
  const keep = old?.version === version ? old.platforms ?? {} : {};
  const next = {
    version,
    pub_date: old?.version === version && old.pub_date ? old.pub_date : new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { ...keep, ...Object.fromEntries(build.targets.map((t) => [t, entry])) },
  };
  writeFileSync(manifest, JSON.stringify(next, null, 2) + "\n");
  gh("release", "upload", tag, manifest, "--repo", REPO, "--clobber");

  const check = currentManifest();
  if (build.targets.every((t) => check?.platforms?.[t]?.url === entry.url)) {
    console.log(`latest.json now serves ${Object.keys(check.platforms).sort().join(", ")}`);
    break;
  }
  if (attempt === 3) {
    console.error("latest.json kept losing this platform's entries; run again");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000 * attempt));
}
