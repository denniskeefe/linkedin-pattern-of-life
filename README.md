# LinkedIn Pattern of Life

Charts when you actually post on LinkedIn, using exact publication times rather
than the feed's "3w ago" labels.

Built against one account over a 31-day window; the tooling is generic and the
window is a flag.

![pipeline](https://img.shields.io/badge/pipeline-collect%20%E2%86%92%20analyze%20%E2%86%92%20dashboard-2a78d6)

## Why the times are exact

LinkedIn shows relative timestamps, but every activity carries an id:

```
urn:li:activity:7504139249412337664
```

That id is a snowflake. Its high 41 bits are the publication time in
milliseconds since the epoch, so the precise moment is recoverable from the id
alone:

```js
Number(BigInt("7504139249412337664") >> 22n)   // 1789126217225
```

Every time in the output is decoded this way, then converted to a reporting
timezone. No estimation, no rounding to the nearest week.

## Usage

**1. Collect.**

```bash
npm install        # once; uses the Chrome you already have
npm run collect    # three passes over the last 30 days, then analyze
```

The first run opens a Chrome window and waits up to fifteen minutes while you
sign in to LinkedIn yourself — the script never handles credentials, and
`--login-timeout <minutes>` adjusts the wait. The session is then kept in
`.browser/`, which is gitignored, and later runs are headless. Sign-in is
detected by the presence of LinkedIn's own `li_at` cookie, so an expired
session is noticed rather than collected through: the collector reopens a
window and asks for a fresh one.

From there it is one step: `collect.js` opens your activity page, scrolls it in
small increments, reads each card as it renders, merges what it finds into
`raw.psv`, and hands off to `analyze.py`. Nothing goes through the clipboard.

```bash
node collect.js --days 90        # a wider window
node collect.js --passes 5       # more passes over the same window
node collect.js --headed         # watch it scroll
node collect.js --no-analyze     # stop after writing raw.psv
node collect.js --replace        # overwrite raw.psv instead of merging
node collect.js --tz Europe/London
node collect.js --login-timeout 30
```

Whose activity it reads is not a flag. The collector opens `/in/me/`, which
LinkedIn resolves to whichever account holds the session, so it can only ever
reach your own history.

Runs merge into `raw.psv` keyed on publication time, keeping the fullest
reading of each field, so collecting again accumulates rather than replaces —
the same union the multi-pass design depends on. The summary line reports how
many of the events were new.

**2. Open `dashboard.html`** for the interactive read, or `graphic.html` for the
poster — one page that leads with the finding rather than the charts. Both are
single files with the dataset inlined; `analyze.py --inject` refreshes both.

**3. Export the poster** (optional):

```bash
./make_graphic.sh                    # -> pattern-of-life.png, light, 2x
THEME=dark ./make_graphic.sh         # dark palette
WIDTH=1600 ./make_graphic.sh ~/Desktop/pol.png
```

Captures the full page at twice the pixel density, so it holds up when shared or
printed. It reuses the Playwright installed for collection; without it, it falls
back to headless Chrome.

**4. Export a PDF of the dashboard** (optional):

```bash
./make_pdf.sh                      # -> linkedin-pattern-of-life.pdf
./make_pdf.sh ~/Desktop/out.pdf    # or somewhere else
```

Renders through headless Chrome onto landscape Letter. The print stylesheet
forces the light palette regardless of the screen theme, expands the event log
into an appendix, and keeps charts from straddling page breaks. `Cmd+P` from the
browser produces the same result.

### Collecting by hand

`scrape.js` is still a paste-in console script, which is useful when Playwright
is not available or the automated pass is blocked. Open your own activity page:

```
https://www.linkedin.com/in/<you>/recent-activity/all/
```

and paste the file into the DevTools console:

```js
await lkCollect({ days: 30 })   // run this two or three times — see below
copy(lkExport())                // clipboard now holds the raw.psv contents
```

Paste into `raw.psv`, then:

```bash
python3 analyze.py --inject      # summary, activity.json, dashboard refresh
python3 analyze.py --tz Europe/London
python3 analyze.py other.psv
```

Both paths run the same harvest: `collect.js` loads `scrape.js` and calls the
functions it defines, rather than keeping a second copy of the card parsing.

Requires Python 3.9+ (for `zoneinfo`) and no third-party Python packages. The
automated path additionally needs Node and Playwright, which `npm install`
covers; it drives your installed Chrome, so no browser download is involved. If
you have no Chrome, run `npx playwright install chromium` and it will use that
instead.

## Two things the feed does that shape the code

**It virtualizes.** Cards scrolled out of view are removed from the DOM
entirely, so reading the page once after scrolling to the bottom returns only
whatever happens to be on screen. `scrape.js` harvests on every scroll tick
instead, and steps in ~350px increments — larger jumps let a card recycle in and
out between ticks without ever being read.

**It paginates non-deterministically.** Two independent passes over the same
date range return overlapping but *non-identical* sets. In the run this repo was
built from, each pass missed roughly a quarter of what the other caught. This is
why `lkCollect()` accumulates into a store across calls rather than returning a
result: **run it several times and take the union.**

The practical consequence: treat event counts as a floor, not a complete census.

## Hosting

The dashboard is a single self-contained file, so any static host works.
`vercel.json` builds only the dashboard into `public/index.html` — the
collection scripts and the raw data stay out of the deployed surface:

```bash
vercel deploy          # preview URL
vercel deploy --prod   # production
```

Responses are sent with `X-Robots-Tag: noindex`, so a deployment will not turn
up in search results. That is not access control: **a Vercel URL is public to
anyone who has it.** This page maps when a named person is reliably online and
when they are not, so gate it with Deployment Protection rather than relying on
an unguessable URL.

## Scope and caveats

- **Broadcast activity only.** The activity feed surfaces posts and reposts.
  Comments and reactions left on other people's content are not included, so
  real time-on-platform is wider than these charts show. For the complete
  picture use LinkedIn's own data export (Settings → Data privacy → Get a copy
  of your data), which ships `Shares.csv`, `Comments.csv` and `Reactions.csv`.
