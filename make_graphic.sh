#!/usr/bin/env bash
# Render graphic.html to a shareable PNG.
#
#   ./make_graphic.sh                       # -> pattern-of-life.png, light, 2x
#   ./make_graphic.sh ~/Desktop/out.png
#   THEME=dark ./make_graphic.sh            # dark palette
#   WIDTH=1600 ./make_graphic.sh            # wider layout
#
# Uses the Playwright already installed for collection, which measures the page
# and captures all of it. With no node_modules it falls back to headless Chrome
# and a fixed window, which can leave blank space below the content.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/pattern-of-life.png}"
WIDTH="${WIDTH:-1280}"
THEME="${THEME:-light}"

if [ -d "$HERE/node_modules/playwright" ]; then
  OUT="$OUT" WIDTH="$WIDTH" THEME="$THEME" HERE="$HERE" node -e '
    const { chromium } = require(process.env.HERE + "/node_modules/playwright");
    (async () => {
      const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
      const page = await browser.newPage({
        viewport: { width: Number(process.env.WIDTH), height: 900 },
        deviceScaleFactor: 2,
        colorScheme: process.env.THEME === "dark" ? "dark" : "light"
      });
      await page.goto("file://" + process.env.HERE + "/graphic.html", { waitUntil: "load" });
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
  echo "No Chrome or Chromium found. Open graphic.html and screenshot it instead." >&2
  exit 1
fi

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --virtual-time-budget=8000 \
  --window-size="${WIDTH},${GRAPHIC_HEIGHT:-2400}" \
  --screenshot="$OUT" \
  "file://$HERE/graphic.html" 2>/dev/null

echo "wrote $OUT (${WIDTH}px wide, fixed window)"
