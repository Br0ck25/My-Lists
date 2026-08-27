function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// --- security headers ----------------------------------------------------
//
// Applied once, globally, at the very edge of the fetch handler (see the
// export default wrapper at the bottom of 26_api-creator-and-admin-routes.js)
// rather than threaded through every individual `new Response(...)` call
// site across the router -- there are dozens of those (HTML pages, JSON via
// json(), the icon, generated SVGs, the manifest, /sw.js...), so wrapping
// the single point everything already funnels back through is far less
// risky than editing each one and keeps this from silently missing a
// future route. `if (!headers.has(...))` guards mean a route that already
// set a more specific value for one of these (none do today) would still
// win, rather than this clobbering it.
//
// CSP is deliberately not the strict, script-src-locked-down kind: this
// app relies on plenty of inline <script> blocks and inline onclick=/
// onchange= handlers throughout the builder/admin pages (see the
// verification pipeline's own "onclick/onchange handler resolution check"
// step), which only work with 'unsafe-inline' on script-src. Tightening
// that further would mean a nonce- or hash-based rewrite of every inline
// handler -- a real project of its own, not a header tweak. What this CSP
// still buys, even with 'unsafe-inline' allowed: no loading of scripts/
// styles/fonts from any origin except the ones this app actually uses
// (jsDelivr for fflate, Google Fonts, YouTube for trailer embeds), no
// <object>/<embed> plugins, no <base> tag hijacking, and (via
// frame-ancestors) this site can't be iframed by someone else's page for
// a clickjacking attempt.
function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' https: data:",
      "connect-src 'self' https:",
      "frame-src https://www.youtube.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  };
}

// Wraps a Response with the headers above, without disturbing anything the
// route handler already set (status, statusText, body, its own headers
// like Content-Type/Cache-Control/CORS) -- see securityHeaders' own
// comment for why this is applied here, once, rather than at each call
// site.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  const extra = securityHeaders();
  for (const key in extra) {
    if (!headers.has(key)) headers.set(key, extra[key]);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePkcePair() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncodeBytes(randomBytes);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncodeBytes(new Uint8Array(digest));
  return { verifier, challenge };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "max-age=3600",
      ...corsHeaders(),
      // Applied last so a caller (e.g. the admin dashboard's own JSON
      // endpoints -- see their own comment on why they need this) can
      // override the max-age default above, rather than every non-admin
      // call site needing to keep repeating the default just to get it.
      ...extraHeaders,
    },
  });
}

// Detect whether a request is a top-level browser page load (someone tapping
// "Configure" and being sent to the manifest URL) vs. a JSON fetch by wako/
// Stremio itself. We check two independent signals and trust either one:
//  - Sec-Fetch-Mode: "navigate" is sent by real browser navigations and is
//    essentially never sent by app HTTP clients.
//  - Accept header preferring text/html over application/json is what a
//    browser sends when loading a URL directly; JSON clients typically send
//    "application/json" or "*/*".
function isBrowserNavigation(request) {
  // Sec-Fetch-Mode: "navigate" is sent by real top-level browser navigations
  // (e.g. someone tapping "Configure" and being sent straight to the
  // manifest URL) and is essentially never sent by wako/Stremio's own HTTP
  // clients when they fetch the manifest/catalog as data.
  //
  // We previously also inspected the Accept header (preferring text/html
  // over application/json) as a second signal, but that turned out to be
  // unreliable in practice: some app HTTP clients — notably wako's
  // webview-based client — send a browser-style Accept header even on
  // plain background data fetches. That caused wako's manifest/catalog
  // requests to be misidentified as browser navigations and redirected to
  // the HTML configure page instead of receiving JSON, silently breaking
  // installs/catalogs in wako while Stremio (whose client doesn't trigger
  // the false positive) kept working. Sec-Fetch-Mode alone is a much more
  // trustworthy signal, so we rely on it exclusively now.
  return request.headers.get("Sec-Fetch-Mode") === "navigate";
}

// --- config encoding -------------------------------------------------

