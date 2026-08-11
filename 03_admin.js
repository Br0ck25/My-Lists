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
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin \u2014 My Lists Addon</title>
<style>
  body { background:#060b16; color:#f1f2f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:380px; margin:80px auto; padding:24px 16px; }
  .card { background:rgba(255,255,255,0.045); border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:24px; }
  h1 { margin-top:0; font-size:1.25rem; }
  input { width:100%; padding:12px 14px; border-radius:10px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.06); color:#f1f2f5; font-size:16px; box-sizing:border-box; }
  button { width:100%; margin-top:12px; padding:12px 16px; border-radius:10px; border:none; background:#0066f7; color:#fff; font-size:1rem; cursor:pointer; }
  .err { color:#ffb0b8; margin-top:12px; font-size:0.9rem; }
</style></head>
<body>
  <div class="card">
    <h1>Admin sign in</h1>
    <form method="POST" action="/admin/login">
      <input type="password" name="key" placeholder="Admin key" autofocus>
      <button type="submit">Sign in</button>
    </form>
    ${errorMsg ? `<p class="err">${escapeHtmlServer(errorMsg)}</p>` : ""}
  </div>
</body></html>`;
}

async function renderAdminDashboard(env) {
  if (!env || !env.CONFIGS) {
    return `<!DOCTYPE html><html><body style="background:#060b16;color:#f1f2f5;font-family:sans-serif;padding:40px;">This Worker has no CONFIGS KV namespace bound, so there's no stats to show.</body></html>`;
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
      return { username, displayName, createdAt };
    })
  );
  creatorAccounts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const accountRows = creatorAccounts
    .map(
      (c) =>
        `<tr><td>${escapeHtmlServer(c.displayName)}</td><td>${escapeHtmlServer(c.username)}</td>` +
        `<td>${c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "\u2014"}</td></tr>`
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
  body { background:#060b16; color:#f1f2f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:900px; margin:0 auto; padding:24px 16px; }
  h1 { margin-bottom:4px; }
  h2 { font-size:1.1rem; }
  .stat-cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:14px; margin:20px 0; }
  .stat-card { background:rgba(255,255,255,0.045); border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:18px; }
  .stat-value { font-size:2rem; font-weight:700; }
  .stat-label { color:#8d9099; font-size:0.9rem; margin-top:4px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.08); font-size:0.9rem; }
  th { color:#8d9099; font-weight:600; }
  a { color:#4d9fff; }
  .admin-tab-bar { display:flex; gap:8px; border-bottom:1px solid rgba(255,255,255,0.1); margin-top:24px; }
  .admin-tab-btn {
    background:none; border:none; color:#8d9099; font-size:0.95rem; font-weight:600; cursor:pointer;
    padding:10px 4px; margin-bottom:-1px; border-bottom:2px solid transparent;
  }
  .admin-tab-btn.active { color:#f1f2f5; border-bottom-color:#0066f7; }
  .admin-tab-panel { display:none; }
  .admin-tab-panel.active { display:block; }
</style></head>
<body>
  <h1>Admin Dashboard</h1>
  <p style="color:#8d9099; margin-top:0;">My Lists Addon usage stats.</p>

  <div class="admin-tab-bar" role="tablist">
    <button type="button" class="admin-tab-btn active" data-admin-tab="last30" onclick="switchAdminTab('last30')">Last 30 Days</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="creators" onclick="switchAdminTab('creators')">Creator accounts</button>
    <button type="button" class="admin-tab-btn" data-admin-tab="sources" onclick="switchAdminTab('sources')">Sources people use</button>
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
      <tr><th>Display name</th><th>Username</th><th>Created</th></tr>
      ${accountRows || '<tr><td colspan="3">No accounts yet.</td></tr>'}
    </table>
  </div>

  <div class="admin-tab-panel" data-admin-panel="sources">
    <p style="color:#8d9099; margin-top:0; font-size:0.9rem;">Counted from each row's group at the moment an install link is generated -- one Custom List and one Channel in the same install still count as one of each, five MDBList Charts rows count as five.</p>
    <table>
      <tr><th>Source</th><th>Count</th><th>Share</th></tr>
      ${sourceGroupRows || '<tr><td colspan="3">No data yet.</td></tr>'}
    </table>
  </div>

  <p style="margin-top:24px;"><a href="/admin/logout">Log out</a></p>
  <script>
    function switchAdminTab(tabId) {
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminTab === tabId));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.adminPanel === tabId));
    }
  </script>
</body></html>`;
}

// generateShortId() always produces a 12-character id; legacy base64
// configs are virtually always much longer than that (even a single list's
// JSON encodes to well over 100 characters), so length alone reliably
// tells the two apart without needing a prefix.
