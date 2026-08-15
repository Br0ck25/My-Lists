// --- Admin stats (page views, install links generated) -----------------
//
// Deliberately simple counters -- KV has no atomic increment (each bump is
// a read-then-write), so under truly simultaneous requests a bump can very
// occasionally get lost. That's an acceptable tradeoff for a personal
// project's traffic; this isn't meant to be exact to the request, just a
// reasonable running total and day-by-day trend for the admin-only
// dashboard below. No cookies, no per-visitor identity involved -- just a
// running count of events.
// Calendar date (YYYY-MM-DD) for a given moment, in Eastern time -- this
// admin dashboard is for a single owner in a fixed timezone, and using
// UTC's day boundary meant "today" started rolling over into "tomorrow"
// as early as ~7-8pm Eastern, well before the day was actually over
// locally. en-CA formats as YYYY-MM-DD directly; America/New_York's IANA
// data handles the EST/EDT switch automatically, unlike a fixed offset
// would.
function easternDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function statsToday() {
  return easternDateKey(new Date());
}

async function bumpStat(env, kind) {
  if (!env || !env.CONFIGS) return;
  try {
    const totalKey = `stats:${kind}:total`;
    const dayKey = `stats:${kind}:${statsToday()}`;
    const [totalRaw, dayRaw] = await Promise.all([env.CONFIGS.get(totalKey), env.CONFIGS.get(dayKey)]);
    const total = (parseInt(totalRaw, 10) || 0) + 1;
    const day = (parseInt(dayRaw, 10) || 0) + 1;
    await Promise.all([env.CONFIGS.put(totalKey, String(total)), env.CONFIGS.put(dayKey, String(day))]);
  } catch (e) {
    // best-effort -- a failed stat bump should never break the actual
    // request it's riding along on (see the ctx.waitUntil call sites,
    // which don't await this at all for exactly that reason).
  }
}

// Like bumpStat above, but by a caller-supplied amount in one write
// instead of always +1 -- used for the per-source-group counters (a
// single "generate install link" beacon can represent several rows of the
// same group at once, e.g. five Custom Lists in one install). Total only,
// no daily breakdown -- "which sources people use" reads more like a
// standing preference than a day-to-day trend, and this keeps the write
// count reasonable for a request that can touch several groups at once.
async function bumpStatBy(env, kind, amount) {
  if (!env || !env.CONFIGS || !amount) return;
  try {
    const totalKey = `stats:${kind}:total`;
    const totalRaw = await env.CONFIGS.get(totalKey);
    const total = (parseInt(totalRaw, 10) || 0) + amount;
    await env.CONFIGS.put(totalKey, String(total));
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

// Records roughly how recently a creator account was last active -- feeds
// the "Last Active" column in the admin dashboard's Creator Accounts tab.
// Throttled to at most once per 30 minutes per account (one extra read to
// check, skipped write if already recent) so a burst of debounced
// autosaves during a single active session doesn't turn into a KV write
// on every one of them -- called from authenticateCreator on every
// successful auth, fire-and-forget (never awaited there), so this can
// never add latency or a failure mode to the actual authenticated action
// it's riding along with.
async function touchCreatorLastSeen(env, username) {
  if (!env || !env.CONFIGS || !username) return;
  try {
    const key = `creatorlastseen:${username}`;
    const raw = await env.CONFIGS.get(key);
    const last = parseInt(raw, 10) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return; // updated recently enough
    await env.CONFIGS.put(key, String(Date.now()));
  } catch (e) {
    // best-effort -- a missing/stale "Last Active" value is cosmetic only
  }
}

// Records one "marked as watched" or "added to a list" event for a given
// title -- feeds the admin dashboard's Trending Data tab, which is meant
// to eventually seed this add-on's own trending/popular catalogs once
// there's enough data. Bucketed by Eastern calendar day (see
// easternDateKey) rather than a raw event log, so an arbitrary rolling
// window (7/30/90 days) can be summed later without needing a real
// time-series database -- evtdayindex tracks which title ids had any
// activity on a given day, so the dashboard only has to sum counts for
// titles that were actually active in the requested window instead of
// checking every title that's ever been tracked. KV has no atomic
// increment (same tradeoff as bumpStat above), so this is a reasonable
// running total, not an exact ledger.
async function recordTrackedEvent(env, eventType, id, title, mediaType) {
  if (!env || !env.CONFIGS || !id) return;
  try {
    const day = statsToday();
    const dayKey = `evtcount:${eventType}:${id}:${day}`;
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const metaKey = `evtmeta:${eventType}:${id}`;
    const indexKey = `evtdayindex:${eventType}:${day}`;

    const [dayRaw, totalRaw, indexRaw] = await Promise.all([
      env.CONFIGS.get(dayKey),
      env.CONFIGS.get(totalKey),
      env.CONFIGS.get(indexKey),
    ]);
    const dayCount = (parseInt(dayRaw, 10) || 0) + 1;
    const totalCount = (parseInt(totalRaw, 10) || 0) + 1;

    let index = [];
    try {
      index = indexRaw ? JSON.parse(indexRaw) : [];
    } catch {
      index = [];
    }
    if (!index.includes(id)) index.push(id);

    await Promise.all([
      env.CONFIGS.put(dayKey, String(dayCount)),
      env.CONFIGS.put(totalKey, String(totalCount)),
      env.CONFIGS.put(indexKey, JSON.stringify(index)),
      // Overwritten every time rather than only on first sight -- keeps
      // title/mediaType current if either ever changes upstream, and
      // lastSeen doubles as a cheap staleness signal in the dashboard.
      env.CONFIGS.put(metaKey, JSON.stringify({ title: title || "", mediaType: mediaType || "", lastSeen: Date.now() })),
    ]);
  } catch (e) {
    // best-effort -- never breaks the actual watch/list action riding along
  }
}

// Computes a top-100 leaderboard of the most tracked titles for a given
// event type ("watched" or "list-add") and time window -- powers the
// admin dashboard's Trending Data tab. See recordTrackedEvent's own
// comment for the underlying data model. "today"/"7"/"30"/"90" sum via
// each day's index (bounded to titles that were actually active
// somewhere in that window, not every title ever tracked); "alltime"
// reads each title's running total directly instead, since there's no
// day-index for it that would need summing. mediaTypeFilter ("movie" /
// "series" / falsy for both) is applied before the top-100 cut, not
// after, so filtering to just movies still returns up to 100 movies
// instead of whatever happened to survive filtering an already-mixed
// top 100.
async function computeLeaderboard(env, eventType, window, mediaTypeFilter) {
  if (!env || !env.CONFIGS) return [];
  const prefix = `evtcount:${eventType}:`;
  const wantType = mediaTypeFilter === "movie" || mediaTypeFilter === "series" ? mediaTypeFilter : null;

  if (window === "alltime") {
    const listResult = await env.CONFIGS.list({ prefix, limit: 1000 });
    const alltimeKeys = listResult.keys.filter((k) => k.name.endsWith(":alltime"));
    const entries = await Promise.all(
      alltimeKeys.map(async (k) => {
        const id = k.name.slice(prefix.length, -":alltime".length);
        const [countRaw, metaRaw] = await Promise.all([
          env.CONFIGS.get(k.name),
          env.CONFIGS.get(`evtmeta:${eventType}:${id}`),
        ]);
        let title = id;
        let mediaType = "";
        try {
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            title = meta.title || id;
            mediaType = meta.mediaType || "";
          }
        } catch {
          // fall back to raw id as the title
        }
        return { id, title, mediaType, count: parseInt(countRaw, 10) || 0 };
      })
    );
    const filtered = wantType ? entries.filter((e) => e.mediaType === wantType) : entries;
    filtered.sort((a, b) => b.count - a.count);
    return filtered.slice(0, 100);
  }

  const days = window === "today" ? 1 : parseInt(window, 10) || 7;
  const nowMs = Date.now();
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(easternDateKey(new Date(nowMs - i * 86400000)));
  }

  // Union of every title id that had any activity anywhere in this window.
  const indexResults = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`evtdayindex:${eventType}:${d}`)));
  const idSet = new Set();
  indexResults.forEach((raw) => {
    if (!raw) return;
    try {
      JSON.parse(raw).forEach((id) => idSet.add(id));
    } catch {
      // skip an unparseable day index rather than failing the whole window
    }
  });
  const ids = [...idSet].slice(0, 500); // defensive cap, see the size-guard convention used elsewhere in this file

  const entries = await Promise.all(
    ids.map(async (id) => {
      const dayCounts = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`evtcount:${eventType}:${id}:${d}`)));
      const count = dayCounts.reduce((sum, v) => sum + (parseInt(v, 10) || 0), 0);
      const metaRaw = await env.CONFIGS.get(`evtmeta:${eventType}:${id}`);
      let title = id;
      let mediaType = "";
      try {
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          title = meta.title || id;
          mediaType = meta.mediaType || "";
        }
      } catch {
        // fall back to raw id as the title
      }
      return { id, title, mediaType, count };
    })
  );
  const filtered = wantType ? entries.filter((e) => e.mediaType === wantType) : entries;
  filtered.sort((a, b) => b.count - a.count);
  return filtered.slice(0, 100);
}

