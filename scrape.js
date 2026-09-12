/* LinkedIn activity collector.
 *
 * collect.js loads this file into the page and calls lkCollect/lkExport for
 * you; `npm run collect` is the normal way to run it. It also still works by
 * hand. Paste into the DevTools console on your own recent-activity page:
 *   https://www.linkedin.com/in/<you>/recent-activity/all/
 *
 * Then drive it:
 *   await lkCollect({ days: 30 })   // one pass
 *   await lkCollect({ days: 30 })   // run 2-3 times; results accumulate
 *   copy(lkExport())                // pipe-delimited, for analyze.py
 *
 * Two things about this feed shape the design:
 *
 * 1. It virtualizes. Cards scrolled out of view are removed from the DOM, so
 *    reading once at the end returns only what happens to be on screen.
 *    Everything here harvests on every scroll tick instead.
 *
 * 2. It paginates non-deterministically. Two passes over the same date range
 *    return overlapping but non-identical sets. Run several passes and take the
 *    union; treat the total as a floor, not a complete census.
 *
 * Exact publication times come from the activity id, not the feed's "3w ago"
 * labels: the id is a snowflake whose high 41 bits are the epoch milliseconds.
 */

window.lkStore = window.lkStore || new Map();

function lkParseCount(s) {
  if (!s) return 0;
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMkm])?/);
  if (!m) return 0;
  let v = parseFloat(m[1]);
  if (/k/i.test(m[2] || "")) v *= 1e3;
  if (/m/i.test(m[2] || "")) v *= 1e6;
  return Math.round(v);
}

/* Read every activity card currently in the DOM into the store. Safe to call
   repeatedly; later reads only overwrite a field when they see more of it. */
function lkHarvest(cutoffMs) {
  const cards = document.querySelectorAll(
    '[data-urn^="urn:li:activity"],[data-id^="urn:li:activity"]'
  );

  for (const card of cards) {
    const urn = card.getAttribute("data-urn") || card.getAttribute("data-id");
    const id = (urn.match(/urn:li:activity:(\d+)/) || [])[1];
    if (!id) continue;

    const ts = Number(BigInt(id) >> 22n);
    if (ts < cutoffMs) continue;

    const full = (card.innerText || "").replace(/\s+/g, " ").trim();
    const header = full.slice(0, 200).toLowerCase();
    let kind = "post";
    if (/\breposted\b/.test(header)) kind = "repost";
    else if (/\bcommented on\b|\breplied to\b/.test(header)) kind = "comment";

    // Social counts render as e.g. "8 Kevin Branzetti and 7 others 2 comments".
    // The leading bare number is the reaction count.
    const socialEl = card.querySelector(".social-details-social-counts");
    const social = socialEl ? socialEl.innerText.replace(/\s+/g, " ").trim() : "";
    const leading = (social.match(/^\s*([\d.,]+[KMkm]?)\b(?!\s*(comment|repost))/) || [])[1];

    const bodyEl = card.querySelector(
      ".update-components-text, .feed-shared-inline-show-more-text"
    );
    const body = (bodyEl ? bodyEl.innerText : "")
      .replace(/\s+/g, " ")
      .replace(/…more$/, "")
      .trim();

    const media =
      card.querySelector("video, .update-components-linkedin-video") ? "video"
      : card.querySelector('.update-components-document, iframe[title*="document" i]') ? "document"
      : card.querySelector(".update-components-image, img.update-components-image__image") ? "image"
      : card.querySelector(".update-components-article, .update-components-entity") ? "link"
      : "text";

    const next = {
      id, ts, kind, media,
      reactions: lkParseCount(leading),
      comments: lkParseCount((social.match(/([\d.,]+[KMkm]?)\s*comment/i) || [])[1]),
      reposts: lkParseCount((social.match(/([\d.,]+[KMkm]?)\s*repost/i) || [])[1]),
      words: body ? body.split(/\s+/).length : 0,
      text: body.slice(0, 240),
      url: "https://www.linkedin.com/feed/update/urn:li:activity:" + id + "/"
    };

    // A card can be caught mid-render, with counts or body text not yet filled
    // in. Keep the fullest reading of each field rather than the latest.
    const prev = window.lkStore.get(id);
    window.lkStore.set(id, !prev ? next : {
      ...next,
      reactions: Math.max(prev.reactions, next.reactions),
      comments: Math.max(prev.comments, next.comments),
      reposts: Math.max(prev.reposts, next.reposts),
      words: Math.max(prev.words, next.words),
      text: next.text.length > prev.text.length ? next.text : prev.text
    });
  }

  return window.lkStore.size;
}

/* One top-to-bottom pass. Steps are deliberately small: larger jumps let the
   feed recycle a card in and out between ticks, and it is never harvested. */
async function lkCollect(opts) {
  const { days = 30, step = 350, pause = 450, maxTicks = 400 } = opts || {};
  const cutoff = Date.now() - days * 86400000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  window.scrollTo(0, 0);
  await sleep(1500);

  let y = 0;
  let quiet = 0;
  let lastHeight = 0;

  for (let tick = 0; tick < maxTicks; tick++) {
    lkHarvest(cutoff);

    // Stop once the oldest card on screen predates the window.
    const onScreen = [...document.querySelectorAll(
      '[data-urn^="urn:li:activity"],[data-id^="urn:li:activity"]'
    )].map(c => {
      const u = c.getAttribute("data-urn") || c.getAttribute("data-id");
      const m = u.match(/urn:li:activity:(\d+)/);
      return m ? Number(BigInt(m[1]) >> 22n) : Infinity;
    });
    if (onScreen.length && Math.min(...onScreen) < cutoff) break;

    y += step;
    window.scrollTo(0, y);
    await sleep(pause);

    for (const b of document.querySelectorAll("button")) {
      const label = (b.innerText || "").trim().toLowerCase();
      if (label.includes("show more results") || label === "load more") { b.click(); break; }
    }

    // The page stops growing once the feed is exhausted.
    const h = document.body.scrollHeight;
    quiet = h === lastHeight && y >= h ? quiet + 1 : 0;
    lastHeight = h;
    if (quiet >= 5) break;
  }

  lkHarvest(cutoff);
  console.log("collected " + window.lkStore.size + " events in the last " + days + " days");
  return window.lkStore.size;
}

/* Pipe-delimited, oldest first — the format analyze.py reads. */
function lkExport() {
  return [...window.lkStore.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(e => [
      e.ts, e.kind, e.reactions, e.comments, e.reposts, e.words, e.media,
      e.text.replace(/[|\n]/g, " ")
    ].join("|"))
    .join("\n");
}
