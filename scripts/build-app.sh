#!/usr/bin/env bash
# Builds build/memable.app (and a distributable zip) from the Swift package.
#
#   scripts/build-app.sh                 # release build for this Mac's architecture, ad-hoc signed
#   UNIVERSAL=1 scripts/build-app.sh     # arm64 + x86_64
#   CODESIGN_IDENTITY="Developer ID Application: …" scripts/build-app.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(tr -d '[:space:]' < VERSION)"
BUILD_NUMBER="${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
BUNDLE_ID="${BUNDLE_ID:-com.tetsuakibaba.memable}"
IDENTITY="${CODESIGN_IDENTITY:--}"
OUT="$ROOT/build"
APP="$OUT/memable.app"

ARCH_FLAGS=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
    ARCH_FLAGS=(--arch arm64 --arch x86_64)
fi

echo "==> Building memable $VERSION ($BUILD_NUMBER)"
swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN_DIR="$(swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Memable" "$APP/Contents/MacOS/memable"
cp Sources/Memable/Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" -e "s/__BUNDLE_ID__/$BUNDLE_ID/" \
    Sources/Memable/Resources/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" > /dev/null

# Synced folders (Dropbox, iCloud) attach extended attributes that codesign rejects.
xattr -cr "$APP"

echo "==> Signing ($IDENTITY)"
SIGN_FLAGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != "-" ]]; then
    SIGN_FLAGS+=(--options runtime --timestamp)
fi
codesign "${SIGN_FLAGS[@]}" "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "==> Architectures: $(lipo -archs "$APP/Contents/MacOS/memable")"

ZIP="$OUT/memable-$VERSION-macos.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "==> Done: $APP"
echo "         $ZIP"
