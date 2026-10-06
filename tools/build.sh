#!/bin/bash
# Builds all release artifacts into dist/ and zipped archives into dist/release/.
#   bash tools/build.sh            # everything (macOS app + helper only when run on macOS)
#   bash tools/build.sh --host     # only the binary for this machine (fast local builds)
#   bash tools/build.sh --app      # the macOS app for this machine only (fast local builds, macOS)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
BUNDLE_ID="io.github.b4rtt.sketch2pen"
rm -rf dist
mkdir -p dist/release

build() { bun build src/cli.ts --compile --minify --target="$1" --outfile "dist/$2" >/dev/null && echo "  built dist/$2"; }

APP="dist/Sketch Pen.app"

# The macOS app: SwiftUI front end (native/app) with the CLI binaries and the CoreText helper in its resources.
#   build_app <archs…>   e.g. build_app arm64 x86_64 – the CLI binaries dist/sketch2pen-macos-* must exist
build_app() {
  local ICON=assets/icon
  local ACTOOL_MAJOR
  ACTOOL_MAJOR=$(xcrun actool --version 2>/dev/null | plutil -extract "com\.apple\.actool\.version.short-bundle-version" raw - 2>/dev/null | cut -d. -f1 || echo 0)
  if [[ "${ACTOOL_MAJOR:-0}" -ge 26 ]]; then
    ICON=dist/icon
    bash tools/icon.sh "$ICON"
  fi
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  local parts=()
  for arch in "$@"; do
    swiftc -parse-as-library -O -target "$arch-apple-macos13" native/app/SketchPen.swift -o "dist/app-$arch"
    parts+=("dist/app-$arch")
  done
  lipo -create "${parts[@]}" -output "$APP/Contents/MacOS/SketchPen"
  rm -f "${parts[@]}"
  local RES="$APP/Contents/Resources"
  for arch in "$@"; do
    local suffix=${arch/x86_64/x64}
    cp "dist/sketch2pen-macos-$suffix" "$RES/sketch2pen-$suffix"
  done
  cp dist/sketch2pen-coretext "$RES/"
  cp "$ICON/Assets.car" "$RES/Assets.car"
  cp "$ICON/Icon.icns" "$RES/Icon.icns"
  rm -rf dist/icon
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>SketchPen</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Sketch Pen</string>
  <key>CFBundleDisplayName</key><string>Sketch ⇄ Pen</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>Icon</string>
  <key>CFBundleIconName</key><string>Icon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>cs</string></array>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Sketch document</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>com.bohemiancoding.sketch.drawing</string></array>
      <key>CFBundleTypeExtensions</key><array><string>sketch</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>pen.dev document</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>CFBundleTypeExtensions</key><array><string>pen</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
  codesign --force --deep --sign - "$APP"
  echo "  built $APP"
}

if [[ "${1:-}" == "--host" ]]; then
  bun build src/cli.ts --compile --minify --outfile dist/sketch2pen >/dev/null
  if [[ "$(uname)" == "Darwin" ]]; then
    codesign --force --sign - dist/sketch2pen
    swiftc -O native/coretext.swift -o dist/sketch2pen-coretext
  fi
  echo "dist/sketch2pen ready"
  exit 0
fi

if [[ "${1:-}" == "--app" ]]; then
  ARCH=$(uname -m)
  SUFFIX=${ARCH/x86_64/x64}
  bun build src/cli.ts --compile --minify --outfile "dist/sketch2pen-macos-$SUFFIX" >/dev/null
  codesign --force --sign - "dist/sketch2pen-macos-$SUFFIX"
  swiftc -O native/coretext.swift -o dist/sketch2pen-coretext
  build_app "$ARCH"
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

build_app arm64 x86_64
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/release/Sketch-Pen-macos.zip"
(cd dist/release && shasum -a 256 * > SHA256SUMS.txt)
ls -lh dist/release
