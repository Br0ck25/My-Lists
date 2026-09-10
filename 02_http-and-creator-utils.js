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

// Paths whose responses are per-account or admin-only, and must never be
// stored by a browser or by anything between it and this Worker.
//
// json() defaults to a cacheable max-age for a successful response, which is
// right for the catalog and directory endpoints this add-on leans on to stay
// inside upstream rate limits, and wrong for everything under these two
// prefixes. Individual routes were given jsonPrivate() for N10, but that is
// opt-in: the four sync/save* routes and lists/delete were still answering
// 200 with max-age=3600, and a route added tomorrow starts out wrong too.
//
// Nothing is leaking today -- those are POSTs, and browsers do not store a
// POST response -- but that is protection by accident of HTTP method rather
// than by design, and it stops being true the day one of them gains a GET
// form.
//
// Enforced at the single point every response funnels back through rather
// than at each of the ~25 call sites, for the same reason securityHeaders is:
// a route added later cannot forget to opt in. The header is SET, not
// defaulted, so a route cannot accidentally opt out either.
function isPrivateApiPath(path) {
  const p = String(path || "");
  // /api/resolve is neither of those prefixes and is the one per-account GET
  // in this Worker. It hands back the config owner's MDBList key and their
  // Trakt/MDBList OAuth tokens to anyone holding the install id -- and being a
  // GET, it inherited json()'s cacheable max-age default, with no Vary, so a
  // browser (or any shared cache in front of this Worker) could store one
  // person's OAuth tokens for an hour. The sibling page that renders the same
  // secrets, /:config/configure, sets no-store deliberately; the two disagreed.
  //
  // The comment below already predicted this exact shape -- "it stops being
  // true the day one of them gains a GET form". Named here rather than only
  // fixed at the route, because this is the choke point that is supposed to
  // mean a route added later cannot forget.
  if (p === "/api/resolve") return true;
  return p.startsWith("/api/creator/") || p === "/admin" || p.startsWith("/admin/");
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
// onchange= handlers throughout the builder/admin pages, which only work
// with 'unsafe-inline' on script-src. (That trade is only reasonable if the
// handlers actually resolve, which html_checks.py now verifies across all
// 733 of them -- for a long time this comment cited that step before it
// existed.) Tightening
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
function withSecurityHeaders(response, privatePath = false) {
  const headers = new Headers(response.headers);
  const extra = securityHeaders();
  for (const key in extra) {
    if (!headers.has(key)) headers.set(key, extra[key]);
  }
  // Deliberately set rather than defaulted -- see isPrivateApiPath.
  if (privatePath) headers.set("Cache-Control", "no-store");
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
      // An error is never worth caching, and caching one does real damage
      // here: there is no `Vary: Cookie` on these responses, so an admin
      // whose browser had already seen a 401 from /admin/api/analytics --
      // which any cross-origin page can provoke with an <img> tag -- was
      // served that cached 401 for an hour AFTER logging in, and the
      // dashboard just said "Not authorized". A 404 from a list URL had the
      // same shape: cached for an hour, so a list published a minute later
      // stayed missing.
      //
      // `ok: false` counts as an error even with a 200 status, because that
      // is this codebase's own convention -- most failure paths here return
      // { ok: false, error } without changing the status code, and a status
      // check alone would have missed every one of them.
      //
      // A successful 2xx keeps the previous default deliberately. Flipping it
      // wholesale would strip edge caching from the catalog and provider
      // endpoints this add-on leans on to stay inside upstream rate limits,
      // which is a much larger change than the defect requires; the handful
      // of successful responses that genuinely must not be cached set
      // no-store explicitly at their call site instead.
      "Cache-Control": (status >= 400 || (data && typeof data === "object" && data.ok === false))
        ? "no-store"
        : "max-age=3600",
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

// For a response whose BODY belongs to one account: their lists (public and
// private), their synced config, the provider API keys inside it, their
// playback diagnostics, their identity.
//
// json() above defaults a successful 2xx to `max-age=3600` with no `Vary`,
// and that default is deliberate -- it is what keeps the catalog and provider
// endpoints inside upstream rate limits. The mistake was letting the
// account-scoped endpoints inherit it. Failures were given `no-store`, and so
// were the two routes that hand back a plaintext Creator Key and the admin
// endpoints; /api/creator/sync/load, which returns the account's own TMDB /
// Trakt / MDBList / Simkl credentials, was not.
//
// These are POSTs, so in practice the method is what stops a browser cache
// storing them rather than the header -- which is exactly why this exists as
// one helper rather than a note at each call site. Naming the property makes
// it survive the next endpoint.
function jsonPrivate(data, status = 200, extraHeaders = {}) {
  return json(data, status, { "Cache-Control": "no-store", ...extraHeaders });
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
//
// The bucket is the EASTERN calendar day, the same one every stats counter
// uses (see easternDateKey, 03_admin.js). It used to be
// Math.floor(Date.now() / 86400000), a UTC day -- so the "daily" shuffle
// rotated at 7 or 8pm Eastern, in the middle of the evening people actually
// use this, while every other "day" in the app rolled over at midnight
// Eastern. Two different definitions of the same word, and the one users felt
// was the one that moved during peak hours.
//
// easternDateKey is declared in a later numbered file, which is fine: both
// are top-level function declarations in one concatenated module, so
// hoisting has them defined before any request runs.
function getDailySeed(salt = "") {
  // new Date(Date.now()), not new Date(): they are equivalent in production,
  // but only the first goes through Date.now, which is the one seam a test
  // can hold still.
  const dayBucket = easternDateKey(new Date(Date.now()));
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
//
// The early length return is deliberate and safe HERE: every caller compares
// two values of a length fixed by construction (a PBKDF2 digest, an OAuth
// state minted by generateShortId, an admin session signature), so the length
// is not a secret and never varies with the input. A caller comparing a
// secret of UNKNOWN length must use timingSafeEqualSecret below instead --
// this one would answer from the length alone.
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The same comparison for a secret whose length is itself secret.
//
// ADMIN_KEY is chosen by whoever deploys this Worker, so its length is not
// fixed by anything -- and `if (a.length !== b.length) return false` above
// answers before the constant-time loop, which makes the length observable
// by timing from an unauthenticated endpoint. Guessing a length is not
// guessing a key, but it narrows the search for free and the fix costs one
// hash.
//
// Both sides are digested first, so the comparison always runs over 64 hex
// characters whatever came in, and the loop below sees no difference between
// a one-character guess and a hundred-character one.
async function timingSafeEqualSecret(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a == null ? "" : a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b == null ? "" : b))),
  ]);
  return timingSafeEqualHex(bufferToHex(new Uint8Array(da)), bufferToHex(new Uint8Array(db)));
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

