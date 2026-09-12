#!/usr/bin/env python3
"""Turn collected LinkedIn activity into a summary and a ready-to-open dashboard.

Pipeline:
    scrape.js  ->  raw.psv  ->  analyze.py  ->  activity.json + dashboard.html

Usage:
    python3 analyze.py                      # read raw.psv, print summary
    python3 analyze.py --inject             # ...and refresh dashboard.html
    python3 analyze.py --tz Europe/London   # report in a different timezone

raw.psv is what lkExport() copies to the clipboard: one event per line,
pipe-delimited, oldest first:

    <epoch_ms>|<kind>|<reactions>|<comments>|<reposts>|<words>|<media>|<text>
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# The dashboard reads its data from this element.
DATA_OPEN = '<script id="data" type="application/json">'
DATA_CLOSE = "</script>"


def read_events(path, tzname):
    """Parse raw.psv into event dicts, with times in the reporting timezone."""
    tz = ZoneInfo(tzname)
    events = []

    for lineno, line in enumerate(Path(path).read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 7:
            sys.exit(f"{path}:{lineno}: expected at least 7 fields, got {len(parts)}")

        ts, kind, reactions, comments, reposts, words, media = parts[:7]
        text = parts[7].strip() if len(parts) > 7 else ""
        dt = datetime.fromtimestamp(int(ts) / 1000, tz)

        events.append({
            "ts": int(ts),
            "iso": dt.isoformat(),
            "date": dt.strftime("%Y-%m-%d"),
            "hour": dt.hour,
            "min": dt.minute,
            "dow": dt.weekday(),
            "kind": kind,
            "reactions": int(reactions),
            "comments": int(comments),
            "reposts": int(reposts),
            "words": int(words),
            "media": media,
            "text": text,
        })

    events.sort(key=lambda e: e["ts"])
    return events


def summarize(events):
    """Print the findings the dashboard headlines, so a run is useful on its own."""
    first, last = events[0], events[-1]
    by_hour = Counter(e["hour"] for e in events)
    by_dow = Counter(e["dow"] for e in events)

    span = (datetime.fromisoformat(last["iso"]).date()
            - datetime.fromisoformat(first["iso"]).date()).days + 1

    active = {e["date"] for e in events}
    silent = span - len(active)

    print(f"{len(events)} events over {span} days "
          f"({first['iso'][:10]} to {last['iso'][:10]})")
    print("  mix     " + ", ".join(f"{k} {v}" for k, v in Counter(e["kind"] for e in events).most_common()))
    print("  media   " + ", ".join(f"{k} {v}" for k, v in Counter(e["media"] for e in events).most_common()))
    print(f"  cadence {len(events) / span * 7:.1f}/week, {silent} silent days")
    print()

    print("TIME OF DAY")
    for h in range(24):
        if by_hour[h]:
            print(f"  {h:02d}:00  {'#' * by_hour[h]} {by_hour[h]}")
    print()

    print("DAY OF WEEK")
    for d in range(7):
        print(f"  {DAYS[d]}  {'#' * by_dow[d]:<14} {by_dow[d]}")
    print()

    # Reach by hour. Most hours hold very few events, so print n alongside the
    # average and let the reader discount the thin ones.
    total = Counter()
    count = Counter()
    for e in events:
        total[e["hour"]] += e["reactions"]
        count[e["hour"]] += 1

    print("AVG REACTIONS BY HOUR")
    for h in sorted(count, key=lambda h: -total[h] / count[h]):
        flag = "" if count[h] >= 3 else "   (thin)"
        print(f"  {h:02d}:00  {total[h] / count[h]:6.1f}  n={count[h]}{flag}")


def inject(events, dashboard):
    """Replace the dashboard's embedded dataset in place."""
    html = dashboard.read_text()
    start = html.find(DATA_OPEN)
    if start == -1:
        sys.exit(f"{dashboard}: no <script id=\"data\"> block to inject into")
    body = start + len(DATA_OPEN)
    end = html.find(DATA_CLOSE, body)
    if end == -1:
        sys.exit(f"{dashboard}: unterminated <script id=\"data\"> block")

    compact = [{
        "t": e["iso"][:16],
        "k": e["kind"],
        "r": e["reactions"],
        "c": e["comments"],
        "p": e["reposts"],
        "m": e["media"],
        "x": e["text"],
    } for e in events]

    payload = json.dumps(compact, separators=(",", ":"))
    dashboard.write_text(html[:body] + payload + html[end:])
    print(f"injected {len(compact)} events into {dashboard.name}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", nargs="?", default=HERE / "raw.psv",
                    help="pipe-delimited event file (default: raw.psv)")
    ap.add_argument("--tz", default="America/Chicago",
                    help="timezone to report in (default: America/Chicago)")
    ap.add_argument("--inject", action="store_true",
                    help="also rewrite the dataset embedded in dashboard.html")
    args = ap.parse_args()

    events = read_events(args.source, args.tz)
    if not events:
        sys.exit(f"no events found in {args.source}")

    print(f"timezone: {args.tz}\n")
    summarize(events)

    out = HERE / "activity.json"
    out.write_text(json.dumps(events, indent=1))
    print(f"\nwrote {out.name}")

    if args.inject:
        for page in ("dashboard.html", "graphic.html"):
            target = HERE / page
            if target.exists():
                inject(events, target)


if __name__ == "__main__":
    main()