- **Engagement is a snapshot.** Reaction and comment counts are read at
  collection time. A post from four weeks ago has had four weeks to accumulate
  and today's has had hours, which biases any reach-over-time comparison toward
  older posts.
- **Small samples.** Split 42 events across 24 hours and most hours hold one or
  two. `analyze.py` marks those `(thin)` and the dashboard draws them as hollow
  bars. They are anecdotes, not evidence.
- **Your own account.** This reads a page you are already logged into and
  authorized to view. It is not a tool for collecting on other people.

## Files

| File | |
|---|---|
| `collect.js` | Automated collector — drives Chrome, writes `raw.psv`, runs the analysis |
| `scrape.js` | The harvest itself — loaded by `collect.js`, pasteable into the console |
| `raw.psv` | Collected events, pipe-delimited, oldest first |
| `analyze.py` | Summary, `activity.json`, dashboard injection |
| `activity.json` | Full parsed dataset, one object per event |
| `dashboard.html` | Self-contained interactive dashboard, data inlined |
| `graphic.html` | Poster view — hero finding, heatmap, cadence, table views |
| `make_pdf.sh` | Renders the dashboard to PDF via headless Chrome |
| `make_graphic.sh` | Renders the poster to PNG at 2x |
| `.browser/` | Chrome profile holding the LinkedIn session; gitignored |

## The dashboard

Five views, each answering a different question:

- **Weekday × hour grid** — the pattern-of-life view; where the cluster is
- **Time of day** — all events folded onto one 24-hour clock
- **Day of week** — posts and reposts, stacked
- **Daily timeline** — cadence and silent days across the window
- **Reach by hour** — average reactions per event, with sample sizes shown

Light and dark themes, hover detail on every mark, and a full event log table.
Prints to a seven-page landscape report, one chart per page.
