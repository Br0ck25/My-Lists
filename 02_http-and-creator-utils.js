function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// Stremio / wako fetch catalog, manifest, meta, and public-list JSON from
// other origins, so those routes still advertise `Access-Control-Allow-Origin:
// *`. Creator and like endpoints must not: `json()` used to spread
// corsHeaders() onto every JSON response, including POSTs, and a simple
// cross-origin POST (text/plain) is not preflighted -- that is how
// unauthenticated writes (likes) became callable from any page.
function isPublicCorsPath(path) {
  const p = String(path || "");
  if (p === "/manifest.json" || p.endsWith("/manifest.json")) return true;
  if (p.includes("/catalog/") && p.endsWith(".json")) return true;
  if (p.includes("/subtitles/") && p.endsWith(".json")) return true;
  if ((p.includes("/meta/") || p.startsWith("/meta/")) && p.endsWith(".json")) return true;
  if (p === "/lists/public.json" || p === "/api/public-lists.json") return true;
  if (/^\/lists\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/.test(p)) return true;
  if (p === "/icon.png" || p === "/unavailable-poster.svg") return true;
  if (p === "/api/poster-badge" || p === "/api/channel-poster" || p === "/api/channel-logo") return true;
  if (p.startsWith("/api/scrobble")) return true;
  return false;
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
      // Applied last so a caller (e.g. the admin dashboard's own JSON
      // endpoints -- see their own comment on why they need this) can
      // override the max-age default above, rather than every non-admin
      // call site needing to keep repeating the default just to get it.
      // CORS is NOT included by default -- see jsonPublic / corsHeaders.
      ...extraHeaders,
    },
  });
}

function jsonPublic(data, status = 200, extraHeaders = {}) {
  return json(data, status, { ...corsHeaders(), ...extraHeaders });
}

// Turns an exception into something safe to hand back to a caller, and logs
// the original.
//
// Dozens of routes used to return `String(err.message || err)` verbatim.
// That is not as bad as it sounds today -- every `throw` in this codebase
// is deliberately status-only ("Trakt request failed (HTTP 401).") with no
// URL or key in it, which is checked, and those messages are genuinely
// useful: a 401 surfaced to the user is how they learn their own API key is
// wrong. Blanking every one of them to "something went wrong" would be a
// real regression in the product, not a security win.
//
// The problem is that it is one careless `throw new Error(someUrl)` away
// from shipping an API key to the client, and /api/bulk-resolve already
// states the rule for the whole file: "the message can carry upstream URLs
// and internal detail that the caller has no business seeing."
//
// So this keeps the message and removes the parts that could ever carry a
// secret -- any URL, any explicit key/token parameter, and any long opaque
// token -- rather than choosing between useful and safe. The unredacted
// error still goes to the log, where the operator can see it.
function safeErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  try {
    console.error("handled error:", err);
  } catch {
    // logging must never be the thing that throws
  }
  let msg = "";
  try {
    // Deliberately not `err.message || err`: an Error with an empty message
    // would fall through to String(err) and surface the literal word
    // "Error", which tells the caller nothing and looks like a bug.
    if (err && typeof err.message === "string") msg = err.message;
    else if (typeof err === "string") msg = err;
    else if (err) msg = String(err);
  } catch {
    return fallback;
  }
  msg = msg.trim();
  // String(someObject) gives "[object Object]" -- no better than the fallback.
  if (!msg || msg === "[object Object]") return fallback;
  msg = msg
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|key)\b\s*[=:]\s*\S+/gi, "$1=[redacted]")
    // Anything long and opaque enough to be a credential, even unlabelled.
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .trim();
  if (!msg) return fallback;
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
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

// --- Verified-key memo (per-isolate, in memory only) -------------------------
// verifyCreatorKey above runs PBKDF2 at 100,000 iterations, and because a
// Creator Profile issues no session or token, EVERY authenticated request
// re-runs it from scratch -- routine autosaves, the dashboard load, each
// Auto-Track Playback ping, and the sync poll that fires while the
// dashboard is simply open. That made key verification the single largest
// CPU cost of being signed in, paid over and over for a credential that
// had already been proven correct moments earlier.
//
// This memoizes only the RESULT of a verification that already succeeded,
// for a few minutes, in this isolate's memory:
//   * Nothing is written to KV, D1, or any response -- it cannot outlive
//     the isolate and cannot be read by another request path.
//   * The memo is keyed on a SHA-256 of the username, the presented key,
//     AND the stored hash, so a wrong key never collides with a right one,
//     and rotating the key (which changes the stored hash) invalidates
//     every existing entry for that account immediately.
//   * A key that has NOT been verified before still pays the full PBKDF2
//     cost. This is a cache of successes, never a shortcut past one, so
//     brute-forcing is exactly as expensive as it was before.
// Failures are deliberately not memoized -- caching them would let a
// transient issue lock out a correct key for the rest of the TTL.
const CREATOR_AUTH_MEMO = new Map();
const CREATOR_AUTH_MEMO_TTL_MS = 5 * 60 * 1000;
const CREATOR_AUTH_MEMO_MAX = 500;

