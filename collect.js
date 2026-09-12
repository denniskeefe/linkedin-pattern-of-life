#!/usr/bin/env node
/* Automated LinkedIn activity collection.
 *
 *   node collect.js                        # your own account, 30 days
 *   node collect.js --subject dkeefe       # a named profile
 *   node collect.js --subject "https://www.linkedin.com/in/dkeefe/" --days 90
 *
 * Drives a real Chrome through the same harvest scrape.js performs by hand: it
 * loads an activity page, scrolls it in small steps, reads the cards as they
 * render, writes subjects/<slug>/raw.psv and hands off to analyze.py. Nothing
 * is copied through the clipboard and nothing leaves this machine.
 *
 * With no --subject it opens /in/me/, which LinkedIn resolves to whichever
 * account is signed in, and marks that subject --self. A --subject that is not
 * the signed-in account is a third party: its directory is gitignored along
 * with every other subject, and analyze.py --publish refuses to put it on a
 * public page.
 *
 * Sign-in is yours to do. The first run opens a visible window and waits for
 * you to log in; the session is then kept in .browser/ (gitignored) and later
 * runs are headless. This script never handles credentials.
 */

const { chromium } = require("playwright");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROFILE_DIR = path.join(HERE, ".browser");
const SCRAPER = path.join(HERE, "scrape.js");

const FIELDS = ["ts", "kind", "reactions", "comments", "reposts", "words", "media", "text"];
const NUMERIC = ["reactions", "comments", "reposts", "words"];

