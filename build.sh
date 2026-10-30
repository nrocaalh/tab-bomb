#!/usr/bin/env bash
# Construye los paquetes instalables de Tab Bomb (Chrome/Brave + Firefox).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist"
SRC="$ROOT/src"

rm -rf "$OUT/chrome" "$OUT/firefox"
mkdir -p "$OUT/chrome" "$OUT/firefox"

cp -R "$SRC/." "$OUT/chrome/"
cp -R "$SRC/." "$OUT/firefox/"

cp "$ROOT/manifests/manifest.chrome.json" "$OUT/chrome/manifest.json"
cp "$ROOT/manifests/manifest.firefox.json" "$OUT/firefox/manifest.json"

python3 "$ROOT/tools/zipdist.py"

echo "Listo:"
ls -lh "$OUT"/tab-bomb-*.zip