async function creatorAuthMemoKey(username, key, storedHash) {
  const data = new TextEncoder().encode(String(username) + "\u0000" + String(key) + "\u0000" + String(storedHash));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyCreatorKeyMemoized(key, storedHash, username) {
  if (!key || !storedHash) return false;
  let memoKey = "";
  try {
    memoKey = await creatorAuthMemoKey(username || "", key, storedHash);
  } catch {
    // Digest unavailable for some reason -- fall straight through to the
    // real verification rather than failing the request.
    return await verifyCreatorKey(key, storedHash);
  }
  const now = Date.now();
  const hit = CREATOR_AUTH_MEMO.get(memoKey);
  if (hit !== undefined && now < hit) return true;
  if (hit !== undefined) CREATOR_AUTH_MEMO.delete(memoKey);
  const valid = await verifyCreatorKey(key, storedHash);
  if (valid) {
    if (CREATOR_AUTH_MEMO.size >= CREATOR_AUTH_MEMO_MAX) {
      const oldest = CREATOR_AUTH_MEMO.keys().next().value;
      if (oldest !== undefined) CREATOR_AUTH_MEMO.delete(oldest);
    }
    CREATOR_AUTH_MEMO.set(memoKey, now + CREATOR_AUTH_MEMO_TTL_MS);
  }
  return valid;
}

// Drops every memoized verification for one account. Called after any
// change to the stored key hash so a rotated key cannot keep working from
// a warm isolate. (The hash is part of the memo key above, so this is
// belt-and-braces rather than strictly required.)
function invalidateCreatorAuthMemo() {
  CREATOR_AUTH_MEMO.clear();
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

// Display names used to be silently overwritten with the validated username
// (`const displayName = String(body.creatorName || "").trim()`), which was
// load-bearing as a security control: admin/client HTML never saw interesting
// input. Accepting a real display name therefore has to ship with length and
// control-character validation, plus escaping at every render site.
const CREATOR_DISPLAY_NAME_MAX = 40;

function normalizeCreatorDisplayName(raw, fallbackUsername) {
  let s = String(raw == null ? "" : raw).replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) s = String(fallbackUsername || "").trim();
  if (!s) return { ok: false, error: "Display name can't be empty." };
  if (s.length > CREATOR_DISPLAY_NAME_MAX) {
    return { ok: false, error: "Display name must be 40 characters or fewer." };
  }
  return { ok: true, displayName: s };
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

// --- List visibility (public / private) --------------------------------------
//
// Public exposure used to be `visibility !== "private"`: a missing field,
// empty string, typo, or garbage value all counted as public. Writes
// mirrored that (`=== "private" ? "private" : "public"`), so an old client
// that omitted the field published by default. That is the wrong default
// for a privacy flag -- only an explicit `"public"` should ever expose a
// list.
//
// Writes now fail closed (`normalizeListVisibility`). Reads now fail closed
// too (`isPublicListVisibility` === `"public"`). Legacy records that have
// no enum value were served as public under the old rule, so a one-off
// backfill stamps those `"public"` before the inverted reads would hide
// them. `stampListVisibilityIfNeeded` is that backfill, applied lazily on
// public read/rebuild paths and eagerly from /admin/api/migrate-d1.
function normalizeListVisibility(raw) {
  return raw === "public" ? "public" : "private";
}

function isPublicListVisibility(visibility) {
  return visibility === "public";
}

function needsListVisibilityBackfill(visibility) {
  return visibility !== "public" && visibility !== "private";
}

function backfillListVisibilityValue(visibility) {
  // Old rule: anything other than the exact string "private" was public.
  return visibility === "private" ? "private" : "public";
}

function effectiveListVisibility(visibility) {
  if (visibility === "public" || visibility === "private") return visibility;
  return backfillListVisibilityValue(visibility);
}

async function stampListVisibilityIfNeeded(env, key, data) {
  if (!data || typeof data !== "object") return false;
  if (!needsListVisibilityBackfill(data.visibility)) return false;
  data.visibility = backfillListVisibilityValue(data.visibility);
  if (env && env.CONFIGS && key) {
    try {
      await env.CONFIGS.put(key, JSON.stringify(data));
    } catch {
      // Best-effort: the in-memory value is still stamped for this request.
    }
  }
  return true;
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

// --- Builder page: render memo + conditional requests ------------------------
// The builder page is roughly 1.6MB of HTML with the entire client script
// inlined, and it was rebuilt from scratch on every single navigation and
// sent in full every time -- no ETag, no Last-Modified, and on most routes
// an explicit Cache-Control: no-store that told the browser never even to
// keep a copy. So opening the app, following a shared list link, and
// pressing back each re-downloaded and re-parsed the whole thing.
//
// Two separate fixes, both of which depend on the same fact: for a given
// origin and a given set of arguments, renderBuilder is deterministic
// (verified by rendering twice and comparing). Nothing in it varies per
// request -- no timestamp, no random id.
//
//  1. renderBuilderCached memoizes the argument-free variants (the default
//     page and the bare /configure page) per origin, so the Worker stops
//     re-concatenating 1.6MB of string on every page load. Config-bearing
//     and deep-link variants are not memoized -- they differ per request --
//     but still get an ETag below.
//  2. htmlPageResponse hashes the HTML into an ETag and answers a matching
//     If-None-Match with a bare 304. Cache-Control is "no-cache", which is
//     often misread as "do not cache": it means "you may store this, but
//     revalidate before reusing it". That is exactly right here -- the page
//     must never go stale after a deploy, and revalidating costs a 304
//     instead of 1.6MB.
//
// Worth being explicit about why this is safe on the routes that previously
// said no-store: the ETag is a hash of the actual bytes being returned, so
// a page whose content depends on a config or a deep-linked list gets a
// different ETag the moment that content differs. A 304 can only ever be
// sent when the browser already holds a byte-identical copy.
const BUILDER_PAGE_MEMO = new Map();

function renderBuilderCached(origin, opts) {
  // Only the argument-free variants are stable enough to memoize; anything
  // carrying entries, keys or a deep link is rendered fresh.
  const isDefault = !opts || Object.keys(opts).length === 0;
  const isBareConfigure = !!(opts && opts.isConfigureMode === true && Object.keys(opts).length === 1);
  if (!isDefault && !isBareConfigure) {
    return renderBuilder(origin, opts || {});
  }
  const memoKey = `${origin}::${isBareConfigure ? "configure" : "default"}`;
  const hit = BUILDER_PAGE_MEMO.get(memoKey);
  if (hit) return hit;
  const html = renderBuilder(origin, opts || {});
  // Bounded purely as a guard against an unexpected flood of distinct
  // origins; in practice this holds one or two entries.
  if (BUILDER_PAGE_MEMO.size >= 8) {
    const oldest = BUILDER_PAGE_MEMO.keys().next().value;
    if (oldest !== undefined) BUILDER_PAGE_MEMO.delete(oldest);
  }
  BUILDER_PAGE_MEMO.set(memoKey, html);
  return html;
}

// ETags are cached alongside the HTML they describe so a repeat request for
// a memoized page does not re-hash 1.6MB to decide it can send a 304.
const BUILDER_ETAG_MEMO = new Map();

async function htmlEtagFor(html) {
  const cached = BUILDER_ETAG_MEMO.get(html);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  const etag = `"${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  if (BUILDER_ETAG_MEMO.size >= 16) {
    const oldest = BUILDER_ETAG_MEMO.keys().next().value;
    if (oldest !== undefined) BUILDER_ETAG_MEMO.delete(oldest);
  }
  BUILDER_ETAG_MEMO.set(html, etag);
  return etag;
}

// --- App bundle extraction ---------------------------------------------------
// renderBuilder emits the client script as two elements: a small per-request
// preamble, then a bundle wrapped in the markers below (see the comment in
// 16_client-row-core.js for why the split falls where it does). Everything
// between the markers is identical for every visitor and every route --
// which is checked rather than assumed: the verification suite renders the
// page with sentinel OAuth tokens, entries, deep links and origins, then
// asserts the extracted bundle is byte-identical every time and contains
// none of them.
//
// So it is lifted out of the HTML and served from /app.js?v=<hash> with
// immutable caching. ETags already made a repeat visit to an UNCHANGED page
// cheap, but they do nothing for the pages people actually share: every
// distinct shared list URL, configure link and deep link renders different
// HTML, so each one re-sent all 1.3MB. Now they all share one cached
// bundle, and the browser can reuse its compiled copy instead of re-parsing
// inline script on every page load.
const APP_BUNDLE_START = "<script>/*MYLISTS_APP_BUNDLE_START*/";
const APP_BUNDLE_END = "/*MYLISTS_APP_BUNDLE_END*/<" + "/script>";

// A single entry, because the bundle is the same for everyone. Populated by
// whichever happens first -- a page render or a direct /app.js hit.
let APP_BUNDLE = null;

async function getAppBundle(origin) {
  if (APP_BUNDLE) return APP_BUNDLE;
  await splitAppBundle(renderBuilderCached(origin, {}));
  return APP_BUNDLE;
}

// Returns { page, bundle }, where page has the bundle element replaced by a
// script src. If the markers are missing for any reason the original HTML
// comes back untouched and nothing is cached -- an unrecognised page is
// served exactly as it was before this existed, rather than half-rewritten.
async function splitAppBundle(html) {
  const start = html.indexOf(APP_BUNDLE_START);
  if (start === -1) return { page: html, bundle: null };
  const bodyStart = start + APP_BUNDLE_START.length;
  const end = html.indexOf(APP_BUNDLE_END, bodyStart);
  if (end === -1) return { page: html, bundle: null };

  const bundle = html.slice(bodyStart, end);
  if (!APP_BUNDLE) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundle));
    const hash = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
    APP_BUNDLE = { js: bundle, hash };
  }
  const page =
    html.slice(0, start) +
    '<script src="/app.js?v=' + APP_BUNDLE.hash + '"><' + '/script>' +
    html.slice(end + APP_BUNDLE_END.length);
  return { page, bundle: APP_BUNDLE };
}

// The stylesheet gets exactly the same treatment as the script bundle, for
// exactly the same reason: ~85KB, identical for everyone, and previously
// re-sent inline with every page. Splitting it out also means the browser
// can start fetching it in parallel with the page's own parse rather than
// after re-reading it inline.
const APP_CSS_START = "<style>/*MYLISTS_APP_CSS_START*/";
const APP_CSS_END = "/*MYLISTS_APP_CSS_END*/<" + "/style>";

let APP_CSS = null;

async function getAppCss(origin) {
  if (APP_CSS) return APP_CSS;
  await splitAppCss(renderBuilderCached(origin, {}));
  return APP_CSS;
}

async function splitAppCss(html) {
  const start = html.indexOf(APP_CSS_START);
  if (start === -1) return { page: html, css: null };
  const bodyStart = start + APP_CSS_START.length;
  const end = html.indexOf(APP_CSS_END, bodyStart);
  if (end === -1) return { page: html, css: null };

  const css = html.slice(bodyStart, end);
  if (!APP_CSS) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css));
    const hash = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
    APP_CSS = { css, hash };
  }
  // rel=stylesheet in <head> still blocks first paint, which is what we
  // want -- swapping to a non-blocking load here would trade a re-download
  // for a flash of unstyled content on every page.
  const page =
    html.slice(0, start) +
    '<link rel="stylesheet" href="/app.css?v=' + APP_CSS.hash + '">' +
    html.slice(end + APP_CSS_END.length);
  return { page, css: APP_CSS };
}

// Rewritten pages are remembered per distinct HTML string, so a repeat
// request for the same page does not re-scan 1.6MB looking for the markers.
const SPLIT_PAGE_MEMO = new Map();

async function pageWithExternalBundle(html) {
  const memo = SPLIT_PAGE_MEMO.get(html);
  if (memo) return memo;
  let page = html;
  try {
    page = (await splitAppBundle(html)).page;
    page = (await splitAppCss(page)).page;
  } catch {
    // Nothing unexpected here is worth costing somebody their page.
    return html;
  }
  if (SPLIT_PAGE_MEMO.size >= 16) {
    const oldest = SPLIT_PAGE_MEMO.keys().next().value;
    if (oldest !== undefined) SPLIT_PAGE_MEMO.delete(oldest);
  }
  SPLIT_PAGE_MEMO.set(html, page);
  return page;
}

async function htmlPageResponse(request, fullHtml, extraHeaders) {
  // The ~1.3MB client bundle is lifted out to /app.js?v=<hash> first, so
  // both the body sent below and the ETag computed from it describe the
  // small page rather than the page-plus-bundle.
  const html = await pageWithExternalBundle(fullHtml);
  let etag = "";
  try {
    etag = await htmlEtagFor(html);
  } catch {
    // No digest available -- fall through and just send the page, exactly
    // as this did before there was an ETag at all.
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    ...(extraHeaders || {}),
  };
  if (!etag) return new Response(html, { headers });
  headers["ETag"] = etag;

  // If-None-Match can carry a list, and a cache is allowed to weaken a tag
  // it stores, so compare against each entry with any W/ prefix removed
  // rather than string-equalling the whole header.
  const inm = request && request.headers ? (request.headers.get("If-None-Match") || "") : "";
  if (inm) {
    const match = inm
      .split(",")
      .map((s) => s.trim().replace(/^W\//, ""))
      .some((s) => s === etag || s === "*");
    if (match) {
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(html, { headers });
}

// --- Per-User Cache & Circuit Breaker Shield ---------------------------------
// Safe in-memory LRU cache with rolling window and Stale-If-Error degradation.
// Ensures bearer-authenticated user data is safely isolated and never leaks between users.
const PER_USER_CACHE_MAP = new Map();
const PER_USER_CACHE_MAX_ENTRIES = 1000;

// Widened from a single 32-bit accumulator to two independently-seeded ones
// (~64 bits combined). This value separates one person's cached provider
// data from another's, and with only 32 bits a collision between two users
// of this add-on was already possible in memory -- it becomes more
// consequential now that the same value also names a KV entry, where an
// entry outlives the isolate that wrote it. Still a fast non-cryptographic
// hash, which is all this needs: nothing outside the Worker can choose the
// input, so the only failure mode worth engineering against is accidental
// collision, not a deliberate one.
function safeUserHash(token = "", username = "") {
  const input = `${token}:${username}`;
  let h1 = 0;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) - h1) + c;
    h1 |= 0;
    h2 = ((h2 << 7) - h2) + (c * 31 + i);
    h2 |= 0;
  }
  const a = (Math.abs(h1) || 1).toString(36);
  const b = (Math.abs(h2) || 1).toString(36);
  return a + b;
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
// If provider returns 429, 1015, or 5xx, or network fails, serves last-known-good stale response from in-memory or KV.
// --- In-flight request coalescing --------------------------------------------
// Nothing below deduplicated concurrent work for the same cacheKey, so N
// simultaneous misses meant N identical upstream calls. That is not a rare
// case here: an Airing Next refresh fires several /api/details lookups at
// once and shows routinely resolve to the same series, a catalog row can ask
// for the same chart from several shelves, and a popular list being
// requested by several people at the same moment lands in one isolate. Each
// of those spent a provider request -- against the shared key or, worse,
// against somebody's personal quota -- to compute an answer another
// in-progress request was about to produce.
//
// The first miss for a key registers its promise here; everyone else who
// arrives before it settles awaits that same promise. A rejection is shared
// too, which is correct: the callers all made the same request, so they all
// get the same outcome (including the circuit breaker's stale fallback,
// which happens inside the shared promise). The entry is always removed
// once settled, so a failure never poisons the key for later attempts.
const IN_FLIGHT_FETCHES = new Map();

async function fetchWithPerUserCacheAndCircuitBreaker(options) {
  const cacheKey = options && options.cacheKey;
  const cachedFresh = cacheKey ? getPerUserCache(cacheKey) : null;
  if (cachedFresh && cachedFresh.isFresh) {
    return cachedFresh.data;
  }
  // No usable key to coalesce on -- run it directly rather than letting every
  // keyless call collapse onto one shared entry.
  if (!cacheKey) {
    return await fetchWithPerUserCacheUncoalesced(options);
  }
  const existing = IN_FLIGHT_FETCHES.get(cacheKey);
  if (existing) {
    return await existing;
  }
  const p = fetchWithPerUserCacheUncoalesced(options);
  IN_FLIGHT_FETCHES.set(cacheKey, p);
  try {
    return await p;
  } finally {
    IN_FLIGHT_FETCHES.delete(cacheKey);
  }
}

async function fetchWithPerUserCacheUncoalesced({
  cacheKey,
  fetchFn,
  freshTtlSec = 60,
  staleTtlSec = 1800,
  providerLabel = "External API",
  env = null,
  ctx = null,
  kvKey = "",
  kvTtlSec = 86400,
}) {
  const cached = getPerUserCache(cacheKey);
  if (cached && cached.isFresh) {
    return cached.data;
  }

  let kvData = null;
  if (!cached && env && env.CONFIGS && kvKey) {
    try {
      const raw = await env.CONFIGS.get(`cache:${kvKey}`, "json");
      if (raw && raw.data !== undefined) {
        kvData = raw;
        setPerUserCache(cacheKey, raw.data, freshTtlSec, staleTtlSec);
        const now = Date.now();
        if (raw.freshUntil && now <= raw.freshUntil) {
          return raw.data;
        }
      }
    } catch {}
  }

  let edgeCacheData = null;
  const edgeCacheReq = new Request(`https://my-lists-addon.internal/cache/${encodeURIComponent(cacheKey)}`);
  if (!cached && !kvData) {
    try {
      const edgeRes = await caches.default.match(edgeCacheReq);
      if (edgeRes) {
        const raw = await edgeRes.json();
        if (raw && raw.data !== undefined) {
          edgeCacheData = raw;
          setPerUserCache(cacheKey, raw.data, freshTtlSec, staleTtlSec);
          const now = Date.now();
          if (raw.freshUntil && now <= raw.freshUntil) {
            return raw.data;
          }
        }
      }
    } catch {}
  }

  try {
    // Bounded, so a provider that hangs rather than failing still reaches
    // the fallback tiers below instead of holding the request open -- see
    // withTimeout's own comment.
    const freshData = await withTimeout(fetchFn(), OUTBOUND_TIMEOUT_MS, providerLabel);
    if (freshData !== null && freshData !== undefined) {
      setPerUserCache(cacheKey, freshData, freshTtlSec, staleTtlSec);
      
      const cachePayload = JSON.stringify({
        data: freshData,
        freshUntil: Date.now() + freshTtlSec * 1000,
      });

      if (env && env.CONFIGS && kvKey) {
        const p = env.CONFIGS.put(`cache:${kvKey}`, cachePayload, { expirationTtl: kvTtlSec }).catch(() => {});
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(p);
        }
      }

      try {
        const edgeRes = new Response(cachePayload, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `s-maxage=${Math.max(freshTtlSec, kvTtlSec)}`
          }
        });
        const cachePromise = caches.default.put(edgeCacheReq, edgeRes);
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(cachePromise);
        } else {
          cachePromise.catch(() => {});
        }
      } catch {}

      return freshData;
    }
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err);
    if (cached && cached.data) {
      console.warn(`[CircuitBreaker] ${providerLabel} request issue (${errMsg}). Gracefully serving last-known-good in-memory cached data.`);
      return cached.data;
    }
    if (kvData && kvData.data) {
      console.warn(`[CircuitBreaker] ${providerLabel} request issue (${errMsg}). Gracefully serving last-known-good KV cached data.`);
      return kvData.data;
    }
    if (edgeCacheData && edgeCacheData.data) {
      console.warn(`[CircuitBreaker] ${providerLabel} request issue (${errMsg}). Gracefully serving last-known-good Edge cached data.`);
      return edgeCacheData.data;
    }
    throw err;
  }

  if (cached && cached.data) {
    return cached.data;
  }
  if (kvData && kvData.data) {
    return kvData.data;
  }
  if (edgeCacheData && edgeCacheData.data) {
    return edgeCacheData.data;
  }
  return null;
}

