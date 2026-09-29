#!/bin/bash
# Builds all release artifacts into dist/ and zipped archives into dist/release/.
#   bash tools/build.sh            # everything (macOS app + helper only when run on macOS)
#   bash tools/build.sh --host     # only the binary for this machine (fast local builds)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
BUNDLE_ID="io.github.b4rtt.sketch2pen"
rm -rf dist
mkdir -p dist/release

build() { bun build src/cli.ts --compile --minify --target="$1" --outfile "dist/$2" >/dev/null && echo "  built dist/$2"; }

if [[ "${1:-}" == "--host" ]]; then
  bun build src/cli.ts --compile --minify --outfile dist/sketch2pen >/dev/null
  if [[ "$(uname)" == "Darwin" ]]; then
    codesign --force --sign - dist/sketch2pen
    swiftc -O native/coretext.swift -o dist/sketch2pen-coretext
  fi
  echo "dist/sketch2pen ready"
  exit 0
fi

echo "sketch2pen $VERSION"
build bun-linux-x64 sketch2pen-linux-x64
build bun-linux-arm64 sketch2pen-linux-arm64
build bun-windows-x64 sketch2pen-windows-x64.exe
(cd dist && cp sketch2pen-linux-x64 sketch2pen && tar -czf release/sketch2pen-linux-x64.tar.gz sketch2pen && rm sketch2pen)
(cd dist && cp sketch2pen-linux-arm64 sketch2pen && tar -czf release/sketch2pen-linux-arm64.tar.gz sketch2pen && rm sketch2pen)
(cd dist && cp sketch2pen-windows-x64.exe sketch2pen.exe && zip -q release/sketch2pen-windows-x64.zip sketch2pen.exe && rm sketch2pen.exe)

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping macOS builds (they need macOS for codesign, swiftc and osacompile)."
  exit 0
fi

build bun-darwin-arm64 sketch2pen-macos-arm64
build bun-darwin-x64 sketch2pen-macos-x64
# bun's embedded signature is invalidated by the appended payload – re-sign ad hoc
codesign --force --sign - dist/sketch2pen-macos-arm64 dist/sketch2pen-macos-x64

# CoreText helper: SF Symbols outlines and Sketch-exact text wrapping (universal binary)
swiftc -O -target arm64-apple-macos12 native/coretext.swift -o dist/coretext-arm64
swiftc -O -target x86_64-apple-macos12 native/coretext.swift -o dist/coretext-x64
lipo -create dist/coretext-arm64 dist/coretext-x64 -output dist/sketch2pen-coretext
rm dist/coretext-arm64 dist/coretext-x64
codesign --force --sign - dist/sketch2pen-coretext
echo "  built dist/sketch2pen-coretext (universal)"

for arch in arm64 x64; do
  mkdir -p "dist/pkg-$arch"
  cp "dist/sketch2pen-macos-$arch" "dist/pkg-$arch/sketch2pen"
  cp dist/sketch2pen-coretext "dist/pkg-$arch/"
  (cd "dist/pkg-$arch" && zip -q -y "../release/sketch2pen-macos-$arch.zip" sketch2pen sketch2pen-coretext)
  rm -rf "dist/pkg-$arch"
done

# App icon: compile the Liquid Glass source when actool 26+ is available, otherwise use the prebuilt copy.
ICON=assets/icon
ACTOOL_MAJOR=$(xcrun actool --version 2>/dev/null | plutil -extract "com\.apple\.actool\.version.short-bundle-version" raw - 2>/dev/null | cut -d. -f1 || echo 0)
if [[ "${ACTOOL_MAJOR:-0}" -ge 26 ]]; then
  ICON=dist/icon
  bash tools/icon.sh "$ICON"
fi

APP="dist/Sketch to Pen.app"
osacompile -o "$APP" tools/droplet.applescript
RES="$APP/Contents/Resources"
cp dist/sketch2pen-macos-arm64 "$RES/sketch2pen-arm64"
cp dist/sketch2pen-macos-x64 "$RES/sketch2pen-x64"
cp dist/sketch2pen-coretext "$RES/"
rm -f "$RES/droplet.icns" "$RES/Assets.car"
cp "$ICON/Assets.car" "$RES/Assets.car"
cp "$ICON/Icon.icns" "$RES/Icon.icns"
rm -rf dist/icon
PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null 2>&1 || true; }
pb "Delete :CFBundleIconFile"; pb "Add :CFBundleIconFile string Icon"
pb "Delete :CFBundleIconName"; pb "Add :CFBundleIconName string Icon"
pb "Delete :CFBundleIdentifier"; pb "Add :CFBundleIdentifier string $BUNDLE_ID"
pb "Delete :CFBundleShortVersionString"; pb "Add :CFBundleShortVersionString string $VERSION"
pb "Delete :CFBundleVersion"; pb "Add :CFBundleVersion string $VERSION"
pb "Delete :CFBundleDocumentTypes"
pb "Add :CFBundleDocumentTypes array"
pb "Add :CFBundleDocumentTypes:0 dict"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Sketch document"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer"
pb "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate"
pb "Add :CFBundleDocumentTypes:0:LSItemContentTypes array"
pb "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string com.bohemiancoding.sketch.drawing"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string sketch"
codesign --force --deep --sign - "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/release/Sketch-to-Pen-macos.zip"
echo "  built $APP"
(cd dist/release && shasum -a 256 * > SHA256SUMS.txt)
ls -lh dist/release
