const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Xueqiu 24h crawler — v6 (harvest, don't fight the WAF).
//
// What the runner logs proved (runs #1-#5):
//   - With fingerprint patches, the PROFILE DOCUMENT loads clean (real title,
//     no slider). So the document path passes risk-control.
//   - But a manual in-page fetch() of the timeline JSON is blocked:
//     400 "用户未登录" (anonymous tokens insufficient on this DC IP) or a
//     200 ACW JS-challenge body. Loading that challenge by navigation does
//     NOT mint the acw_sc__v2 pass cookie here.
//
// So instead of solving the XHR WAF, we HARVEST what the page itself gets:
//   1. Intercept the page's OWN XHR responses (it uses its full session +
//      headers/referer, closer to a real user) and keep any timeline JSON.
//   2. Extract the server-rendered state (window.__INITIAL_STATE__ / __NUXT__)
//      which ships in the passed document and is NOT subject to XHR WAF.
//   3. Fallback: manual API fetch (kept, low priority).
//   4. Fallback: DOM scrape of rendered feed rows.
// All candidate posts are de-duplicated and the 24h window is applied from
// the created_at millisecond timestamp. Rich diagnostics are logged so a
// still-blocked run reveals the exact structure to target next.
const USER_ID = process.env.XUEQIU_USER_ID || "9493911686";
const PROFILE_URL = `https://xueqiu.com/u/${USER_ID}`;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WINDOW_MS = 24 * 3600 * 1000;

function isWithin24hLabel(label) {
  const s = String(label || "").trim();
  if (!s) return false;
  let m;
  if ((m = s.match(/(\d+)\s*分钟/))) return Number(m[1]) < 60 * 24;
  if ((m = s.match(/(\d+)\s*小时/))) return Number(m[1]) < 24;
  if (/^\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2})?$/.test(s)) return true;
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

// In-page: pull the server-rendered state object (Vue/Nuxt) as a JSON string.
function readSsrState() {
  const out = { keys: [], candidates: 0, sample: "" };
  const candidates = [window.__INITIAL_STATE__, window.__NUXT__, window.__PRELOADED_STATE__];
  let found = null;
  for (const c of candidates) {
    if (c && typeof c === "object") { found = c; break; }
  }
  if (!found) {
    out.sample = "no __INITIAL_STATE__/__NUXT__ found; window keys with data: " +
      Object.keys(window).filter(k => /state|nuxt|data|store|initial/i.test(k)).join(",");
    return out;
  }
  out.keys = Object.keys(found).slice(0, 60);
  const s = JSON.stringify(found);
  out.sample = s.slice(0, 400);
  // crude candidate count: objects that look like statuses
  out.candidates = (s.match(/"created_at"\s*:\s*\d{12,}/g) || []).length;
  out.size = s.length;
  // return the whole (bounded) string for local parsing
  out.raw = s.slice(0, 400000);
  return out;
}