// --- Outbound request timeouts -----------------------------------------------
//
// Nothing in this add-on used to bound how long a provider could take. The
// multi-tier fallback in fetchWithPerUserCacheUncoalesced above (memory ->
// KV -> edge cache -> stale) is good, but it only ever fires on a
// REJECTION: a provider that accepts the connection and then never
// responds produced no rejection at all, so the request simply hung and
// the stale data sitting right there was never served.
//
// Two places are enough to cover essentially every outbound call, rather
// than editing ~135 individual fetch() sites:
//   * fetchWithTimeout, used by the shared retry helper below, aborts the
//     underlying request.
//   * withTimeout, wrapped around the circuit breaker's fetchFn, turns a
//     hang into the rejection the fallback tiers already know how to
//     handle -- so a stalled provider now degrades to last-known-good data
//     instead of a spinner.
//
// 10s is chosen against what the callers are: catalog and metadata reads
// that a Stremio/wako client is actively waiting on. A provider that has
// not answered in ten seconds is not about to make the request feel fast;
// serving slightly stale data is strictly better than holding the
// connection open.
const OUTBOUND_TIMEOUT_MS = 10000;

// AbortSignal.timeout exists in the Workers runtime, but this also runs
// inside render_check.js's sandbox (which deliberately provides a minimal
// global set) and in tests that stub fetch -- so the capability is probed
// rather than assumed, and its absence just means no signal.
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // fall through
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, ms = OUTBOUND_TIMEOUT_MS) {
  // A caller that already manages its own signal keeps it.
  if (options && options.signal) return fetch(url, options);
  const signal = timeoutSignal(ms);
  return fetch(url, signal ? { ...options, signal } : options);
}

