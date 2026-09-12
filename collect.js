#!/usr/bin/env node
/* Automated LinkedIn activity collection.
 *
 *   node collect.js                 # 3 passes over the last 30 days, then analyze
 *   node collect.js --days 90
 *   node collect.js --passes 5 --no-analyze
 *
 * Drives a real Chrome through the same harvest that scrape.js performs by
 * hand: it loads your own activity page, scrolls it in small steps, reads the
 * cards as they render, writes raw.psv and hands off to analyze.py. Nothing is
 * copied through the clipboard and nothing leaves this machine.
 *
 * The subject is not a parameter. The collector opens /in/me/, which LinkedIn
 * resolves to whichever account is signed in, so it can only ever read your
 * own history — the same property the console flow had, kept structural rather
 * than left to whoever is typing the URL.
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
    out: path.join(HERE, "raw.psv"),
    headed: false,
    merge: true,
    analyze: true,
    tz: null,
    loginWaitMs: 5 * 60 * 1000
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
      case "--passes":     opts.passes = Number(next()); break;
      case "--out":        opts.out = path.resolve(next()); break;
      case "--tz":         opts.tz = next(); break;
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
  return opts;
}

function usage() {
  console.log(`
Usage: node collect.js [options]

  --days N        window to collect, in days (default: 30)
  --passes N      scroll passes to run (default: 3)
  --out FILE      where to write the events (default: raw.psv)
  --tz ZONE       timezone to pass to analyze.py
  --headed        show the browser window
  --replace       overwrite the existing file instead of merging into it
  --no-analyze    stop after writing the file
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

async function signedIn(page) {
  const url = page.url();
  if (/\/(login|authwall|checkpoint|signup)\b/.test(url)) return false;
  if (await page.locator('input[name="session_key"]').count()) return false;
  return true;
}

/* Resolve the signed-in account's activity feed. /in/me/ is LinkedIn's own
   redirect to whoever holds the session, so the slug is never guessed. */
async function activityUrl(page) {
  await page.goto("https://www.linkedin.com/in/me/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  let match = page.url().match(/linkedin\.com\/in\/([^/?#]+)/);
  if (match && match[1] !== "me") {
    return `https://www.linkedin.com/in/${match[1]}/recent-activity/all/`;
  }

  // The redirect did not resolve; read the slug off the profile link instead.
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/in/"]').first().getAttribute("href").catch(() => null);
  match = href && href.match(/\/in\/([^/?#]+)/);
  if (!match) throw new Error("could not resolve the signed-in profile");
  return `https://www.linkedin.com/in/${match[1]}/recent-activity/all/`;
}

async function waitForLogin(page, timeoutMs) {
  console.log("\nA Chrome window is open. Sign in to LinkedIn there — this script");
  console.log("never sees your credentials — and collection starts on its own.\n");

  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.url().includes("/feed") && await signedIn(page)) {
      console.log("signed in, session saved to .browser/\n");
      return true;
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const firstRun = !fs.existsSync(PROFILE_DIR);

  let context = await launch({ headed: opts.headed || firstRun });
  let page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(60000);

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });

  if (!await signedIn(page)) {
    if (context.browser()?.isConnected() && !opts.headed && !firstRun) {
      // The saved session expired while we were headless. Come back visible.
      await context.close();
      context = await launch({ headed: true });
      page = context.pages()[0] || await context.newPage();
      context.setDefaultTimeout(60000);
    }
    if (!await waitForLogin(page, opts.loginWaitMs)) {
      await context.close();
      fail("timed out waiting for sign-in");
    }
  }

  const url = await activityUrl(page);
  console.log(`collecting ${opts.days} days from ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const psv = await collect(page, opts);
  await context.close();

  const fresh = parsePsv(psv);
  if (!fresh.size) fail("no activity found — the feed may have changed shape, or the window is empty");

  const existing = opts.merge && fs.existsSync(opts.out)
    ? parsePsv(fs.readFileSync(opts.out, "utf8"))
    : new Map();

  const added = [...fresh.keys()].filter(ts => !existing.has(ts)).length;
  for (const [ts, event] of fresh) existing.set(ts, mergeEvent(existing.get(ts), event));

  fs.writeFileSync(opts.out, formatPsv(existing));
  console.log(`\nwrote ${path.relative(HERE, opts.out)}: ${existing.size} events (${added} new)\n`);

  if (!opts.analyze) return;

  const args = [path.join(HERE, "analyze.py"), opts.out, "--inject"];
  if (opts.tz) args.push("--tz", opts.tz);
  const run = spawnSync("python3", args, { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`collect: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parsePsv, mergeEvent, formatPsv };
