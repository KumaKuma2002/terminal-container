#!/bin/bash
# Builds build/TerminalContainer.app — the native (Swift + WKWebView) host.
# Needs only the Command Line Tools (no full Xcode).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/build/TerminalContainer.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -swift-version 5 -O \
  native/main.swift native/PtySession.swift native/SessionStore.swift native/Bridge.swift \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/TerminalContainer"

mkdir -p "$APP/Contents/Resources"
cp native/Info.plist "$APP/Contents/Info.plist"
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
printf 'APPLTCTN' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "Built $APP"
echo "Run with: open \"$APP\""