// Rejects if `promise` has not settled within `ms`. Used where the work is
// a caller-supplied closure rather than a single fetch (see the circuit
// breaker's fetchFn), so an AbortSignal cannot be threaded in directly.
// The underlying request is not cancelled here -- the point is to stop
// WAITING on it, so the fallback tiers can serve.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label || "Upstream"} did not respond within ${ms}ms`)),
      ms
    );
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function fetchTraktWithRetry(url, options = {}, retries = 2) {
  let res = await fetchWithTimeout(url, options);
  if (res.status === 429 && retries > 0) {
    const retrySec = parseInt((res.headers && res.headers.get("Retry-After")) || "1", 10);
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = Math.min(3000, Math.max(1000, retrySec * 1000)) + jitter;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchTraktWithRetry(url, options, retries - 1);
  }
  return res;
}


// --- Like voter ledger -------------------------------------------------------
//
// Likes used to be a bare read-modify-write counter on an unauthenticated
// endpoint: every POST did `likes = likes + 1` with nothing recording WHO
// voted. A trivial curl loop took a list from 0 to 11 in one second, and
// `action:"unlike"` decremented just as freely, so a competing list could
// be driven to zero as easily as your own could be inflated. Since the
// community directory sorts and surfaces by likes, that made the ranking
// meaningless.
//
// Instead of a counter, each likeable thing now keeps a small ledger of
// distinct voter ids. Liking is idempotent set-insertion and unliking is
// set-removal, so replaying the same request any number of times converges
// on the same state rather than accumulating. The displayed count is
// derived from the ledger size, never incremented directly.
//
// Voter identity, best available:
//   * signed-in creator  -> "u:<username>"  (stable across devices)
//   * anonymous          -> "a:<hash of IP + list id>"
// The anonymous id is salted with the list id specifically so the same
// ledger cannot be used to correlate one IP's activity across lists.
//
// This is deliberately NOT full authentication -- likes stay available to
// signed-out visitors, which is the existing product behaviour. It raises
// ballot-stuffing from "one curl loop" to "one vote per IP per list",
// which is the appropriate bar for a non-critical popularity signal.
const LIKE_VOTER_CAP = 5000;