// Whether verifyCreatorKeyMemoized would answer this exact triple from the
// memo, i.e. WITHOUT running PBKDF2.
//
// Only used to decide whether a request is about to spend ~15ms of CPU, so
// that the throttle in authenticateCreator charges the expensive path and
// leaves a warm, signed-in client alone. Deliberately not a shortcut past
// verification: it reports on the memo, it does not consult it, and the real
// check runs either way.
async function isCreatorAuthMemoized(key, storedHash, username) {
  if (!key || !storedHash) return false;
  try {
    const memoKey = await creatorAuthMemoKey(username || "", key, storedHash);
    const hit = CREATOR_AUTH_MEMO.get(memoKey);
    return hit !== undefined && Date.now() < hit;
  } catch {
    return false;
  }
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

// JSON destined for the inside of a <script> element.
//
// JSON.stringify escapes " and \ , which is everything the JavaScript parser
// needs -- and nothing the HTML parser does. An HTML tokenizer ends a script
// element at the first "</script" sequence it sees, with no notion of being
// inside a JS string, so a value carrying one closes the block early and every
// byte after it is parsed as markup. That is a stored XSS on the two pages
// that render caller-supplied data into the preamble: a published list's name
// or item titles (/lists/:user/:slug) and the provider keys and OAuth tokens
// baked into an install link (/:config/configure).
//
// escapeHtmlServer above is the wrong tool here -- it would turn the payload
// into &lt;/script&gt;, which is correct in a text node and wrong inside a
// script element, where the browser does not decode entities at all and the
// literal &lt; would land in the value.
//
// \u003c is a valid escape in BOTH grammars this output has to satisfy: JSON
// (the ld+json blocks) and JavaScript source (everything else). So the parsed
// value is byte-for-byte what it was before -- only the wire bytes change,
// and nothing downstream needs to know this ran.
//
// U+2028 and U+2029 are escaped for a separate, older reason: they are legal
// inside a JSON string but were line terminators in JavaScript source before
// ES2019, so an unescaped one used to be a SyntaxError that took the whole
// bundle with it.
//
// Applied at EVERY stringify that lands in a script element, not only the ones
// reachable by a caller today. Deciding per site is how this was missed twice:
// two prior audits checked the client-side render, where escapeHtml is applied
// correctly, and never the server-rendered preamble. html_checks.py now proves
// the rule holds against a deliberately hostile render -- see its
// MYLXSSPROBE check.
function jsonForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The size of a string as it will actually be stored, in BYTES.
//
// Every *_BYTES_MAX ceiling in 00_constants.js is a byte budget -- KV value
// size, and D1's 2,000,000-byte maximum string/row size, which is why
// CREATOR_LIST_BYTES_MAX exists at all. All four guards measured with
// String.prototype.length, which counts UTF-16 code units, not bytes. For
// ASCII the two agree, which is why this went unnoticed; for anything else
// they do not. A CJK character is 1 unit and 3 bytes, an emoji or any astral
// character is 2 units and 4 bytes -- so a 1.8M-unit list of Japanese titles
// measured 4.7 MB on the wire, passed the guard, and was written to KV. The
// D1 mirror then failed, in the catch that logs and carries on, so the list
// was saved and served while the admin panel could not see it and every
// migrate-d1 run reported the same unclearable error.
//
// The check now measures what the comment always said it measured.
function utf8ByteLength(s) {
  return new TextEncoder().encode(String(s == null ? "" : s)).length;
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

// Keeping a page's real list size across the durable cache tiers.
//
// Several fetchers hang the source's own item count on the array of metas
// they return -- fetchMdblist, fetchTmdbChart, fetchTmdbCollection and the
// rest of the TMDB window fetchers all end with `res.totalItems = <n>`, and
// /api/preview reads exactly that to tell the browser how big a list is
// (25_api-catalog-routes.js).
//
// A property hung on an array does not survive JSON.stringify: `[1,2,3]`
// serializes as `[1,2,3]`, total dropped. Two of the three cache tiers below
// are durable and store JSON, so the count survived a hit in isolate memory
// and vanished on a KV or edge hit -- which is worse than never having it,
// because it made the bug look intermittent. That is what left a "See All"
// header saying 100 items (the first page's length) for a 303-item TMDB
// chart or MDBList list until enough scrolling had paged the rest in.
//
// So the total travels beside the data in the stored envelope and is hung
// back on the array on the way out. Entries written before this shipped
// simply have no `totalItems` key, which reads as "no total" -- the state
// every one of them was already in.
function cacheEnvelopeFor(data, freshUntil) {
  const envelope = { data, freshUntil };
  if (Array.isArray(data) && typeof data.totalItems === "number") {
    envelope.totalItems = data.totalItems;
  }
  return envelope;
}

function rehydrateCachedTotal(envelope) {
  if (envelope && typeof envelope.totalItems === "number" && Array.isArray(envelope.data)) {
    envelope.data.totalItems = envelope.totalItems;
  }
  return envelope;
}

// "Empty" for the purposes of refuseEmptyOverwrite below: an array with no
// items, or a plain object with no keys. A string, number or boolean is never
// treated as empty -- those are real answers.
function isEmptyPayload(value) {
  if (Array.isArray(value)) return value.length === 0;
  // A wrapper carrying its rows under `items` is as empty as the array inside
  // it -- see traktPayloadWithTotal (06_source-fetchers-mdblist-trakt.js),
  // which wraps a Trakt reply so its real item count can survive being
  // cached. Without this, wrapping a response to carry its total would
  // quietly switch this guard off for that cache: { items: [], totalItems: 0 }
  // is an object with two keys, so an empty upstream reply would have counted
  // as a successful refresh and overwritten the last good copy.
  if (value && typeof value === "object" && Array.isArray(value.items)) return value.items.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
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
  refuseEmptyOverwrite = false,
}) {
  const cached = getPerUserCache(cacheKey);
  if (cached && cached.isFresh) {
    return cached.data;
  }

  let kvData = null;
  if (!cached && env && env.CONFIGS && kvKey) {
    try {
      const raw = rehydrateCachedTotal(await env.CONFIGS.get(`cache:${kvKey}`, "json"));
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
        const raw = rehydrateCachedTotal(await edgeRes.json());
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
      // A provider that answers 200 with nothing in it must not be allowed to
      // erase the last good copy -- for the caches where "nothing" cannot be
      // the truth.
      //
      // The gate above is only "not null and not undefined", so an empty array
      // or object counted as a successful refresh and was written over every
      // tier: the isolate memo, the KV copy, and the edge copy. That destroys
      // precisely the last-known-good data the three tiers exist to hold, so a
      // provider blip stopped being "slightly stale rows" and became "empty
      // rows", and the fallback below had nothing left to fall back to. It is
      // not hypothetical: a soft-failed or rate-limited upstream answering
      // `{}` or `{"results":[]}` is an ordinary incident shape, and
      // prewarmSharedCatalogs re-runs every six minutes, so one bad window
      // wrote empties across every shared chart at once.
      //
      // Opt-in, because emptiness is only suspicious for caches the PROVIDER
      // owns. A trending chart is never legitimately empty. A person's Trakt
      // watchlist absolutely is -- they cleared it -- and refusing that write
      // would show them items they had just deleted. So the shared chart and
      // collection call sites pass this and the per-user ones do not.
      const refusingEmpty = refuseEmptyOverwrite && isEmptyPayload(freshData);
      const lastGood = (cached && cached.data) || (kvData && kvData.data) || (edgeCacheData && edgeCacheData.data) || null;
      if (refusingEmpty && lastGood && !isEmptyPayload(lastGood)) {
        console.warn(`[CircuitBreaker] ${providerLabel} returned an empty result; keeping the last non-empty copy rather than caching the empty one.`);
        // Re-stamp the last good copy as fresh in memory before returning it.
        //
        // Without this, refusing the write leaves nothing fresh, so the very
        // next request goes upstream again -- and during exactly the incident
        // this exists for, that turns one bad reply into a request per
        // visitor against a provider already in trouble. Holding the good
        // copy for one fresh window instead means the retry happens on the
        // same cadence a successful refresh would have, and the durable KV and
        // edge copies are deliberately left alone: they still hold the same
        // data, and rewriting them would spend a KV write per empty reply.
        setPerUserCache(cacheKey, lastGood, freshTtlSec, staleTtlSec);
        return lastGood;
      }
      setPerUserCache(cacheKey, freshData, freshTtlSec, staleTtlSec);
      
      const cachePayload = JSON.stringify(
        cacheEnvelopeFor(freshData, Date.now() + freshTtlSec * 1000)
      );

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
// `cost` is how much of the bucket this call spends -- 1 for an ordinary
// request, and for /api/bulk-resolve the number of titles it is about to
// look up. That endpoint's real cost is someone else's TMDB quota, not the
// request itself, so counting requests would move the ceiling by a factor of
// eight the moment a request was split into several smaller invocations.
// Every other caller omits it and behaves exactly as before.
async function consumeRateLimit(env, ctx, bucket, ip, maxPerWindow, windowSec = 60, cost = 1) {
  if (!env || !env.CONFIGS || !ip) return false;
  const key = `ratelimit:${bucket}:${ip}`;
  const used = parseInt((await env.CONFIGS.get(key)) || "0", 10) || 0;
  if (used >= maxPerWindow) return true;
  const spend = Number.isFinite(cost) && cost > 0 ? Math.floor(cost) : 1;
  const write = env.CONFIGS.put(key, String(used + spend), { expirationTtl: windowSec });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
  else await write;
  return false;
}

// --- Per-account authentication failure budget -------------------------------
//
// consumeRateLimit above counts per IP, which is the right dimension for
// abuse of an expensive endpoint and the wrong one for guessing one
// account's secret: IPs are cheap and rotate, the account under attack does
// not. /api/creator/reset-key needs both, because the secret it checks is a
// recovery answer -- see RESET_KEY_ACCOUNT_MAX_FAILURES (00_constants.js).
//
// Counted per account per day and only on FAILURES, so someone who answers
// correctly never spends their own budget, and a locked-out account frees
// itself the next day rather than needing an admin.
//
// D1's upsert is atomic, so when it is bound a burst of concurrent guesses
// cannot all read the same pre-increment value. KV cannot promise that (its
// reads are edge-cached for up to a minute), so the KV path is looser -- but
// that is a one-minute window against a 24-hour bucket, which bounds a burst
// instead of leaving guesses unlimited the way having no per-account counter
// at all did. Same "D1 when bound, KV otherwise" split as the counters.
//
// The KV copies expire on their own via expirationTtl. The D1 rows do not --
// they are one row per (account that was guessed at, day), only ever read
// for the current day, so old ones are inert rather than harmful. Worth a
// sweep eventually if a deployment is attacked persistently; not worth a
// migration today.
const AUTH_FAIL_TTL_SEC = 86400;

async function readAuthFailureCount(env, scope, day) {
  if (env && env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT n FROM stats WHERE kind = ? AND day = ?"
      ).bind(`authfail:${scope}`, day).all();
      // The query SUCCEEDED, so no row means no failures yet. Deliberately
      // not readStatCount's "no row -> fall through to KV" rule: that exists
      // because a missing counter row can mean "not migrated yet", and
      // applying it here would reset the failure count on every attempt.
      return results && results.length ? (Number(results[0].n) || 0) : 0;
    } catch {
      // Table missing (migration 0002 not applied) or D1 unavailable --
      // fall through to KV, which is also where the writes will land.
    }
  }
  if (!env || !env.CONFIGS) return 0;
  return parseInt(await env.CONFIGS.get(`authfail:${scope}:${day}`), 10) || 0;
}

async function noteAuthFailure(env, scope, day) {
  if (env && env.DB) {
    try {
      // d1BumpStat, not a hand-written INSERT. Its statement shape --
      // VALUES (?, ?, ?) with DO UPDATE SET n = n + excluded.n -- is the one
      // every other counter here uses, and it is the atomic part. Writing a
      // near-miss variant of it by hand (DO UPDATE SET n = n + 1, with the
      // amount inlined rather than bound) is exactly how this throttle
      // silently counted nothing at all on D1-bound deployments the first
      // time it was written.
      await d1BumpStat(env, `authfail:${scope}`, [day], 1);
      return;
    } catch {
      // Same fallback as the read above, so both halves stay on one store.
    }
  }
  if (!env || !env.CONFIGS) return;
  const key = `authfail:${scope}:${day}`;
  const n = parseInt(await env.CONFIGS.get(key), 10) || 0;
  await env.CONFIGS.put(key, String(n + 1), { expirationTtl: AUTH_FAIL_TTL_SEC });
}

async function likeVoterId(request, env, creatorUsername, scopeId) {
  if (creatorUsername) return `u:${creatorUsername}`;
  const ip = clientIpKey(request);
  if (!ip) return null;
  const hash = await hashStringForKey(`${ip}|${scopeId}`);
  return `a:${hash}`;
}

function ledgerKeyToListId(ledgerKey) {
  if (typeof ledgerKey !== "string") return "";
  if (ledgerKey.startsWith("listlikevoters:user:")) {
    return "a:" + ledgerKey.slice("listlikevoters:user:".length);
  }
  if (ledgerKey.startsWith("listlikevoters:")) {
    return "c:" + ledgerKey.slice("listlikevoters:".length);
  }
  if (ledgerKey.startsWith("extlikevoters:")) {
    return "ext:" + ledgerKey.slice("extlikevoters:".length);
  }
  return ledgerKey;
}

function listIdToLedgerKey(listId) {
  if (typeof listId !== "string") return "";
  if (listId.startsWith("a:")) {
    return "listlikevoters:user:" + listId.slice(2);
  }
  if (listId.startsWith("c:")) {
    return "listlikevoters:" + listId.slice(2);
  }
  if (listId.startsWith("ext:")) {
    return "extlikevoters:" + listId.slice(4);
  }
  return "listlikevoters:" + listId;
}

async function readLikeVotersFromKv(env, ledgerKey) {
  try {
    if (!env || !env.CONFIGS) return [];
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

// Reads a ledger key's voter list. When D1 is bound, queries list_likes first;
// falls back to KV if D1 returns no rows.
async function readLikeVoters(env, ledgerKey) {
  const listId = ledgerKeyToListId(ledgerKey);
  if (env && env.DB) {
    try {
      const res = await env.DB.prepare(
        "SELECT voter_id FROM list_likes WHERE list_id = ?"
      ).bind(listId).all();
      if (res && Array.isArray(res.results) && res.results.length > 0) {
        return res.results.map((r) => r.voter_id);
      }
    } catch {
      // D1 query failed or table not migrated yet; fall through to KV
    }
  }
  return readLikeVotersFromKv(env, ledgerKey);
}

// Applies one vote to a ledger key and returns the resulting count.
// `capped: true` means the ledger is full (see LIKE_VOTER_CAP) and this
// would have been a new voter -- the caller keeps the existing count rather
// than silently discarding the vote or growing the key without bound.
//
// When D1 is bound, list_likes is authoritative and creator_lists.likes /
// published_lists.likes is updated in D1. KV is mirrored with retry-and-verify
// to support KV-only readers and detect any racing writes across stores.
const LIKE_VOTE_MAX_ATTEMPTS = 3;

async function applyLikeVote(env, ledgerKey, voterId, liked) {
  const listId = ledgerKeyToListId(ledgerKey);
  let lastCount = 0;
  for (let attempt = 0; attempt < LIKE_VOTE_MAX_ATTEMPTS; attempt++) {
    const voters = await readLikeVoters(env, ledgerKey);
    const before = new Set(voters);
    const set = new Set(voters);
    const had = set.has(voterId);
    if (liked) {
      if (!had && set.size >= LIKE_VOTER_CAP) return { count: set.size, capped: true };
      set.add(voterId);
    } else {
      set.delete(voterId);
    }
    lastCount = set.size;
    // No write at all when nothing changed -- KV allows one write per second
    // per key, and a double-tap on a busy list should not burn that budget.
    // The size comparison also collapses a ledger that had duplicate
    // entries, since `set` is deduplicated.
    if (had === liked && set.size === voters.length) {
      return { count: set.size, capped: false };
    }
    if (env && env.CONFIGS) {
      await env.CONFIGS.put(ledgerKey, JSON.stringify([...set]));
    }

    if (env && env.DB) {
      try {
        // If this list had voters in KV that haven't been migrated to D1 yet,
        // seed them into D1 so votes are not dropped.
        if (voters.length > 0) {
          const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM list_likes WHERE list_id = ?").bind(listId).first();
          if (!countRow || countRow.c === 0) {
            const seedBatch = voters.map((v) =>
              env.DB.prepare("INSERT OR IGNORE INTO list_likes (list_id, voter_id, created_at) VALUES (?, ?, ?)").bind(listId, v, Date.now())
            );
            await env.DB.batch(seedBatch);
          }
        }
        if (liked) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO list_likes (list_id, voter_id, created_at) VALUES (?, ?, ?)"
          ).bind(listId, voterId, Date.now()).run();
        } else {
          await env.DB.prepare(
            "DELETE FROM list_likes WHERE list_id = ? AND voter_id = ?"
          ).bind(listId, voterId).run();
        }
        const updatedRow = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM list_likes WHERE list_id = ?"
        ).bind(listId).first();
        const d1Count = updatedRow ? Number(updatedRow.c || 0) : set.size;

        if (listId.startsWith("c:")) {
          await env.DB.prepare("UPDATE creator_lists SET likes = ? WHERE id = ?").bind(d1Count, listId.slice(2)).run();
        } else if (listId.startsWith("a:")) {
          await env.DB.prepare("UPDATE published_lists SET likes = ? WHERE slug = ?").bind(d1Count, listId.slice(2)).run();
        }
      } catch (dbErr) {
        console.error("D1 write error (applyLikeVote):", dbErr);
      }
    }

    if (!env || !env.CONFIGS) {
      return { count: lastCount, capped: false };
    }

    const after = await readLikeVotersFromKv(env, ledgerKey);
    const afterSet = new Set(after);
    if (afterSet.has(voterId) === liked) {
      // Our vote is visible in storage. Done.
      return { count: after.length, capped: false };
    }
    // Our vote is missing. Is there any trace of another writer?
    const anotherWriterLanded = [...afterSet].some((id) => id !== voterId && !before.has(id));
    if (!anotherWriterLanded) {
      // No trace: this is a stale read of the state we already had, not a
      // lost update. Trust our own PUT rather than writing it again.
      return { count: lastCount, capped: false };
    }
    // Someone else's write really did land on top of ours -- sync racing voters into D1 as well
    if (env && env.DB) {
      try {
        for (const racingId of afterSet) {
          if (!before.has(racingId)) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO list_likes (list_id, voter_id, created_at) VALUES (?, ?, ?)"
            ).bind(listId, racingId, Date.now()).run();
          }
        }
      } catch {}
    }
  }
  // Sustained genuine contention on this one list: report what is actually
  // in storage rather than guessing.
  const finalVoters = await readLikeVoters(env, ledgerKey);
  return { count: finalVoters.length, capped: false };
}

