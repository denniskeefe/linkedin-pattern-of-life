#!/usr/bin/env python3
"""Turn collected LinkedIn activity into a summary and a dashboard, per subject.

Layout:
    subjects/<slug>/raw.psv        collected events (you create this)
    subjects/<slug>/meta.json      label / timezone / self flag (written on first run)
    subjects/<slug>/activity.json  parsed dataset
    subjects/<slug>/index.html     rendered dashboard

Usage:
    python3 analyze.py --list
    python3 analyze.py --subject dkeefe --label "Dennis Keefe" --self
    python3 analyze.py --subject someone-else --tz Europe/London
    python3 analyze.py --subject dkeefe --publish     # also write ./dashboard.html

`--publish` copies the rendered page to the repo root, where vercel.json picks it
up. It is refused for subjects not marked `--self`: a third party's pattern of
life is for the engagement file, not a public URL.

raw.psv is what lkExport() copies to the clipboard: one event per line,
    <epoch_ms>|<kind>|<reactions>|<comments>|<reposts>|<words>|<media>|<text>
"""

import argparse
import json
import re
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
SUBJECTS = HERE / "subjects"
TEMPLATE = HERE / "template.html"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PLACEHOLDER = "__DATA__"

# A profile slug: letters, digits, hyphens, and the percent-escapes LinkedIn
# uses for non-Latin names. Deliberately not a path, so a pasted URL cannot
# walk out of subjects/.
SLUG = re.compile(r"^[A-Za-z0-9\-_%À-￿]{1,120}$")

PROFILE_PATH = re.compile(r"/in/([^/?#]+)", re.I)
COMPANY_PATH = re.compile(r"/(company|school|showcase)/([^/?#]+)", re.I)


def parse_subject(value):
    """Accept a bare slug or any LinkedIn profile URL and return the slug.

    All of these name the same subject:
        dkeefe
        linkedin.com/in/dkeefe
        https://www.linkedin.com/in/dkeefe/
        https://www.linkedin.com/in/dkeefe/recent-activity/all/
        https://uk.linkedin.com/in/dkeefe?originalSubdomain=uk
    """
    raw = value.strip()
    if not raw:
        sys.exit("--subject is empty")

    if "/" in raw:
        # Anything path-shaped must actually name a member profile. Falling back
        # to "last path segment" here would happily turn /feed/ into a subject
        # called "feed", and ../../etc/passwd into one called "passwd".
        company = COMPANY_PATH.search(raw)
        if company and not PROFILE_PATH.search(raw):
            sys.exit(f"that is a {company.group(1)} page, not a member profile.\n"
                     "This tool reads /in/<slug> activity feeds only.")

        match = PROFILE_PATH.search(raw)
        if not match:
            sys.exit(f"no /in/<slug> in {value!r}.\n"
                     "Pass a member profile URL such as "
                     "https://www.linkedin.com/in/<slug>/, or just the slug.")
        slug = match.group(1)
    else:
        slug = raw

    # PROFILE_PATH already stops at ? and #, so only escapes remain to resolve.
    slug = unquote(slug).strip()

    if not slug or not SLUG.match(slug):
        sys.exit(f"could not read a profile slug from {value!r}.\n"
                 "Pass the slug, or a profile URL such as "
                 "https://www.linkedin.com/in/<slug>/")

    return slug


def profile_url(slug):
    return f"https://www.linkedin.com/in/{slug}/"


def activity_url(slug):
    return f"https://www.linkedin.com/in/{slug}/recent-activity/all/"


def subject_dir(slug):
    return SUBJECTS / slug


def load_meta(slug, args):
    """Per-subject settings, remembered between runs so flags are optional."""
    path = subject_dir(slug) / "meta.json"
    meta = json.loads(path.read_text()) if path.exists() else {}

    if args.label:
        meta["label"] = args.label
    if args.tz:
        meta["tz"] = args.tz
    if args.self_subject:
        meta["self"] = True

    meta.setdefault("label", slug)
    meta.setdefault("tz", "America/Chicago")
    meta.setdefault("self", False)
    meta["subject"] = f"/in/{slug}"
    meta["url"] = profile_url(slug)

    path.write_text(json.dumps(meta, indent=1))
    return meta


def read_events(path, tzname):
    tz = ZoneInfo(tzname)
    events = []

    for lineno, line in enumerate(path.read_text().splitlines(), 1):
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


