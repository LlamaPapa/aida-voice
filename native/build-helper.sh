#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/AidaVoiceHelper.swift"
OUT="$SCRIPT_DIR/AidaVoiceHelper"

echo "Building AidaVoiceHelper..."
swiftc -O \
  -framework AVFoundation \
  -framework Foundation \
  -o "$OUT" \
  "$SRC"

echo "Built: $OUT ($(du -h "$OUT" | cut -f1) )"