// --- Scrobble tokens ---------------------------------------------------------
//
// A media-server webhook URL has to carry its credential in the query
// string: Plex, Jellyfin and Emby let you paste a URL and nothing else. That
// URL then lives in the media server's configuration, in its logs, and in
// any request log along the way.
//
// A scrobble token is a separate, revocable credential that authorises
// exactly one thing: recording playback for one account. In D1, rotation is
// an atomic batch (DELETE old + INSERT new) so revocation takes effect
// immediately everywhere.
function scrobbleTokenKey(token) {
  return `scrobbletoken:${token}`;
}
function creatorScrobbleTokenKey(username) {
  return `creatorscrobbletoken:${username}`;
}

// Returns the account's current token, minting one if it has none.
// `rotate` forces a fresh token and revokes the previous one.
async function getOrCreateScrobbleToken(env, username, rotate = false) {
  let existing = "";
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT token FROM scrobble_tokens WHERE username = ?").bind(username).first();
      if (row && row.token) existing = row.token;
    } catch {}
  }
  if (!existing && env && env.CONFIGS) {
    try {
      existing = (await env.CONFIGS.get(creatorScrobbleTokenKey(username))) || "";
    } catch {
      existing = "";
    }
  }
  if (existing && !rotate) {
    if (env && env.DB) {
      try {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO scrobble_tokens (token, username, created_at) VALUES (?, ?, ?)"
        ).bind(existing, username, Date.now()).run();
      } catch {}
    }
    return existing;
  }

  // Same CSPRNG helper the OAuth state cookies use.
  const token = generateShortId() + generateShortId();
  if (env && env.DB) {
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM scrobble_tokens WHERE username = ?").bind(username),
        env.DB.prepare("INSERT INTO scrobble_tokens (token, username, created_at) VALUES (?, ?, ?)").bind(token, username, Date.now()),
      ]);
    } catch (dbErr) {
      console.error("D1 write error (scrobble_tokens):", dbErr);
    }
  }
  if (env && env.CONFIGS) {
    await env.CONFIGS.put(scrobbleTokenKey(token), username);
    await env.CONFIGS.put(creatorScrobbleTokenKey(username), token);
    if (existing) {
      // Revoke the old one, so a leaked webhook URL actually stops working.
      try {
        await env.CONFIGS.delete(scrobbleTokenKey(existing));
      } catch {
        console.error("scrobble token rotation: could not revoke the previous token");
      }
    }
  }
  return token;
}

// Resolves a presented token to the account it belongs to, or "" .
async function usernameForScrobbleToken(env, token) {
  const t = String(token || "").trim();
  // Shape check before touching KV/D1, so a junk value cannot mint reads.
  if (!t || t.length > 64 || !/^[A-Za-z0-9_-]+$/.test(t)) return "";
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT username FROM scrobble_tokens WHERE token = ?").bind(t).first();
      if (row && row.username) return row.username;
    } catch {}
  }
  if (!env || !env.CONFIGS) return "";
  try {
    const u = (await env.CONFIGS.get(scrobbleTokenKey(t))) || "";
    if (u && env && env.DB) {
      // Check if D1 has an active token for this user; if so, but it doesn't match t, t was revoked
      try {
        const active = await env.DB.prepare("SELECT token FROM scrobble_tokens WHERE username = ?").bind(u).first();
        if (active && active.token && active.token !== t) {
          return "";
        }
        // Lazy backfill into D1
        await env.DB.prepare(
          "INSERT OR IGNORE INTO scrobble_tokens (token, username, created_at) VALUES (?, ?, ?)"
        ).bind(t, u, Date.now()).run();
      } catch {}
    }
    return u;
  } catch {
    return "";
  }
}

// --- "this account deleted that list" ----------------------------------------

//
// A list deleted on one device came back a few minutes later on another, and
// this key is what stops it.
//
// Deleting a list removes its record, its order entry and its directory entry
// -- so from any OTHER signed-in browser, an account that no longer has the
// list is indistinguishable from an account that never received it. That
// browser still holds the list in its own localStorage, and
// renderCreatorDashboard's reconciliation (uploadMissingLocalListsToAccount,
// 22_client-creator-profile.js) exists precisely to push a list the account is
// missing back up. Its own comment describes the recovery it was written for
// -- a browser whose copy survived when the server's did not -- and a deletion
// made somewhere else reads exactly the same way. So the phone re-created what
// the desktop had deleted, and the person's delete undid itself.
//
// The deleting browser already writes a LOCAL tombstone for the same reason
// (recordCreatorListDeletion), which is why the delete sticks on the device it
// was made on and nowhere else. This is that tombstone, kept on the account
// where every device can see it.
//
// Bounded on both axes: entries older than the TTL are dropped on every read
// (a list deleted long ago must not be un-restorable forever if a browser's
// copy is the last one left), and the newest CREATOR_LIST_TOMBSTONE_MAX are
// kept so a bulk delete cannot grow this key without limit.
const CREATOR_LIST_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CREATOR_LIST_TOMBSTONE_MAX = 300;

function creatorListTombstoneKey(username) {
  return `creatorlistdeleted:${username}`;
}

// { slug: deletedAtMs } with anything expired already dropped. Never throws --
// an unreadable record means "no deletions known", which is the behaviour this
// whole mechanism replaces, not a worse one.
async function readCreatorListDeletions(env, username) {
  if (!env || !username) return {};
  const now = Date.now();
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT slug, until FROM list_tombstones WHERE username = ? AND until > ?"
      ).bind(username, now).all();
      if (results && results.length > 0) {
        const out = {};
        for (const row of results) {
          out[row.slug] = row.until;
        }
        return out;
      }
    } catch (e) {
      console.error("D1 read error (readCreatorListDeletions), falling back to KV:", e);
    }
  }
  if (!env.CONFIGS) return {};
  let raw = null;
  try {
    raw = await env.CONFIGS.get(creatorListTombstoneKey(username));
  } catch (e) {
    return {};
  }
  if (!raw) return {};
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const slugs = parsed && typeof parsed === "object" ? (parsed.slugs || parsed) : null;
  if (!slugs || typeof slugs !== "object") return {};
  const out = {};
  for (const [slug, at] of Object.entries(slugs)) {
    const ts = Number(at) || 0;
    if (ts && now - ts < CREATOR_LIST_TOMBSTONE_TTL_MS) out[slug] = ts;
  }
  return out;
}

// Best-effort by design, like bumpCreatorListsStamp: the list is already gone
// by the time this runs, and failing the delete over its bookkeeping would be
// the worse outcome. A lost write costs one device one spurious re-upload --
// exactly what happened before this key existed.
//
// Deliberately does not bump the lists stamp itself: both callers sit inside
// an operation that already does (deleteCreatorLists, /api/creator/lists/save),
// and a bump from here would be a second write for the same change. Anything
// that ever calls this from somewhere else has to bump.
async function writeCreatorListDeletions(env, username, slugs) {
  if (!env || !env.CONFIGS || !username) return;
  try {
    const entries = Object.entries(slugs)
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
      .slice(0, CREATOR_LIST_TOMBSTONE_MAX);
    if (!entries.length) {
      await env.CONFIGS.delete(creatorListTombstoneKey(username));
      return;
    }
    await env.CONFIGS.put(
      creatorListTombstoneKey(username),
      JSON.stringify({ slugs: Object.fromEntries(entries) })
    );
  } catch (e) {
    console.error("could not record the list deletion", e);
  }
}

async function recordCreatorListDeletions(env, username, slugs) {
  if (!env || !username || !slugs || !slugs.length) return;
  const now = Date.now();
  const until = now + CREATOR_LIST_TOMBSTONE_TTL_MS;
  if (env.DB) {
    try {
      const stmts = slugs.filter(Boolean).map((s) =>
        env.DB.prepare(
          "INSERT INTO list_tombstones (username, slug, until) VALUES (?, ?, ?) ON CONFLICT(username, slug) DO UPDATE SET until = excluded.until"
        ).bind(username, String(s), until)
      );
      if (stmts.length > 0) {
        await env.DB.batch(stmts);
      }
    } catch (e) {
      console.error("D1 write error (recordCreatorListDeletions):", e);
    }
  }
  if (env.CONFIGS) {
    const known = await readCreatorListDeletions(env, username);
    for (const slug of slugs) {
      if (slug) known[String(slug)] = now;
    }
    await writeCreatorListDeletions(env, username, known);
  }
}

// The other half: re-creating a list at a slug that was deleted is a
// deliberate act and has to win, or the tombstone would tell every other
// device to throw the new list away. Called by /api/creator/lists/save.
async function clearCreatorListDeletion(env, username, slug) {
  if (!env || !username || !slug) return;
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM list_tombstones WHERE username = ? AND slug = ?").bind(username, String(slug)).run();
    } catch (e) {
      console.error("D1 delete error (clearCreatorListDeletion):", e);
    }
  }
  if (env.CONFIGS) {
    try {
      const known = await readCreatorListDeletions(env, username);
      if (Object.prototype.hasOwnProperty.call(known, String(slug))) {
        delete known[String(slug)];
        await writeCreatorListDeletions(env, username, known);
      }
    } catch (e) {}
  }
}

// Prunes expired tombstone markers from D1 (creator_tombstones and list_tombstones).
// Note: per STORAGE-PLAN-KV-D1.md §5.4, no analytics, telemetry or feedback data is ever pruned.
async function pruneTombstones(env) {
  if (!env || !env.DB) return { prunedCreators: 0, prunedLists: 0 };
  const now = Date.now();
  let prunedCreators = 0;
  let prunedLists = 0;
  try {
    const resCreators = await env.DB.prepare(
      "DELETE FROM creator_tombstones WHERE until < ?"
    ).bind(now).run();
    prunedCreators = (resCreators && resCreators.meta && resCreators.meta.changes) || 0;
  } catch (e) {
    console.error("pruneTombstones (creator_tombstones) error:", e);
  }
  try {
    const resLists = await env.DB.prepare(
      "DELETE FROM list_tombstones WHERE until < ?"
    ).bind(now).run();
    prunedLists = (resLists && resLists.meta && resLists.meta.changes) || 0;
  } catch (e) {
    console.error("pruneTombstones (list_tombstones) error:", e);
  }
  return { prunedCreators, prunedLists };
}

