#!/bin/bash
# Signs every Mach-O file in the staged server (desktop/src-tauri/resources/perch)
# with the Developer ID identity, hardened runtime and a secure timestamp, as
# notarization requires: the Node runtime, node-pty's pty.node and spawn-helper,
# fsevents.node and esbuild. Tauri signs the app's own binary but not these.
# Run it after `npm run stage` and before `tauri build`.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)" desktop/scripts/sign-resources.sh
set -euo pipefail

[ "$(uname)" = Darwin ] || { echo "sign-resources: macOS only" >&2; exit 1; }
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY to the Developer ID Application identity}"

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../src-tauri/resources/perch"
entitlements="$here/../src-tauri/node.entitlements"
[ -d "$root" ] || { echo "sign-resources: no staged server at $root (run npm run stage first)" >&2; exit 1; }

sign() { codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$@"; }

count=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q '^Mach-O' || continue
  if [ "$f" = "$root/node/bin/node" ]; then
    sign --entitlements "$entitlements" "$f"
  else
    sign "$f"
  fi
  count=$((count + 1))
done < <(find "$root" -type f -print0)

[ -f "$root/node/bin/node" ] || { echo "sign-resources: $root/node/bin/node is missing" >&2; exit 1; }
codesign --verify --strict "$root/node/bin/node"
echo "sign-resources: signed $count Mach-O files"
