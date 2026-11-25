#!/usr/bin/env bash
# Assemble the GitHub Pages site into $1 (default _site) and stamp a build id so browsers
# never run stale JS/CSS after a deploy (GitHub Pages caches files for 10 minutes).
# BUILD = hash of the static code files, so it only changes when the code changes
# (data-only refreshes keep the same build and never trigger page reloads).
set -euo pipefail
OUT="${1:-_site}"
cd "$(dirname "$0")/.."
rm -rf "$OUT"
mkdir -p "$OUT/data"
cp index.html style.css app.js "$OUT/"
cp data/markets.json "$OUT/data/"
BUILD="$(cat index.html style.css app.js | sha256sum | cut -c1-12)"
VERSION="$(grep -o 'v[0-9]\+\.[0-9]\+' index.html | tail -1)"
sed -i "s/__BUILD__/${BUILD}/g" "$OUT/index.html"
printf '{"build":"%s","version":"%s"}\n' "$BUILD" "$VERSION" > "$OUT/version.json"
touch "$OUT/.nojekyll"
echo "built $OUT: build=$BUILD version=$VERSION"