// Deletes one or more of a creator's lists: the KV record, the D1 row, the
// like ledger, the entry in their display order, and the directory index --
// with a single index write and a single order write however many slugs are
// passed.
//
// One function because the account purge and the per-list delete used to be
// written out separately and drifted (see purgeCreatorData's own comment on
// exactly that). The like ledger matters in particular: leaving
// listlikevoters:{user}:{slug} behind means whoever next creates a list at
// that same slug inherits a like count they never earned, and every voter in
// the old ledger is silently unable to like it.
//
// `ok` is the part callers must not ignore, and it is why this returns at all.
// Both the KV delete and the directory removal used to log their failure and
// carry on, and both callers returned ok:true regardless -- so a KV outage
// during a delete answered "deleted" while the record stayed live and public
// at /lists/:user/:slug, with the D1 row gone so the admin panel agreed it had
// been deleted. Same lesson purgeCreatorData already records about itself, in
// the one place that had not learned it: a delete that deleted nothing must
// say so.
async function deleteCreatorLists(env, username, slugs) {
  const out = { deleted: [], missing: [], ok: true };
  if (!env || (!env.CONFIGS && !env.DB) || !username || !slugs || !slugs.length) return out;

  for (const slug of slugs) {
    const key = `creatorlist:${username}:${slug}`;
    let existed = false;
    if (env.CONFIGS) {
      try {
        existed = !!(await env.CONFIGS.get(key));
      } catch {
        existed = false;
      }
    }
    if (env.DB) {
      try {
        const d1Res = await env.DB.prepare("DELETE FROM creator_lists WHERE id = ?").bind(`${username}:${slug}`).run();
        if (d1Res && d1Res.meta && d1Res.meta.changes > 0) {
          existed = true;
        }
        try {
          await env.DB.prepare("DELETE FROM lists_fts WHERE list_id = ?").bind(`c:${username}:${slug}`).run();
        } catch {}
        try {
          await env.DB.prepare("DELETE FROM list_likes WHERE list_id = ?").bind(`c:${username}:${slug}`).run();
        } catch {}
      } catch (dbErr) {
        console.error("D1 write error (deleteCreatorLists):", dbErr);
        out.ok = false;
      }
    }
    // Unconditional: a D1 DELETE matching zero rows still "succeeds", and
    // skipping the KV delete on that basis leaves the list live in KV -- a
    // delete that reports success and deletes nothing.
    if (env.CONFIGS) {
      try {
        await env.CONFIGS.delete(key);
      } catch (e) {
        console.error("deleteCreatorLists: could not delete", key, e);
        // KV is the authoritative store and the one every public read path
        // uses, so this is the failure that means the list is still out there.
        out.ok = false;
      }
      try {
        await env.CONFIGS.delete(`listlikevoters:${username}:${slug}`);
      } catch (e) {
        // A stranded ledger is untidy, not harmful on its own.
      }
    }
    (existed ? out.deleted : out.missing).push(slug);
  }


  try {
    const orderRaw = await env.CONFIGS.get(`creatorlistorder:${username}`);
    let order = [];
    try {
      order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
    } catch {
      order = [];
    }
    const gone = new Set(slugs);
    const next = order.filter((s) => !gone.has(s));
    if (next.length !== order.length || orderRaw) {
      await env.CONFIGS.put(`creatorlistorder:${username}`, JSON.stringify({ order: next }));
    }
  } catch (e) {
    console.error("deleteCreatorLists: could not update list order", e);
  }

  // Every device signed into this account has to be told the list is gone, not
  // merely find it absent -- see readCreatorListDeletions above for why those
  // two are not the same thing to a browser holding its own copy. Recorded for
  // every slug asked for, phantom ones included, for the same reason the order
  // cleanup above covers them: a record that was already missing is exactly
  // the case where some other browser is still holding the only copy.
  await recordCreatorListDeletions(env, username, slugs);

  // Deleting a list is a list change like any other, and the one shape of it a
  // derived stamp could not have seen: a MAX(updated_at) over the surviving
  // records goes DOWN when the newest list is the one removed. See
  // bumpCreatorListsStamp.
  await bumpCreatorListsStamp(env, username);

  return out;
}

// The same thing for an ANONYMOUS published list -- the ones /api/publish-list
// mints under the literal `user` namespace.
//
// These had no delete path at all. Not "no convenient one": no route in this
// Worker could remove a `publishedlist:user:{slug}` key once written, and the
// admin creator-list endpoint could not reach them either, because it runs the
// username through validateCreatorUsername and `user` is a reserved name. So a
// list published anonymously -- by anyone, unauthenticated -- was permanent,
// and an operator faced with abusive or infringing content had nothing to
// reach for but the Cloudflare KV dashboard. Both prior audits recorded the
// gap; this closes it.
//
// Kept separate from deleteCreatorLists rather than parameterised, because the
// two differ in more than the prefix: an anonymous list has no owner, so there
// is no display order to update and no D1 row to drop (they live only in KV).
// What they share -- the like ledger, the directory entry, and reporting a
// failure rather than swallowing it -- is shared here explicitly.
async function deletePublishedLists(env, slugs) {
  const out = { deleted: [], missing: [], ok: true };
  if (!env || (!env.CONFIGS && !env.DB) || !slugs || !slugs.length) return out;

  for (const slug of slugs) {
    const key = `publishedlist:user:${slug}`;
    let existed = false;
    if (env.CONFIGS) {
      try {
        existed = !!(await env.CONFIGS.get(key));
      } catch {
        existed = false;
      }
    }
    if (env.DB) {
      try {
        const d1Res = await env.DB.prepare("DELETE FROM published_lists WHERE slug = ?").bind(slug).run();
        if (d1Res && d1Res.meta && d1Res.meta.changes > 0) {
          existed = true;
        }
        try {
          await env.DB.prepare("DELETE FROM lists_fts WHERE list_id = ?").bind(`a:${slug}`).run();
        } catch {}
        try {
          await env.DB.prepare("DELETE FROM list_likes WHERE list_id = ?").bind(`a:${slug}`).run();
        } catch {}
      } catch (dbErr) {
        console.error("D1 write error (deletePublishedLists):", dbErr);
        out.ok = false;
      }
    }
    if (env.CONFIGS) {
      try {
        await env.CONFIGS.delete(key);
      } catch (e) {
        console.error("deletePublishedLists: could not delete", key, e);
        out.ok = false;
      }
      try {
        await env.CONFIGS.delete(`listlikevoters:user:${slug}`);
      } catch (e) {
        // A stranded ledger is untidy, not harmful on its own.
      }
    }
    (existed ? out.deleted : out.missing).push(slug);
  }

  return out;
}

// --- Slug allocation ---------------------------------------------------------
//
// Picks a slug nothing has claimed yet, given an async predicate that says
// whether a candidate is taken.
//
// Numbered suffixes first, because "-2"/"-3" make far nicer URLs than a
// random token, but only a few of them: the numbered scan is O(n) in how
// many lists already share a name, and at /api/publish-list each of those
// checks is a KV read. 500 collisions meant 501 KV reads for one publish --
// half of Cloudflare's per-invocation subrequest budget, on an
// unauthenticated endpoint, and a condition anyone could manufacture just by
// publishing the same list name repeatedly. After that it switches to a
// random suffix, which needs one check regardless of how crowded the name is.
//
// Returns "" when it cannot find a free slug, and callers MUST treat that as
// a failure. Both call sites previously ran a bounded numbered loop and then
// used whatever slug it exited on -- which, once the bound was reached, was a
// slug that WAS taken. The write then went straight over an existing list:
// at /api/publish-list, publishing a 501st list called "Movies" silently
// replaced the contents of movies-500, returned ok:true, and handed back
// that list's URL as if it were yours.
const SLUG_NUMBERED_ATTEMPTS = 10;
const SLUG_RANDOM_ATTEMPTS = 5;

