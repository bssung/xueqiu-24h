const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Fetch a xueqiu user's posts/replies published in the last 24 hours.
//
// Strategy (API-first, DOM fallback):
//   1. Headless Chromium visits the xueqiu.com homepage to seed anonymous
//      cookies (xq_a_token etc. — no login needed).
//   2. Opens the profile page (for diagnostics: final URL, title,
//      slider/captcha detection — Xueqiu risk-control often swaps the
//      profile page for a "slide to verify" challenge).
//   3. From the profile page (same origin, with cookies) it calls the
//      public timeline API /v4/statuses/user_timeline.json and paginates
//      until posts older than 24h appear. created_at is a millisecond
//      timestamp, so the 24h window is exact.
//   4. If the API path yields nothing (HTTP error / challenge page /
//      empty feed), falls back to DOM scraping of the profile feed.
const USER_ID = process.env.XUEQIU_USER_ID || "9493911686";
const PROFILE_URL = `https://xueqiu.com/u/${USER_ID}`;
const WINDOW_MS = 24 * 3600 * 1000;

// Xueqiu profile time labels: "15分钟前", "3小时前", "昨天 14:30",
// "09-30 12:33", "2025-09-20". Return true when the label is within
// the trailing 24h (conservatively: same-day or relative < 24h).
// Only used by the DOM fallback path.
function isWithin24h(label) {
  const s = String(label || "").trim();
  if (!s) return false;
  let m;
  if ((m = s.match(/(\d+)\s*分钟/))) return Number(m[1]) < 60 * 24;
  if ((m = s.match(/(\d+)\s*小时/))) return Number(m[1]) < 24;
  if (/^\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2})?$/.test(s)) return true; // today, shown as MM-DD [HH:mm]
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    return s.slice(0, 10) === today;
  }
  return false;
}