// --- Deterministic 24-Hour Daily Randomizer --------------------------------
function getDailySeed(salt = "") {
  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  let hash = 0;
  const str = `${dayBucket}:${salt}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) || 1;
}

function pseudoRandom(seed) {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function deterministicDailyShuffle(array, salt = "") {
  if (!Array.isArray(array) || array.length <= 1) return array;
  let seed = getDailySeed(salt);
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const rnd = pseudoRandom(seed++);
    const j = Math.floor(rnd * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

// entries: [{ id, name, type: 'movie'|'series', url }]
//
// Config is normally { entries, tmdbKey, mdblistKey } but older install
// links encode a bare entries array — those still decode fine, just with
// no personal keys attached.
function decodeConfig(config) {
  const empty = { entries: [], tmdbKey: "", mdblistKey: "", mdblistAccessToken: "", traktKey: "", traktUsername: "", traktAccessToken: "", simklKey: "", simklAccessToken: "", track: false, trackCreatorName: "", trackCreatorKey: "", shuffleShelves: false, shuffleItems: false, region: "US", hideNonDigitalReleases: false };
  try {
    const b64 = config.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const jsonStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(jsonStr);

    const rawEntries = Array.isArray(parsed) ? parsed : parsed.entries;
    const entries = Array.isArray(rawEntries)
      ? rawEntries
          .filter((e) => e && e.id && e.url && e.type)
          .map((e) => ({ ...e, enabled: e.enabled !== false }))
      : [];

    return {
      entries,
      tmdbKey: (!Array.isArray(parsed) && parsed.tmdbKey) || "",
      mdblistKey: (!Array.isArray(parsed) && parsed.mdblistKey) || "",
      mdblistAccessToken: (!Array.isArray(parsed) && parsed.mdblistAccessToken) || "",
      traktKey: (!Array.isArray(parsed) && parsed.traktKey) || "",
      traktUsername: (!Array.isArray(parsed) && parsed.traktUsername) || "",
      traktAccessToken: (!Array.isArray(parsed) && parsed.traktAccessToken) || "",
      simklKey: (!Array.isArray(parsed) && parsed.simklKey) || "",
      simklAccessToken: (!Array.isArray(parsed) && parsed.simklAccessToken) || "",
      track: !!(!Array.isArray(parsed) && parsed.track),
      trackCreatorName: (!Array.isArray(parsed) && parsed.trackCreatorName) || "",
      trackCreatorKey: (!Array.isArray(parsed) && parsed.trackCreatorKey) || "",
      shuffleShelves: !!(!Array.isArray(parsed) && parsed.shuffleShelves),
      shuffleItems: !!(!Array.isArray(parsed) && parsed.shuffleItems),
      // Two-letter watch_region for streaming-availability catalogs
      // (provider charts, Stream Releases) and content ratings -- see
      // 07_source-fetchers-tmdb-simkl.js's tmdbProviderChartPaths and
      // fetchTmdbItemDetailsUncached for where this actually gets used.
      // Defaults to US so every install predating this feature keeps
      // behaving exactly as it always did.
      region: (!Array.isArray(parsed) && parsed.region) || "US",
      // Filters items with no known digital release (movie charts only,
      // see fetchTmdbChart's own comment for why) out of TMDB Trending/
      // Popular movie catalogs. Defaults to false so every install
      // predating this feature keeps showing everything, same reasoning
      // as region's own default above.
      hideNonDigitalReleases: !!(!Array.isArray(parsed) && parsed.hideNonDigitalReleases),
    };
  } catch {
    return empty;
  }
}

// --- short-link config storage (Workers KV) ------------------------------
//
// Install URLs used to bake the *entire* list config (every list's name,
// URL, type, plus the personal MDBList key) as base64 directly into the
// manifest URL. That works fine for a handful of lists, but the URL grows
// with every list added — past roughly 20 lists it's long enough to hit
// URL-length limits some apps enforce on installed add-on URLs (wako
// included), so the add-on silently stops working beyond that point even
// though nothing in the wako/Stremio protocol itself limits catalog count.
//
// If a CONFIGS KV namespace is bound (see wrangler.toml), the config is now
// stored server-side under a short random id, and only that id goes in the
// URL — so the install link stays a fixed, short length no matter how many
// lists someone adds. If no KV namespace is bound, everything falls back to
// the old self-contained-URL behavior below, so this is purely additive and
// won't break existing installs either way.
function generateShortId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Creator Profile: crypto + validation -------------------------------------
//
// bcrypt itself isn't available in the Workers runtime, but PBKDF2 via the
// standard Web Crypto API (crypto.subtle, built in) is a well-established,
// equally-accepted choice for this exact job -- a per-credential random
// salt plus a deliberately slow, iterated hash. The Creator Key itself is
// never stored anywhere, only this hash.
function bufferToHex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
// Constant-time-ish comparison -- guards against a timing attack revealing
// how many leading hex characters matched, which a plain === wouldn't.
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const PBKDF2_ITERATIONS = 100000;

async function hashCreatorKey(key) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${bufferToHex(salt)}:${bufferToHex(new Uint8Array(derivedBits))}`;
}