// Uniqueness, not secrecy -- this only has to avoid colliding with other
// lists sharing a name, so the slight modulo bias here does not matter.
function randomSlugSuffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function pickFreeSlug(baseSlug, isTaken) {
  if (!(await isTaken(baseSlug))) return baseSlug;
  for (let attempt = 2; attempt <= SLUG_NUMBERED_ATTEMPTS; attempt++) {
    const candidate = `${baseSlug}-${attempt}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  for (let attempt = 0; attempt < SLUG_RANDOM_ATTEMPTS; attempt++) {
    const candidate = `${baseSlug}-${randomSlugSuffix()}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return "";
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

// The origin /api/resolve is allowed to refetch from, or null.
//
// That route's `url` parameter named any http(s) origin and the Worker fetched
// it and echoed the body back -- unauthenticated, with no allowlist and no rate
// limit. Off Cloudflare (which the README documents as a supported way to run
// this) loopback and RFC1918 are reachable, so that was an internal-network
// SSRF; on Cloudflare they are not routable from the edge, but it was still an
// unbounded outbound-request generator pointed at the public internet, burning
// this deployment's subrequest budget and putting its egress behind somebody
// else's traffic.
//
// /api/preview grew a provider allowlist for exactly this shape and this
// sibling was missed. It cannot reuse that list, though: the legitimate target
// here is not a provider, it is ANOTHER DEPLOYMENT OF THIS ADD-ON, which lives
// on whatever workers.dev subdomain or custom domain its owner chose. So the
// rule is "a real, public, DNS-named https origin" rather than a fixed set.
//
// The TLD test is what does most of the work. Every hostname that is really an
// IP address in disguise fails it, in every encoding a URL parser accepts:
//
//   http://127.0.0.1/        last label "1"          -> rejected
//   http://2130706433/       no dot at all           -> rejected
//   http://0x7f.0.0.0xff/    last label "0xff"       -> rejected
//   http://[::1]/            hostname has colons     -> rejected
//   http://192.168.1.7:8080/ last label "7", + port  -> rejected
//   https://my.workers.dev/  last label "dev"        -> allowed
//
// Names that resolve inside a private network by suffix are named explicitly,
// since those do have alphabetic TLDs. The port is pinned because a sibling
// deployment is always on 443, and a port is the other half of a scan.
const PRIVATE_HOST_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home.arpa"];

function isRemoteResolveOrigin(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.port && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  // An IPv6 literal keeps its brackets in hostname; either way it has colons.
  if (!host || host.includes(":")) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null;
  // Alphabetic TLD: no IPv4 literal has one, in any encoding.
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return null;
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith("." + suffix)) return null;
  }
  return u.origin;
}

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
// Public list directory index (D1-backed)
// ---------------------------------------------------------------------------
// Replaces the legacy 32-shard KV index with a direct UNION ALL query over
// creator_lists and published_lists in D1, filtered by visibility = 'public'
// and ordered by likes DESC, updated_at DESC.
//
// When D1 is not bound, falls back to scanning public lists from KV.
async function getPublicListIndex(env, ctx) {
  if (env && env.DB) {
    try {
      const query = `
        SELECT
          'c:' || cl.id AS id,
          1 AS isCreator,
          cl.username AS username,
          COALESCE(c.display_name, cl.username) AS creatorName,
          substr(cl.id, length(cl.username) + 2) AS slug,
          cl.name AS name,
          cl.type AS type,
          CASE WHEN json_valid(cl.items_json) THEN json_array_length(cl.items_json) ELSE 0 END AS itemCount,
          cl.likes AS likes,
          cl.updated_at AS updatedAt
        FROM creator_lists cl
        LEFT JOIN creators c ON c.username = cl.username
        WHERE cl.visibility = 'public'

        UNION ALL

        SELECT
          'a:' || pl.slug AS id,
          0 AS isCreator,
          'user' AS username,
          'Anonymous' AS creatorName,
          pl.slug AS slug,
          pl.name AS name,
          pl.type AS type,
          CASE WHEN json_valid(pl.items_json) THEN json_array_length(pl.items_json) ELSE 0 END AS itemCount,
          pl.likes AS likes,
          pl.updated_at AS updatedAt
        FROM published_lists pl
        WHERE pl.visibility = 'public'

        ORDER BY likes DESC, updatedAt DESC
      `;
      const res = await env.DB.prepare(query).all();
      const rows = (res && res.results) ? res.results : [];
      return rows.map((r) => ({
        ...r,
        isCreator: Boolean(r.isCreator),
      }));
    } catch (e) {
      console.error("getPublicListIndex D1 query error:", e);
      return null;
    }
  }

  // KV fallback when D1 is not bound
  if (env && env.CONFIGS) {
    try {
      const fetchLimit = 200;
      const [pubRes, creatorRes] = await Promise.all([
        env.CONFIGS.list({ prefix: "publishedlist:user:", limit: fetchLimit }),
        env.CONFIGS.list({ prefix: "creatorlist:", limit: fetchLimit }),
      ]);
      const listKeys = [];
      (pubRes.keys || []).forEach(k => listKeys.push({ key: k.name, isCreator: false }));
      (creatorRes.keys || []).forEach(k => {
        const rest = k.name.slice("creatorlist:".length);
        if (rest.includes(":")) listKeys.push({ key: k.name, isCreator: true });
      });

      const creatorExists = makeCreatorExistsMemo(env);
      const entries = (await Promise.all(
        listKeys.slice(0, fetchLimit).map(async ({ key, isCreator }) => {
          const raw = await env.CONFIGS.get(key);
          if (!raw) return null;
          try {
            const l = JSON.parse(raw);
            if (!isPublicListVisibility(l.visibility)) return null;
            let username = "user";
            let slug = l.slug || "";
            let creatorName = "Anonymous";
            let id = "";
            if (isCreator) {
              const parts = key.slice("creatorlist:".length).split(":");
              username = parts[0] || "creator";
              slug = parts[1] || slug;
              id = `c:${username}:${slug}`;
              if (!(await creatorExists(username))) return null;
              try {
                const profileRaw = await getCreator(env, username);
                if (profileRaw) creatorName = JSON.parse(profileRaw).displayName || username;
              } catch {
                creatorName = username;
              }
            } else {
              slug = key.slice("publishedlist:user:".length);
              id = `a:${slug}`;
            }
            return {
              id,
              isCreator,
              username,
              creatorName,
              slug,
              name: l.name || slug,
              type: l.type || "mixed",
              itemCount: Array.isArray(l.items) ? l.items.length : 0,
              likes: Number(l.likes) || 0,
              updatedAt: l.updatedAt || l.publishedAt || l.createdAt || null,
            };
          } catch {
            return null;
          }
        })
      )).filter(Boolean);

      return entries.sort((a, b) => (b.likes || 0) - (a.likes || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
      return null;
    }
  }

  return null;
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

// --- Optimistic concurrency for the synced blobs -----------------------------
//
// Every /api/creator/sync/save* endpoint stores one wholesale blob per
// account, and a second device autosaving a stale snapshot replaces it. The
// guard for that is the client sending back the updatedAt its edits are
// built on; these two helpers are the parts of it that were wrong or
// missing.
//
// parseExpectedUpdatedAt distinguishes ABSENT from MALFORMED. Absent means an
// older client, which keeps its previous last-write-wins behaviour on
// purpose -- this was always meant to be additive. Malformed used to mean
// the same thing, because the check was `Number.isFinite(body.
// expectedUpdatedAt)` and Number.isFinite("1788650901055") is false: a
// client that round-tripped the stamp through localStorage, a dataset
// attribute or a form field sent a string and got last-write-wins with no
// error anywhere. A value that is present but unusable is a client bug, and
// silently dropping the only protection against overwriting someone else's
// work is the worst available response to it.
function parseExpectedUpdatedAt(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: false };
  if (typeof raw !== "string" && typeof raw !== "number") return { ok: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

// nextSyncVersion makes the stamp strictly increasing.
//
// Date.now() is frozen for the duration of a Workers request and only
// advances on I/O, so two saves genuinely can carry the same millisecond.
// With a bare timestamp as the version, `stored.updatedAt > expected` then
// cannot tell a stale write from a current one, and the stale one wins --
// silently, with both requests answering 200. Comparing with >= instead is
// not the fix: expected === stored is the NORMAL case (my edits are built on
// exactly the version that is stored), so >= would reject every legitimate
// save.
//
// Advancing past the stored value by at least one instead means a write
// always produces a version no earlier write can claim, which is what the
// comparison needs. It also makes the guard survive a clock that moves
// backwards.
function nextSyncVersion(currentUpdatedAt) {
  const now = Date.now();
  const prev = Number(currentUpdatedAt);
  return Number.isFinite(prev) && prev >= now ? prev + 1 : now;
}

// --- "the custom lists changed" stamp ----------------------------------------
//
// /api/creator/sync/meta answers the browser's "has anything moved?" poll from
// four stored blobs, and reading those real records is what makes its answer
// impossible to drift from the truth. Custom lists have no such blob -- they
// are one record per list (creatorlist:{user}:{slug}) plus an order key -- so
// there was nothing for meta to read, and it reported "nothing changed" for an
// account whose lists had just been rewritten from another device. A resumed
// browser therefore kept showing a list that had moved on, and went on showing
// it through the 60s poll and through every tab switch, until something else
// happened to change one of the four (FE-17).
//
// This is the missing fifth stamp. It IS the dedicated key meta's own comment
// argues against -- "a single missed write there would silently stop a device
// from ever syncing again" -- so the mitigation is structural rather than
// hopeful: every list mutation in the codebase goes through one of five call
// sites, all of which call this, and tests/client.test.mjs fails the build if a
// sixth writer of a creatorlist:/creatorlistorder: key appears without one.
//
// Best-effort by design. A failed bump costs one browser a delayed refresh;
// throwing would fail a save whose data is already safely stored.
//
// `notBefore` is a floor the new stamp must clear. It exists for the one caller
// that destroys the key before bumping it: purgeCreatorData sweeps
// creatorliststamp: along with everything else, so the read below finds nothing,
// prev falls to 0, and the new stamp is a bare Date.now() -- which ties with the
// previous stamp whenever the whole reset lands inside one millisecond. A tie
// reads as "nothing changed" to a polling browser, which is precisely the state
// this stamp exists to prevent. CI caught that as a flake; it is a real hole,
// not a flaky test.
async function bumpCreatorListsStamp(env, username, notBefore) {
  if (!env || !username) return;
  try {
    let prev = Number(notBefore) || 0;
    if (env.DB) {
      try {
        const { results } = await env.DB.prepare("SELECT lists_stamp FROM creators WHERE username = ?").bind(username).all();
        if (results && results.length > 0 && results[0].lists_stamp != null) {
          prev = Math.max(prev, Number(results[0].lists_stamp) || 0);
        }
      } catch (dbErr) {
        console.error("D1 read error (bumpCreatorListsStamp):", dbErr);
      }
    }
    if (prev === (Number(notBefore) || 0) && env.CONFIGS) {
      try {
        const raw = await env.CONFIGS.get(`creatorliststamp:${username}`);
        if (raw) {
          try { prev = Math.max(prev, Number(JSON.parse(raw).updatedAt) || 0); } catch {}
        }
      } catch (e) {}
    }
    // Strictly increasing, for the same reason the sync blob's own version is:
    // the client compares with >, so two saves inside one millisecond must not
    // land on the same number.
    const nextStamp = nextSyncVersion(prev);
    if (env.DB) {
      try {
        await env.DB.prepare("UPDATE creators SET lists_stamp = ? WHERE username = ?")
          .bind(nextStamp, username)
          .run();
      } catch (dbErr) {
        console.error("D1 write error (bumpCreatorListsStamp):", dbErr);
      }
    }
    if (env.CONFIGS) {
      await env.CONFIGS.put(
        `creatorliststamp:${username}`,
        JSON.stringify({ updatedAt: nextStamp })
      );
    }
  } catch (e) {
    console.error("bumpCreatorListsStamp: could not record a list change", e);
  }
}

// --- Deleted-username tombstones ---------------------------------------------
//
// A purge is a sweep, and a sweep is a moment in time. Every authenticated
// route verifies the key once at the top and then writes; nothing re-checked
// that the account still existed by the time the write landed. So a request
// that authenticated a moment before delete-account and finished a moment
// after it PUT its key back, after the sweep had already gone past. The purge
// had already reported success and freed the username -- so the next person to
// register that name inherited whatever had been resurrected. Measured: all
// seven authenticated write paths did it, and `creatorsync:{u}` carries
// `keys`, which is where the account's own TMDB/Trakt/MDBList/Simkl
// credentials live.
//
// The tombstone closes both halves. It is written BEFORE the sweep starts, so
// any request that authenticates from then on is refused; and it is checked by
// /api/creator/create, so the username cannot be re-registered while a
// straggler might still be writing. Combined with the second sweep at the end
// of purgeCreatorData, what is left is only a request that authenticated
// before the tombstone AND is still running after the second sweep -- and even
// that cannot reach a new owner, because the name is not available yet.
//
// Five minutes is chosen to comfortably outlast both an in-flight request and
// KV's own propagation window, which is the other reason a just-deleted
// account can still authenticate somewhere.
const CREATOR_TOMBSTONE_TTL_SEC = 300;

function creatorTombstoneKey(username) {
  return `creatordeleted:${username}`;
}

// Fails OPEN on a read error, deliberately. This gates ordinary sign-in, and a
// KV blip must not lock every creator out of their own account; the sweep and
// the reclaim check are the load-bearing parts, not this.
//
// The KV copy alone leaves one window open. KV reads are edge-cached, so a
// colo that has seen neither this key nor the `creator:{u}` delete answers
// both from its own cached copy -- and a deleted account keeps authenticating
// until that window passes. D1 has no such window, so when it is bound it is
// consulted too. The KV check stays first and is usually the only one that
// runs: it is the cheaper read, and it is the whole answer for the many
// deployments with no D1 at all.
//
// Note this cannot be inferred from `creators` instead. A missing row there
// means "not migrated into D1 yet", which is the lazy-migration state every
// accessor here tolerates -- deleted and not-yet-migrated are the same shape.
// Hence a table whose rows mean one thing only. See migrations/0004.
async function isCreatorTombstoned(env, username) {
  if (!env || !username) return false;
  if (env.CONFIGS) {
    try {
      if (await env.CONFIGS.get(creatorTombstoneKey(username))) return true;
    } catch (e) {
      console.error("could not read the deletion tombstone for", username, e);
    }
  }
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT until FROM creator_tombstones WHERE username = ?"
      ).bind(username).all();
      if (results && results.length) {
        // Expired rows are inert rather than a permanent block on
        // re-registering the name, so an old one does not accumulate meaning.
        return Number(results[0].until) > Date.now();
      }
    } catch (e) {
      // Table missing (migration 0004 not applied) or D1 unavailable. The KV
      // copy above is the fallback, exactly as it is for every other counter.
    }
  }
  return false;
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
  // Read before the sweep below deletes it, so the bump at the end can still
  // guarantee the stamp moves forward -- see bumpCreatorListsStamp's notBefore.
  let priorListsStamp = 0;
  try {
    const stampRaw = await env.CONFIGS.get(`creatorliststamp:${u}`);
    if (stampRaw) priorListsStamp = Number(JSON.parse(stampRaw).updatedAt) || 0;
  } catch (e) {
    // An unreadable stamp is no worse than the absent one this used to assume.
  }
  let listsCleared = 0;
  const purgedListIds = [];
  let keysCleared = 0;
  // Anything that would leave account-owned data behind flips this. Every
  // step below used to log its failure and carry on, which made a sweep that
  // THREW indistinguishable from one that found nothing -- and the caller
  // returned ok:true either way. That is how "delete my account" came to
  // report success, leave every list live and public, and still free the
  // username: whoever registered it next inherited the previous owner's
  // lists, private ones and their contents included, via the orphan-recovery
  // sweep in /api/creator/lists.
  //
  // The function's own comment already described the intent -- the identity
  // goes last "so that a failure partway through leaves an account that can
  // still sign in and retry" -- but nothing was actually watching for that
  // failure. This is.
  let dataSweepFailed = false;

  // Before anything is deleted, so that a request arriving from here on is
  // refused rather than racing the sweep -- see the tombstone comment above.
  // Only for a real deletion: account/reset keeps the identity and the account
  // has to stay usable the moment it returns.
  //
  // Best-effort. If this write fails the purge still runs; what is lost is the
  // narrowing, not the sweep.
  if (deleteIdentity) {
    try {
      await env.CONFIGS.put(creatorTombstoneKey(u), "1", { expirationTtl: CREATOR_TOMBSTONE_TTL_SEC });
    } catch (e) {
      console.error("purgeCreatorData: could not write the deletion tombstone", e);
    }
    // And in D1 when it is bound, which is the copy without a propagation
    // window -- see isCreatorTombstoned. Best-effort like the KV one: a
    // deployment with no D1, or an unapplied migration 0004, keeps exactly the
    // KV behaviour.
    if (env.DB) {
      try {
        await env.DB.prepare(
          "INSERT INTO creator_tombstones (username, until) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET until = excluded.until"
        ).bind(u, Date.now() + CREATOR_TOMBSTONE_TTL_SEC * 1000).run();
      } catch (dbErr) {
        console.error("purgeCreatorData: could not write the D1 deletion tombstone:", dbErr);
      }
    }
  }

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
    dataSweepFailed = true;
  }

  if (env.DB) {
    try {
      // `WHERE username = ?`, NOT `WHERE id LIKE '{u}:%'`.
      //
      // validateCreatorUsername allows [a-z0-9_-], and `_` is SQL LIKE's
      // single-character wildcard. Interpolating the username into a LIKE
      // pattern therefore made one account's purge a wildcard against every
      // other account's list ids: a creator named `a_c-films` deleting their
      // own account also deleted every D1 row belonging to `abc-films`,
      // `axc-films`, `a1c-films` and so on -- silently, because KV still had
      // the records so nothing visibly broke, while the D1 like counts were
      // gone and the next ordinary edit wrote those zeroes back into KV.
      //
      // Usernames are 3-25 characters and `___` is a legal one, so the scaled
      // version needed no credentials at all: register one all-underscore
      // name per length, call the self-service /api/creator/account/reset on
      // each, and creator_lists is empty for the whole deployment.
      //
      // The username column is what this actually means, it is indexed
      // (idx_creator_lists_username), it is an equality rather than a scan,
      // and it has no pattern syntax to escape. The FK's ON DELETE CASCADE
      // covers the identity path too, so this is belt-and-braces there -- but
      // it is the only thing covering account/reset, which keeps the creator
      // row.
      await env.DB.prepare("DELETE FROM creator_lists WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM lists_fts WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM list_tombstones WHERE username = ?").bind(u).run();
      const escapedU = u.replace(/([%_\\])/g, "\\$1");
      await env.DB.prepare("DELETE FROM list_likes WHERE list_id LIKE ? ESCAPE '\\'").bind(`c:${escapedU}:%`).run();
      if (deleteIdentity) {
        await env.DB.prepare("DELETE FROM list_likes WHERE voter_id = ?").bind(`u:${u}`).run();
      }
      await env.DB.prepare("DELETE FROM scrobble_tokens WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM watch_history WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM continue_watching WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM airing_next WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM creator_user_lists WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM creator_show_states WHERE username = ?").bind(u).run();
      await env.DB.prepare("DELETE FROM creator_tracking_meta WHERE username = ?").bind(u).run();
    } catch (dbErr) {
      console.error("D1 write error (purgeCreatorData lists):", dbErr);
      dataSweepFailed = true;
    }
  }

  // The scrobble token is keyed by the token, not the username, so it has to
  // be resolved through the reverse index before that index is deleted --
  // otherwise a deleted or reset account leaves a live webhook credential
  // behind that still authorises writes for it.
  try {
    const staleToken = await env.CONFIGS.get(creatorScrobbleTokenKey(u));
    if (staleToken) {
      await env.CONFIGS.delete(scrobbleTokenKey(staleToken));
      keysCleared++;
    }
  } catch (e) {
    console.error("purgeCreatorData: could not revoke the scrobble token", e);
    // A live webhook credential for an account that is about to stop
    // existing is exactly the kind of leftover that must not be reported as
    // a clean delete.
    dataSweepFailed = true;
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
    `creatorliststamp:${u}`,
    // The account's list-deletion record (readCreatorListDeletions). Nothing
    // owns it once the account does not, and leaving it behind would tell a
    // re-registered username's browsers to discard lists it never deleted.
    creatorListTombstoneKey(u),
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
    // The reverse index only. The token key itself is keyed BY TOKEN, so it
    // cannot be reached from a username prefix -- it is deleted explicitly
    // just above this list.
    creatorScrobbleTokenKey(u),
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
      dataSweepFailed = true;
    }
  }

  let identityRemoved = false;
  if (deleteIdentity) {
    // Last, and only for delete-account: the identity itself. Done after
    // the data sweep so that a failure partway through leaves an account
    // that can still sign in and retry, rather than orphaned data with no
    // owner and a username nobody can ever reclaim.
    //
    // Gated on the sweep having actually worked, because deleting the
    // identity is what FREES THE USERNAME. Doing that while the account's
    // lists are still sitting in KV hands them to whoever registers the name
    // next -- the failure mode this used to have.
    if (!dataSweepFailed) {
      // D1 before KV, which is the opposite of the old order and the whole
      // of the second half of this fix. getCreator falls back to D1, so a
      // swallowed D1 failure after the KV row was already gone left a
      // "deleted" account that still authenticated and could still write --
      // while its owner had been told it was gone. Doing the store that can
      // fail FIRST means a failure aborts before anything is destroyed.
      let d1Ok = true;
      if (env.DB) {
        try {
          await env.DB.prepare("DELETE FROM creators WHERE username = ?").bind(u).run();
        } catch (dbErr) {
          console.error("D1 write error (purgeCreatorData identity):", dbErr);
          d1Ok = false;
        }
      }
      if (d1Ok) {
        try {
          await env.CONFIGS.delete(`creator:${u}`);
          keysCleared++;
          identityRemoved = true;
        } catch (e) {
          console.error("purgeCreatorData: could not delete identity", e);
        }
        try {
          await env.CONFIGS.delete(`creatorlastseen:${u}`);
          keysCleared++;
        } catch (e) {}
      }
    }
  }

  // Any verification memoized in a warm isolate must stop being honoured
  // the instant the account it refers to is reset or removed.
  try { invalidateCreatorAuthMemo(); } catch (e) {}

  // Second pass, after the identity is gone.
  //
  // The first pass ran while the account was still able to authenticate, so a
  // request already past its own auth check could still be writing during it.
  // The tombstone stops any request that STARTS from here on; this catches
  // whatever landed in between. Cheap -- one list() and a handful of deletes
  // against keys that are almost always already absent -- and it runs only on
  // the deletion path, where a leftover is inheritable.
  //
  // Deliberately not folded into `dataSweepFailed`: the identity is already
  // gone by now, so failing here cannot un-delete the account, and reporting
  // failure would send the owner back to retry a delete that has in fact
  // happened. Anything still stranded is unreachable (no identity, no key)
  // and cannot be inherited either, because the tombstone holds the username
  // for longer than any request can run.
  if (deleteIdentity && identityRemoved) {
    // Whatever this pass finds also has to come OUT OF THE DIRECTORY. The
    // first pass collects its ids into purgedListIds and hands them to
    // removeListsFromPublicIndex above; this one only deleted the KV keys, so
    // a list that landed between the two passes had its record removed and its
    // index entry left behind -- a directory row advertising an item count
    // that 404s the moment anyone opens it. Same failure the batch removal
    // exists to prevent, one pass later.
    const lateListIds = [];
    try {
      let cursor;
      for (let page = 0; page < 5; page++) {
        const res = await env.CONFIGS.list({ prefix: `creatorlist:${u}:`, cursor });
        for (const k of res.keys) {
          await env.CONFIGS.delete(k.name);
          const listPath = k.name.slice("creatorlist:".length);
          lateListIds.push("c:" + listPath);
          try { await env.CONFIGS.delete(`listlikevoters:${listPath}`); } catch (e) {}
          listsCleared++;
        }
        if (res.list_complete || !res.cursor) break;
        cursor = res.cursor;
      }
      // Resolve the token through the reverse index again: a scrobble-token
      // request that landed in between minted a NEW token, so the one the
      // first pass revoked is not the one that now exists.
      try {
        const revived = await env.CONFIGS.get(creatorScrobbleTokenKey(u));
        if (revived) await env.CONFIGS.delete(scrobbleTokenKey(revived));
      } catch (e) {}
      for (const key of dataKeys) {
        await env.CONFIGS.delete(key);
      }
      await env.CONFIGS.delete(`creator:${u}`);
      await env.CONFIGS.delete(`creatorlastseen:${u}`);
    } catch (e) {
      console.error("purgeCreatorData: the post-deletion sweep did not finish", e);
    }
    if (lateListIds.length && env.DB) {
      try {
        await env.DB.prepare("DELETE FROM creator_lists WHERE username = ?").bind(u).run();
        await env.DB.prepare("DELETE FROM lists_fts WHERE username = ?").bind(u).run();
      } catch (e) {
        console.error("purgeCreatorData: could not drop late lists from D1", e);
      }
    }
  }

  // A delete that did not happen must not keep the username reserved, or a
  // failed attempt would lock the owner out of their own working account for
  // the tombstone's lifetime.
  if (deleteIdentity && !identityRemoved) {
    try {
      await env.CONFIGS.delete(creatorTombstoneKey(u));
    } catch (e) {
      console.error("purgeCreatorData: could not clear the tombstone after a failed delete", e);
    }
    if (env.DB) {
      try {
        await env.DB.prepare("DELETE FROM creator_tombstones WHERE username = ?").bind(u).run();
      } catch (dbErr) {
        console.error("purgeCreatorData: could not clear the D1 tombstone after a failed delete:", dbErr);
      }
    }
  }

  // An account/reset empties the lists but leaves the person signed in on
  // every device, so the stamp has to move or those browsers keep rendering
  // lists that no longer exist. Deliberately after the sweep above, which
  // deletes creatorliststamp: along with the rest -- and skipped entirely for
  // a full account delete, where there is no account left to poll.
  //
  // Gated on having actually removed something, because /api/creator/create
  // runs this as a pre-create purge over a name that is usually clean: an
  // unconditional bump there would hand every brand-new account a non-zero
  // stamp describing a list change that never happened.
  if (!deleteIdentity && listsCleared > 0) {
    await bumpCreatorListsStamp(env, u, priorListsStamp);
  }

  // `ok` is the whole point: it is false when this call left something
  // behind, and both callers turn that into an error rather than a 200.
  return {
    ok: !dataSweepFailed && (!deleteIdentity || identityRemoved),
    listsCleared,
    keysCleared,
    identityRemoved,
  };
}

