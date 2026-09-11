# LinkedIn Pattern of Life

Charts when you actually post on LinkedIn, using exact publication times rather
than the feed's "3w ago" labels.

Built against one account over a 31-day window; the tooling is generic and the
window is a flag.

![pipeline](https://img.shields.io/badge/pipeline-scrape%20%E2%86%92%20analyze%20%E2%86%92%20dashboard-2a78d6)

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

**1. Collect.** Open your own activity page and paste `scrape.js` into the
DevTools console:

```
https://www.linkedin.com/in/<you>/recent-activity/all/
```

```js
await lkCollect({ days: 30 })   // run this two or three times — see below
copy(lkExport())                // clipboard now holds the raw.psv contents
```

Paste into `raw.psv`.

**2. Analyze.**

```bash
python3 analyze.py --inject
```

Prints a summary, writes `activity.json`, and refreshes the dataset embedded in
`dashboard.html`.

**3. Open `dashboard.html`.** No build step and no server; it is a single file.

```bash
python3 analyze.py --tz Europe/London    # report in a different timezone
python3 analyze.py other.psv             # read a different collection
```

Requires Python 3.9+ (for `zoneinfo`). No third-party packages.

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
| `scrape.js` | Console collector — multi-pass, virtualization-aware |
| `raw.psv` | Collected events, pipe-delimited, oldest first |
| `analyze.py` | Summary, `activity.json`, dashboard injection |
| `activity.json` | Full parsed dataset, one object per event |
| `dashboard.html` | Self-contained dashboard, data inlined |

## The dashboard

Five views, each answering a different question:

- **Weekday × hour grid** — the pattern-of-life view; where the cluster is
- **Time of day** — all events folded onto one 24-hour clock
- **Day of week** — posts and reposts, stacked
- **Daily timeline** — cadence and silent days across the window
- **Reach by hour** — average reactions per event, with sample sizes shown

Light and dark themes, hover detail on every mark, and a full event log table.