// Rate limits (and anonymous like votes) key on CF-Connecting-IP, which
// Cloudflare's edge sets and a client cannot spoof. The old
// `|| "unknown"` fallback meant every request missing the header shared
// one global bucket -- a single header-less client could lock everyone
// else out of signup, and any non-Cloudflare path had no real per-client
// limit. Fail closed: empty/missing header returns null and the caller
// rejects. IPv6 is collapsed to a /64 so one subscriber is one bucket
// rather than 2^64 addresses.
function expandIpv6Hextets(ip) {
  const raw = String(ip || "").trim().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (!raw || !raw.includes(":")) return null;
  if (!/^[0-9a-fA-F:]+$/.test(raw)) return null;
  const sides = raw.split("::");
  if (sides.length > 2) return null;
  const parseSide = (s) => (s ? s.split(":") : []);
  let head = parseSide(sides[0]);
  let tail = sides.length === 2 ? parseSide(sides[1]) : [];
  if (head.length === 1 && head[0] === "") head = [];
  if (tail.length === 1 && tail[0] === "") tail = [];
  if (sides.length === 1) {
    if (head.length !== 8) return null;
  } else if (8 - head.length - tail.length < 0) {
    return null;
  }
  const mid = sides.length === 2 ? Array(8 - head.length - tail.length).fill("0") : [];
  const all = [...head, ...mid, ...tail];
  if (all.length !== 8) return null;
  for (let i = 0; i < 8; i++) {
    const h = all[i] || "0";
    if (h.length > 4 || !/^[0-9a-fA-F]+$/.test(h)) return null;
    all[i] = h.toLowerCase();
  }
  return all;
}

function clientIpKey(request) {
  const raw = request && request.headers ? request.headers.get("CF-Connecting-IP") : "";
  const ip = String(raw || "").trim();
  if (!ip) return null;
  const v4mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped) return v4mapped[1];
  if (ip.includes(".") && !ip.includes(":")) return ip;
  const hextets = expandIpv6Hextets(ip);
  if (hextets) {
    const prefix = hextets.slice(0, 4).map((h) => h.replace(/^0+(?=[0-9a-f])/, "") || "0");
    return prefix.join(":") + "::/64";
  }
  return ip.toLowerCase();
}

// --- Shared per-IP rate limiter --------------------------------------------
//
// The same IP-keyed 60-second KV slot /api/preview, /api/creator/create,
// /api/creator/restore and /admin/login each grew their own copy of. Pulled
// out because the endpoints that spend THIS Worker owner's provider quota
// (rather than the caller's own key) all need it and all want it to behave
// identically.
//
// Returns true when the caller is over budget and the request should stop.
// Follows the convention the existing call sites already established:
// skipped entirely when CONFIGS isn't bound (every KV-optional feature here
// degrades rather than fails closed), and the increment rides on
// ctx.waitUntil so a rate-limit bookkeeping write never adds latency to the
// request it is protecting. Callers check for a missing client IP
// themselves, since what to return in that case is route-specific.
async function consumeRateLimit(env, ctx, bucket, ip, maxPerWindow, windowSec = 60) {
  if (!env || !env.CONFIGS || !ip) return false;
  const key = `ratelimit:${bucket}:${ip}`;
  const used = parseInt((await env.CONFIGS.get(key)) || "0", 10) || 0;
  if (used >= maxPerWindow) return true;
  const write = env.CONFIGS.put(key, String(used + 1), { expirationTtl: windowSec });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
  else await write;
  return false;
}

async function likeVoterId(request, env, creatorUsername, scopeId) {
  if (creatorUsername) return `u:${creatorUsername}`;
  const ip = clientIpKey(request);
  if (!ip) return null;
  const hash = await hashStringForKey(`${ip}|${scopeId}`);
  return `a:${hash}`;
}

// Reads a ledger key's voter list, tolerating both storage shapes this
// function has ever written (a bare array, or {voters: [...]}).
async function readLikeVoters(env, ledgerKey) {
  try {
    const raw = await env.CONFIGS.get(ledgerKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.voters)) return parsed.voters;
  } catch {
    // fall through
  }
  return [];
}

// Applies one vote to a ledger key and returns the resulting count.
// Returns null when the ledger is full (see LIKE_VOTER_CAP) and this would
// be a new voter -- the caller keeps the existing count rather than
// silently discarding the vote or growing the key without bound.
//
// Cloudflare KV has no atomic compare-and-swap, so a plain read-modify-write
// here can lose a vote: two requests can both read the same snapshot, and
// whichever PUT lands last in KV wins, silently dropping the other one.
// Rather than a full lock (KV has no primitive to build one on reliably
// either), this re-reads the ledger after writing and confirms this
// voter's own membership actually stuck; if another write raced it in
// between, it retries against that fresh state instead of just trusting
// its own PUT. Bounded to a handful of attempts -- this only protects
// against genuinely concurrent requests on one list, not a design that
// needs to spin forever.
async function applyLikeVote(env, ledgerKey, voterId, liked) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const voters = await readLikeVoters(env, ledgerKey);
    const set = new Set(voters);
    const had = set.has(voterId);
    if (liked) {
      if (!had && set.size >= LIKE_VOTER_CAP) return { count: set.size, capped: true };
      set.add(voterId);
    } else {
      set.delete(voterId);
    }
    // No write at all when nothing changed -- KV allows one write per
    // second per key, and a double-tap on a busy list should not burn
    // that budget or race with a genuine vote.
    if (set.size === voters.length && had === set.has(voterId)) {
      return { count: set.size, capped: false };
    }
    await env.CONFIGS.put(ledgerKey, JSON.stringify([...set]));
    const verifyVoters = await readLikeVoters(env, ledgerKey);
    if (new Set(verifyVoters).has(voterId) === liked) {
      return { count: verifyVoters.length, capped: false };
    }
    // Someone else's write landed on top of ours between the PUT and this
    // re-read -- loop and retry against their (now current) state rather
    // than reporting a count/liked state that isn't what's actually
    // stored.
  }
  // Exhausted retries under sustained contention on this one list: report
  // whatever is actually in KV right now rather than guessing.
  const finalVoters = await readLikeVoters(env, ledgerKey);
  return { count: finalVoters.length, capped: false };
}