// Lean sibling of recordTrackedEvent used only by the trending-data
// backfill (26_api-creator-and-admin-routes.js) -- updates just the
// all-time counter and metadata for a title, skipping the day-bucket and
// day-index writes recordTrackedEvent also does. Backfilling from
// existing Watch History/Custom List data has no natural "today" to
// bucket it under, and walking real historical per-day data would
// multiply KV operations well past a single Worker invocation's practical
// budget (Cloudflare's free-plan subrequest limit in particular) for any
// account with meaningful history. All-time-only is also the
// semantically correct home for this anyway: a rolling "last 7 days"
// window showing something watched two years ago wouldn't make sense
// even if it were cheap to compute. Returns true/false so the caller can
// track how many titles it actually got through this call.
async function backfillTitleCount(env, eventType, id, title, mediaType, incrementBy) {
  if (!env || !env.CONFIGS || !id || !incrementBy) return false;
  try {
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const metaKey = `evtmeta:${eventType}:${id}`;
    const totalRaw = await env.CONFIGS.get(totalKey);
    const total = (parseInt(totalRaw, 10) || 0) + incrementBy;
    await Promise.all([
      env.CONFIGS.put(totalKey, String(total)),
      env.CONFIGS.put(metaKey, JSON.stringify({ title: title || "", mediaType: mediaType || "", lastSeen: Date.now() })),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

// The group names bumpStatBy above gets called with ultimately come from
// the client's own collectEntries() -- not attacker-controlled in the
// normal case, but /api/track-install has no auth on it (same as the
// plain pageview/install counters), so a malicious request could send
// arbitrary junk trying to spam garbage keys into KV. This caps length and
// character set rather than trusting it outright; doesn't need to be
// exhaustive, just enough that a genuine group name always passes through
// untouched and abuse can't create unbounded distinct keys.
function sanitizeStatGroupName(raw) {
  const s = String(raw || "").trim().slice(0, 40);
  return /^[A-Za-z0-9 &().'-]+$/.test(s) ? s : null;
}

// Reads every stats:{kind}:YYYY-MM-DD entry via a prefix list (there's no
// KV range-query, so this is the only way to enumerate them) and returns a
// { "YYYY-MM-DD": count } map, skipping the :total key itself.
async function loadStatsByDay(env, kind) {
  if (!env || !env.CONFIGS) return {};
  const prefix = `stats:${kind}:`;
  const result = await env.CONFIGS.list({ prefix, limit: 1000 });
  const byDay = {};
  await Promise.all(
    result.keys.map(async (k) => {
      const day = k.name.slice(prefix.length);
      if (day === "total") return;
      const raw = await env.CONFIGS.get(k.name);
      byDay[day] = parseInt(raw, 10) || 0;
    })
  );
  return byDay;
}

// HMAC-SHA256 via the Workers runtime's native Web Crypto API, same
// approach as hashStringForKey above -- used to sign the admin session
// cookie so it can't be forged without knowing ADMIN_KEY, without needing
// any server-side session storage (the cookie IS the session: an
// expiry timestamp plus a signature over that timestamp).
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ADMIN_COOKIE_NAME = "mla_admin";
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function makeAdminCookieValue(env) {
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  const sig = await hmacHex(env.ADMIN_KEY, String(expiresAt));
  return `${expiresAt}.${sig}`;
}

async function isValidAdminCookie(env, value) {
  if (!value || !env || !env.ADMIN_KEY) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const expiresAtStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.ADMIN_KEY, expiresAtStr);
  return timingSafeEqualHex(sig, expectedSig);
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const map = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        map[k] = decodeURIComponent(v);
      } catch {
        map[k] = v;
      }
    }
  });
  return map;
}

