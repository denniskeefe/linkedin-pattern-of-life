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

## Researching a new profile

`subjects/index.html` is a local launcher. Paste any LinkedIn profile URL into
the field and it resolves the URL to a subject slug, says whether that profile
has already been collected, and lays out the collection steps with the commands
filled in — including `scrape.js` itself, inlined behind a copy button.

```bash
python3 analyze.py --console     # build or refresh it, then open subjects/index.html
```

It resolves URLs with the same rules as `--subject`, so it will never hand you a
command the CLI turns around and refuses. Typing a name instead of a URL filters
the list of already-collected subjects. Optional fields for collection window,
display name and reporting timezone rewrite the generated commands as you type —
timezone matters when the subject is not in yours.

The console is rewritten after every `analyze.py` run, so its subject list cannot
drift from what is on disk. It lives under `subjects/`, which is gitignored, and
`analyze.py --subject <new-slug>` prints a direct link to it.

The same page is deployed publicly, built with no subject list at all:

```bash
python3 analyze.py --publish-console     # writes research.html, which vercel.json serves
```

Which profiles someone has collected is the most sensitive thing this repo holds,
so the hosted build ships none of it. It is the launcher and the collector, not
anybody's data.

## Usage

The console walks you through all of this; here it is in full.

**1. Collect.** Open a profile's activity page and paste `scrape.js` into the
DevTools console:

```
https://www.linkedin.com/in/<slug>/recent-activity/all/
```

```js
lkSubject()                     // prints the slug and the file path to use
await lkCollect({ days: 30 })   // run two or three times — see below
copy(lkExport())
```

Paste the clipboard into `subjects/<slug>/raw.psv`.

Collecting a second profile? Reload the page and run `lkReset()` first. The
store persists across calls by design, so without a reset two people's activity
merges into one file.

**2. Analyze.**

```bash
python3 analyze.py --subject <slug> --label "Their Name"
python3 analyze.py --list                       # what has been collected
python3 analyze.py --subject <slug> --tz Europe/London
```

`--subject` takes a slug or any member profile URL — paste the link straight
from the address bar and the extra path and tracking parameters are discarded:

```bash
python3 analyze.py --subject dkeefe
python3 analyze.py --subject linkedin.com/in/dkeefe
python3 analyze.py --subject "https://www.linkedin.com/in/dkeefe/recent-activity/all/"
python3 analyze.py --subject "https://uk.linkedin.com/in/dkeefe?originalSubdomain=uk"
```

Anything path-shaped must actually contain `/in/<slug>`. A company page, a feed
URL, or a stray path is rejected by name rather than quietly analyzed as a
subject called `feed`.

Each subject gets its own directory:

```
subjects/index.html             research console — paste a URL, get the steps
subjects/<slug>/raw.psv         collected events
subjects/<slug>/meta.json       label, timezone, self flag — remembered
subjects/<slug>/activity.json   parsed dataset
subjects/<slug>/index.html      rendered dashboard
```

**3. Open `subjects/<slug>/index.html`.** No build step and no server.

Every number and every sentence in a report is computed from that subject's own
data — headline findings, the cadence description, the small-sample caveat.
Nothing carries over between subjects.

**4. Export a PDF** (optional):

```bash
./make_pdf.sh                                    # the published dashboard
./make_pdf.sh out.pdf subjects/<slug>/index.html # a specific subject
```

Renders through headless Chrome onto landscape Letter. The print stylesheet
forces the light palette regardless of the screen theme, expands the event log
into an appendix, and keeps charts from straddling page breaks. `Cmd+P` from the
browser produces the same result.

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

## Hosting

**What is deployed is the console, and only the console.** `vercel.json` builds
`research.html` into `public/index.html`. No report is hosted — not a
third party's, and not your own.

```bash
python3 analyze.py --publish-console   # rebuild research.html after changing console.html
vercel deploy                          # preview URL
vercel deploy --prod                   # production
```

The deployed page is a launcher: it normalizes a URL and prints commands. It has
no backend, makes no requests, and stores nothing — whatever you type into it
stays in your own browser. Collection still happens in your console, on your
account.

If you ever go back to hosting a rendered report, remember what one is: a map of
when a named person is reliably online and when they are not. A Vercel URL is
public to anyone who has it, so gate it with Deployment Protection rather than
relying on the URL being unguessable.

## Subjects other than your own

The collector reads whatever activity page is open, so any profile you can view
works the same way. Three consequences follow, and they are enforced rather than
suggested:

**Collected subjects stay local.** `subjects/` is gitignored, and the deployed
console is built with an empty subject list. A third party's activity history
does not belong in a repo, and a repo made public later is not a decision you
want to have made by accident.

One exception, stated plainly rather than left to be discovered: this repo's own
`subjects/dkeefe/raw.psv` was committed before that ignore rule existed, so the
maintainer's 42 collected events are in the public history. It is self-collected
data published knowingly. Nothing else under `subjects/` has ever been tracked,
and `git check-ignore subjects/<slug>` will confirm that for anything you add.

**`--publish` refuses non-self subjects.** Copying a report onto the deployed
surface requires that subject to be marked `--self`. Reports on other people are
read on the machine that produced them.

**Reports label themselves.** A subject not marked `--self` renders as
`third-party subject` in the masthead and carries a note stating plainly what
the page maps. A pattern-of-life report circulating without that framing invites
exactly the wrong reading.

Two matters that belong to the operator, not the tool:

- **LinkedIn's terms prohibit automated collection.** Whether scraping public
  pages is lawful and whether it breaches a contract you accepted are separate
  questions. The practical exposure is account restriction, and it falls on the
  account doing the collecting.
- **Individual pattern-of-life needs a basis.** This output maps when a named
  person is reliably reachable and — more useful to the wrong reader — when they
  are not. Inside an authorized engagement that is a finding. Outside one it is
  something else, and the data having been public does not change which.

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
- **Small samples.** Split a month of posting across 24 hours and most hours hold
  one or two events. `analyze.py` marks those `(thin)` and the dashboard draws
  them as hollow bars. They are anecdotes, not evidence.

## Files

| File | |
|---|---|
| `scrape.js` | Console collector — multi-pass, virtualization-aware |
| `analyze.py` | Per-subject summary and dashboard rendering |
| `template.html` | The report, with an empty data slot |
| `console.html` | The research console, with an empty subject-list slot |
| `research.html` | The deployed console — built with no subject list |
| `subjects/<slug>/` | One directory per collected profile — **gitignored** |
| `dashboard.html` | Rendered copy of the self subject — committed, not deployed |
| `make_pdf.sh` | Renders a dashboard to PDF via headless Chrome |

## The dashboard

Five views, each answering a different question:

- **Weekday × hour grid** — the pattern-of-life view; where the cluster is
- **Time of day** — all events folded onto one 24-hour clock
- **Day of week** — posts and reposts, stacked
- **Daily timeline** — cadence and silent days across the window
- **Reach by hour** — average reactions per event, with sample sizes shown

Light and dark themes, hover detail on every mark, and a full event log table.
Prints to a seven-page landscape report, one chart per page.