// In-page: generic DOM scrape of rendered feed rows (last resort).
function domScrape(uid) {
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

  // Response harvest: capture the page's own timeline/feed XHR JSON.
  const xhrPosts = [];       // normalized posts from intercepted responses
  const xhrUrls = [];        // every response URL we observed (diagnostic)
  let xhrJsonHits = 0;
  page.on("response", async (resp) => {
    const url = resp.url();
    xhrUrls.push(url.split("?")[0].slice(0, 120));
    if (!/xueqiu\.com/i.test(url)) return;
    const ct = (resp.headers()["content-type"] || "");
    if (!ct.includes("json")) return;
    if (!/timeline|statuses|user_|comment|reply|status/i.test(url)) return;
    try {
      const j = await resp.json();
      const list = j.statuses || (j.data && (j.data.statuses || j.data.list)) || [];
      if (Array.isArray(list) && list.length) {
        xhrJsonHits++;
        for (const s of list) {
          if (s && (s.id != null) && (typeof s.created_at === "number" || s.created_at)) {
            const desc = s.description || s.text || "";
            xhrPosts.push({
              id: String(s.id),
              created_at: typeof s.created_at === "number" ? new Date(s.created_at).toISOString() : String(s.created_at),
              kind: s.retweet_status_id ? "retweet" : (/^回复</.test(desc) ? "reply" : "status"),
              url: `https://xueqiu.com/${USER_ID}/${s.id}`,
              text: String(desc).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim().slice(0, 2000)
            });
          }
        }
      }
    } catch (_) { /* not json / not our shape */ }
  });

  let posts = [];
  let freshSource = "none";

  async function manualApiFetch() {
    return await page.evaluate(async (uid) => {
      const now = Date.now();
      const cutoff = now - 24 * 3600 * 1000;
      const out = { pages: 0, http: 0, total_seen: 0, posts: [], error: null, bodyHead: "" };
      for (let p = 1; p <= 20; p++) {
        let r;
        try {
          r = await fetch(`/v4/statuses/user_timeline.json?user_id=${uid}&page=${p}&count=100`,
            { credentials: "include", headers: { "x-requested-with": "XMLHttpRequest" } });
        } catch (e) { out.error = "fetch:" + e.message; break; }
        out.http = r.status;
        const raw = await r.text();
        out.bodyHead = raw.slice(0, 60).replace(/\s+/g, " ");
        if (r.status !== 200) { out.error = "http:" + r.status; break; }
        let j;
        try { j = JSON.parse(raw); } catch (e) { out.error = "json:" + out.bodyHead.slice(0, 30); break; }
        const list = j.statuses || [];
        out.pages = p;
        out.total_seen += list.length;
        let oldest = Infinity;
        for (const s of list) {
          if (typeof s.created_at === "number") oldest = Math.min(oldest, s.created_at);
          if (typeof s.created_at !== "number" || s.created_at < cutoff) continue;
          const desc = s.description || "";
          out.posts.push({
            id: String(s.id), created_at: new Date(s.created_at).toISOString(),
            kind: s.retweet_status_id ? "retweet" : (/^回复</.test(desc) ? "reply" : "status"),
            url: `https://xueqiu.com/${uid}/${s.id}`,
            text: String(desc).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim().slice(0, 2000)
          });
        }
        if (list.length === 0) break;
        if (oldest !== Infinity && oldest < cutoff) break;
      }
      return out;
    }, USER_ID);
  }

  try {
    console.log("Seeding cookies: https://xueqiu.com/");
    await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log("Home title:", await page.title());

    // Open profile (document path passes risk-control with fingerprint patches).
    console.log(`Opening: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    console.log("Profile title:", await page.title());

    // Scroll to trigger lazy feed loading (drives the page's own XHR).
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(2000);

    // --- Harvest 1: intercepted XHR posts ---------------------------------
    const uniqXhr = [...new Map(xhrPosts.map(p => [p.id, p])).values()];
    console.log(`[harvest] XHR responses seen: ${xhrUrls.length}; json timeline hits: ${xhrJsonHits}; posts captured: ${uniqXhr.length}`);
    console.log(`[harvest] XHR urls: ${[...new Set(xhrUrls)].slice(0, 25).join(" | ")}`);

    // --- Harvest 2: SSR state ---------------------------------------------
    let ssr = { candidates: 0, size: 0, raw: "" };
    try { ssr = await page.evaluate(readSsrState); } catch (e) { ssr = { error: e.message }; }
    console.log(`[ssr] keys: ${JSON.stringify((ssr.keys || []).slice(0, 40))}`);
    console.log(`[ssr] created_at candidates in state: ${ssr.candidates}; state size: ${ssr.size}`);
    console.log(`[ssr] sample: ${ssr.sample || ssr.error || ""}`);

    // Parse SSR state for post-like objects (created_at ms + description).
    let ssrPosts = [];
    if (ssr.raw) {
      try {
        const state = JSON.parse(ssr.raw);
        const found = [];
        (function walk(o) {
          if (!o || typeof o !== "object" || found.length > 500) return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          const isPost = (o.id != null) && typeof o.created_at === "number" &&
            (typeof o.description === "string" || typeof o.text === "string");
          if (isPost) {
            const desc = o.description || o.text || "";
            found.push({
              id: String(o.id), created_at: new Date(o.created_at).toISOString(),
              kind: o.retweet_status_id ? "retweet" : (/^回复</.test(desc) ? "reply" : "status"),
              url: `https://xueqiu.com/${USER_ID}/${o.id}`,
              text: String(desc).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim().slice(0, 2000)
            });
          }
          for (const k of Object.keys(o)) walk(o[k]);
        })(state);
        ssrPosts = [...new Map(found.map(p => [p.id, p])).values()];
      } catch (e) { /* raw was truncated JSON; ignore */ }
    }
    console.log(`[ssr] posts parsed from state: ${ssrPosts.length}`);

    // --- Harvest 3: manual API (last attempt) -----------------------------
    if (uniqXhr.length === 0 && ssrPosts.length === 0) {
      const api = await manualApiFetch();
      console.log(`[api] pages=${api.pages} http=${api.http} total_seen=${api.total_seen} kept=${api.posts.length} error=${api.error} body=${api.bodyHead}`);
      if (!api.error && api.total_seen > 0) { posts = api.posts; freshSource = "api"; }
    }

    // --- Merge all harvested sources --------------------------------------
    const merged = new Map();
    for (const p of [...ssrPosts, ...uniqXhr, ...posts]) {
      if (!merged.has(p.id)) merged.set(p.id, p);
    }
    let combined = [...merged.values()];
    if (combined.length) {
      // apply 24h window from created_at when available
      const cutoff = Date.now() - WINDOW_MS;
      const withTs = combined.filter(p => /^\d{4}-/.test(String(p.created_at)));
      if (withTs.length === combined.length) {
        combined = withTs.filter(p => new Date(p.created_at).getTime() >= cutoff);
      }
    }

    if (combined.length) {
      posts = combined;
      freshSource = freshSource === "api" ? "api" :
        (ssrPosts.length ? "ssr+xhr" : "xhr");
    } else if (uniqXhr.length || ssrPosts.length) {
      // had posts but none in 24h
      posts = [];
      freshSource = (ssrPosts.length ? "ssr" : "xhr") + "-none-in-24h";
    }

    // --- Harvest 4: DOM fallback ------------------------------------------
    if (posts.length === 0) {
      freshSource = "dom";
      let dom = await page.evaluate(domScrape, USER_ID);
      if (dom.length) {
        dom = dom.filter(p => isWithin24hLabel(p.time_label));
        posts = dom;
      }
    }

    console.log(`Source=${freshSource}; posts: ${posts.length}`);
    if (posts.length) {
      console.log(`Sample post: ${JSON.stringify(posts[0]).slice(0, 300)}`);
    } else {
      console.warn("WARNING: no posts in window. Check harvest diagnostics above (XHR urls, ssr keys).");
    }
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
  } finally {
    const dataDir = path.join(process.cwd(), "data", "xueqiu", USER_ID);
    const existing = new Set();
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
          for (const p of d.posts || []) existing.add(String(p.id));
        } catch (_) {}
      }
    }
    const newPosts = posts.filter(p => !existing.has(p.id));

    const now = new Date();
    const stamp = beijingStamp(now);
    fs.mkdirSync(dataDir, { recursive: true });
    const output = {
      user_id: USER_ID, profile_url: PROFILE_URL, window: "last-24h",
      source: freshSource, crawled_at_beijing: stamp.time, crawled_date: stamp.date,
      post_count: newPosts.length, posts: newPosts
    };
    const outputFile = path.join(dataDir, `${stamp.date}.json`);
    let mergedFile = output;
    if (fs.existsSync(outputFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const have = new Set((prev.posts || []).map(p => String(p.id)));
        for (const p of newPosts) if (!have.has(p.id)) prev.posts.push(p);
        prev.post_count = (prev.posts || []).length;
        prev.crawled_at_beijing = stamp.time;
        mergedFile = prev;
      } catch (_) {}
    }
    fs.writeFileSync(outputFile, JSON.stringify(mergedFile, null, 2), "utf8");
    console.log(`Posts: source=${freshSource} captured=${posts.length} new=${newPosts.length}.`);
    console.log(`Saved to: ${outputFile}`);
    await browser.close();
  }
})();