async function verifyCreatorKey(key, storedHash) {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = hexToBuffer(parts[2]);
  const expectedHex = parts[3];
  try {
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), "PBKDF2", false, ["deriveBits"]);
    const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
    return timingSafeEqualHex(bufferToHex(new Uint8Array(derivedBits)), expectedHex);
  } catch {
    return false;
  }
}

// MYL-XXXX-XXXX-XXXX -- excludes visually-ambiguous characters (0/O, 1/I/L)
// so a key someone's reading off a screen to type into another device
// doesn't turn into a guessing game. 12 real characters from a 32-symbol
// alphabet is ~60 bits of entropy, comfortably infeasible to brute-force
// especially combined with the rate limit on the restore endpoint.
function generateCreatorKey() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const randBytes = crypto.getRandomValues(new Uint8Array(12));
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let chars = "";
    for (let i = 0; i < 4; i++) chars += alphabet[randBytes[g * 4 + i] % alphabet.length];
    groups.push(chars);
  }
  return "MYL-" + groups.join("-");
}

// "user" is reserved because that's the literal namespace anonymous
// (unclaimed) published lists already live under (see /api/publish-list) --
// a creator registering it would collide with every anonymous list ever
// published. The rest of this list is the impersonation/confusion set from
// the spec.
const RESERVED_CREATOR_USERNAMES = new Set([
  "user", "admin", "support", "official", "system", "root", "staff", "help",
  "developer", "team", "api", "owner", "contact", "stremio", "trakt", "simkl",
  "tmdb", "imdb", "mdblist", "letterboxd", "netflix", "prime", "disney", "apple",
  "hulu", "hbo",
]);

function validateCreatorUsername(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 25) {
    return { ok: false, error: "Creator name must be between 3 and 25 characters." };
  }
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return { ok: false, error: "Creator names can only contain letters, numbers, hyphens, and underscores." };
  }
  if (RESERVED_CREATOR_USERNAMES.has(normalized)) {
    return { ok: false, error: "That username is reserved." };
  }
  if (normalized.includes("mylists") || normalized.includes("mylistsaddon")) {
    return { ok: false, error: "That username isn't allowed." };
  }
  return { ok: true, normalized };
}

