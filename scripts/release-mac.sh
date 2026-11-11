#!/usr/bin/env bash
# Build the universal macOS app signed with a Developer ID and notarized by
# Apple, with a signed update, and publish the .dmg and the update to the
# GitHub release <tag> (create the release first, as a draft or published).
#
#   scripts/release-mac.sh v0.3.1            # build, notarize and publish
#   scripts/release-mac.sh v0.3.1 --no-publish
#
# Needs, once per Mac:
#   - a "Developer ID Application" certificate in the login keychain. The first
#     one found is used; set APPLE_SIGNING_IDENTITY to pick another.
#   - notarization credentials stored in the keychain as the profile
#     "edit2-notary" (or EDIT2_NOTARY_PROFILE):
#       xcrun notarytool store-credentials edit2-notary
#   - the updater key, ~/.tauri/edit2-updater.key (or EDIT2_UPDATER_KEY), with
#     its password in the .password file next to it.
set -euo pipefail

tag=${1:?usage: scripts/release-mac.sh <tag> [--no-publish], e.g. v0.3.1}
publish=1
[ "${2:-}" = --no-publish ] && publish=0

cd "$(dirname "$0")/.."
version=$(node -p 'require("./src-tauri/tauri.conf.json").version')
[ "${tag#v}" = "$version" ] || { echo "$tag does not match the version being built ($version)" >&2; exit 1; }

key=${EDIT2_UPDATER_KEY:-$HOME/.tauri/edit2-updater.key}
TAURI_SIGNING_PRIVATE_KEY=$(cat "$key")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$key.password")
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -1)
  [ -n "$APPLE_SIGNING_IDENTITY" ] || { echo 'no "Developer ID Application" certificate in the keychain' >&2; exit 1; }
fi
export APPLE_SIGNING_IDENTITY
echo "signing as $APPLE_SIGNING_IDENTITY"

# Check the credentials before a build that takes minutes.
profile=${EDIT2_NOTARY_PROFILE:-edit2-notary}
if ! xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
  echo "no notarization credentials in the keychain profile \"$profile\"; store them once with:" >&2
  echo "  xcrun notarytool store-credentials $profile" >&2
  exit 1
fi

# Tauri signs with the identity above. This script notarizes the result, so
# keep Tauri's own notarization (driven by these variables) out of the way.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

npm run tauri build -- --target universal-apple-darwin --config src-tauri/tauri.release.conf.json

out=src-tauri/target/universal-apple-darwin/release/bundle
app=$out/macos/edit2.app
dmg=$out/dmg/edit2_${version}_universal.dmg
codesign --verify --deep --strict "$app"

# Notarizing the signed .dmg covers the app inside it. Apple issues a ticket
# for each; stapling them lets Gatekeeper check them offline.
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
echo "notarizing $(basename "$dmg") (usually a few minutes)"
result=$(mktemp)
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait --timeout 30m --output-format json > "$result" || true
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
  if (r.status !== "Accepted") {
    console.error(`notarization: ${r.status ?? "failed"}` + (r.id ? `; details: xcrun notarytool log ${r.id} --keychain-profile ${process.argv[2]}` : ""));
    process.exit(1);
  }
  console.log("notarization: Accepted");
' "$result" "$profile"
xcrun stapler staple "$dmg"
xcrun stapler staple "$app"

# The update archive must hold the stapled app, so make it again and sign it
# again, bound to this version like the one `tauri build` made.
COPYFILE_DISABLE=1 tar -czf "$app.tar.gz" -C "$out/macos" edit2.app
rm -f "$app.tar.gz.sig"
npx tauri signer sign --app-version "$version" "$app.tar.gz" >/dev/null

spctl --assess --type execute "$app"
spctl --assess --type open --context context:primary-signature "$dmg"
echo "signed and notarized: $(basename "$dmg"), edit2.app.tar.gz"

if [ "$publish" = 1 ]; then
  node scripts/publish-update.mjs "$tag" mac
fi