function parseArgs(argv) {
  const opts = {
    days: 30,
    passes: 3,
    subject: null,
    label: null,
    out: null,
    headed: false,
    merge: true,
    analyze: true,
    tz: null,
    loginWaitMs: 15 * 60 * 1000
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--days":       opts.days = Number(next()); break;
      case "--subject":    opts.subject = next(); break;
      case "--passes":     opts.passes = Number(next()); break;
      case "--out":        opts.out = path.resolve(next()); break;
      case "--tz":         opts.tz = next(); break;
      case "--label":      opts.label = next(); break;
      case "--login-timeout": opts.loginWaitMs = Number(next()) * 60 * 1000; break;
      case "--headed":     opts.headed = true; break;
      case "--replace":    opts.merge = false; break;
      case "--no-analyze": opts.analyze = false; break;
      case "-h":
      case "--help":       usage(); process.exit(0);
      default:             fail(`unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.days) || opts.days <= 0) fail("--days must be a positive number");
  if (!Number.isFinite(opts.passes) || opts.passes <= 0) fail("--passes must be a positive number");
  if (!Number.isFinite(opts.loginWaitMs) || opts.loginWaitMs <= 0) fail("--login-timeout must be a positive number of minutes");
  return opts;
}

function usage() {
  console.log(`
Usage: node collect.js [options]

  --subject SLUG|URL  whose activity to collect (default: the signed-in account)
  --days N            window to collect, in days (default: 30)
  --passes N          scroll passes to run (default: 3)
  --out FILE          write the events here instead of subjects/<slug>/raw.psv
                      (analyze.py reads the standard path, so this implies
                      --no-analyze)
  --tz ZONE           timezone to pass to analyze.py
  --label NAME        display name for the report
  --login-timeout N   minutes to wait for sign-in (default: 15)
  --headed            show the browser window
  --replace           overwrite the existing file instead of merging into it
  --no-analyze        stop after writing the file
`.trim());
}

function fail(msg) {
  console.error(`collect: ${msg}`);
  process.exit(2);
}

/* ---- raw.psv ------------------------------------------------------------ */

function parsePsv(text) {
  const events = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|");
    if (parts.length < FIELDS.length - 1) continue;
    const e = {};
    FIELDS.forEach((f, i) => { e[f] = parts[i] ?? ""; });
    e.ts = Number(e.ts);
    if (!Number.isFinite(e.ts)) continue;
    for (const f of NUMERIC) e[f] = Number(e[f]) || 0;
    events.set(e.ts, e);
  }
  return events;
}

/* Later readings of a card can be fuller or thinner than earlier ones — a card
   caught mid-render reports no counts and no body. Keep the fullest of each
   field rather than the most recent, matching lkHarvest. */
function mergeEvent(prev, next) {
  if (!prev) return next;
  const merged = { ...prev, ...next };
  for (const f of NUMERIC) merged[f] = Math.max(prev[f], next[f]);
  merged.text = next.text.length > prev.text.length ? next.text : prev.text;
  merged.media = next.media === "text" ? prev.media : next.media;
  return merged;
}

function formatPsv(events) {
  return [...events.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(e => FIELDS.map(f => String(e[f]).replace(/[|\n]/g, " ")).join("|"))
    .join("\n") + "\n";
}

/* ---- subjects ------------------------------------------------------------ */

/* Mirrors parse_subject() in analyze.py: the same inputs resolve to the same
   slug, so this cannot hand analyze.py a subject it turns around and refuses.
   Path-shaped input must actually name /in/<slug> — "last path segment" would
   turn /feed/ into a subject called "feed", and a traversal into one called
   "passwd". */
const SLUG_RE = /^[A-Za-z0-9\-_%\u00C0-\uFFFF]{1,120}$/;

function parseSubject(value) {
  const raw = String(value || "").trim();
  if (!raw) fail("--subject is empty");

  let slug = raw;
  if (raw.includes("/")) {
    const company = raw.match(/\/(company|school|showcase)\/([^/?#]+)/i);
    const profile = raw.match(/\/in\/([^/?#]+)/i);
    if (company && !profile) {
      fail(`that is a ${company[1]} page, not a member profile — `
           + "this reads /in/<slug> activity feeds only");
    }
    if (!profile) {
      fail(`no /in/<slug> in ${JSON.stringify(value)} — pass a member profile URL `
           + "such as https://www.linkedin.com/in/<slug>/, or just the slug");
    }
    slug = profile[1];
  }

  slug = decodeURIComponent(slug).trim();
  if (!slug || !SLUG_RE.test(slug)) {
    fail(`could not read a profile slug from ${JSON.stringify(value)}`);
  }
  return slug;
}

const activityFor = slug =>
  `https://www.linkedin.com/in/${encodeURIComponent(slug)}/recent-activity/all/`;

/* ---- browser ------------------------------------------------------------ */

async function launch({ headed }) {
  const common = { headless: !headed, viewport: { width: 1280, height: 900 } };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { channel: "chrome", ...common });
  } catch {
    // No system Chrome — fall back to Playwright's own build.
    return await chromium.launchPersistentContext(PROFILE_DIR, common);
  }
}

/* li_at is the session cookie LinkedIn sets on sign-in. Asking for it beats
   inspecting the URL: a signed-out visit can land on the feed, the authwall,
   a checkpoint or a marketing page depending on what it thinks you are. */
async function signedIn(context) {
  const cookies = await context.cookies("https://www.linkedin.com");
  return cookies.some(c => c.name === "li_at" && c.value);
}

function onAuthwall(page) {
  return /\/(login|authwall|checkpoint|signup|uas)\b/.test(page.url());
}

/* Resolve the signed-in account's own slug. /in/me/ is LinkedIn's own redirect
   to whoever holds the session, so "is this me?" is answered by the session
   rather than by what someone typed. */
async function whoAmI(page) {
  await page.goto("https://www.linkedin.com/in/me/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (onAuthwall(page)) return null;

  let match = page.url().match(/linkedin\.com\/in\/([^/?#]+)/);
  if (match && match[1] !== "me") return decodeURIComponent(match[1]);

  // The redirect did not resolve; read the slug off the profile link instead.
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  if (onAuthwall(page)) return null;
  const href = await page.locator('a[href*="/in/"]').first().getAttribute("href").catch(() => null);
  match = href && href.match(/\/in\/([^/?#]+)/);
  if (!match) throw new Error("could not resolve the signed-in profile");
  return decodeURIComponent(match[1]);
}

async function waitForLogin(context, page, timeoutMs) {
  const minutes = Math.round(timeoutMs / 60000);
  console.log("\nA Chrome window is open. Sign in to LinkedIn there — this script");
  console.log("never sees your credentials — and collection starts on its own.");
  console.log(`Waiting up to ${minutes} minutes; --login-timeout changes that.\n`);

  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + timeoutMs;
  let nextNotice = Date.now() + 60000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await signedIn(context)) {
      console.log("signed in; session saved to .browser/\n");
      return true;
    }
    if (Date.now() >= nextNotice) {
      const left = Math.ceil((deadline - Date.now()) / 60000);
      console.log(`  still waiting for sign-in — ${left} minute${left === 1 ? "" : "s"} left`);
      nextNotice = Date.now() + 60000;
    }
  }
  return false;
}

async function collect(page, opts) {
  const source = fs.readFileSync(SCRAPER, "utf8");

  // Evaluated over CDP rather than injected as a <script>, which the page's
  // own content-security policy would refuse.
  await page.evaluate(`(() => {
    ${source}
    window.lkCollect = lkCollect;
    window.lkExport = lkExport;
  })()`);

  page.on("console", msg => {
    const text = msg.text();
    if (text.startsWith("collected ")) console.log(text);
  });

  for (let pass = 1; pass <= opts.passes; pass++) {
    process.stdout.write(`pass ${pass}/${opts.passes} `);
    await page.evaluate(days => window.lkCollect({ days }), opts.days);
  }

  return page.evaluate(() => window.lkExport());
}

/* ---- main --------------------------------------------------------------- */

/* A signed-in page. Runs headless when the saved session still works, and only
   opens a window when someone has to type into it. */
async function openSession(opts) {
  let headed = opts.headed;
  let context = await launch({ headed });
  let page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(60000);

  if (!await signedIn(context)) {
    if (!headed) {
      await context.close();
      headed = true;
      context = await launch({ headed });
      page = context.pages()[0] || await context.newPage();
      context.setDefaultTimeout(60000);
    }
    if (!await waitForLogin(context, page, opts.loginWaitMs)) {
      await context.close();
      fail("timed out waiting for sign-in — run it again when you have a moment,"
           + "\n         or allow longer with --login-timeout <minutes>");
    }
  }

  return { context, page };
}

/* The cookie outlived the session it stood for. Start the profile clean rather
   than retrying against a credential LinkedIn has already stopped honouring. */
async function reauthenticate(opts, context) {
  await context.close();
  const fresh = await launch({ headed: true });
  const page = fresh.pages()[0] || await fresh.newPage();
  fresh.setDefaultTimeout(60000);
  await fresh.clearCookies();

  console.log("the saved session has expired");
  if (!await waitForLogin(fresh, page, opts.loginWaitMs)) {
    await fresh.close();
    fail("timed out waiting for sign-in");
  }
  return { context: fresh, page };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let { context, page } = await openSession(opts);

  let me = await whoAmI(page);
  if (!me) {
    ({ context, page } = await reauthenticate(opts, context));
    me = await whoAmI(page);
    if (!me) {
      await context.close();
      fail("signed in, but LinkedIn is still serving its authwall");
    }
  }

  const slug = opts.subject ? parseSubject(opts.subject) : me;
  const isSelf = slug === me;
  const url = activityFor(slug);
  const out = opts.out || path.join(HERE, "subjects", slug, "raw.psv");
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`signed in as /in/${me}`);
  console.log(`collecting ${opts.days} days from ${url}`
    + (isSelf ? "" : "  (third party — stays local)"));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const psv = await collect(page, opts);
  await context.close();

  const fresh = parsePsv(psv);
  if (!fresh.size) fail("no activity found — the feed may have changed shape, or the window is empty");

  const existing = opts.merge && fs.existsSync(out)
    ? parsePsv(fs.readFileSync(out, "utf8"))
    : new Map();

  const added = [...fresh.keys()].filter(ts => !existing.has(ts)).length;
  for (const [ts, event] of fresh) existing.set(ts, mergeEvent(existing.get(ts), event));

  fs.writeFileSync(out, formatPsv(existing));
  console.log(`\nwrote ${path.relative(HERE, out)}: ${existing.size} events (${added} new)\n`);

  if (opts.out) {
    console.log("--out set: analyze.py reads subjects/<slug>/raw.psv, so it was not run");
    return;
  }
  if (!opts.analyze) return;

  const args = [path.join(HERE, "analyze.py"), "--subject", slug];
  if (isSelf) args.push("--self");
  if (opts.tz) args.push("--tz", opts.tz);
  if (opts.label) args.push("--label", opts.label);
  const run = spawnSync("python3", args, { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`collect: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parsePsv, mergeEvent, formatPsv, parseSubject };