function beijingStamp(d) {
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d),
    time: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium"
    }).format(d)
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });

  let posts = [];
  let freshSource = "none";

  try {
    // --- 1. seed anonymous cookies on the homepage -----------------------
    console.log("Seeding cookies: https://xueqiu.com/");
    await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    console.log("Home title:", await page.title());
    const cookieNames = (await page.context().cookies()).map((c) => c.name).join(",");
    console.log("Cookies:", cookieNames);

    // --- 2. open the profile page (diagnostics + same-origin base) -------
    console.log(`Opening: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    const diag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      slider: !!document.querySelector(
        "[class*=slider], [class*=captcha], [class*=verify], .tc-slider, .nc-container"
      ),
      head: document.body ? document.body.innerText.slice(0, 200) : ""
    }));
    console.log("Profile diag:", JSON.stringify(diag));

    // --- 3. API-first fetch (same-origin, with cookies) ------------------
    const api = await page.evaluate(async (uid) => {
      function stripHtml(html) {
        return String(html || "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
      }
      const now = Date.now();
      const cutoff = now - 24 * 3600 * 1000;
      const out = { pages: 0, http: 0, total_seen: 0, posts: [], error: null };
      for (let p = 1; p <= 20; p++) {
        let r;
        try {
          r = await fetch(
            `/v4/statuses/user_timeline.json?user_id=${uid}&page=${p}&count=100`,
            { credentials: "include", headers: { "x-requested-with": "XMLHttpRequest" } }
          );
        } catch (e) { out.error = "fetch:" + e.message; break; }
        out.http = r.status;
        if (r.status !== 200) { out.error = "http:" + r.status; break; }
        let j;
        try { j = await r.json(); } catch (e) { out.error = "json:" + e.message; break; }
        const list = j.statuses || [];
        out.pages = p;
        out.total_seen += list.length;
        let oldest = Infinity;
        for (const s of list) {
          if (typeof s.created_at === "number") oldest = Math.min(oldest, s.created_at);
          if (typeof s.created_at !== "number" || s.created_at < cutoff) continue;
          const desc = s.description || "";
          out.posts.push({
            id: String(s.id),
            created_at: new Date(s.created_at).toISOString(),
            kind: s.retweet_status_id ? "retweet" : (/^回复</.test(desc) ? "reply" : "status"),
            url: `https://xueqiu.com/${uid}/${s.id}`,
            text: stripHtml(desc).trim().slice(0, 2000)
          });
        }
        if (list.length === 0) break;               // no more pages
        if (oldest !== Infinity && oldest < cutoff) break; // past the 24h boundary
      }
      return out;
    }, USER_ID);

    console.log(`API: pages=${api.pages} http=${api.http} total_seen=${api.total_seen} kept=${api.posts.length} error=${api.error}`);
    if (!api.error && api.total_seen > 0) {
      posts = api.posts;
      freshSource = "api";
    }

    // --- 4. DOM fallback --------------------------------------------------
    if (posts.length === 0) {
      freshSource = "dom";
      let prevTime = "";
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(700);
        const lastLabel = await page.evaluate(() => {
          const labels = [...document.querySelectorAll("span.time, .from, [class*=time]")]
            .map(e => (e.textContent || "").trim()).filter(Boolean);
          return labels.length ? labels[labels.length - 1] : "";
        });
        if (lastLabel && lastLabel !== prevTime) {
          prevTime = lastLabel;
          if (!isWithin24h(lastLabel)) break;
        }
      }
      posts = await page.evaluate((uid) => {
        const seen = new Set();
        const out = [];
        const anchors = [...document.querySelectorAll("a")]
          .map(a => {
            let url;
            try { url = new URL(a.href); } catch (_) { return null; }
            if (url.hostname !== "xueqiu.com") return null;
            const m = url.pathname.match(new RegExp(`^/${uid}/(\\d+)`));
            if (!m) return null;
            return { postId: m[1], href: url.href, anchor: a };
          })
          .filter(Boolean);
        for (const { postId, href, anchor } of anchors) {
          if (seen.has(postId)) continue;
          let row = anchor;
          for (let hop = 0; hop < 8 && row.parentElement; hop++) {
            row = row.parentElement;
            const t = row.querySelector("span.time, .from, [class*=time]");
            if (t && (t.textContent || "").trim()) {
              const label = t.textContent.trim();
              if (/分钟前|小时前|^\d{1,2}-\d{1,2}|^\d{4}-/.test(label)) {
                seen.add(postId);
                out.push({ id: postId, url: href, time_label: label, kind: "unknown" });
              }
              break;
            }
          }
        }
        return out;
      }, USER_ID);
      if (posts.length > 0) {
        posts = posts.filter(p => isWithin24h(p.time_label));
      }
    }

    console.log(`Source=${freshSource}; posts: ${posts.length}`);
    if (posts.length === 0) {
      console.warn("WARNING: no posts captured via API or DOM. Check diag above for risk-control (slider) page.");
    }
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
  } finally {
    // --- 5. de-duplicate, merge, save ------------------------------------
    const dataDir = path.join(process.cwd(), "data", "xueqiu", USER_ID);
    const existing = new Set();
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
          for (const p of d.posts || []) existing.add(String(p.id));
        } catch (_) { /* skip corrupt file */ }
      }
    }
    const newPosts = posts.filter(p => !existing.has(p.id));

    const now = new Date();
    const stamp = beijingStamp(now);

    fs.mkdirSync(dataDir, { recursive: true });
    const output = {
      user_id: USER_ID,
      profile_url: PROFILE_URL,
      window: "last-24h",
      source: freshSource,
      crawled_at_beijing: stamp.time,
      crawled_date: stamp.date,
      post_count: newPosts.length,
      posts: newPosts
    };
    const outputFile = path.join(dataDir, `${stamp.date}.json`);

    // Merge into the day file if the run lands on the same date.
    let merged = output;
    if (fs.existsSync(outputFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const have = new Set((prev.posts || []).map(p => String(p.id)));
        for (const p of newPosts) {
          if (!have.has(p.id)) prev.posts.push(p);
        }
        prev.post_count = (prev.posts || []).length;
        prev.crawled_at_beijing = stamp.time;
        merged = prev;
      } catch (_) { /* overwrite on parse failure */ }
    }

    fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2), "utf8");
    console.log(`Posts: source=${freshSource} captured=${posts.length} new=${newPosts.length}.`);
    console.log(`Saved to: ${outputFile}`);
    await browser.close();
  }

  if (process.exitCode === undefined && posts.length === 0) {
    // Keep the run "successful" so the commit step still executes;
    // the empty day file is the visible signal.
    process.exitCode = 0;
  }
})();