// --- External list URL validation --------------------------------------------
//
// /api/lists/like-external hashes a caller-supplied URL into a KV key. With
// no validation that was an unbounded, attacker-controlled key-space write
// primitive: any string at all minted a brand-new permanent KV key, which
// is a storage and billing denial-of-service and pollutes the external
// likes dataset with garbage nobody can ever clean up.
//
// Only list URLs from the providers this add-on actually integrates with
// are likeable, which is the only thing the feature was ever for.
const EXTERNAL_LIKE_HOSTS = new Set([
  "mdblist.com", "www.mdblist.com",
  "trakt.tv", "www.trakt.tv",
  "themoviedb.org", "www.themoviedb.org",
  "simkl.com", "www.simkl.com",
  "letterboxd.com", "www.letterboxd.com",
]);

// This add-on's own Discover shelves (Popular/Trending/Genre/Collection/
// Top 10/... charts) aren't backed by a real URL at all -- they're
// referenced internally by a sentinel string (see detectSource,
// 04_config-resolution.js), e.g. "tmdb:chart:popular". Those never
// matched an EXTERNAL_LIKE_HOSTS host, so every one of them 400'd with
// "That URL can't be liked" the moment someone tried -- this add-on's
// own built-in charts were the one thing this feature could never
// actually be used on.
//
// Allowing a *prefix* rather than the exact chart/genre/collection id
// against its real enum doesn't reopen the unbounded-keyspace problem
// EXTERNAL_LIKE_HOSTS exists to prevent: it's the same shape of risk the
// host allowlist above already accepts today (any *path* under an
// allowed host mints its own key, not just the ones that correspond to a
// real list), just scoped under a small, fixed, code-defined set of
// prefixes instead of a domain. Deliberately excludes anything session/
// account-relative (watchlist, history, airing-next, a connected
// account's own Simkl/Trakt list) -- those resolve to a DIFFERENT real
// list depending on who's viewing, so there's no one shared thing for a
// like to mean; the client already never shows a like button for those
// (see openListDetailsPage).
const LIKEABLE_SENTINEL_PREFIXES = [
  "tmdb:chart:", "tmdb:top10:", "tmdb:kids:", "tmdb:holiday:", "tmdb:genre:", "tmdb:collection:",
  "trakt:chart:", "simkl:chart:",
];
const LIKEABLE_SENTINEL_EXACT = new Set(["tmdb:hidden-gems"]);

function normalizeExternalListUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s || s.length > 300) return null;
  const lower = s.toLowerCase();
  if (
    LIKEABLE_SENTINEL_EXACT.has(lower) ||
    (LIKEABLE_SENTINEL_PREFIXES.some((p) => lower.startsWith(p)) && /^[a-z0-9:_-]+$/.test(lower))
  ) {
    return lower;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  // Blocks javascript:, data:, file:, and anything else non-web outright.
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!EXTERNAL_LIKE_HOSTS.has(host)) return null;
  // Normalized so the same list liked via http/https, with or without a
  // "www." prefix, with a trailing slash, or with tracking query params
  // all land on ONE ledger instead of fragmenting the count across
  // near-duplicate keys. The "www." strip matters most: trakt.tv and
  // www.trakt.tv are the same list to a human, and were otherwise counted
  // separately.
  const bareHost = host.replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `https://${bareHost}${path}`;
}

// ---------------------------------------------------------------------------
// Public list directory index
// ---------------------------------------------------------------------------
// The directory and search used to do list({prefix:"creatorlist:", limit:150})
// with no cursor and then slice(0,100). KV returns keys in lexicographic
// order, so past ~150 lists only usernames sorting earliest were ever visible
// -- everyone else silently vanished from the directory with no error.
//
// Paginating that properly is worse, not better: it means reading EVERY list
// on every directory load (10k lists = 10k KV reads per page view, well past
// the 1,000 subrequest/invocation cap). So the directory reads a single
// maintained index blob instead, updated on publish/unpublish. Directory cost
// is now ONE KV read regardless of how many lists exist.
//
// The index stores the display fields the directory needs (name, creator,
// counts, likes) so no per-list get is required. It is a derived cache: if it
// is missing or stale, rebuildPublicListIndex() regenerates it from the
// authoritative creatorlist:/publishedlist: keys. Never treat it as the
// source of truth.
const PUBLIC_INDEX_KEY = "index:publiclists";
// 25 MiB is the KV value ceiling. At ~200 bytes/entry, 20k entries is ~4 MB --
// comfortably inside it while still bounding worst-case memory and response
// size. Beyond this the tail is dropped (least-liked first).
const PUBLIC_INDEX_MAX = 20000;