async function isAdminRequest(request, env) {
  const cookies = parseCookies(request);
  return isValidAdminCookie(env, cookies[ADMIN_COOKIE_NAME]);
}

function renderAdminLoginPage(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F2F2F7">
<title>Admin \u2014 ${ADDON_NAME}</title>
<link rel="icon" type="image/png" href="/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script>
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
</script>
<style>
  :root {
    --bg: #F2F2F7;
    --surface: #FFFFFF;
    --panel-strong: #E5E5EA;
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.15);
    --text: #000000;
    --text-2: #3A3A3C;
    --muted: #8E8E93;
    --accent: #007AFF;
    --danger: #FF3B30;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
    --shadow: 0 2px 10px rgba(0,0,0,0.08);
    --radius: 14px;
    --radius-sm: 10px;
    --radius-pill: 999px;
    --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }
  html.dark-theme {
    --bg: #000000; --surface: #1C1C1E; --panel-strong: #2C2C2E;
    --border: rgba(255,255,255,0.15); --border-strong: rgba(255,255,255,0.25);
    --text: #FFFFFF; --text-2: #EBEBF5;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  .login-wrap { width: 100%; max-width: 380px; }
  .login-header {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-bottom: 20px;
  }
  .login-header img { width: 36px; height: 36px; border-radius: 10px; box-shadow: var(--shadow-sm); }
  .login-header span { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 20px;
    width: 100%;
  }
  .panel-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; letter-spacing: -0.01em; color: var(--text); }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 0; width: 100%; }
  input {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 11px 18px;
    min-height: 44px;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.925rem;
    font-family: inherit;
    transition: opacity 0.12s;
  }
  button:hover { opacity: 0.85; }
  .err { color: var(--danger); margin: 14px 0 0; font-size: 0.85rem; }
</style></head>
<body>
  <div class="login-wrap">
    <div class="login-header">
      <img src="/icon.png" alt="${ADDON_NAME}">
      <span>${ADDON_NAME}</span>
    </div>
    <div class="panel">
      <h2 class="panel-title">Admin sign in</h2>
      <form method="POST" action="/admin/login">
        <div class="row">
          <input type="password" name="key" placeholder="Admin key" autofocus>
        </div>
        <button type="submit">Sign in</button>
      </form>
      ${errorMsg ? `<p class="err">${escapeHtmlServer(errorMsg)}</p>` : ""}
    </div>
  </div>
