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

**1. Pick a subject.** Open the research console and paste a profile URL or a
slug; it prints the commands with the subject filled in.

```bash
npm install                  # once; uses the Chrome you already have
npm run console              # -> subjects/index.html
```

The console resolves pasted URLs through the same rules as `--subject`, so it
cannot hand you a command the CLI turns around and refuses. It also lists what
has been collected on this machine. A second build, `research.html`, is the one
that gets deployed: same launcher, no subject list.

**2. Collect.**

```bash
node collect.js                          # the signed-in account
node collect.js --subject dkeefe         # a named profile
node collect.js --subject "https://www.linkedin.com/in/dkeefe/" --days 90
```

The first run opens a Chrome window and waits up to fifteen minutes while you
sign in to LinkedIn yourself — the script never handles credentials, and
`--login-timeout <minutes>` adjusts the wait. The session is then kept in
`.browser/`, which is gitignored, and later runs are headless. Sign-in is
detected by LinkedIn's own `li_at` cookie, so an expired session is noticed
rather than collected through.

From there it is one step: `collect.js` opens the activity page, scrolls it in
small increments, reads each card as it renders, merges what it finds into
`subjects/<slug>/raw.psv`, and hands off to `analyze.py`, which writes the
report and its poster. Nothing goes through the clipboard.

```bash
node collect.js --subject X --passes 5   # more passes over the same window
node collect.js --subject X --headed     # watch it scroll
node collect.js --subject X --no-analyze # stop after writing raw.psv
node collect.js --subject X --replace    # overwrite rather than merging
```

Runs merge keyed on publication time, keeping the fullest reading of each field,
so collecting again accumulates rather than replaces — the same union the
multi-pass design depends on. The summary line reports how many were new.

**3. Read it.**

```bash
open subjects/<slug>/index.html      # the report
open subjects/<slug>/graphic.html    # the poster
```

**4. Export** (optional):

```bash
./make_graphic.sh <slug>                  # -> <slug>-pattern-of-life.png, 2x
THEME=dark ./make_graphic.sh <slug>       # dark palette
./make_pdf.sh out.pdf subjects/<slug>/index.html
```

### Subjects other than your own

Everything under `subjects/` is gitignored. Which profiles someone has collected
is the most sensitive thing this repo holds, so third-party histories stay on the
machine that collected them, and the deployed console ships none of them.

`collect.js` asks LinkedIn who you are before it collects: a subject that
resolves to the signed-in account is marked `--self`, and anything else is a
third party. `analyze.py --publish` refuses any subject not marked `--self`, so
another person's pattern of life cannot reach the published page by routine.

This is a tool for reading activity you are authorized to read. A pattern-of-life
report maps when a named person is reliably online and when they are not; treat
the output accordingly.

### Collecting by hand

`scrape.js` is still a paste-in console script, useful when Node is unavailable
or the automated pass is blocked. The console prints these steps too. Open the
subject's activity page, paste the file into DevTools, then:

```js
await lkCollect({ days: 30 })   // run this two or three times — see below
copy(lkExport())                // clipboard now holds the raw.psv contents
```

Paste into `subjects/<slug>/raw.psv`, then:

```bash
python3 analyze.py --subject <slug>          # summary, report, poster
python3 analyze.py --list                    # what has been collected
python3 analyze.py --tz Europe/London --subject <slug>
```

Both paths run the same harvest: `collect.js` loads `scrape.js` and calls the
functions it defines, rather than keeping a second copy of the card parsing.

Requires Python 3.9+ (for `zoneinfo`) and no third-party Python packages. The
automated path additionally needs Node and Playwright, which `npm install`
covers; it drives your installed Chrome, so no browser download is involved.

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

What gets deployed is the **console**, not a report. `vercel.json` builds
`research.html` into `public/index.html`:

```bash
npm run publish-console   # rebuild research.html from console.html
vercel deploy             # preview URL
vercel deploy --prod      # production
```

The hosted page is a launcher and nothing else. It resolves a profile URL to a
slug and prints the commands you run on your own machine; it holds no collected
data, names no subjects, and sends nothing anywhere — every keystroke stays in
the browser. The deployed build ships an empty subject list by construction, so
which profiles have been collected is not disclosed by the site.

**No report is hosted, including the maintainer's own.** A pattern-of-life page
maps when a named person is reliably online and when they are not, which is not
something to leave at a public URL for the convenience of having it there. A
Vercel URL is public to anyone who has it — `X-Robots-Tag: noindex` keeps it out
of search results, which is not the same as access control. If you ever do host
a rendered report, gate it with Deployment Protection.

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
- **Small samples.** Split sixty events across 24 hours and most hours hold one
  or two. `analyze.py` marks those `(thin)`, the dashboard draws them as hollow
  bars and the poster lightens them. They are anecdotes, not evidence.
- **Authorized reading only.** This reads pages you are signed in to and
  entitled to view, at human scroll speed. Collecting on a third party is a
  deliberate act: their data stays local, `--publish` refuses it, and what you
  do with it is your responsibility, not the tool's.

## Files

| File | |
|---|---|
| `collect.js` | Automated collector — drives Chrome, writes `subjects/<slug>/raw.psv`, runs the analysis |
| `scrape.js` | The harvest itself — loaded by `collect.js`, pasteable into the console |
| `console.html` | The research console — paste a profile, get the commands |
| `research.html` | The deployed build of the console; lists no subjects |
| `template.html` | Report template, one render per subject |
| `subjects/<slug>/` | Collected events, report and poster — gitignored |
| `analyze.py` | Summary, per-subject report and poster, console builds |
| `dashboard.html` | The published self report (`--publish`), data inlined |
| `graphic.html` | Poster template — hero finding, heatmap, cadence, table views |
| `make_pdf.sh` | Renders the dashboard to PDF via headless Chrome |
| `make_graphic.sh` | Renders a subject's poster to PNG at 2x |
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
