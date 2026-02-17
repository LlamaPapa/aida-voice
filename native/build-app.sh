#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="AIDA Voice"
APP_BUNDLE="${SCRIPT_DIR}/${APP_NAME}.app"

echo "═══════════════════════════════════════════════"
echo "  Building ${APP_NAME}.app"
echo "═══════════════════════════════════════════════"
echo ""

# ── Clean previous build ─────────────────────────────
if [ -d "$APP_BUNDLE" ]; then
    echo "  Cleaning previous build..."
    rm -rf "$APP_BUNDLE"
fi

# ── Create .app bundle structure ─────────────────────
echo "  Creating bundle structure..."
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources/bin"

# ── Copy Info.plist ──────────────────────────────────
cp "${SCRIPT_DIR}/Info.plist" "${APP_BUNDLE}/Contents/Info.plist"

# ── Build the audio helper ───────────────────────────
echo "  Compiling AidaVoiceHelper..."
swiftc -O \
    -framework AVFoundation \
    -framework Foundation \
    "${SCRIPT_DIR}/AidaVoiceHelper.swift" \
    -o "${APP_BUNDLE}/Contents/Resources/bin/AidaVoiceHelper"
echo "  ✓ AidaVoiceHelper"

# ── Build the server binary (bun compile) ────────────
BUN="$HOME/.bun/bin/bun"
if [ ! -f "$BUN" ]; then
    echo "  Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    BUN="$HOME/.bun/bin/bun"
fi

echo "  Compiling aida-voice-server (bun build --compile)..."
cd "$PROJECT_DIR"
"$BUN" build dist/cli.js --compile --outfile "${APP_BUNDLE}/Contents/Resources/bin/aida-voice-server" 2>&1 | tail -1
echo "  ✓ aida-voice-server"

# ── Copy .env if exists ──────────────────────────────
if [ -f "${PROJECT_DIR}/.env" ]; then
    cp "${PROJECT_DIR}/.env" "${APP_BUNDLE}/Contents/Resources/.env"
    echo "  ✓ .env copied"
fi

# ── Build the main app binary ────────────────────────
echo "  Compiling AidaVoice (main app)..."
swiftc -O \
    -framework Cocoa \
    -framework WebKit \
    -framework CoreGraphics \
    -framework QuartzCore \
    "${SCRIPT_DIR}/AidaVoice.swift" \
    -o "${APP_BUNDLE}/Contents/MacOS/AidaVoice"
echo "  ✓ AidaVoice"

# ── Ad-hoc code sign ────────────────────────────────
echo "  Code signing (ad-hoc)..."
codesign --force --deep --sign - "${APP_BUNDLE}" 2>/dev/null
echo "  ✓ Signed"

# ── Create DMG ──────────────────────────────────────
DMG_PATH="${SCRIPT_DIR}/${APP_NAME}.dmg"
if [ -f "$DMG_PATH" ]; then
    rm "$DMG_PATH"
fi

echo "  Creating DMG..."
hdiutil create -volname "${APP_NAME}" \
    -srcfolder "${APP_BUNDLE}" \
    -ov -format UDZO \
    "${DMG_PATH}" >/dev/null 2>&1
echo "  ✓ DMG created"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Build complete!"
echo ""
echo "  App:  ${APP_BUNDLE}"
echo "  DMG:  ${DMG_PATH}"
echo ""
echo "  To install:"
echo "    1. Open the DMG"
echo "    2. Drag AIDA Voice to Applications"
echo "    3. Right-click → Open (first time, to bypass Gatekeeper)"
echo "    4. Grant Accessibility + Microphone permissions"
echo "═══════════════════════════════════════════════"