async function readPublicListIndex(env) {
  if (!env || !env.CONFIGS) return null;
  try {
    const raw = await env.CONFIGS.get(PUBLIC_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Sorted by likes so that if anything downstream truncates, it drops the
// least popular rather than an arbitrary lexicographic slice.
function sortPublicIndexEntries(entries) {
  return entries.sort(
    (a, b) => (b.likes || 0) - (a.likes || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

async function writePublicListIndex(env, entries) {
  const trimmed = sortPublicIndexEntries(entries).slice(0, PUBLIC_INDEX_MAX);
  await env.CONFIGS.put(
    PUBLIC_INDEX_KEY,
    JSON.stringify({ updatedAt: Date.now(), entries: trimmed })
  );
  return trimmed;
}

// Incremental update for one list. `entry` null => remove (unpublished,
// deleted, or made private).
//
// This is a read-modify-write on a single key, so concurrent publishes can
// lose an update. That is acceptable here in a way it was NOT for like counts:
// the index is a rebuildable cache, a lost entry costs one list's directory
// visibility until its next save or the next rebuild, and publishes are rare
// and self-correcting. Like counts had no such backstop.
async function updatePublicListIndex(env, id, entry) {
  if (!env || !env.CONFIGS) return;
  try {
    const idx = await readPublicListIndex(env);
    // No index yet: don't build one from a single entry, or the directory
    // would show exactly one list. Leave it absent so the read path falls
    // back to a scan and rebuilds the whole thing.
    if (!idx) return;
    const prev = idx.entries.find((e) => e && e.id === id);
    const entries = idx.entries.filter((e) => e && e.id !== id);
    // Merge onto the previous entry rather than replacing it: callers that
    // only know part of the record (the like route has no displayName, for
    // instance) must not blank out fields they never loaded.
    if (entry) entries.push({ ...(prev || {}), ...entry, id });
    await writePublicListIndex(env, entries);
  } catch (err) {
    // Non-fatal: the list itself is already saved. Worst case the directory
    // is stale until the next rebuild.
    console.error("public list index update failed:", err);
  }
}

// Full scan -> index. Expensive (one KV get per list), so it runs only when
// the index is missing, and only one caller at a time via a short lock.
async function rebuildPublicListIndex(env) {
  const entries = [];
  const seen = new Set();

  // Search matches against the creator's display name too, so the index has
  // to carry it. Cached per username: creators are far fewer than lists, and
  // without this the rebuild would do a second get for every list.
  const displayNameCache = new Map();
  async function resolveDisplayName(username) {
    if (displayNameCache.has(username)) return displayNameCache.get(username);
    let name = username;
    try {
      const profileRaw = await getCreator(env, username);
      if (profileRaw) name = JSON.parse(profileRaw).displayName || username;
    } catch {
      // fall back to the raw username slug
    }
    displayNameCache.set(username, name);
    return name;
  }

  const creatorKeys = await listAllKeys(env.CONFIGS, "creatorlist:");
  for (const k of creatorKeys.keys) {
    const rest = k.name.slice("creatorlist:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) continue;
    const username = rest.slice(0, sep);
    const slug = rest.slice(sep + 1);
    const raw = await env.CONFIGS.get(k.name);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      await stampListVisibilityIfNeeded(env, k.name, data);
      if (!isPublicListVisibility(data.visibility)) continue;
      const itemCount = Array.isArray(data.items) ? data.items.length : (data.itemCount || 0);
      const id = `c:${username}:${slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        isCreator: true,
        username,
        creatorName: await resolveDisplayName(username),
        slug,
        name: data.name || "List",
        type: data.type || "mixed",
        itemCount,
        likes: data.likes || 0,
        updatedAt: data.updatedAt || data.createdAt || null,
      });
    } catch {
      // skip unparseable record
    }
  }

  const anonKeys = await listAllKeys(env.CONFIGS, "publishedlist:user:");
  for (const k of anonKeys.keys) {
    const slug = k.name.slice("publishedlist:user:".length);
    const raw = await env.CONFIGS.get(k.name);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      await stampListVisibilityIfNeeded(env, k.name, data);
      if (!isPublicListVisibility(data.visibility)) continue;
      const itemCount = Array.isArray(data.items) ? data.items.length : (data.itemCount || 0);
      const id = `a:${slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        isCreator: false,
        username: "user",
        slug,
        name: data.name || "List",
        type: data.type || "mixed",
        itemCount,
        likes: data.likes || 0,
        updatedAt: data.updatedAt || data.createdAt || null,
      });
    } catch {
      // skip unparseable record
    }
  }

  return await writePublicListIndex(env, entries);
}

// Returns index entries, rebuilding if absent. `ctx` (optional) lets the
// rebuild run after the response so the requesting user doesn't pay for it.
async function getPublicListIndex(env, ctx) {
  const idx = await readPublicListIndex(env);
  if (idx) return idx.entries;

  // Rebuilding is a full scan; a burst of traffic against a cold index must
  // not start one per request. First caller takes a 60s lock and rebuilds,
  // the rest fall through to the bounded legacy scan for this one request.
  let gotLock = false;
  try {
    const lock = await env.CONFIGS.get("lock:publiclistindex");
    if (!lock) {
      await env.CONFIGS.put("lock:publiclistindex", "1", { expirationTtl: 60 });
      gotLock = true;
    }
  } catch {
    // If the lock read fails, fall through to the scan rather than risking
    // a rebuild stampede.
  }
  if (!gotLock) return null;

  if (ctx && typeof ctx.waitUntil === "function") {
    // Rebuild in the background; serve this request from the legacy scan.
    ctx.waitUntil(rebuildPublicListIndex(env).catch((err) => {
      console.error("public list index rebuild failed:", err);
    }));
    return null;
  }
  try {
    return await rebuildPublicListIndex(env);
  } catch (err) {
    console.error("public list index rebuild failed:", err);
    return null;
  }
}

// Pages a whole prefix, following the cursor to completion.
//
// `maxKeys` (optional) caps how many keys are collected. It exists for
// prefixes whose key space is not intrinsically bounded -- see the caps in
// computeCatalogAndCommunityLeaderboards (03_admin.js), where an
// unbounded scan followed by one get per key was enough to push a request
// past Cloudflare's per-invocation subrequest limit. Callers that pass it
// must treat `list_complete: false` as "there was more" rather than
// assuming they have everything; callers that omit it keep the previous
// exhaustive behaviour exactly.
async function listAllKeys(namespace, prefix, maxKeys = Infinity) {
  const keys = [];
  let cursor;
  do {
    const remaining = maxKeys - keys.length;
    if (remaining <= 0) return { keys, list_complete: false };
    const result = await namespace.list({
      prefix,
      limit: Math.min(1000, remaining),
      ...(cursor ? { cursor } : {})
    });
    keys.push(...result.keys);
    cursor = result.cursor;
    if (result.list_complete) {
      break;
    }
  } while (cursor);
  return { keys, list_complete: true };
}

// --- Account data purge (shared by reset and delete) -------------------------
//
// /api/creator/account/reset and /api/creator/delete-account are the same
// sweep apart from one thing: whether the identity itself (`creator:{u}`
// plus the D1 `creators` row) goes too. They used to be written out
// separately, and drifted -- delete-account was still naming
// `creatorprofile:`/`creatorpresets:`/`creatorchannels:`, key names this
// codebase has not written in a long time, while missing every key it
// actually does write (`creatorsync:`, `creatorsynctracking:`,
// `creatorsyncpresets:`, `creatorsyncchannels:`, ...). The result was a
// "delete my account" that returned ok:true while leaving the account
// fully intact and still able to authenticate. One function so that
// cannot happen again: anything added to the account's key set gets
// cleaned up by both callers automatically.
async function purgeCreatorData(env, username, options = {}) {
  const deleteIdentity = options.deleteIdentity === true;
  const u = username;
  let listsCleared = 0;
  const purgedListIds = [];
  let keysCleared = 0;

  // Custom lists are one key each and list() pages -- keep going until the
  // cursor is exhausted rather than assuming a single page covers an
  // account that may have hundreds.
  try {
    let cursor;
    for (let page = 0; page < 50; page++) {
      const res = await env.CONFIGS.list({ prefix: `creatorlist:${u}:`, cursor });
      for (const k of res.keys) {
        await env.CONFIGS.delete(k.name);
        // Drop it from the directory index too, or a deleted account's
        // lists keep appearing publicly until the next full rebuild.
        const listPath = k.name.slice("creatorlist:".length);
        purgedListIds.push("c:" + listPath);
        // And the list's like ledger, keyed listlikevoters:{user}:{slug}
        // (see applyLikeVote's call site in /api/lists/like). These used to
        // survive the account: because delete-account frees the username for
        // re-registration, whoever claimed it next and made a list with the
        // same slug inherited the previous owner's ledger -- a like count
        // they never earned, and every voter in the old ledger silently
        // unable to like it.
        try {
          await env.CONFIGS.delete(`listlikevoters:${listPath}`);
        } catch (e) {
          // best-effort: a stranded ledger is untidy, not harmful on its own
        }
        listsCleared++;
      }
      if (res.list_complete || !res.cursor) break;
      cursor = res.cursor;
    }
  } catch (e) {
    console.error("purgeCreatorData: list enumeration failed", e);
  }

  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM creator_lists WHERE id LIKE ?").bind(`${u}:%`).run();
    } catch (dbErr) {
      console.error("D1 write error (purgeCreatorData lists):", dbErr);
    }
  }

  // One index write for the whole account rather than one per list --
  // deleting an account with 200 lists should not be 200 read-modify-writes
  // against the same key (KV allows 1 write/sec/key).
  if (purgedListIds.length) {
    try {
      const idx = await readPublicListIndex(env);
      if (idx) {
        const gone = new Set(purgedListIds);
        await writePublicListIndex(env, idx.entries.filter((e) => e && !gone.has(e.id)));
      }
    } catch (e) {
      console.error("purgeCreatorData: index cleanup failed", e);
    }
  }

  // Everything else the account owns, under the key names actually in use
  // today, plus the legacy ones (harmless if absent) so an old account
  // still gets fully cleaned.
  const dataKeys = [
    `creatorsync:${u}`,
    `creatorsynctracking:${u}`,
    `creatorsyncpresets:${u}`,
    `creatorsyncchannels:${u}`,
    `creatorlistorder:${u}`,
    `creatorscrobblequeue:${u}`,
    `creatorlistlikes:${u}`,
    `creatorlikes:${u}`,
    `creatorshare:${u}`,
    // Playback diagnostics (handleSubtitlesTrack writes it,
    // /api/creator/track-status reads it) and the scrobble seen-user set
    // (handleMediaServerScrobble). Both are live keys, not legacy ones --
    // creatortrack: was previously listed under the legacy heading below,
    // which was simply wrong about it.
    `creatortrack:${u}`,
    `scrobbleseenusers:${u}`,
    // legacy names, harmless if absent
    `creatorpresets:${u}`,
    `creatorchannels:${u}`,
    `creatorprofile:${u}`,
  ];
  for (const key of dataKeys) {
    try {
      await env.CONFIGS.delete(key);
      keysCleared++;
    } catch (e) {
      console.error("purgeCreatorData: could not delete", key, e);
    }
  }

  if (deleteIdentity) {
    // Last, and only for delete-account: the identity itself. Done after
    // the data sweep so that a failure partway through leaves an account
    // that can still sign in and retry, rather than orphaned data with no
    // owner and a username nobody can ever reclaim.
    try {
      await env.CONFIGS.delete(`creator:${u}`);
      keysCleared++;
    } catch (e) {
      console.error("purgeCreatorData: could not delete identity", e);
    }
    try {
      await env.CONFIGS.delete(`creatorlastseen:${u}`);
      keysCleared++;
    } catch (e) {}
    if (env.DB) {
      try {
        await env.DB.prepare("DELETE FROM creators WHERE username = ?").bind(u).run();
      } catch (dbErr) {
        console.error("D1 write error (purgeCreatorData identity):", dbErr);
      }
    }
  }

  // Any verification memoized in a warm isolate must stop being honoured
  // the instant the account it refers to is reset or removed.
  try { invalidateCreatorAuthMemo(); } catch (e) {}

  return { listsCleared, keysCleared };
}

// D1 is an optional accelerator in front of KV, never a replacement for it
// -- KV remains the store every account is guaranteed to exist in (see the
// unconditional KV writes in the create/rotate paths).
//
// This used to `return null` when D1 was bound and the row was absent,
// instead of falling through to KV. That is only correct if every account
// is guaranteed present in D1, which is exactly what is NOT true: D1 is
// populated lazily by /admin/api/migrate-d1, so every account created
// before that endpoint was first run has no D1 row. Binding DB therefore
// locked all of those users out of their own accounts completely -- the
// key was fine, the data was fine, the lookup just said "no such creator"
// and every endpoint returned the generic "Username or Key is incorrect."
// A missing row means "not migrated yet", not "does not exist".
async function getCreator(env, username) {
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT * FROM creators WHERE username = ?').bind(username).all();
      if (results && results.length > 0) {
        const row = results[0];
        return JSON.stringify({ displayName: row.display_name, keyHash: row.key_hash, recoveryAnswerHash: row.recovery_answer_hash, createdAt: row.created_at });
      }
      // fall through to KV -- not migrated (or D1 is behind)
    } catch(e) {
      console.error("D1 read error (getCreator), falling back to KV:", e);
    }
  }
  return await env.CONFIGS.get(`creator:${username}`);
}

// Same lazy-migration hazard as getCreator above: a list absent from D1
// must fall through to KV rather than being reported as nonexistent.
async function getCreatorList(env, username, slug) {
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT * FROM creator_lists WHERE id = ?').bind(`${username}:${slug}`).all();
      if (results && results.length > 0) {
        const row = results[0];
        return JSON.stringify({ 
          slug: row.id.split(':')[1] || slug, 
          name: row.name, 
          type: row.type, 
          visibility: row.visibility, 
          items: JSON.parse(row.items_json || '[]'), 
          createdAt: row.created_at, 
          updatedAt: row.updated_at,
          likes: row.likes || 0
        });
      }
      // fall through to KV -- not migrated (or D1 is behind)
    } catch(e) {
      console.error("D1 read error (getCreatorList), falling back to KV:", e);
    }
  }
  return await env.CONFIGS.get(`creatorlist:${username}:${slug}`);
}

function isEpisodeAired(airDateStr) {
  if (!airDateStr) return false;
  const parts = String(airDateStr).split(/[-T\s]/);
  if (parts.length < 3) return false;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < today.getTime();
}

function formatAirDateBadge(airDateStr) {
  if (!airDateStr) return '';
  const parts = String(airDateStr).split(/[-T\s]/);
  if (parts.length < 3) return '';
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return '';
  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 'TODAY';
  if (diffDays === 1) return 'TOMORROW';
  if (diffDays > 1 && diffDays < 7) {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    return days[d.getDay()];
  }
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  if (d.getFullYear() !== now.getFullYear()) {
    return months[d.getMonth()] + ' ' + String(d.getFullYear()).slice(-2);
  }
  return months[d.getMonth()] + ' ' + d.getDate();
}

