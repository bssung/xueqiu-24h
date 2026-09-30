const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Fetch a xueqiu user's posts published in the last 24 hours.
// Modeled on bym0122/bym_files: headless Chromium opens the profile page,
// lazy-loads the feed, and each post row is matched by its
// /<USER_ID>/<postId> link. 24h window is decided from the row's
// relative time label (x分钟前 / x小时前 / today's HH:mm).
const USER_ID = process.env.XUEQIU_USER_ID || "9493911686";
const PROFILE_URL = `https://xueqiu.com/u/${USER_ID}`;

// Xueqiu profile time labels: "15分钟前", "3小时前", "昨天 14:30",
// "09-30 12:33", "2025-09-20". Return true when the label is within
// the trailing 24h (conservatively: same-day or relative < 24h).
function isWithin24h(label) {
  const s = String(label || "").trim();
  if (!s) return false;
  let m;
  if ((m = s.match(/(\d+)\s*分钟/))) return Number(m[1]) < 60 * 24;
  if ((m = s.match(/(\d+)\s*小时/))) return Number(m[1]) < 24;
  if (/^\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2})?$/.test(s)) return true; // today, shown as MM-DD [HH:mm]
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    // Full date: only include when it is today (Beijing).
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    return s.slice(0, 10) === today;
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });

  try {
    console.log(`Opening: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    // Scroll to trigger lazy loading until the feed reaches the 24h boundary.
    let prevTime = "";
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
      // Stop once we have scrolled past the last same-day post.
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

    // Pair each post link with the nearest time label inside its row.
    const posts = await page.evaluate((uid) => {
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
              out.push({ id: postId, url: href, time_label: label });
            }
            break;
          }
        }
      }
      return out;
    }, USER_ID);

    const fresh = posts.filter(p => isWithin24h(p.time_label));

    // De-duplicate against already-committed data in this repo.
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
    const newPosts = fresh.filter(p => !existing.has(p.id));

    const now = new Date();
    const beijingDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now);
    const beijingTime = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium"
    }).format(now);

    fs.mkdirSync(dataDir, { recursive: true });
    const output = {
      user_id: USER_ID,
      profile_url: PROFILE_URL,
      window: "last-24h",
      crawled_at_beijing: beijingTime,
      crawled_date: beijingDate,
      post_count: newPosts.length,
      posts: newPosts
    };
    const outputFile = path.join(dataDir, `${beijingDate}.json`);

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
        prev.crawled_at_beijing = beijingTime;
        merged = prev;
      } catch (_) { /* overwrite on parse failure */ }
    }

    fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2), "utf8");
    console.log(`Posts seen in feed: ${posts.length}; within 24h: ${fresh.length}; new: ${newPosts.length}.`);
    console.log(`Saved to: ${outputFile}`);
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