// D1 is an optional accelerator in front of KV, never a replacement for it
// -- KV remains the store every account is guaranteed to exist in (see the
// unconditional KV writes in the create/rotate paths).
//
// KV IS READ FIRST. That sentence above was already the design; the code
// contradicted it by asking D1 first, and the contradiction is what four
// separate defects were made of. The asymmetry: every D1 WRITE in this
// codebase is optional (wrapped in a catch that logs and carries on, because
// KV is the store that matters), while every D1 READ was preferred. So any
// dropped D1 write became a permanent, invisible lie that outranked the
// truth:
//
//   * a rotation whose D1 update threw left the OLD key authenticating and
//     the new one rejected, and no repair tool could fix it;
//   * an account whose D1 delete threw kept authenticating and writing after
//     its owner had been told it was deleted;
//   * a list whose D1 row was missing reported 0 likes -- and the next
//     ordinary save read that 0 back out and wrote it into KV, destroying a
//     real count in the authoritative store;
//   * a visibility change whose D1 write was dropped left the owner's own
//     dashboard saying "private" about a list the world could read.
//
// D1 is the authoritative store for creator identities when bound.
// KV serves as a read-through cache and fallback for unmigrated accounts.
async function getCreator(env, username) {
  if (env && env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT * FROM creators WHERE username = ?').bind(username).all();
      if (results && results.length > 0) {
        const row = results[0];
        const payload = {
          displayName: row.display_name,
          keyHash: row.key_hash,
          recoveryAnswerHash: row.recovery_answer_hash,
          createdAt: row.created_at,
          lastActive: row.last_active || null,
          shareJson: row.share_json || null,
          listsStamp: row.lists_stamp != null ? row.lists_stamp : null,
        };
        const raw = JSON.stringify(payload);
        try {
          if (env.CONFIGS) await env.CONFIGS.put(`creator:${username}`, raw);
        } catch (kvErr) {
          console.error("KV cache write error (getCreator):", kvErr);
        }
        return raw;
      }
    } catch (e) {
      console.error("D1 read error (getCreator), falling back to KV:", e);
    }
  }
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(`creator:${username}`);
      if (raw) {
        if (env.DB) {
          backfillCreatorRowInD1(env, username).catch((e) => console.error("Lazy backfill creator to D1 error:", e));
        }
        return raw;
      }
    } catch (e) {
      console.error("KV read error (getCreator):", e);
    }
  }
  return null;
}

