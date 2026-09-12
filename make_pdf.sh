#!/usr/bin/env bash
# Render dashboard.html to PDF using headless Chrome.
#
#   ./make_pdf.sh [output.pdf]
#
# The ?print=1 query expands the collapsed event log; the print stylesheet in
# dashboard.html forces the light palette and keeps charts off page breaks.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/linkedin-pattern-of-life.pdf}"

CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
done

if [ -z "$CHROME" ]; then
  echo "No Chrome or Chromium found. Install one, or open dashboard.html and print to PDF." >&2
  exit 1
fi

"$CHROME" \
  --headless \
  --disable-gpu \
  --no-pdf-header-footer \
  --virtual-time-budget=10000 \
  --print-to-pdf="$OUT" \
  "file://$HERE/dashboard.html?print=1" \
  2>/dev/null

echo "wrote $OUT"
