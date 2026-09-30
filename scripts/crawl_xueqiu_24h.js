const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Fetch a xueqiu user's posts/replies published in the last 24 hours.
//
// Risk-control context (learned from run logs):
//   - The homepage seeds anonymous tokens (xq_a_token ...) without any
//     challenge, and the timeline API works from the homepage origin.
//   - The profile URL /u/<id> is protected by an Aliyun "slide to verify"
//     (ACW) challenge; the API called from that challenged origin returns
//     an HTML verification page instead of JSON.
//
// Strategy:
//   1. Visit homepage, seed tokens, call the timeline API from homepage.
//   2. If that yields nothing, open the profile page; when the ACW slider
//      appears, solve it with a human-like drag and retry the API from the
//      profile origin.
//   3. Last resort: DOM scrape of the profile feed.
// The 24h window is decided from the created_at millisecond timestamp
// (exact); DOM labels are only used by the last-resort path.
const USER_ID = process.env.XUEQIU_USER_ID || "9493911686";
const PROFILE_URL = `https://xueqiu.com/u/${USER_ID}`;
const WINDOW_MS = 24 * 3600 * 1000;

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

// In-page: detect the Aliyun ACW "slide to verify" challenge.
function detectChallenge() {
  const out = {
    url: location.href,
    title: document.title,
    isChallenge: /verif|valid|acw/i.test(location.search + location.hash) ||
                 /Access Verification|slide to verify|滑动验证|访问验证/.test(document.body ? document.body.innerText.slice(0, 500) : ""),
    handle: null,
    trackW: 0
  };
  const cands = [
    "[class*=nc_iconfont]", "[id*=nc_1_scale]", "[class*=nc-container] [class*=scale]",
    "[class*=slider] [class*=btn]", "[class*=drag] [class*=handle]",
    "[class*=verify] [class*=icon]", "[class*=slider-btn]", "[class*=slide] [class*=btn]"
  ];
  for (const sel of cands) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      const r = el.getBoundingClientRect();
      if (r.width > 10 && r.width < 120 && r.height > 10) {
        out.handle = { x: r.x, y: r.y, w: r.width, h: r.height };
        break;
      }
    }
  }
  if (!out.handle) {
    // generic: smallest visible box inside a wide track
    const boxes = [...document.querySelectorAll("div,span,button,a")].filter(e => {
      if (e.offsetParent === null) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 24 && r.width <= 60 && r.height >= 24 && r.height <= 60 &&
             /slide|drag|verify|slider|nc_|btn/i.test((e.className || "") + (e.id || ""));
    });
    for (const e of boxes) {
      const r = e.getBoundingClientRect();
      out.handle = { x: r.x, y: r.y, w: r.width, h: r.height };
      break;
    }
  }
  if (out.handle) {
    const track = document.querySelector("[class*=nc_bg],[class*=track],[class*=slider-track],[class*=verify-bar]");
    if (track) out.trackW = track.getBoundingClientRect().width;
  }
  return out;
}

