#!/bin/sh
# Renders electron/build/dmg-background.svg into the retina TIFF the .dmg window uses
# (540×380 @1x + 1080×760 @2x). Needs rsvg-convert (brew install librsvg); tiffutil is built in.
set -eu
cd "$(dirname "$0")/../../electron/build"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rsvg-convert -w 540 -h 380 dmg-background.svg -o "$tmp/bg.png"
rsvg-convert -w 1080 -h 760 dmg-background.svg -o "$tmp/bg@2x.png"
tiffutil -cathidpicheck "$tmp/bg.png" "$tmp/bg@2x.png" -out dmg-background.tiff
echo "wrote electron/build/dmg-background.tiff"
