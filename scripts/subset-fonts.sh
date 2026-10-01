#!/usr/bin/env bash
# Rebuilds public/fonts from Bertioga Sans (SIL OFL 1.1, https://github.com/cssobral2013/Bertioga-Sans).
# Keeps Latin, Latin-1 and Latin Extended-A plus common punctuation and symbols, which cuts each
# weight from about 250 KB to about 36 KB. Needs fonttools and brotli: pip install fonttools brotli
set -euo pipefail

SRC="${1:?usage: scripts/subset-fonts.sh path/to/Bertioga-Sans}"
OUT="$(dirname "$0")/../public/fonts"
UNICODES="U+0000-017F,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-209F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215,U+2303,U+2318,U+2325,U+232B,U+23CE,U+25B8,U+25BE,U+2713"

mkdir -p "$OUT"
for weight in Light Regular Medium SemiBold; do
    pyftsubset "$SRC/ttf/BertiogaSans-$weight.ttf" \
        --unicodes="$UNICODES" \
        --layout-features='*' \
        --flavor=woff2 \
        --output-file="$OUT/BertiogaSans-$weight.woff2"
done
cp "$SRC/OFL.txt" "$OUT/OFL.txt"
echo "Wrote $(ls "$OUT"/*.woff2 | wc -l) fonts to $OUT"