// "Does this account still exist", memoized for one request.
//
// A creator list whose creator is gone is an orphan -- left behind by a save
// that raced its owner's account deletion, which the two purge sweeps cannot
// fully prevent because nothing bounds how late a KV write may land. The
// public list route refuses to serve one; these are the two places that
// ADVERTISE lists by reading records directly (the cold-index fallbacks in
// /lists/public.json and /api/search-published-lists), and without this they
// kept offering a row that 404s the moment anyone opens it.
//
// The promise, not the result, goes in the map: both callers fan out over a
// page of keys with Promise.all, so a hundred lists by one creator would
// otherwise each start their own lookup.
//
// A read that FAILED counts as present. getCreator already falls back to D1
// and only returns null when neither store has the account, so this only fires
// on a genuine absence -- and hiding live lists over a transient KV error
// would be the worse mistake.
function makeCreatorExistsMemo(env) {
  const cache = new Map();
  return function creatorExists(username) {
    if (!username) return Promise.resolve(false);
    if (cache.has(username)) return cache.get(username);
    const pending = (async () => {
      try {
        return !!(await getCreator(env, username));
      } catch {
        return true;
      }
    })();
    cache.set(username, pending);
    return pending;
  };
}

// Copies an account's identity row from KV into D1, if it is not there
// already. Returns true when D1 now has a row for this account.
//
// D1 enforces foreign keys by default, so creator_lists.username ->
// creators.username rejects a list write for an account that has not been
// migrated yet -- which is precisely the lazy-migration state the accessors
// above are built to tolerate. The list itself is never at risk (KV is
// authoritative and read first), but a mirror that quietly never fills is
// how a list ends up invisible to the admin panel and to every D1-backed
// query. This is the compensating write, used only after such a failure.
async function backfillCreatorRowInD1(env, username) {
  if (!env || !env.DB || !env.CONFIGS) return false;
  try {
    const raw = await env.CONFIGS.get(`creator:${username}`);
    if (!raw) return false;
    const profile = JSON.parse(raw);
    await env.DB.prepare(
      "INSERT INTO creators (username, display_name, key_hash, recovery_answer_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING"
    ).bind(
      username,
      profile.displayName || username,
      profile.keyHash || "",
      profile.recoveryAnswerHash || null,
      profile.createdAt || 0
    ).run();
    return true;
  } catch (e) {
    console.error("could not backfill a creator row into D1:", e);
    return false;
  }
}

// Puts a rotated key hash into D1, or makes sure D1 cannot answer with the
// OLD one -- and says which, so the caller can decide whether the rotation
// actually happened.
//
// Both rotation endpoints used to wrap this statement in a catch that logged
// and carried on, then wrote KV and returned ok:true with a brand-new key.
// The zero-rows case was already handled (see meta.changes below); a THROW
// was not. Because getCreator prefers D1, a swallowed throw left the old
// hash answering every lookup: the caller got a key that would never work
// while the key they were rotating BECAUSE IT LEAKED kept working forever,
// and /admin/api/migrate-d1 could not repair it either. That is the worst
// possible direction for this particular endpoint to fail in.
//
// So a throw is now compensated rather than ignored. Dropping the row is
// enough and is safe: KV holds every account unconditionally and getCreator
// falls back to it, so an account with no D1 row is a fully working account
// (that is the lazy-migration state this codebase is built to tolerate) --
// and /admin/api/migrate-d1 puts the row back.
//
// If even the DELETE fails, D1 is unreachable rather than merely unhappy, and
// there is nothing that can stop it serving the old hash. Then the honest
// answer is "this did not happen": the caller MUST NOT write KV, because
// rotating KV while D1 keeps answering with the old hash would leave neither
// key working and lock the owner out of their own account.
async function rotateCreatorKeyHashInD1(env, username, keyHash) {
  if (!env || !env.DB) return { ok: true };
  try {
    // meta.changes, not merely "did not throw". A D1 UPDATE that matches ZERO
    // rows succeeds -- so for any account that exists in KV but was never
    // migrated into D1, this used to report success, skip the KV write, and
    // rotate nothing at all.
    const res = await env.DB.prepare(
      "UPDATE creators SET key_hash = ? WHERE username = ?"
    ).bind(keyHash, username).run();
    if (!(res && res.meta && res.meta.changes > 0)) {
      // Row absent (never migrated). Not an error -- the unconditional KV
      // write is the source of truth -- but worth surfacing.
      console.warn("D1 key rotation matched no row for", username, "-- KV updated");
    }
    return { ok: true };
  } catch (dbErr) {
    console.error("D1 write error (key rotation):", dbErr);
    try {
      await env.DB.prepare("DELETE FROM creators WHERE username = ?").bind(username).run();
      return { ok: true, droppedD1Row: true };
    } catch (delErr) {
      console.error("D1 key rotation could not be made consistent:", delErr);
      return { ok: false };
    }
  }
}

// D1 is the authoritative store for creator lists when bound.
// KV serves as a read-through cache and fallback for unmigrated lists.
//
// Note the slug: a D1 row's id is `{username}:{slug}`, and splitting on ":"
// would truncate a slug containing one. slugifyServer cannot produce such a
// slug, but the caller already knows the right answer, so use it.
async function getCreatorList(env, username, slug) {
  if (env && env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT * FROM creator_lists WHERE id = ?').bind(`${username}:${slug}`).all();
      if (results && results.length > 0) {
        const row = results[0];
        let kvData = null;
        if (env.CONFIGS) {
          try {
            const rawKv = await env.CONFIGS.get(`creatorlist:${username}:${slug}`);
            if (rawKv) kvData = JSON.parse(rawKv);
          } catch {}
        }

        // If KV has a fresher edit because a D1 write was dropped, prefer KV and repair D1
        const kvIsFresher = kvData && typeof kvData.updatedAt === "number" && kvData.updatedAt > (row.updated_at || 0);
        const name = kvIsFresher && kvData.name ? kvData.name : row.name;
        const type = kvIsFresher && kvData.type ? kvData.type : row.type;
        const visibility = kvIsFresher && kvData.visibility ? kvData.visibility : row.visibility;
        const items = kvIsFresher && Array.isArray(kvData.items) ? kvData.items : JSON.parse(row.items_json || '[]');

        let likes = row.likes || 0;
        if (kvData && typeof kvData.likes === "number" && kvData.likes > likes) {
          likes = kvData.likes;
        }

        let updatedAt;
        if (kvData && !("updatedAt" in kvData)) {
          // Explicit legacy record without updatedAt
          updatedAt = undefined;
        } else if (kvIsFresher) {
          updatedAt = kvData.updatedAt;
        } else {
          updatedAt = row.updated_at > 0 ? row.updated_at : (kvData && kvData.updatedAt ? kvData.updatedAt : undefined);
        }

        if (kvIsFresher) {
          try {
            env.DB.prepare(
              "UPDATE creator_lists SET name = ?, type = ?, visibility = ?, items_json = ?, updated_at = ? WHERE id = ?"
            ).bind(name, type, visibility, JSON.stringify(items), updatedAt || 0, `${username}:${slug}`).run().catch(() => {});
          } catch {}
        }

        const payload = {
          slug,
          name,
          type,
          visibility,
          items,
          createdAt: row.created_at || (kvData && kvData.createdAt ? kvData.createdAt : 0),
          updatedAt,
          likes,
          sortOrder: row.sort_order != null ? row.sort_order : undefined,
        };
        const raw = JSON.stringify(payload);
        try {
          if (env.CONFIGS && !kvIsFresher) await env.CONFIGS.put(`creatorlist:${username}:${slug}`, raw);
        } catch (kvErr) {
          console.error("KV cache write error (getCreatorList):", kvErr);
        }
        return raw;
      }
    } catch (e) {
      console.error("D1 read error (getCreatorList), falling back to KV:", e);
    }
  }
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(`creatorlist:${username}:${slug}`);
      if (raw) return raw;
    } catch (e) {
      console.error("KV read error (getCreatorList):", e);
    }
  }
  return null;
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


// Which entries in D1_SCHEMA_MANIFEST this database actually has.
//
// One query. sqlite_master is a handful of rows here, and its stored `sql`
// text is updated by ALTER TABLE ADD COLUMN, so the same read answers both
// "does this table/index exist" and "does creator_lists have a likes column"
// without a PRAGMA -- which keeps this to plain SQL that D1 is certain to
// support.
//
// Returns { bound, ok, missing, pendingMigrations }, and never throws: a
// database that will not answer is reported as unknown rather than as a
// missing schema, because "I could not check" and "it is not there" are
// different things and only one of them is an instruction to go run a
// migration.
async function checkD1Schema(env) {
  if (!env || !env.DB) {
    return { bound: false, ok: true, checked: false, missing: [], pendingMigrations: [] };
  }
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index')"
    ).all();
    rows = results || [];
  } catch (e) {
    console.error("checkD1Schema: could not read sqlite_master", e);
    return { bound: true, ok: true, checked: false, error: safeErrorMessage(e), missing: [], pendingMigrations: [] };
  }

  const names = new Set(rows.map((r) => r && r.name));
  const ddl = new Map(rows.map((r) => [r && r.name, String((r && r.sql) || "")]));
  const missing = [];
  for (const entry of D1_SCHEMA_MANIFEST) {
    let present;
    if (entry.kind === "column") {
      const tableSql = ddl.get(entry.table) || "";
      // Word-boundary match so a column named `likes` is not satisfied by
      // `likes_count`, and so the table's own name cannot match its column.
      present = new RegExp(`(^|[(,\\s])${entry.name}\\s`, "i").test(tableSql);
    } else {
      present = names.has(entry.name);
    }
    if (!present) missing.push(entry);
  }
  return {
    bound: true,
    checked: true,
    ok: missing.length === 0,
    missing,
    pendingMigrations: [...new Set(missing.map((m) => m.migration))].sort(),
  };
}

// --- Phase 4: Relational D1 Storage for Sync Tracking & User Lists -----------