</body></html>`;
}

async function renderAdminDashboard(env) {
  if (!env || !env.CONFIGS) {
    return `<!DOCTYPE html><html><body style="background:#F2F2F7;color:#1C1C1E;font-family:sans-serif;padding:40px;">This Worker has no CONFIGS KV namespace bound, so there's no stats to show.</body></html>`;
  }
  const today = statsToday();
  const [totalPV, todayPV, totalIN, todayIN, pvByDay, inByDay, creatorResult, sourceGroupResult] = await Promise.all([
    env.CONFIGS.get("stats:pageviews:total"),
    env.CONFIGS.get(`stats:pageviews:${today}`),
    env.CONFIGS.get("stats:installs:total"),
    env.CONFIGS.get(`stats:installs:${today}`),
    loadStatsByDay(env, "pageviews"),
    loadStatsByDay(env, "installs"),
    // "creator:" (with the colon) is deliberately narrow -- creatorlist:,
    // creatorsync:, etc. all start with "creator" too but not "creator:",
    // so this can't accidentally sweep those in as if they were accounts.
    env.CONFIGS.list({ prefix: "creator:", limit: 1000 }),
    env.CONFIGS.list({ prefix: "stats:sourcegroup:", limit: 1000 }),
  ]);

  // Walks the last 30 calendar days explicitly (rather than just listing
  // whatever KV happens to have) so days with zero activity still show up
  // as a 0 row instead of silently vanishing from the table. Same Eastern-
  // time day boundary as statsToday()/bumpStat() above, so these labels
  // actually match the keys being looked up.
  const rows = [];
  const nowMs = Date.now();
  for (let i = 0; i < 30; i++) {
    const key = easternDateKey(new Date(nowMs - i * 86400000));
    rows.push(`<tr><td>${key}</td><td>${pvByDay[key] || 0}</td><td>${inByDay[key] || 0}</td></tr>`);
  }

  const creatorAccounts = await Promise.all(
    creatorResult.keys.map(async (k) => {
      const username = k.name.slice("creator:".length);
      let displayName = username;
      let createdAt = null;
      try {
        const raw = await env.CONFIGS.get(k.name);
        if (raw) {
          const data = JSON.parse(raw);
          displayName = data.displayName || username;
          createdAt = typeof data.createdAt === "number" ? data.createdAt : null;
        }
      } catch {
        // fall back to the raw username slug above
      }
      // Best-effort -- see touchCreatorLastSeen's own comment. An account
      // that predates this feature, or simply hasn't made an authenticated
      // request since it shipped, just shows as "\u2014" below rather than
      // a wrong or misleading date.
      let lastActive = null;
      try {
        const lastRaw = await env.CONFIGS.get(`creatorlastseen:${username}`);
        lastActive = lastRaw ? parseInt(lastRaw, 10) || null : null;
      } catch {
        // non-critical
      }
      return { username, displayName, createdAt, lastActive };
    })
  );
  creatorAccounts.sort((a, b) => (b.lastActive || b.createdAt || 0) - (a.lastActive || a.createdAt || 0));
  const accountRows = creatorAccounts
    .map(
      (c) =>
        `<tr><td>${escapeHtmlServer(c.displayName)}</td><td>${escapeHtmlServer(c.username)}</td>` +
        `<td>${c.createdAt ? easternDateKey(new Date(c.createdAt)) : "\u2014"}</td>` +
        `<td>${c.lastActive ? easternDateKey(new Date(c.lastActive)) : "\u2014"}</td></tr>`
    )
    .join("");
  const truncatedNote = creatorResult.list_complete === false ? " (showing the first 1000)" : "";

  // Each key is stats:sourcegroup:{group}:total -- strip both ends to get
  // the group name back. ":total" is a fixed suffix here (see bumpStatBy's
  // total-only design above), so a plain slice is enough, no need to guard
  // against a stray per-day key existing alongside it the way
  // loadStatsByDay has to for pageviews/installs.
  const sourceGroupPrefix = "stats:sourcegroup:";
  const sourceGroups = await Promise.all(
    sourceGroupResult.keys.map(async (k) => {
      const group = k.name.slice(sourceGroupPrefix.length, -":total".length);
      const raw = await env.CONFIGS.get(k.name);
      return { group, count: parseInt(raw, 10) || 0 };
    })
  );
  sourceGroups.sort((a, b) => b.count - a.count);
  const sourceGroupTotal = sourceGroups.reduce((sum, g) => sum + g.count, 0);
  const sourceGroupRows = sourceGroups
    .map((g) => {
      const pct = sourceGroupTotal ? Math.round((g.count / sourceGroupTotal) * 100) : 0;
      return `<tr><td>${escapeHtmlServer(g.group)}</td><td>${g.count}</td><td>${pct}%</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin \u2014 My Lists Addon</title>
<style>
  body { background:#F2F2F7; color:#1C1C1E; font-family:'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif; max-width:900px; margin:0 auto; padding:24px 16px; }
  h1 { margin-bottom:4px; }
  h2 { font-size:1.1rem; }
  .stat-cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:14px; margin:20px 0; }
  .stat-card { background:#FFFFFF; border:1px solid rgba(0,0,0,0.08); border-radius:14px; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .stat-value { font-size:2rem; font-weight:700; }
  .stat-label { color:#8E8E93; font-size:0.9rem; margin-top:4px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; background:#FFFFFF; border:1px solid rgba(0,0,0,0.08); border-radius:14px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid rgba(0,0,0,0.08); font-size:0.9rem; }
  th { color:#8E8E93; font-weight:600; }
  a { color:#007AFF; }
  .admin-tab-bar { display:flex; gap:8px; border-bottom:1px solid rgba(0,0,0,0.08); margin-top:24px; }
  .admin-tab-btn {
    background:none; border:none; color:#8E8E93; font-size:0.95rem; font-weight:600; cursor:pointer;
    padding:10px 4px; margin-bottom:-1px; border-bottom:2px solid transparent;
  }
  .admin-tab-btn.active { color:#1C1C1E; border-bottom-color:#007AFF; }
  .admin-tab-panel { display:none; }
  .admin-tab-panel.active { display:block; }
  .admin-select { padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.15); background:#FFFFFF; font-size:0.9rem; margin-right:8px; }
  .admin-badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:0.75rem; font-weight:700; text-transform:uppercase; }
  .admin-badge.bug { background:rgba(255,59,48,0.12); color:#FF3B30; }
  .admin-badge.improvement { background:rgba(0,122,255,0.12); color:#007AFF; }
  .admin-badge.idea { background:rgba(255,149,0,0.12); color:#FF9500; }
  .admin-badge.other { background:rgba(142,142,147,0.15); color:#636366; }
  .feedback-card { background:#FFFFFF; border:1px solid rgba(0,0,0,0.08); border-radius:14px; padding:14px 16px; margin-top:10px; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .feedback-card.completed { opacity:0.55; }
  .feedback-meta { color:#8E8E93; font-size:0.8rem; margin-top:6px; }
  .feedback-message { margin-top:8px; white-space:pre-wrap; font-size:0.92rem; }
  .netflix-preview-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap:12px; margin-top:10px; }
  .netflix-preview-poster { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:8px; background:#E5E5EA; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
  .netflix-preview-poster-placeholder { width:100%; aspect-ratio:2/3; border-radius:8px; background:#E5E5EA; display:flex; align-items:center; justify-content:center; color:#8E8E93; font-size:0.75rem; text-align:center; padding:6px; box-sizing:border-box; }
  .netflix-preview-title { font-size:0.8rem; margin-top:4px; line-height:1.25; }
  .netflix-preview-year { color:#8E8E93; font-size:0.75rem; }
</style></head>
<body>
  <h1>Admin Dashboard</h1>
  <p style="color:#8E8E93; margin-top:0;">My Lists Addon usage stats.</p>

  <div class="admin-tab-bar" role="tablist">
    <button type="button" class="admin-tab-btn active" data-admin-tab="last30" onclick="switchAdminTab('last30')">Last 30 Days</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="creators" onclick="switchAdminTab('creators')">Creator accounts</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="sources" onclick="switchAdminTab('sources')">Sources people use</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="trending" onclick="switchAdminTab('trending')">Trending Data</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="feedback" onclick="switchAdminTab('feedback')">Feedback</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="apiusage" onclick="switchAdminTab('apiusage')">API Usage</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="netflixpreview" onclick="switchAdminTab('netflixpreview')">Provider Preview</button>
  </div>

  <div class="admin-tab-panel active" data-admin-panel="last30">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${parseInt(totalPV, 10) || 0}</div><div class="stat-label">Total page views</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(todayPV, 10) || 0}</div><div class="stat-label">Page views today</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(totalIN, 10) || 0}</div><div class="stat-label">Total install links generated</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(todayIN, 10) || 0}</div><div class="stat-label">Install links generated today</div></div>
    </div>
    <table>
      <tr><th>Date</th><th>Page views</th><th>Install links</th></tr>
      ${rows.join("")}
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="creators">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${creatorAccounts.length}</div><div class="stat-label">Creator accounts${truncatedNote}</div></div>
    </div>
    <table>
      <tr><th>Display name</th><th>Username</th><th>Created</th><th>Last Active</th></tr>
      ${accountRows || '<tr><td colspan="4">No accounts yet.</td></tr>'}
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="sources">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Counted from each row's group at the moment an install link is generated -- one Custom List and one Channel in the same install still count as one of each, five MDBList Charts rows count as five.</p>
    <table>
      <tr><th>Source</th><th>Count</th><th>Share</th></tr>
      ${sourceGroupRows || '<tr><td colspan="3">No data yet.</td></tr>'}
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="trending">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">How many times each title has been marked watched or added to a list, across everyone using this add-on. Meant to eventually seed this add-on's own trending/popular catalogs once there's enough data.</p>
    <div style="margin:12px 0;">
      <select class="admin-select" id="trendingTypeSelect" onchange="loadTrendingData()">
        <option value="watched">Most Watched</option>
        <option value="list-add">Most Added to Lists</option>
      </select>
      <select class="admin-select" id="trendingWindowSelect" onchange="loadTrendingData()">
        <option value="today">Today</option>
        <option value="7" selected>Last 7 Days</option>
        <option value="30">Last 30 Days</option>
        <option value="90">Last 90 Days</option>
        <option value="alltime">All Time</option>
      </select>
      <select class="admin-select" id="trendingMediaTypeSelect" onchange="loadTrendingData()">
        <option value="">Movies + Shows</option>
        <option value="movie">Movies Only</option>
        <option value="series">Shows Only</option>
      </select>
      <button type="button" class="admin-select" style="cursor:pointer;" id="backfillTrendingBtn" onclick="runBackfillTrending()">Backfill Existing Data</button>
      <span id="backfillTrendingStatus" style="color:#8E8E93; font-size:0.85rem; margin-left:6px;"></span>
    </div>
    <p style="color:#8E8E93; margin:0 0 12px; font-size:0.8rem;">Backfill only adds to the <strong>All Time</strong> window (there's no historical date to bucket existing data into 7/30/90-day windows) -- it seeds counts from Watch History and Custom Lists that already existed before this feature shipped. Safe to run more than once; it only adds, never resets anything. Processes accounts a few at a time, so it may take a minute for larger sites.</p>
    <table>
      <tr><th>#</th><th>Title</th><th>Type</th><th>Count</th></tr>
      <tbody id="trendingTableBody"><tr><td colspan="4">Loading\u2026</td></tr></tbody>
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="feedback">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Bug reports, improvement requests, and ideas submitted from Settings &gt; Feedback, newest first.</p>
    <div class="feedback-card">
      <div style="font-weight:600; margin-bottom:8px;">Log something yourself</div>
      <select class="admin-select" id="newFeedbackCategory" style="margin-bottom:8px;">
        <option value="bug" selected>Bug</option>
        <option value="improvement">Improvement</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>
      <textarea id="newFeedbackMessage" placeholder="What did you find?" style="width:100%; min-height:70px; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.15); font-family:inherit; font-size:0.9rem; resize:vertical;"></textarea>
      <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
        <button type="button" class="admin-select" style="cursor:pointer;" id="newFeedbackSubmitBtn" onclick="submitAdminFeedback()">Add to list</button>
        <span id="newFeedbackStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
      </div>
    </div>
    <div id="feedbackList">Loading\u2026</div>
  </div>

  <!-- Edit Feedback Modal -->
  <div id="editFeedbackModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center; padding:16px;">
    <div style="background:#fff; border-radius:14px; padding:20px; max-width:500px; width:100%; box-shadow:0 4px 20px rgba(0,0,0,0.15);">
      <h3 style="margin:0 0 12px; font-size:1.1rem; color:#001f3f;">Edit Feedback</h3>
      <input type="hidden" id="editFeedbackId">
      <label style="display:block; font-size:0.8rem; font-weight:600; color:#8E8E93; margin-bottom:4px;">Category</label>
      <select class="admin-select" id="editFeedbackCategory" style="margin-bottom:12px; width:100%;">
        <option value="bug">bug</option>
        <option value="improvement">improvement</option>
        <option value="idea">idea</option>
        <option value="other">other</option>
      </select>
      <label style="display:block; font-size:0.8rem; font-weight:600; color:#8E8E93; margin-bottom:4px;">Message</label>
      <textarea id="editFeedbackMessage" style="width:100%; min-height:100px; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.15); font-family:inherit; font-size:0.9rem; resize:vertical; margin-bottom:12px;"></textarea>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" class="admin-select" style="cursor:pointer;" onclick="closeEditFeedbackModal()">Cancel</button>
        <button type="button" class="admin-select" id="editFeedbackSaveBtn" style="cursor:pointer; background:#001f3f; color:#fff;" onclick="saveEditFeedback()">Save Changes</button>
      </div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="apiusage">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Requests made using this Worker's own shared API keys (the fallback used whenever a visitor hasn't supplied their own) -- not counting anyone's personal keys, which only they can rate-limit. Watch these against each provider's limit if catalogs start coming back empty or slow.</p>
    <table>
      <tr><th>Key</th><th>Last 24h</th><th>Last 7 days</th><th>Last 30 days</th><th>Provider limit</th></tr>
      <tbody id="apiUsageTableBody"><tr><td colspan="5">Loading\u2026</td></tr></tbody>
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="netflixpreview">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">A look at what a TMDB-discover-based shelf would actually contain for any streaming provider, before wiring it into Quick Add for real -- pulled live from TMDB, not a saved list. Counts are TMDB/JustWatch's own tracking, not the provider's real numbers, and typically run a bit under what trackers like FlixPatrol report.</p>

    <div class="panel" style="margin:0 0 18px; padding:14px 16px;">
      <div style="font-weight:600; font-size:0.9rem; margin-bottom:8px;">Find a provider's id</div>
      <p style="color:#8E8E93; margin:0 0 10px; font-size:0.82rem;">TMDB sometimes has more than one entry for the same service (e.g. two separate "Disney Plus" ids) -- look the name up here rather than guessing, since a wrong id fails silently: it just quietly shows the wrong catalog under the right label.</p>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="text" id="providerLookupQueryInput" class="admin-select" style="margin-right:0; flex:1; max-width:220px;" placeholder="e.g. disney, max, hulu" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupProviderIds();}">
        <button type="button" class="secondary lc-btn" onclick="lookupProviderIds()">Search</button>
        <span id="providerLookupStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
      </div>
      <div id="providerLookupResults" style="margin-top:10px;"></div>
    </div>

    <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
      <label style="font-size:0.85rem; color:#8E8E93;">Provider id
        <input type="text" id="netflixPreviewProviderIdInput" class="admin-select" style="margin-right:0; width:60px;" value="8" placeholder="8">
      </label>
      <label style="font-size:0.85rem; color:#8E8E93;">Region
        <input type="text" id="netflixPreviewRegionInput" class="admin-select" style="margin-right:0; width:70px; text-transform:uppercase;" value="US" maxlength="2" placeholder="US">
      </label>
      <button type="button" class="secondary lc-btn" onclick="loadNetflixPreview()">Load Preview</button>
      <span id="netflixPreviewStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
    </div>
    <div id="netflixPreviewMovies"></div>
    <div id="netflixPreviewShows" style="margin-top:28px;"></div>
  </div>

  <p style="margin-top:24px;"><a href="/admin/logout">Log out</a></p>
  <script>
    function switchAdminTab(tabId) {
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminTab === tabId));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.adminPanel === tabId));
      if (tabId === 'trending' && !window._trendingLoadedOnce) { window._trendingLoadedOnce = true; loadTrendingData(); }
      if (tabId === 'feedback' && !window._feedbackLoadedOnce) { window._feedbackLoadedOnce = true; loadFeedback(); }
      if (tabId === 'apiusage' && !window._apiUsageLoadedOnce) { window._apiUsageLoadedOnce = true; loadApiUsage(); }
      if (tabId === 'netflixpreview' && !window._netflixPreviewLoadedOnce) { window._netflixPreviewLoadedOnce = true; loadNetflixPreview(); }
    }

    function escapeHtmlAdmin(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadTrendingData() {
      const body = document.getElementById('trendingTableBody');
      body.innerHTML = '<tr><td colspan="4">Loading\u2026</td></tr>';
      const type = document.getElementById('trendingTypeSelect').value;
      const win = document.getElementById('trendingWindowSelect').value;
      const mediaType = document.getElementById('trendingMediaTypeSelect').value;
      try {
        const res = await fetch('/admin/api/leaderboard?type=' + encodeURIComponent(type) + '&window=' + encodeURIComponent(win) + (mediaType ? '&mediaType=' + encodeURIComponent(mediaType) : ''));
        const data = await res.json();
        if (!data.ok || !data.entries || !data.entries.length) {
          body.innerHTML = '<tr><td colspan="4">No data yet for this window.</td></tr>';
          return;
        }
        body.innerHTML = data.entries.map((e, i) =>
          '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(e.title || e.id) + '</td><td>' + escapeHtmlAdmin(e.mediaType === 'series' ? 'Show' : 'Movie') + '</td><td>' + e.count + '</td></tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="4">Could not load -- try again.</td></tr>';
      }
    }

    async function runBackfillTrending() {
      const btn = document.getElementById('backfillTrendingBtn');
      const status = document.getElementById('backfillTrendingStatus');
      btn.disabled = true;
      let accountsDone = 0;
      let titlesDone = 0;
      let safetyCounter = 0;
      // safetyCounter guards against an unexpected infinite loop (e.g. a
      // bug that never returns done:true) -- 500 calls is comfortably
      // past what any realistic account count needs right now, and this
      // is a manual, admin-triggered action, not something that runs
      // unattended.
      try {
        while (safetyCounter < 500) {
          safetyCounter++;
          const res = await fetch('/admin/api/backfill-trending', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ')';
            break;
          }
          if (data.done) {
            status.textContent = 'Done \u2014 processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ', ' + titlesDone + ' title update' + (titlesDone === 1 ? '' : 's') + '.';
            break;
          }
          accountsDone += data.accountsThisCall || 0;
          titlesDone += data.titlesThisCall || 0;
          status.textContent = 'Working\u2026 ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ' processed so far.';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (processed ' + accountsDone + ' accounts).';
      }
      btn.disabled = false;
      loadTrendingData();
    }

    async function loadApiUsage() {
      const body = document.getElementById('apiUsageTableBody');
      body.innerHTML = '<tr><td colspan="5">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/apiusage');
        const data = await res.json();
        if (!data.ok || !data.keys || !data.keys.length) {
          body.innerHTML = '<tr><td colspan="5">No data yet.</td></tr>';
          return;
        }
        body.innerHTML = data.keys.map((k) =>
          '<tr>' +
            '<td>' + escapeHtmlAdmin(k.label) + (k.configured ? '' : ' <span style="color:#FF9500;">(not set)</span>') + '</td>' +
            '<td>' + k.last24h + '</td>' +
            '<td>' + k.last7d + '</td>' +
            '<td>' + k.last30d + '</td>' +
            '<td style="color:#8E8E93;">' + escapeHtmlAdmin(k.limit) + '</td>' +
          '</tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="5">Could not load -- try again.</td></tr>';
      }
    }

    function netflixPreviewSectionHtml(label, section) {
      if (!section) return '';
      const posters = section.items.map((it) =>
        '<div>' +
          (it.poster
            ? '<img class="netflix-preview-poster" src="' + escapeHtmlAdmin(it.poster) + '" alt="" loading="lazy">'
            : '<div class="netflix-preview-poster-placeholder">No poster</div>') +
          '<div class="netflix-preview-title">' + escapeHtmlAdmin(it.title) + '</div>' +
          (it.date ? '<div class="netflix-preview-year">' + escapeHtmlAdmin(it.date) + '</div>' : '') +
        '</div>'
      ).join('');
      return '<h3 style="margin:0 0 4px; font-size:1.05rem;">' + label + ' <span style="color:#8E8E93; font-weight:400; font-size:0.85rem;">(~' + section.total.toLocaleString() + ' total on TMDB/JustWatch, showing first ' + section.items.length + ')</span></h3>' +
        '<div class="netflix-preview-grid">' + posters + '</div>';
    }

    async function loadNetflixPreview() {
      const statusEl = document.getElementById('netflixPreviewStatus');
      const moviesEl = document.getElementById('netflixPreviewMovies');
      const showsEl = document.getElementById('netflixPreviewShows');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const providerIdInput = document.getElementById('netflixPreviewProviderIdInput');
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      const providerId = (providerIdInput.value || '8').trim() || '8';
      statusEl.textContent = 'Loading\u2026';
      moviesEl.innerHTML = '';
      showsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/netflix-preview?region=' + encodeURIComponent(region) + '&providerId=' + encodeURIComponent(providerId));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load preview.';
          return;
        }
        statusEl.textContent = '';
        moviesEl.innerHTML = netflixPreviewSectionHtml('Movies', data.movies);
        showsEl.innerHTML = netflixPreviewSectionHtml('Shows', data.shows);
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    // Fills the Provider id field from a lookup result and immediately
    // reloads the preview with it -- clicking a name found this way should
    // just show that provider's shelf, not require a second manual click.
    function pickProviderId(id) {
      document.getElementById('netflixPreviewProviderIdInput').value = id;
      loadNetflixPreview();
    }

    async function lookupProviderIds() {
      const statusEl = document.getElementById('providerLookupStatus');
      const resultsEl = document.getElementById('providerLookupResults');
      const queryInput = document.getElementById('providerLookupQueryInput');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const query = (queryInput.value || '').trim();
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      statusEl.textContent = 'Searching\u2026';
      resultsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/provider-lookup?region=' + encodeURIComponent(region) + (query ? '&query=' + encodeURIComponent(query) : ''));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not search.';
          return;
        }
        statusEl.textContent = '';
        if (!data.results.length) {
          resultsEl.innerHTML = '<p style="color:#8E8E93; font-size:0.85rem;">No matches.</p>';
          return;
        }
        resultsEl.innerHTML = data.results.map((p) =>
          '<button type="button" class="admin-select" style="cursor:pointer; margin:0 6px 6px 0;" onclick="pickProviderId(' + p.id + ')">' +
            escapeHtmlAdmin(p.name) + ' <span style="color:#8E8E93;">(' + p.id + ')</span>' +
          '</button>'
        ).join('');
      } catch (e) {
        statusEl.textContent = 'Could not search -- check your connection.';
      }
    }

    // feedbackEntries is the client's local copy of the list, kept in sync
    // with the server -- submitAdminFeedback and toggleFeedbackStatus both
    // mutate this array and re-render immediately (optimistic), then send
    // the real change to the server in the background, only reaching back
    // into the DOM again if that background call fails and the local
    // change needs to be rolled back.
    let feedbackEntries = [];
    let feedbackTruncated = false;

    async function loadFeedback() {
      const box = document.getElementById('feedbackList');
      box.textContent = 'Loading\u2026';
      try {
        const res = await fetch('/admin/api/feedback');
        const data = await res.json();
        if (!data.ok) {
          box.innerHTML = '<p style="color:#FF3B30;">Could not load feedback -- try again.</p>';
          return;
        }
        feedbackEntries = data.entries || [];
        feedbackTruncated = !!data.truncated;
        renderFeedbackList();
      } catch (e) {
        box.innerHTML = '<p style="color:#FF3B30;">Could not load feedback -- try again.</p>';
      }
    }

    // Pure render of whatever's currently in feedbackEntries -- called
    // after the initial load, and again (instantly, no fetch) any time
    // submitAdminFeedback/toggleFeedbackStatus change that array so the
    // list reflects the change right away instead of waiting on a round
    // trip back to the server.
    function renderFeedbackList() {
      const box = document.getElementById('feedbackList');
      if (!feedbackEntries.length) {
        box.innerHTML = '<p style="color:#8E8E93;">No feedback yet.</p>';
        return;
      }
      // Open (not completed) first, newest within each group -- the
      // fetch itself already comes back newest-first, and new entries are
      // unshifted onto the front locally, so this only needs to separate
      // the two groups without disturbing that order.
      const open = feedbackEntries.filter((f) => !f.completed);
      const done = feedbackEntries.filter((f) => f.completed);
      box.innerHTML = open.map(feedbackCardHtml).join('') +
        (done.length ? '<h3 style="margin:20px 0 4px; font-size:0.95rem; color:#8E8E93;">Completed</h3>' + done.map(feedbackCardHtml).join('') : '') +
        (feedbackTruncated ? '<p style="color:#8E8E93; font-size:0.85rem;">Showing the most recent 300.</p>' : '');
    }

    function feedbackCardHtml(f) {
      const cat = ['bug', 'improvement', 'idea', 'other'].includes(f.category) ? f.category : 'other';
      const when = f.createdAt ? new Date(f.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '';
      const who = f.creatorName ? escapeHtmlAdmin(f.creatorName) : 'anonymous';
      const contact = f.contact ? ' \u2014 ' + escapeHtmlAdmin(f.contact) : '';
      const completed = !!f.completed;
      return '<div class="feedback-card' + (completed ? ' completed' : '') + '" id="feedbackCard_' + escapeHtmlAdmin(f.id) + '">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">' +
          '<span class="admin-badge ' + cat + '">' + cat + '</span>' +
          '<div style="display:flex; gap:6px;">' +
            '<button type="button" class="admin-select" style="margin:0; cursor:pointer;" onclick="openEditFeedbackModal(' + escapeHtmlAdmin(JSON.stringify(f.id)) + ')">&#x270E; Edit</button>' +
            '<button type="button" class="admin-select" style="margin:0; cursor:pointer;" onclick="toggleFeedbackStatus(' + escapeHtmlAdmin(JSON.stringify(f.id)) + ', ' + !completed + ')">' +
              (completed ? '\u21a9 Mark not completed' : '\u2713 Mark completed') +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="feedback-message">' + escapeHtmlAdmin(f.message) + '</div>' +
        '<div class="feedback-meta">' + when + ' \u2014 ' + who + contact + '</div>' +
        '</div>';
    }

    // Lets the admin log an issue directly from the dashboard, without
    // going through Settings > Feedback -- posts to the same /api/feedback
    // endpoint real users hit, just tagged so it's obviously self-logged
    // in the list below. Optimistic: the card appears the instant this
    // function runs, built from a temporary client-side id, and is
    // swapped for the server's real entry once the save actually
    // completes (or removed again if it fails).
    async function submitAdminFeedback() {
      const category = document.getElementById('newFeedbackCategory').value;
      const messageBox = document.getElementById('newFeedbackMessage');
      const message = messageBox.value.trim();
      const status = document.getElementById('newFeedbackStatus');
      const btn = document.getElementById('newFeedbackSubmitBtn');
      if (!message) {
        status.textContent = 'Type something first.';
        return;
      }
      btn.disabled = true;

      const tempId = 'temp:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const optimisticEntry = {
        id: tempId,
        category: category,
        message: message,
        contact: null,
        creatorName: 'admin',
        createdAt: Date.now(),
        completed: false,
      };
      feedbackEntries.unshift(optimisticEntry);
      renderFeedbackList();
      messageBox.value = '';
      status.textContent = 'Saving\u2026';

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: category, message: message, creatorName: 'admin' }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
          renderFeedbackList();
          messageBox.value = message;
          status.textContent = (data && data.error) || 'Could not save -- try again.';
          btn.disabled = false;
          return;
        }
        // Swap the temp id for the server's real one -- otherwise a Mark
        // Completed click on this card would send an id the server has
        // never heard of.
        if (data.entry && data.entry.id) {
          const idx = feedbackEntries.findIndex((f) => f.id === tempId);
          if (idx !== -1) {
            feedbackEntries[idx] = data.entry;
            renderFeedbackList();
          }
        }
        status.textContent = 'Added.';
      } catch (e) {
        feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
        renderFeedbackList();
        messageBox.value = message;
        status.textContent = 'Could not save -- check your connection.';
      }
      btn.disabled = false;
    }

    // Optimistic: flips the entry's completed flag (and re-renders,
    // moving the card between the Open/Completed groups) the instant
    // it's clicked, then sends the real change to the server in the
    // background. Rolled back to whatever the server still actually has
    // if that background call fails.
    async function toggleFeedbackStatus(id, completed) {
      const idx = feedbackEntries.findIndex((f) => f.id === id);
      if (idx === -1) return;
      const previousCompleted = feedbackEntries[idx].completed;
      feedbackEntries[idx] = Object.assign({}, feedbackEntries[idx], { completed: completed });
      renderFeedbackList();
      try {
        const res = await fetch('/admin/api/feedback/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, completed: completed }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
          if (stillIdx !== -1) {
            feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
            renderFeedbackList();
          }
          alert((data && data.error) || 'Could not update -- try again.');
          return;
        }
      } catch (e) {
        const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
        if (stillIdx !== -1) {
          feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
          renderFeedbackList();
        }
        alert('Could not update -- check your connection.');
      }
    }

    function openEditFeedbackModal(id) {
      const entry = feedbackEntries.find((f) => f.id === id);
      if (!entry) return;
      document.getElementById('editFeedbackId').value = entry.id;
      document.getElementById('editFeedbackCategory').value = entry.category || 'other';
      document.getElementById('editFeedbackMessage').value = entry.message || '';
      document.getElementById('editFeedbackSaveBtn').disabled = false;
      document.getElementById('editFeedbackSaveBtn').textContent = 'Save Changes';
      document.getElementById('editFeedbackModal').style.display = 'flex';
    }

    function closeEditFeedbackModal() {
      document.getElementById('editFeedbackModal').style.display = 'none';
    }

    async function saveEditFeedback() {
      const id = document.getElementById('editFeedbackId').value;
      const category = document.getElementById('editFeedbackCategory').value;
      const message = document.getElementById('editFeedbackMessage').value.trim();
      const saveBtn = document.getElementById('editFeedbackSaveBtn');
      if (!message) {
        alert('Please enter a message.');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      try {
        const res = await fetch('/admin/api/feedback/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, category, message }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          alert((data && data.error) || 'Could not save feedback edits.');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
          return;
        }
        const idx = feedbackEntries.findIndex((f) => f.id === id);
        if (idx !== -1 && data.entry) {
          feedbackEntries[idx] = data.entry;
          renderFeedbackList();
        }
        closeEditFeedbackModal();
      } catch (err) {
        alert('Network error while saving feedback edits.');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }
  </script>
</body></html>`;
}

// generateShortId() always produces a 12-character id; legacy base64
// configs are virtually always much longer than that (even a single list's
// JSON encodes to well over 100 characters), so length alone reliably
// tells the two apart without needing a prefix.