def summarize(events, meta):
    first, last = events[0], events[-1]
    span = ((datetime.fromisoformat(last["iso"]).date()
             - datetime.fromisoformat(first["iso"]).date()).days + 1)
    active = {e["date"] for e in events}

    print(f"{meta['label']}  ({meta['subject']}, {meta['tz']})")
    print(f"{len(events)} events over {span} days "
          f"({first['iso'][:10]} to {last['iso'][:10]})")
    print("  mix     " + ", ".join(f"{k} {v}" for k, v in
                                   Counter(e["kind"] for e in events).most_common()))
    print(f"  cadence {len(events) / span * 7:.1f}/week, {span - len(active)} silent days")
    print()

    by_hour = Counter(e["hour"] for e in events)
    print("TIME OF DAY")
    for h in range(24):
        if by_hour[h]:
            print(f"  {h:02d}:00  {'#' * by_hour[h]} {by_hour[h]}")
    print()

    by_dow = Counter(e["dow"] for e in events)
    print("DAY OF WEEK")
    for d in range(7):
        print(f"  {DAYS[d]}  {'#' * by_dow[d]:<14} {by_dow[d]}")
    print()

    total, count = Counter(), Counter()
    for e in events:
        total[e["hour"]] += e["reactions"]
        count[e["hour"]] += 1

    print("AVG REACTIONS BY HOUR")
    for h in sorted(count, key=lambda h: -total[h] / count[h]):
        thin = "" if count[h] >= 3 else "   (thin)"
        print(f"  {h:02d}:00  {total[h] / count[h]:6.1f}  n={count[h]}{thin}")


def render(events, meta, out):
    if not TEMPLATE.exists():
        sys.exit(f"missing {TEMPLATE.name} — the dashboard cannot be rendered without it")

    payload = {
        "meta": {
            "subject": meta["subject"],
            "url": meta["url"],
            "label": meta["label"],
            "tz": meta["tz"],
            "collected": datetime.now().strftime("%Y-%m-%d"),
            "thirdParty": not meta["self"],
        },
        "events": [{
            "t": e["iso"][:16], "k": e["kind"], "r": e["reactions"],
            "c": e["comments"], "p": e["reposts"], "m": e["media"], "x": e["text"],
        } for e in events],
    }

    html = TEMPLATE.read_text()
    if PLACEHOLDER not in html:
        sys.exit(f"{TEMPLATE.name}: no {PLACEHOLDER} placeholder to fill")

    out.write_text(html.replace(PLACEHOLDER, json.dumps(payload, separators=(",", ":"))))
    print(f"\nwrote {out.relative_to(HERE)}  ({len(events)} events)")


def list_subjects():
    if not SUBJECTS.exists():
        print("no subjects yet — create subjects/<slug>/raw.psv")
        return
    rows = sorted(p for p in SUBJECTS.iterdir() if p.is_dir())
    if not rows:
        print("no subjects yet — create subjects/<slug>/raw.psv")
        return
    for d in rows:
        meta_path = d / "meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        raw = d / "raw.psv"
        n = len([l for l in raw.read_text().splitlines() if l.strip()]) if raw.exists() else 0
        tag = "self" if meta.get("self") else "third-party"
        print(f"  {d.name:24} {n:>4} events   {tag:12} {meta.get('tz', '')}")
        print(f"  {'':24} {meta.get('url', profile_url(d.name))}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subject",
                    help="profile slug or any LinkedIn profile URL "
                         "(https://www.linkedin.com/in/<slug>/...)")
    ap.add_argument("--label", help="display name for the report")
    ap.add_argument("--tz", help="timezone to report in (default: America/Chicago)")
    ap.add_argument("--self", dest="self_subject", action="store_true",
                    help="mark this subject as the analyst's own account")
    ap.add_argument("--publish", action="store_true",
                    help="also copy the rendered page to ./dashboard.html (self only)")
    ap.add_argument("--list", action="store_true", help="list known subjects and exit")
    args = ap.parse_args()

    if args.list:
        list_subjects()
        return

    if not args.subject:
        ap.error("--subject is required (or use --list)")

    slug = parse_subject(args.subject)
    d = subject_dir(slug)
    raw = d / "raw.psv"

    if not raw.exists():
        d.mkdir(parents=True, exist_ok=True)
        sys.exit(f"no data yet for {slug}. Collect it first:\n"
                 f"  1. open {activity_url(slug)}\n"
                 f"  2. paste scrape.js into the console\n"
                 f"  3. await lkCollect({{ days: 30 }})   (run it two or three times)\n"
                 f"  4. copy(lkExport())\n"
                 f"  5. paste into {raw.relative_to(HERE)}")

    meta = load_meta(slug, args)
    events = read_events(raw, meta["tz"])
    if not events:
        sys.exit(f"no events found in {raw}")

    summarize(events, meta)
    (d / "activity.json").write_text(json.dumps(events, indent=1))
    render(events, meta, d / "index.html")

    if args.publish:
        if not meta["self"]:
            sys.exit("refusing --publish: this subject is not marked --self.\n"
                     "A third party's pattern of life does not belong on a public URL.")
        shutil.copy(d / "index.html", HERE / "dashboard.html")
        print("copied to dashboard.html")


if __name__ == "__main__":
    main()