async function saveCreatorTrackingD1(env, username, trackingData, isIntentionalRemoval) {
  if (!env || !env.DB || !username || !trackingData) return false;
  try {
    const meta = {
      trackPlayback: trackingData.trackPlayback ? 1 : 0,
      removeWatchedWatchlist: trackingData.removeWatchedFromWatchlist !== false ? 1 : 0,
      scrobbleFilterUsers: trackingData.scrobbleFilterUsers ? 1 : 0,
      scrobbleAllowedUsers: typeof trackingData.scrobbleAllowedUsers === "string" ? trackingData.scrobbleAllowedUsers : "",
      scrobbleBlockAnonymous: trackingData.scrobbleBlockAnonymous ? 1 : 0,
      curatedRecommendations: trackingData.curatedRecommendations ? JSON.stringify(trackingData.curatedRecommendations) : null,
      clientVersion: Number(trackingData.clientVersion) || 0,
      updatedAt: Number(trackingData.updatedAt) || Date.now(),
    };

    const stmts = [];

    // 1. Meta
    stmts.push(
      env.DB.prepare(
        `INSERT INTO creator_tracking_meta (
          username, track_playback, remove_watched_watchlist, scrobble_filter_users,
          scrobble_allowed_users, scrobble_block_anonymous, curated_recommendations,
          client_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          track_playback = excluded.track_playback,
          remove_watched_watchlist = excluded.remove_watched_watchlist,
          scrobble_filter_users = excluded.scrobble_filter_users,
          scrobble_allowed_users = excluded.scrobble_allowed_users,
          scrobble_block_anonymous = excluded.scrobble_block_anonymous,
          curated_recommendations = excluded.curated_recommendations,
          client_version = excluded.client_version,
          updated_at = excluded.updated_at`
      ).bind(
        username,
        meta.trackPlayback,
        meta.removeWatchedWatchlist,
        meta.scrobbleFilterUsers,
        meta.scrobbleAllowedUsers,
        meta.scrobbleBlockAnonymous,
        meta.curatedRecommendations,
        meta.clientVersion,
        meta.updatedAt
      )
    );

    // 2. Show states (fullyWatchedShowIds & dismissedContinueWatching)
    const fullyWatched = Array.isArray(trackingData.fullyWatchedShowIds) ? trackingData.fullyWatchedShowIds.map(String) : [];
    const dismissed = trackingData.dismissedContinueWatching && typeof trackingData.dismissedContinueWatching === "object"
      ? trackingData.dismissedContinueWatching
      : {};

    if (isIntentionalRemoval) {
      stmts.push(env.DB.prepare("DELETE FROM creator_show_states WHERE username = ?").bind(username));
    }
    const allShows = new Set([...fullyWatched, ...Object.keys(dismissed)]);
    for (const sid of allShows) {
      const isFw = fullyWatched.includes(sid) ? 1 : 0;
      const dis = dismissed[sid];
      const disSeason = dis && Number.isFinite(Number(dis.seasonNum)) ? Number(dis.seasonNum) : null;
      const disEpisode = dis && Number.isFinite(Number(dis.episodeNum)) ? Number(dis.episodeNum) : null;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO creator_show_states (username, show_id, is_fully_watched, dismissed_season, dismissed_episode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(username, show_id) DO UPDATE SET
             is_fully_watched = excluded.is_fully_watched,
             dismissed_season = excluded.dismissed_season,
             dismissed_episode = excluded.dismissed_episode,
             updated_at = excluded.updated_at`
        ).bind(username, sid, isFw, disSeason, disEpisode, meta.updatedAt)
      );
    }

    // 3. Continue Watching: replace whole set
    if (Array.isArray(trackingData.continueWatching)) {
      stmts.push(env.DB.prepare("DELETE FROM continue_watching WHERE username = ?").bind(username));
      for (const item of trackingData.continueWatching) {
        if (!item) continue;
        const showId = String(item.showId || item.id || "");
        if (!showId) continue;
        const itemId = String(item.id || showId);
        const name = item.name || null;
        const poster = item.poster || null;
        const showTitle = item.showTitle || null;
        const showPoster = item.showPoster || null;
        const seasonNum = item.seasonNum != null ? Number(item.seasonNum) : null;
        const episodeNum = item.episodeNum != null ? Number(item.episodeNum) : null;
        const itemUpdated = Number(item.updatedAt || item.watchedAt) || meta.updatedAt;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO continue_watching (username, show_id, item_id, name, poster, show_title, show_poster, season_num, episode_num, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(username, showId, itemId, name, poster, showTitle, showPoster, seasonNum, episodeNum, itemUpdated)
        );
      }
    }

    // 4. Airing Next: replace whole set
    if (Array.isArray(trackingData.airingNext)) {
      stmts.push(env.DB.prepare("DELETE FROM airing_next WHERE username = ?").bind(username));
      for (const item of trackingData.airingNext) {
        if (!item) continue;
        const showId = String(item.showId || item.id || "");
        if (!showId) continue;
        const itemId = String(item.id || showId);
        const name = item.name || null;
        const poster = item.poster || null;
        const showTitle = item.showTitle || null;
        const showPoster = item.showPoster || null;
        const seasonNum = item.seasonNum != null ? Number(item.seasonNum) : null;
        const episodeNum = item.episodeNum != null ? Number(item.episodeNum) : null;
        const airDate = item.airDate || null;
        const isSeasonPremiere = item.isSeasonPremiere ? 1 : 0;
        const isSeasonFinale = item.isSeasonFinale ? 1 : 0;
        const seasonFinaleAirDate = item.seasonFinaleAirDate || null;
        const seasonFinaleEpisodeNumber = item.seasonFinaleEpisodeNumber != null ? Number(item.seasonFinaleEpisodeNumber) : null;
        const itemUpdated = Number(item.updatedAt) || meta.updatedAt;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO airing_next (
              username, show_id, item_id, name, poster, show_title, show_poster,
              season_num, episode_num, air_date, is_season_premiere, is_season_finale,
              season_finale_air_date, season_finale_episode_number, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            username, showId, itemId, name, poster, showTitle, showPoster,
            seasonNum, episodeNum, airDate, isSeasonPremiere, isSeasonFinale,
            seasonFinaleAirDate, seasonFinaleEpisodeNumber, itemUpdated
          )
        );
      }
    }

    // 5. Watch History
    if (Array.isArray(trackingData.watchHistory)) {
      if (isIntentionalRemoval) {
        stmts.push(env.DB.prepare("DELETE FROM watch_history WHERE username = ?").bind(username));
      }
      for (const item of trackingData.watchHistory) {
        if (!item) continue;
        const itemId = String(item.id || (item.showId ? `${item.showId}:${item.seasonNum}:${item.episodeNum}` : ""));
        if (!itemId) continue;
        const itemType = item.type || (item.seasonNum != null ? "episode" : "movie");
        const title = item.name || item.title || null;
        const poster = item.poster || null;
        const showId = item.showId ? String(item.showId) : null;
        const showTitle = item.showTitle || null;
        const showPoster = item.showPoster || null;
        const seasonNum = item.seasonNum != null ? Number(item.seasonNum) : null;
        const episodeNum = item.episodeNum != null ? Number(item.episodeNum) : null;
        const year = item.year ? String(item.year) : null;
        const airDate = item.airDate ? String(item.airDate) : null;
        const watchedAt = Number(item.watchedAt) || meta.updatedAt;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO watch_history (
              username, item_id, item_type, title, poster, show_id, show_title,
              show_poster, season_num, episode_num, year, air_date, watched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username, item_id) DO UPDATE SET
              item_type = excluded.item_type,
              title = excluded.title,
              poster = excluded.poster,
              show_id = excluded.show_id,
              show_title = excluded.show_title,
              show_poster = excluded.show_poster,
              season_num = excluded.season_num,
              episode_num = excluded.episode_num,
              year = excluded.year,
              air_date = excluded.air_date,
              watched_at = excluded.watched_at`
          ).bind(
            username, itemId, itemType, title, poster, showId, showTitle,
            showPoster, seasonNum, episodeNum, year, airDate, watchedAt
          )
        );
      }
    }

    const CHUNK_SIZE = 80;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + CHUNK_SIZE);
      await env.DB.batch(chunk);
    }
    return true;
  } catch (err) {
    console.error("D1 write error (saveCreatorTrackingD1):", err);
    return false;
  }
}

async function readCreatorTrackingD1(env, username) {
  if (!env || !env.DB || !username) return null;
  try {
    const metaRow = await env.DB.prepare(
      "SELECT * FROM creator_tracking_meta WHERE username = ?"
    ).bind(username).first();
    if (!metaRow) return null;

    const [whRows, cwRows, anRows, stateRows] = await Promise.all([
      env.DB.prepare(
        "SELECT * FROM watch_history WHERE username = ? ORDER BY watched_at DESC"
      ).bind(username).all().then((r) => r.results || []),
      env.DB.prepare(
        "SELECT * FROM continue_watching WHERE username = ? ORDER BY updated_at DESC"
      ).bind(username).all().then((r) => r.results || []),
      env.DB.prepare(
        "SELECT * FROM airing_next WHERE username = ? ORDER BY air_date ASC"
      ).bind(username).all().then((r) => r.results || []),
      env.DB.prepare(
        "SELECT * FROM creator_show_states WHERE username = ?"
      ).bind(username).all().then((r) => r.results || []),
    ]);

    const watchHistory = whRows.map((r) => ({
      id: r.item_id,
      type: r.item_type,
      name: r.title || undefined,
      title: r.title || undefined,
      poster: r.poster || undefined,
      showId: r.show_id || undefined,
      showTitle: r.show_title || undefined,
      showPoster: r.show_poster || undefined,
      seasonNum: r.season_num != null ? r.season_num : undefined,
      episodeNum: r.episode_num != null ? r.episode_num : undefined,
      year: r.year || undefined,
      airDate: r.air_date || undefined,
      watchedAt: r.watched_at,
    }));

    const continueWatching = cwRows.map((r) => ({
      id: r.item_id,
      showId: r.show_id,
      type: "episode",
      name: r.name || undefined,
      poster: r.poster || undefined,
      showTitle: r.show_title || undefined,
      showPoster: r.show_poster || undefined,
      seasonNum: r.season_num != null ? r.season_num : undefined,
      episodeNum: r.episode_num != null ? r.episode_num : undefined,
      updatedAt: r.updated_at,
    }));

    const airingNext = anRows.map((r) => ({
      id: r.item_id,
      showId: r.show_id,
      type: "episode",
      name: r.name || undefined,
      poster: r.poster || undefined,
      showTitle: r.show_title || undefined,
      showPoster: r.show_poster || undefined,
      seasonNum: r.season_num != null ? r.season_num : undefined,
      episodeNum: r.episode_num != null ? r.episode_num : undefined,
      airDate: r.air_date || undefined,
      isSeasonPremiere: r.is_season_premiere ? true : undefined,
      isSeasonFinale: r.is_season_finale ? true : undefined,
      seasonFinaleAirDate: r.season_finale_air_date || undefined,
      seasonFinaleEpisodeNumber: r.season_finale_episode_number != null ? r.season_finale_episode_number : undefined,
      updatedAt: r.updated_at,
    }));

    const fullyWatchedShowIds = [];
    const dismissedContinueWatching = {};
    for (const s of stateRows) {
      if (s.is_fully_watched) fullyWatchedShowIds.push(s.show_id);
      if (s.dismissed_season != null || s.dismissed_episode != null) {
        dismissedContinueWatching[s.show_id] = {
          seasonNum: s.dismissed_season != null ? s.dismissed_season : 0,
          episodeNum: s.dismissed_episode != null ? s.dismissed_episode : 0,
        };
      }
    }

    let curatedRecs = null;
    if (metaRow.curated_recommendations) {
      try { curatedRecs = JSON.parse(metaRow.curated_recommendations); } catch {}
    }

    return {
      watchHistory,
      continueWatching,
      airingNext,
      fullyWatchedShowIds,
      dismissedContinueWatching,
      curatedRecommendations: curatedRecs,
      trackPlayback: Boolean(metaRow.track_playback),
      removeWatchedFromWatchlist: Boolean(metaRow.remove_watched_watchlist),
      scrobbleFilterUsers: Boolean(metaRow.scrobble_filter_users),
      scrobbleAllowedUsers: metaRow.scrobble_allowed_users || "",
      scrobbleBlockAnonymous: Boolean(metaRow.scrobble_block_anonymous),
      clientVersion: Number(metaRow.client_version) || 0,
      updatedAt: Number(metaRow.updated_at) || 0,
    };
  } catch (err) {
    console.error("D1 read error (readCreatorTrackingD1):", err);
    return null;
  }
}

async function saveCreatorUserListsD1(env, username, likedLists, hiddenLists, hiddenSections) {
  if (!env || !env.DB || !username) return false;
  try {
    const stmts = [
      env.DB.prepare("DELETE FROM creator_user_lists WHERE username = ?").bind(username),
    ];
    const now = Date.now();
    if (Array.isArray(likedLists)) {
      for (const id of likedLists) {
        if (typeof id === "string" && id) {
          stmts.push(
            env.DB.prepare("INSERT OR IGNORE INTO creator_user_lists (username, list_id, list_type, created_at) VALUES (?, ?, 'liked', ?)")
              .bind(username, id, now)
          );
        }
      }
    }
    if (Array.isArray(hiddenLists)) {
      for (const id of hiddenLists) {
        if (typeof id === "string" && id) {
          stmts.push(
            env.DB.prepare("INSERT OR IGNORE INTO creator_user_lists (username, list_id, list_type, created_at) VALUES (?, ?, 'hidden', ?)")
              .bind(username, id, now)
          );
        }
      }
    }
    if (Array.isArray(hiddenSections)) {
      for (const id of hiddenSections) {
        if (typeof id === "string" && id) {
          stmts.push(
            env.DB.prepare("INSERT OR IGNORE INTO creator_user_lists (username, list_id, list_type, created_at) VALUES (?, ?, 'hidden_section', ?)")
              .bind(username, id, now)
          );
        }
      }
    }
    const CHUNK_SIZE = 80;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      await env.DB.batch(stmts.slice(i, i + CHUNK_SIZE));
    }
    return true;
  } catch (err) {
    console.error("D1 write error (saveCreatorUserListsD1):", err);
    return false;
  }
}

async function readCreatorUserListsD1(env, username) {
  if (!env || !env.DB || !username) return null;
  try {
    const { results } = await env.DB.prepare(
      "SELECT list_id, list_type FROM creator_user_lists WHERE username = ?"
    ).bind(username).all();
    if (!results || !results.length) return null;
    const likedLists = [];
    const hiddenLists = [];
    const hiddenMyListsSections = [];
    for (const r of results) {
      if (r.list_type === "liked") likedLists.push(r.list_id);
      else if (r.list_type === "hidden") hiddenLists.push(r.list_id);
      else if (r.list_type === "hidden_section") hiddenMyListsSections.push(r.list_id);
    }
    return { likedLists, hiddenLists, hiddenMyListsSections };
  } catch (err) {
    console.error("D1 read error (readCreatorUserListsD1):", err);
    return null;
  }
}