// Server-side counterpart to the client-side slugify() inside the builder
// page's own script (that one only runs in the browser) -- used for
// turning a publish-a-list list-name into the URL-safe slug segment
// /lists/:username/:listname resolves against, for both the anonymous
// publish path and Creator-owned lists.
function slugifyServer(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function deslugifyServer(s) {
  return String(s || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Server-side HTML escaping for the public /lists/:username/:listname page
// below -- list names and Creator display names are user-supplied text
// (a Creator Name isn't restricted to the same [a-z0-9_-] set its
// normalized/slugified username is, see validateCreatorUsername) getting
// interpolated straight into that page's raw HTML, so this needs its own
// escape rather than relying on the client-side escapeHtml() that only
// exists inside the browser-side builder script.
function escapeHtmlServer(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Turns an arbitrary string (an external list's URL, for
// /api/lists/like-external) into a short, stable, filesystem/KV-key-safe
// hex string -- external URLs can contain characters KV keys would rather
// not have verbatim, and this also keeps every key a fixed, short length
// regardless of how long the original URL was. SHA-256 via the Workers
// runtime's native Web Crypto API (no extra dependency); truncated to 32
// hex chars (128 bits) since this only needs to avoid collisions among
// this add-on's own liked lists, not serve as a cryptographic digest.
async function hashStringForKey(s) {
  const data = new TextEncoder().encode(String(s || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// --- Per-User Cache & Circuit Breaker Shield ---------------------------------
// Safe in-memory LRU cache with rolling window and Stale-If-Error degradation.
// Ensures bearer-authenticated user data is safely isolated and never leaks between users.
const PER_USER_CACHE_MAP = new Map();
const PER_USER_CACHE_MAX_ENTRIES = 1000;

function safeUserHash(token = "", username = "") {
  const input = `${token}:${username}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) || 1).toString(36);
}

function getPerUserCache(key) {
  if (!key) return null;
  const entry = PER_USER_CACHE_MAP.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now <= entry.freshUntil) {
    return { data: entry.data, isFresh: true, isStale: false };
  }
  if (now <= entry.staleUntil) {
    return { data: entry.data, isFresh: false, isStale: true };
  }
  PER_USER_CACHE_MAP.delete(key);
  return null;
}

function setPerUserCache(key, data, freshTtlSec = 60, staleTtlSec = 1800) {
  if (!key || data === undefined || data === null) return;
  if (PER_USER_CACHE_MAP.size >= PER_USER_CACHE_MAX_ENTRIES) {
    const oldestKey = PER_USER_CACHE_MAP.keys().next().value;
    if (oldestKey) PER_USER_CACHE_MAP.delete(oldestKey);
  }
  const now = Date.now();
  PER_USER_CACHE_MAP.set(key, {
    data,
    freshUntil: now + freshTtlSec * 1000,
    staleUntil: now + staleTtlSec * 1000,
  });
}

function invalidatePerUserCache(provider, userHash = "") {
  if (!provider) return;
  const prefix = `user_cache:${provider}`;
  for (const k of PER_USER_CACHE_MAP.keys()) {
    if (k.startsWith(prefix) && (!userHash || k.includes(userHash))) {
      PER_USER_CACHE_MAP.delete(k);
    }
  }
}

// Executes an external fetch with safe per-user caching and circuit-breaker fallback.
// If provider returns 429, 1015, or 5xx, or network fails, serves last-known-good stale response if available.
async function fetchWithPerUserCacheAndCircuitBreaker({
  cacheKey,
  fetchFn,
  freshTtlSec = 60,
  staleTtlSec = 1800,
  providerLabel = "External API"
}) {
  const cached = getPerUserCache(cacheKey);
  if (cached && cached.isFresh) {
    return cached.data;
  }

  try {
    const freshData = await fetchFn();
    if (freshData !== null && freshData !== undefined) {
      setPerUserCache(cacheKey, freshData, freshTtlSec, staleTtlSec);
      return freshData;
    }
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err);
    if (cached && cached.data) {
      console.warn(`[CircuitBreaker] ${providerLabel} request issue (${errMsg}). Gracefully serving last-known-good cached data.`);
      return cached.data;
    }
    throw err;
  }

  if (cached && cached.data) {
    return cached.data;
  }
  return null;
}

async function fetchTraktWithRetry(url, options = {}, retries = 2) {
  let res = await fetch(url, options);
  if (res.status === 429 && retries > 0) {
    const retrySec = parseInt((res.headers && res.headers.get("Retry-After")) || "1", 10);
    const delayMs = Math.min(3000, Math.max(1000, retrySec * 1000));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchTraktWithRetry(url, options, retries - 1);
  }
  return res;
}

