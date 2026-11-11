#!/usr/bin/env bash
# Build the universal macOS app with a signed update, and publish the .dmg and
# the update to the GitHub release <tag> (create the release first, as a draft
# or published). The updater key defaults to ~/.tauri/edit2-updater.key, with
# its password in the .password file next to it.
set -euo pipefail

tag=${1:?usage: scripts/release-mac.sh <tag>, e.g. v0.3.0}
key=${EDIT2_UPDATER_KEY:-$HOME/.tauri/edit2-updater.key}

TAURI_SIGNING_PRIVATE_KEY=$(cat "$key")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$key.password")
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

cd "$(dirname "$0")/.."
npm run tauri build -- --target universal-apple-darwin --config src-tauri/tauri.release.conf.json
node scripts/publish-update.mjs "$tag" mac