// In-page: perform a human-like drag of the ACW slider (pointer events,
// eased x-velocity, slight y jitter). Self-contained (detectChallenge is
// duplicated inline because page.evaluate serializes a single function).
async function solveSlider() {
  function detect() {
    const out = {
      isChallenge: /verif|valid|acw/i.test(location.search + location.hash) ||
                   /Access Verification|slide to verify|滑动验证|访问验证/.test(document.body ? document.body.innerText.slice(0, 500) : ""),
      handle: null
    };
    const cands = [
      "[class*=nc_iconfont]", "[id*=nc_1_scale]", "[class*=nc-container] [class*=scale]",
      "[class*=slider] [class*=btn]", "[class*=drag] [class*=handle]",
      "[class*=verify] [class*=icon]", "[class*=slider-btn]", "[class*=slide] [class*=btn]"
    ];
    for (const sel of cands) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.width < 120 && r.height > 10) {
          out.handle = { x: r.x, y: r.y, w: r.width, h: r.height };
          break;
        }
      }
    }
    if (!out.handle) {
      const boxes = [...document.querySelectorAll("div,span,button,a")].filter(e => {
        if (e.offsetParent === null) return false;
        const r = e.getBoundingClientRect();
        return r.width >= 24 && r.width <= 60 && r.height >= 24 && r.height <= 60 &&
               /slide|drag|verify|slider|nc_|btn/i.test((e.className || "") + (e.id || ""));
      });
      for (const e of boxes) {
        const r = e.getBoundingClientRect();
        out.handle = { x: r.x, y: r.y, w: r.width, h: r.height };
        break;
      }
    }
    if (out.handle) {
      const track = document.querySelector("[class*=nc_bg],[class*=track],[class*=slider-track],[class*=verify-bar]");
      if (track) out.trackW = track.getBoundingClientRect().width;
    }
    return out;
  }
  const before = detect();
  if (!before.handle) return "no_handle";
  const h = before.handle;
  const trackW = before.trackW || 300;
  const dist = Math.min(trackW - h.w - 6, 280);
  const sx = h.x + h.w / 2, sy = h.y + h.h / 2;
  const el = document.elementFromPoint(sx, sy) || document.body;

  const fire = (type, x, y) => {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1
    }));
  };
  const steps = 60;
  fire("pointerdown", sx, sy);
  const t0 = performance.now();
  for (let i = 1; i <= steps; i++) {
    // ease-in-out with overshoot correction near the end
    const p = i / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    let dx = dist * eased;
    if (p > 0.92) dx = dist + Math.sin(p * 40) * 1.5; // micro jitter at the end
    const jx = (Math.random() - 0.5) * 1.2;
    const jy = (Math.random() - 0.5) * 2.0;
    fire("pointermove", sx + dx + jx, sy + jy);
    await new Promise(r => setTimeout(r, 8 + Math.random() * 14));
  }
  fire("pointerup", sx + dist, sy);
  const elapsed = performance.now() - t0;
  await new Promise(r => setTimeout(r, 3000));
  const after = detect();
  return JSON.stringify({ elapsed_ms: Math.round(elapsed), still: after.isChallenge, head: document.body ? document.body.innerText.slice(0, 120) : "" });
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

  // In-page API fetch: paginate user_timeline until the 24h boundary.
  async function apiFetch() {
    return await page.evaluate(async (uid) => {
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
  }

  try {
    // --- 1. homepage: seed tokens + try API from the clean origin --------
    console.log("Seeding cookies: https://xueqiu.com/");
    await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log("Home title:", await page.title());
    const cookieNames = (await page.context().cookies()).map((c) => c.name).join(",");
    console.log("Cookies:", cookieNames);

    const apiHome = await apiFetch();
    console.log(`API@home: pages=${apiHome.pages} http=${apiHome.http} total_seen=${apiHome.total_seen} kept=${apiHome.posts.length} error=${apiHome.error}`);
    if (!apiHome.error && apiHome.total_seen > 0) {
      posts = apiHome.posts;
      freshSource = "api-home";
    }

    // --- 2. profile: slider solve + API retry ----------------------------
    if (posts.length === 0) {
      console.log(`Opening: ${PROFILE_URL}`);
      await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      const diag = await page.evaluate(detectChallenge);
      console.log("Profile diag:", JSON.stringify({ url: diag.url.slice(0, 120), title: diag.title, challenge: diag.isChallenge, head: diag.head }));

      if (diag.isChallenge && diag.handle) {
        console.log("Slider detected, attempting drag solve...");
        const result = await page.evaluate(solveSlider);
        console.log("Slider result:", result);
        await page.waitForTimeout(3000);
        const diag2 = await page.evaluate(detectChallenge);
        console.log("Post-solve diag:", JSON.stringify({ title: diag2.title, challenge: diag2.isChallenge, head: diag2.head }));
      }

      // API from the profile origin — always attempted (works when the
      // page loaded clean, or after a successful slider solve).
      const apiProfile = await apiFetch();
      console.log(`API@profile: pages=${apiProfile.pages} http=${apiProfile.http} total_seen=${apiProfile.total_seen} kept=${apiProfile.posts.length} error=${apiProfile.error}`);
      if (!apiProfile.error && apiProfile.total_seen > 0) {
        posts = apiProfile.posts;
        freshSource = "api-profile";
      }
    }

    // --- 3. DOM fallback ---------------------------------------------------
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
      console.warn("WARNING: no posts captured. Profile likely under risk-control; see diagnostics above.");
    }
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
  } finally {
    // --- 4. de-duplicate, merge, save --------------------------------------
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
})();
