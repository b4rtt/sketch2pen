#!/bin/bash
# Compiles the Liquid Glass app icon (assets/AppIcon.icon, edited with Apple's Icon Composer) with actool 26+.
#   bash tools/icon.sh            # refreshes the prebuilt copy in assets/icon and docs/images/icon.png
#   bash tools/icon.sh <outdir>   # writes Assets.car and Icon.icns to <outdir> (used by tools/build.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-assets/icon}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -R assets/AppIcon.icon "$TMP/Icon.icon"
mkdir -p "$OUT"
xcrun actool "$TMP/Icon.icon" --compile "$OUT" --output-format human-readable-text \
  --output-partial-info-plist "$TMP/info.plist" --app-icon Icon --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en --target-device mac \
  --minimum-deployment-target 26.0 --platform macosx >/dev/null
if [[ $# -eq 0 ]]; then
  iconutil -c iconset "$OUT/Icon.icns" -o "$TMP/Icon.iconset"
  cp "$TMP/Icon.iconset/icon_128x128@2x.png" docs/images/icon.png
  echo "updated assets/icon and docs/images/icon.png"
fi
