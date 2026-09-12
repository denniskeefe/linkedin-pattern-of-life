#!/usr/bin/env bash
# Render a subject's poster to a shareable PNG.
#
#   ./make_graphic.sh dkeefe                     # -> dkeefe-pattern-of-life.png
#   ./make_graphic.sh dkeefe ~/Desktop/out.png
#   THEME=dark ./make_graphic.sh dkeefe          # dark palette
#   WIDTH=1600 ./make_graphic.sh dkeefe          # wider layout
#
# Reads subjects/<slug>/graphic.html, which analyze.py renders alongside the
# report. Uses the Playwright installed for collection, which measures the page
# and captures all of it; without it, headless Chrome and a fixed window.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLUG="${1:-}"
WIDTH="${WIDTH:-1280}"
THEME="${THEME:-light}"

if [ -z "$SLUG" ]; then
  echo "usage: ./make_graphic.sh <slug> [output.png]" >&2
  echo "known subjects:" >&2
  ls -1 "$HERE/subjects" 2>/dev/null | grep -v '^index.html$' >&2 || echo "  (none yet)" >&2
  exit 2
fi

PAGE="$HERE/subjects/$SLUG/graphic.html"
OUT="${2:-$HERE/$SLUG-pattern-of-life.png}"

if [ ! -f "$PAGE" ]; then
  echo "no poster for '$SLUG' — collect and render it first:" >&2
  echo "  node collect.js --subject $SLUG" >&2
  exit 1
fi

if [ -d "$HERE/node_modules/playwright" ]; then
  OUT="$OUT" WIDTH="$WIDTH" THEME="$THEME" PAGE="$PAGE" HERE="$HERE" node -e '
    const { chromium } = require(process.env.HERE + "/node_modules/playwright");
    (async () => {
      const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
      const page = await browser.newPage({
        viewport: { width: Number(process.env.WIDTH), height: 900 },
        deviceScaleFactor: 2,
        colorScheme: process.env.THEME === "dark" ? "dark" : "light"
      });
      await page.goto("file://" + process.env.PAGE, { waitUntil: "load" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: process.env.OUT, fullPage: true });
      await browser.close();
    })();
  '
  echo "wrote $OUT (${WIDTH}px wide, ${THEME}, 2x)"
  exit 0
fi

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
  echo "No Chrome or Chromium found. Open $PAGE and screenshot it instead." >&2
  exit 1
fi

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --virtual-time-budget=8000 \
  --window-size="${WIDTH},${GRAPHIC_HEIGHT:-2400}" \
  --screenshot="$OUT" "file://$PAGE" 2>/dev/null

echo "wrote $OUT (${WIDTH}px wide, fixed window)"
