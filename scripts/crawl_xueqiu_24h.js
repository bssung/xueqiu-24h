const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Fetch a xueqiu user's posts/replies published in the last 24 hours.
//
// Risk-control context (learned from run logs #1-#3):
//   - Profile URL /u/<id> is behind an Aliyun ACW "slide to verify" page.
//   - Synthetic in-page PointerEvents (isTrusted=false) get rejected by
//     ACW — the drag must be produced by Playwright's native mouse (CDP
//     Input.dispatchMouseEvent => isTrusted=true).
//   - The runner's datacenter IP is also fingerprinted (API@home got
//     400), so the page has to pass the ACW check to earn a pass cookie.
//
// Strategy:
//   1. Launch with a desktop UA + headless-fingerprint patches,
//      zh-CN locale, Asia/Shanghai timezone.
//   2. Visit homepage to seed anonymous tokens (xq_a_token ...).
//   3. Open the profile page; if the ACW slider appears, drag the handle
//      with page.mouse (trusted events, eased trajectory, jitter,
//      endpoint overshoot), up to 3 attempts, re-navigating between.
//   4. Fetch the timeline API from the (now passed) profile origin,
//      paginating until posts older than 24h appear.
//   5. Last resort: DOM scrape of the profile feed.
// The 24h window is decided from the created_at millisecond timestamp
// (exact); DOM labels are only used by the last-resort path.
const USER_ID = process.env.XUEQIU_USER_ID || "9493911686";
const PROFILE_URL = `https://xueqiu.com/u/${USER_ID}`;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
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

// In-page: detect the Aliyun ACW "slide to verify" challenge and locate
// the drag handle. Returns {challenge, handle:{x,y,w,h}|null, trackW}.
function detectChallenge() {
  const out = {
    url: location.href,
    title: document.title,
    challenge: /verif|valid|acw/i.test(location.search + location.hash) ||
               /Access Verification|slide to verify|滑动验证|访问验证/.test(
                 document.body ? document.body.innerText.slice(0, 500) : ""),
    handle: null,
    trackW: 0
  };
  const sized = (el) => {
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    return (r.width > 10 && r.width < 120 && r.height > 10 && r.height < 120)
      ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  };
  const cands = [
    "#nc_1_n1z, [id*=nc_1_scale]",
    "[class*=nc_bg] [class*=scale], [class*=nc-container] [class*=scale]",
    "[class*=nc_iconfont]",
    "[class*=slider] [class*=btn], [class*=slider-btn]",
    "[class*=drag] [class*=handle]",
    "[class*=verify] [class*=icon]",
    "[class*=slide] [class*=btn]"
  ];
  for (const sel of cands) {
    for (const el of document.querySelectorAll(sel)) {
      out.handle = sized(el);
      if (out.handle) break;
    }
    if (out.handle) break;
  }
  if (!out.handle) {
    // Generic: a small square-ish box inside the challenge card.
    const boxes = [...document.querySelectorAll("div,span,a,button")].filter(e => {
      if (e.offsetParent === null) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 30 && r.width <= 60 && r.height >= 30 && r.height <= 60 &&
             /slide|drag|verify|slider|nc_|btn|icon/i.test((e.className || "") + (e.id || ""));
    });
    for (const e of boxes) {
      out.handle = sized(e);
      if (out.handle) break;
    }
  }
  if (out.handle) {
    const track = document.querySelector(
      "[class*=nc_bg], [class*=track], [class*=slider-track], [class*=verify-bar], [class*=bar]"
    );
    if (track) out.trackW = track.getBoundingClientRect().width;
  }
  return out;
}

// Human-like drag of the ACW slider using Playwright's NATIVE mouse
// (trusted events): ease-in-out, per-step timing jitter, y wobble,
// endpoint overshoot-and-settle. Returns a status object.
async function solveWithNativeMouse(page, handle, trackW) {
  const sx = handle.x + handle.w / 2;
  const sy = handle.y + handle.h / 2;
  const dist = Math.min((trackW || handle.w * 5) - handle.w - 4, 290);
  const t0 = Date.now();
  await page.mouse.move(sx, sy, { steps: 5 });
  await page.waitForTimeout(150 + Math.random() * 250);
  await page.mouse.down();
  const steps = 55 + Math.floor(Math.random() * 25);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    let dx = dist * eased;
    if (p > 0.9) dx = dist + Math.sin(p * 45) * 2.0; // micro overshoot at the end
    const x = sx + dx + (Math.random() - 0.5) * 1.5;
    const y = sy + (Math.random() - 0.5) * 3.0;
    await page.mouse.move(x, y);
    await page.waitForTimeout(6 + Math.random() * 16);
  }
  await page.mouse.move(sx + dist, sy);
  await page.waitForTimeout(60 + Math.random() * 120);
  await page.mouse.up();
  const elapsed = Date.now() - t0;
  await page.waitForTimeout(3000);
  let d;
  try { d = await page.evaluate(detectChallenge); } catch (_) { d = { challenge: null }; }
  return { elapsed_ms: elapsed, still: d.challenge, title: d.title };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  });
  // Fingerprint patches for headless detection.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    const perm = (window.navigator.permissions && window.navigator.permissions.query) || null;
    if (perm) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : perm(p);
    }
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
  const page = await context.newPage();

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
        try { j = await r.json(); } catch (e) { out.error = "json:" + e.message.slice(0, 80); break; }
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
    // --- 1. homepage: seed tokens ------------------------------------------
    console.log("Seeding cookies: https://xueqiu.com/");
    await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log("Home title:", await page.title());
    console.log("Cookies:", (await context.cookies()).map((c) => c.name).join(","));

    const apiHome = await apiFetch();
    console.log(`API@home: pages=${apiHome.pages} http=${apiHome.http} total_seen=${apiHome.total_seen} kept=${apiHome.posts.length} error=${apiHome.error}`);
    if (!apiHome.error && apiHome.total_seen > 0) {
      posts = apiHome.posts;
      freshSource = "api-home";
    }

    // --- 2. profile: ACW slider (trusted mouse), up to 3 rounds ------------
    for (let round = 1; posts.length === 0 && round <= 3; round++) {
      console.log(`Round ${round}: Opening ${PROFILE_URL}`);
      await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      let diag;
      try { diag = await page.evaluate(detectChallenge); } catch (e) { diag = { challenge: true, handle: null, title: "eval-err" }; }
      console.log(`Round ${round} diag: challenge=${diag.challenge} title=${diag.title} handle=${JSON.stringify(diag.handle)} trackW=${diag.trackW}`);

      if (diag.challenge && diag.handle) {
        console.log(`Round ${round}: dragging slider (native mouse)...`);
        const res = await solveWithNativeMouse(page, diag.handle, diag.trackW);
        console.log(`Round ${round} slider: ${JSON.stringify(res)}`);
        if (!res.still) {
          await page.waitForTimeout(2500);
        }
      } else if (diag.challenge) {
        console.log(`Round ${round}: challenge present but no handle found`);
      }

      const api = await apiFetch();
      console.log(`Round ${round} API: pages=${api.pages} http=${api.http} total_seen=${api.total_seen} kept=${api.posts.length} error=${api.error}`);
      if (!api.error && api.total_seen > 0) {
        posts = api.posts;
        freshSource = "api-profile";
        break;
      }
    }

    // --- 3. DOM fallback -----------------------------------------------------
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
      console.warn("WARNING: no posts captured. Risk-control (ACW) likely still blocking; see round logs above.");
    }
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
  } finally {
    // --- 4. de-duplicate, merge, save ---------------------------------------
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
