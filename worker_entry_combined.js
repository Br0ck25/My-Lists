/**
 * my-list-addon
 *
 * A stateless wako/Stremio-protocol add-on that turns mdblist.com,
 * trakt.tv, and themoviedb.org list URLs into catalog rows on the home
 * screen.
 *
 * How it works:
 *  - Config (the list URLs a user wants, their order, and their optional
 *    personal API keys) is base64url-encoded directly into the install URL.
 *    No database, no server-side auth, nothing to run besides this Worker.
 *  - MDBList private lists and "My Watchlist" need an MDBList API key.
 *    Same deal: users paste their own in the builder page, or the Worker
 *    owner can set a fallback MDBLIST_API_KEY below. Public mdblist.com
 *    lists work fine with no key at all.
 *  - Public trakt.tv lists (https://trakt.tv/users/USER/lists/LIST-SLUG)
 *    are supported too. Trakt requires a Client ID (their term for an API
 *    key) on every request, even for public lists — this Worker uses a
 *    single fixed TRAKT_CLIENT_ID (below) for all users; there's no
 *    per-user override in the builder page.
 *  - Public themoviedb.org lists (https://www.themoviedb.org/list/LIST_ID)
 *    are supported too, the same fixed-key way as Trakt (TMDB_API_KEY
 *    below). TMDB list items only carry a TMDB id, so each item needs an
 *    extra external_ids lookup to resolve its IMDB id — those lookups are
 *    throttled and cached hard at Cloudflare's edge to stay well under
 *    TMDB's soft per-IP connection limit.
 *  - GET /                            -> builder page (fresh install, external browser)
 *  - GET /:config/configure           -> same builder, pre-filled, meant to be
 *                                        opened inside wako's own "Configure"
 *                                        screen for an installed add-on
 *  - GET /:config/manifest.json       -> wako/Stremio manifest, one catalog per list.
 *                                        If opened as a *page load* (browser
 *                                        navigation, e.g. via wako's Configure
 *                                        button) it redirects to /:config/configure
 *                                        instead of dumping raw JSON.
 *  - GET /:config/catalog/:type/:id.json -> catalog items, pulled live from mdblist
 *  - GET /api/toplists                -> proxies mdblist.com's Popular Lists
 *                                        (https://mdblist.com/toplists/) so the
 *                                        builder page can offer them as one-click adds
 *  - GET /icon.png                    -> add-on icon, served from this Worker
 *
 * Deploy with `wrangler deploy` or paste directly into the Cloudflare dashboard.
 * No environment variables or bindings required.
 */
/**
 * my-list-addon
 *
 * A stateless wako/Stremio-protocol add-on that turns mdblist.com,
 * trakt.tv, and themoviedb.org list URLs into catalog rows on the home
 * screen.
 *
 * How it works:
 *  - Config (the list URLs a user wants, their order, and their optional
 *    personal API keys) is base64url-encoded directly into the install URL.
 *    No database, no server-side auth, nothing to run besides this Worker.
 *  - MDBList private lists and "My Watchlist" need an MDBList API key.
 *    Same deal: users paste their own in the builder page, or the Worker
 *    owner can set a fallback MDBLIST_API_KEY env var. Public mdblist.com
 *    lists work fine with no key at all.
 *  - Public trakt.tv lists (https://trakt.tv/users/USER/lists/LIST-SLUG)
 *    are supported too. Trakt requires a Client ID (their term for an API
 *    key) on every request, even for public lists — this Worker uses a
 *    single fixed TRAKT_CLIENT_ID env var for all users; there's no
 *    per-user override in the builder page.
 *  - Public themoviedb.org lists (https://www.themoviedb.org/list/LIST_ID)
 *    are supported too, the same fixed-key way as Trakt (TMDB_API_KEY
 *    env var). TMDB list items only carry a TMDB id, so each item needs an
 *    extra external_ids lookup to resolve its IMDB id — those lookups are
 *    throttled and cached hard at Cloudflare's edge to stay well under
 *    TMDB's soft per-IP connection limit.
 *  - GET /                            -> builder page (fresh install, external browser)
 *  - GET /:config/configure           -> same builder, pre-filled, meant to be
 *                                         opened inside wako's own "Configure"
 *                                         screen for an installed add-on
 *  - GET /:config/manifest.json       -> wako/Stremio manifest, one catalog per list.
 *                                         If opened as a *page load* (browser
 *                                         navigation, e.g. via wako's Configure
 *                                         button) it redirects to /:config/configure
 *                                         instead of dumping raw JSON.
 *  - GET /:config/catalog/:type/:id.json -> catalog items, pulled live from mdblist
 *  - GET /api/toplists                -> proxies mdblist.com's Popular Lists
 *                                         (https://mdblist.com/toplists/) so the
 *                                         builder page can offer them as one-click adds
 *  - GET /icon.png                    -> add-on icon, served from this Worker
 *
 * Deploy with `wrangler deploy` or paste directly into the Cloudflare dashboard.
 *
 * Environment variables / secrets (all optional -- the add-on runs fine with
 * none of these set; each one just enables/unlocks the specific feature it
 * covers, with a clear in-app error message wherever it's missing instead of
 * a crash). Set these as Worker secrets (`wrangler secret put NAME`, or the
 * Cloudflare dashboard's Settings -> Variables -> "Encrypt" toggle) rather
 * than plain environment variables, since even the non-genuine-secret ones
 * below (API keys/Client IDs, as opposed to TRAKT_CLIENT_SECRET, a real
 * OAuth secret) are still credentials tied to a personal developer account:
 *  - MDBLIST_API_KEY      -- fallback MDBList key for private lists / "My
 *                             Watchlist" quick-add. Free at
 *                             https://mdblist.com/preferences
 *  - MDBLIST_POPULAR_KEY  -- powers the "Popular Lists" browse/search box
 *                             specifically (see 25_api-catalog-routes.js) --
 *                             same place to get one as MDBLIST_API_KEY above,
 *                             just a separate key so a personal-data key and
 *                             a public-browse-only key aren't the same value.
 *  - TRAKT_CLIENT_ID      -- required for any trakt.tv list/chart support.
 *                             Free at https://trakt.tv/oauth/applications
 *                             (only the Client ID, not the secret, is needed
 *                             here).
 *  - TRAKT_CLIENT_SECRET  -- only needed for the "Connect Trakt account"
 *                             OAuth flow (private lists, watch history
 *                             import) -- public trakt.tv lists work with
 *                             just TRAKT_CLIENT_ID above. From the same
 *                             Trakt OAuth application as TRAKT_CLIENT_ID.
 *  - TMDB_API_KEY         -- required for any themoviedb.org list support,
 *                             episode/season lookups, and trailer/backdrop
 *                             enrichment used throughout the add-on. Free at
 *                             https://www.themoviedb.org/settings/api (the
 *                             "API Key" field, not "API Read Access Token").
 *  - SIMKL_CLIENT_ID      -- required for Simkl trending chart support.
 *                             Free at https://simkl.com/settings/developer/
 *  - ADMIN_KEY            -- unlocks the /admin stats dashboard for this
 *                             Worker's owner. Any long random string works;
 *                             there's no dependency on an external service.
 *
 * None of the above are hardcoded in this source on purpose -- this add-on
 * is meant to be forked and self-hosted, and shipping a personal API key in
 * public source would leak it to everyone who deploys a copy.
 */

const ADDON_ID = "app.my-list";
const ADDON_VERSION = "1.39.0";
const ADDON_NAME = "My Lists";

// --- Env-backed API keys ----------------------------------------------------
//
// These five all used to be hardcoded literals here. They're declared with
// `let` (not `const`) and start out empty -- the actual values get read from
// `env` and assigned to these same module-level names at the very top of the
// fetch() handler in 25_api-catalog-routes.js, once per request. That keeps
// every helper function throughout this add-on that already references
// these constants by name working completely unchanged (no need to thread
// `env` through dozens of call sites), while making sure nothing here in
// source is a real credential. See the file header comment above for what
// each one unlocks and where to get a free one; see
// 25_api-catalog-routes.js for the assignment itself and
// TRAKT_CLIENT_SECRET (a genuine secret, read directly from `env` where
// it's used, never mirrored into a global like these) for the pattern this
// followed.
//
// A per-user override still takes priority over these where one exists
// (the MDBList key / Trakt Client ID boxes in the builder page) -- these
// are only ever the fallback for someone who hasn't filled those in.
let MDBLIST_API_KEY = "";
let MDBLIST_POPULAR_KEY = "";
let TRAKT_CLIENT_ID = "";
let TMDB_API_KEY = "";
let SIMKL_CLIENT_ID = "";
// --- icon (placeholder, replace via /mnt/project source if needed) --------
const ICON_BASE64 =
  "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" +
  "Y/v9zk8v/8Un/uuLK+vrW5aWtywvb11e3Llj65alheWlheWlpaWF+V63U5a6KArtbT1QW/9PKPGd" +
  "Jz9qLho0vEgwyMeniI3IVcQ8FzZfs8ACdV1tbIwgGqcxuUMkE8elTRajryXSpaORJ2yvnOz1Ghqt" +
  "ChYhFBYkTDabxK+B/I6ETaNEdlI0/EWIwBgILchsCVCsNdWs8HmXEvXMQQgsWZJcpt+QEBXvJU7J" +
  "Ws6eahGWC4tk3lV3txBkQIJqN4w3kI4CR/5x3CsiX9Yn3q342bMfHGLWvAszdgtww0/g2jfB+s+o" +
  "XERCogJJE+mIvsPwAMYRucdFZpnSnPm6Q5lE7gwKYyKObaRkWkUAgdF4doddncedd/S/feWgqeu7" +
  "ntD5wj/cvdMvOu3uJZd88dmv+7E55qFkpkDtEict5TrPwMztdudnl1/5nJe8YTSaIFiJPmdEpVSr" +
  "1er3+/1uZ2Fufnl5cfv2rVuXt+zcsXV5eWHb8uLCfH9xYa7X63Y6Ha00KRKvUHIcWHaqLQ5vqeP0" +
  "JWxa8q2HRlQePpMagSgC0+l0dW0NUpCFNBzn4RwSzJJo41MYemhpMizhtGd0HX8dmbjp70bAWEhk" +
  "jR+MyjppkBBj78bTdiRqfhGBQGzGiXCKIBSA2XTU6S+FKOkIwInwGwx+AHKFYgZ+lvRIeg+xJ7IQ" +
  "ogBF6g4ReZRb4sZoNHtlsupHeB6+Qg09a1z37o+qcCa4+y4JCKMimQlc/z947d/C9DpsLREiUkG6" +
  "INf2j6KMeJhlQdic6R/jBo9ZmKLksANH0KAwSQBy2jXX4CaSQyvrf/mYYzeGcOUvD/znuy7u9FS/" +
  "1/vM57/2rFddZo98COpCbA1SdtuzVlEyi2vtEuF/XvLZ9dWVLVu2VHWdFdkMIsKz9bXJ6iG+0Xrq" +
  "gHt6tSranVa3052bm1uY7y8vL27dsmX7lsXt27Zs3bK0dWlxeXlxaXGh1+u0Wy3nzCFEFqkNp3gB" +
  "Y7z/fhOMPlfxo7/0TifjwWAUPLqYx5empgemkbA4rhRklU4aEUneZnKfifaNLsuZFkBBPuqNeyIi" +
  "5JFOkceZtTpyPkIIlcIU1YconsSAdTXuwlIyHCFmIWuSvFPA4XLks9DSaCBDBsU2dJiQiyOViSc3" +
  "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";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "max-age=3600",
      ...corsHeaders(),
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

// entries: [{ id, name, type: 'movie'|'series', url }]
//
// Config is normally { entries, tmdbKey, mdblistKey } but older install
// links encode a bare entries array — those still decode fine, just with
// no personal keys attached.
function decodeConfig(config) {
  const empty = { entries: [], tmdbKey: "", mdblistKey: "", traktKey: "", traktUsername: "", traktAccessToken: "", track: false, trackCreatorName: "", trackCreatorKey: "" };
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
      traktKey: (!Array.isArray(parsed) && parsed.traktKey) || "",
      traktUsername: (!Array.isArray(parsed) && parsed.traktUsername) || "",
      // The OAuth access token from "Connect Trakt" (see /api/trakt/oauth/*
      // below) -- unlike traktKey (the Client ID, used unauthenticated for
      // public data), this is what lets fetchTrakt below read a private
      // list. Baked into the link the same way every other key here is --
      // there's deliberately no server-side token storage/refresh (see the
      // comment on /api/trakt/oauth/callback), so this expires after
      // Trakt's own ~3 month token lifetime and needs reconnecting then.
      traktAccessToken: (!Array.isArray(parsed) && parsed.traktAccessToken) || "",
      // Playback tracking (see /:config/subtitles/... in
      // 25_api-catalog-routes.js, and buildManifest's comment on why that
      // route exists at all). Requires a Creator Profile, since that's the
      // only place Watch History persists outside a single browser for a
      // bare server-side request -- Stremio/wako calling this addon
      // directly, with no cookies or login -- to write into. The Creator
      // Key travels in the install link the same way traktAccessToken
      // above already does: the link IS the credential for this addon
      // (same as any Stremio addon manifest URL), so this isn't a new
      // category of exposure, just one more thing riding along with it.
      track: !!(!Array.isArray(parsed) && parsed.track),
      trackCreatorName: (!Array.isArray(parsed) && parsed.trackCreatorName) || "",
      trackCreatorKey: (!Array.isArray(parsed) && parsed.trackCreatorKey) || "",
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
const SHORT_ID_LENGTH = 12;

async function resolveConfig(configParam, env) {
  if (configParam.length <= SHORT_ID_LENGTH && env && env.CONFIGS) {
    const stored = await env.CONFIGS.get(configParam);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          tmdbKey: parsed.tmdbKey || "",
          mdblistKey: parsed.mdblistKey || "",
          traktKey: parsed.traktKey || "",
          traktUsername: parsed.traktUsername || "",
          traktAccessToken: parsed.traktAccessToken || "",
          track: !!parsed.track,
          trackCreatorName: parsed.trackCreatorName || "",
          trackCreatorKey: parsed.trackCreatorKey || "",
        };
      } catch {
        // fall through to legacy decode below
      }
    }
  }
  return decodeConfig(configParam);
}

// Accepts a full mdblist URL (https://mdblist.com/lists/user/listname[/...])
// or a bare "user/listname" and returns the public JSON feed URL. Pass an
// apikey to also reach a private/personal list you own (mdblist honors the
// key on this endpoint the same way its own site does when you're signed
// in) — public lists work fine with no key.
function mdblistJsonUrl(input, apikey) {
  let s = input.trim();
  s = s.replace(/^https?:\/\/(www\.)?mdblist\.com\/lists\//i, "");
  s = s.replace(/\/(json\/?)?$/i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Normal user lists are /lists/{username}/{slug} (2 segments), but
  // mdblist's own "Official Lists" (mdblist.com/lists/official) are one
  // level deeper -- /lists/official/{movies|shows}/{slug} (3 segments).
  // mdblist's JSON-feed convention is simply "whatever the display page's
  // own path is, plus /json/", so preserving however many segments there
  // are (rather than assuming exactly 2) handles both shapes correctly.
  const encodedPath = parts.map((p) => encodeURIComponent(p)).join("/");
  const base = `https://mdblist.com/lists/${encodedPath}/json/`;
  // append_to_response=poster is documented for mdblist's api.mdblist.com
  // REST endpoint; this add-on actually uses their simpler public JSON feed
  // (this URL), which isn't confirmed to support the same param. Requesting
  // it anyway is a safe bet either way: if unsupported, mdblist just ignores
  // the unknown query param and responds exactly as before (mapMdblistItems
  // below falls back to the metahub poster whenever `poster` isn't present).
  const params = new URLSearchParams({ append_to_response: "poster" });
  if (apikey) params.set("apikey", apikey);
  return `${base}?${params.toString()}`;
}

// --- list-site detection -----------------------------------------------

// Looks at a pasted URL (or the special "mdblist:watchlist" sentinel) and
// figures out which backend should handle it.
// Matches the shareable "/lists/{username}/{listname}" path a published
// Custom List gets, regardless of domain -- this is deliberately domain-
// agnostic (checked structurally, not against a hardcoded hostname) so it
// keeps working whether someone's on the raw *.workers.dev subdomain or a
// custom domain, and so one deployment can resolve a link shared from
// another. Reading this always goes straight to this Worker's OWN KV (see
// fetchPublishedListCatalog) rather than an HTTP fetch of the URL itself.
//
// Critical exception: mdblist.com's own list URLs use this *exact* same
// shape (mdblist.com/lists/{user}/{list}) -- without excluding it here,
// every ordinary mdblist list URL already in use throughout this add-on
// would get misdetected as one of our own published lists and resolved
// against our (empty, for that key) KV instead of mdblist's real data.
function parsePublishedListUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (/^https?:\/\/(www\.)?mdblist\.com\//i.test(s)) return null;
  const m = s.match(/\/lists\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\.json)?\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return { username: m[1].toLowerCase(), listName: m[2].toLowerCase() };
}

function detectSource(input) {
  const s = (input || "").trim();
  if (s === "mdblist:watchlist") return "mdblist-watchlist";
  if (s === "trakt:watchlist") return "trakt-watchlist";
  if (s === "trakt:history") return "trakt-history";
  if (s.startsWith("tmdb:chart:")) return "tmdb-chart";
  if (s === "tmdb:hidden-gems") return "tmdb-hidden-gems";
  if (s.startsWith("tmdb:kids:")) return "tmdb-kids";
  if (s.startsWith("trakt:chart:")) return "trakt-chart";
  if (s.startsWith("simkl:chart:")) return "simkl-chart";
  if (s.startsWith("channel:v1:")) return "channel";
  if (s.startsWith("customlist:v1:")) return "custom-list";
  if (s.startsWith("autotrack:")) return "autotrack";
  if (parsePublishedListUrl(s)) return "published-list";
  if (/^https?:\/\/(www\.|app\.)?trakt\.tv\//i.test(s)) return "trakt";
  if (/^https?:\/\/(www\.)?themoviedb\.org\/list\//i.test(s)) return "tmdb";
  return "mdblist"; // default / backwards-compatible with existing configs
}

// Parses a pasted trakt.tv list URL into the { user, list } pair the Trakt
// API needs. Accepts the standard public-list URL shape:
//   https://trakt.tv/users/USERNAME/lists/LIST-SLUG-OR-ID
// (also tolerates a trailing slash or extra path segments like /items).
// `list` can be either the list's slug or its numeric id — Trakt's API
// accepts both interchangeably in this position.
function traktListPath(input) {
  const s = (input || "").trim().replace(/^https?:\/\/(www\.|app\.)?trakt\.tv\//i, "");
  const m = s.match(/^users\/([^/]+)\/lists\/([^/?#]+)/i);
  if (!m) return null;
  return { user: m[1], list: m[2] };
}

// Parses a pasted themoviedb.org list URL into its numeric list id.
// TMDB lists are global (not scoped under a username the way Trakt's are),
// referenced as either https://www.themoviedb.org/list/8290920 or with a
// trailing display slug like .../list/8290920-my-favorites.
function tmdbListId(input) {
  const s = (input || "").trim();
  const m = s.match(/themoviedb\.org\/list\/(\d+)/i);
  return m ? m[1] : null;
}

// --- popular lists (mdblist.com/toplists) -------------------------------

// Pulls mdblist.com's own "Popular Lists" page (https://mdblist.com/toplists/)
// via their REST API and normalizes each entry into something the builder
// page can turn into an entry with one click. Requires an MDBList API key —
// same one used for private lists / the watchlist quick-add.
async function fetchTopLists(apikey) {
  if (!apikey) {
    throw new Error(
      "Popular Lists isn't configured on this add-on yet — the Worker owner needs to set MDBLIST_POPULAR_KEY."
    );
  }

  const res = await fetch(
    `https://api.mdblist.com/lists/top?apikey=${encodeURIComponent(apikey)}`,
    {
      headers: { "User-Agent": "my-list-addon/1.3" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    }
  );
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403 ? " Double-check your MDBList API key." : "";
    throw new Error(`MDBList top-lists request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((l) => ({
    name: l.name,
    user: l.user_name,
    slug: l.slug,
    type: l.mediatype === "show" ? "series" : "movie",
    items: l.items,
    likes: l.likes,
    url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
  }));
}

// Searches trakt.tv's public lists by name via their official search API.
// Only needs the fixed TRAKT_CLIENT_ID (same key used for fetching list
// items) — no user auth required for public list search.
// Peeks at a small sample of a Trakt list's items (unfiltered by type) to
// determine whether it's a movies list, a shows list, or genuinely mixed --
// used so the "Search Lists" results can offer just one relevant Add
// button instead of always defensively offering both. A shallow sample
// (not the whole list) is a deliberate trade-off: correct for the
// overwhelmingly common case of a single-type list, and falls back to
// "unknown" (both buttons, the previous always-safe behavior) for anything
// ambiguous or genuinely mixed.
async function classifyTraktListContentType(user, slug, traktKey, accessToken) {
  const src = `https://api.trakt.tv/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(
    slug
  )}/items?limit=20`;
  try {
    const headers = {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey || TRAKT_CLIENT_ID,
      "User-Agent": "my-list-addon/1.12",
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(src, {
      headers,
      // List composition virtually never changes once a list is public, so
      // this is cached hard and shared across every search that surfaces
      // the same list -- but never for an authenticated (private-list)
      // request, since Cloudflare's cache key ignores headers and would
      // otherwise risk serving one person's private list classification
      // back to an unrelated, unauthenticated request for the same URL.
      cf: accessToken ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) return "unknown";
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const hasMovie = items.some((it) => it.movie);
    const hasShow = items.some((it) => it.show);
    if (hasMovie && hasShow) return "mixed";
    if (hasMovie) return "movie";
    if (hasShow) return "series";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function searchTraktLists(query, traktKeyOverride) {
  const q = (query || "").trim();
  if (!q) return [];
  const traktKey = traktKeyOverride || TRAKT_CLIENT_ID;
  if (!traktKey) {
    throw new Error("Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID.");
  }

  const src = `https://api.trakt.tv/search/list?query=${encodeURIComponent(q)}&limit=20`;
  const res = await fetch(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      "User-Agent": "my-list-addon/1.6",
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    // Trakt's API uses 403 specifically to mean "invalid API key or
    // unapproved app" (their own client libraries document this exact
    // mapping) -- distinct from a 401 (malformed key) or 429 (rate
    // limited). If TRAKT_CLIENT_ID starts failing with this code, the
    // request itself isn't the problem: the API application behind that
    // Client ID needs checking at https://trakt.tv/oauth/applications
    // (revoked/expired/needs re-approval), or a fresh one created there --
    // or the person searching can supply their own Client ID (see the
    // Trakt API key box in the builder) to bypass this add-on's credential
    // entirely.
    if (res.status === 403) {
      throw new Error(
        traktKeyOverride
          ? "Trakt rejected the Client ID you entered (HTTP 403 = invalid or unapproved app). Double check it against https://trakt.tv/oauth/applications."
          : "Trakt rejected this add-on's API key (HTTP 403 = invalid or unapproved app, per Trakt's own error docs). " +
            "This isn't fixable from a search query -- either the Worker owner needs to check the app behind TRAKT_CLIENT_ID at https://trakt.tv/oauth/applications, or you can enter your own Trakt Client ID in the box above to bypass it."
      );
    }
    throw new Error(`Trakt list search failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const lists = (Array.isArray(data) ? data : [])
    .map((r) => r.list)
    .filter((l) => l && l.ids && l.ids.slug && l.user && l.user.ids && l.user.ids.slug)
    .map((l) => ({
      name: l.name,
      user: l.user.username || l.user.ids.slug,
      slug: l.ids.slug,
      items: l.item_count || 0,
      likes: l.likes || 0,
      url: `https://trakt.tv/users/${encodeURIComponent(l.user.ids.slug)}/lists/${encodeURIComponent(
        l.ids.slug
      )}`,
    }));

  // Classify each result's actual content type (movie/series/mixed) so the
  // builder can offer just the relevant Add button instead of defaulting
  // to both -- throttled to stay well under Trakt's connection limits.
  return mapWithConcurrency(lists, 8, async (l) => ({
    ...l,
    contentType: await classifyTraktListContentType(l.user, l.slug, traktKey),
  }));
}

// --- manifest ----------------------------------------------------------

function buildManifest(entries, origin, track) {
  const active = entries.filter((e) => e.enabled !== false);
  const resources = ["catalog", { name: "meta", types: ["series"], idPrefixes: ["channel_"] }];
  const idPrefixes = ["tt", "channel_"];
  // Stremio/wako call every installed addon's subtitles resource the
  // instant ANY video starts playing (checking for subtitle tracks) --
  // regardless of which addon's catalog the video came from, or whether
  // this addon has any subtitles to offer (it doesn't; see the
  // /:config/subtitles/... route in 25_api-catalog-routes.js). That's a
  // real, reliable "this just started playing" signal to hang automatic
  // watch-tracking off of -- just not a *completion* one, since it's one
  // request at the very start of playback, no ongoing position data. Only
  // declared when the person has turned on "Auto-track playback" in
  // Settings, since otherwise every video played anywhere would ping this
  // addon for no reason.
  if (track) {
    resources.push({ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] });
  }
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description:
      "Browse your own mdblist.com, trakt.tv, and themoviedb.org lists (and your MDBList watchlist) as catalogs on the home screen.",
    logo: `${origin}/icon.png`,
    resources,
    types: ["movie", "series"],
    idPrefixes,
    catalogs: active.map((e) => ({
      type: e.type,
      id: e.id,
      name: e.name,
      // Lets wako/Stremio page through lists longer than one screen by
      // re-requesting the catalog with an increasing `skip`.
      extra: [{ name: "skip", isRequired: false }],
    })),
    behaviorHints: {
      configurable: true,
      configurationRequired: active.length === 0,
    },
  };
}

// --- catalog fetch -------------------------------------------------------

const PAGE_SIZE = 100; // items returned per catalog request, for sources we fetch in full up front

// Dispatches to the right backend based on what kind of URL was pasted in.
// `keys` is { mdblistKey, traktKey } — per-user keys decoded from their
// install link, if any. A key the user didn't supply falls back to the
// Worker-wide MDBLIST_API_KEY/TRAKT_CLIENT_ID constants at the top of the
// file. TRAKT_CLIENT_ID had previously started getting rejected with a 403
// ("invalid or unapproved app"), which made Trakt search/list-import/
// charts fail for anyone not supplying their own Client ID -- it's since
// been replaced with a new one, but if it starts happening again, the
// Worker owner needs a fresh app from https://trakt.tv/oauth/applications,
// or a person can supply their own Client ID in the meantime (see the
// error message a 403 produces below).
// Errors are intentionally allowed to propagate (not swallowed here) so the
// catalog route and the preview endpoint can both report *why* a list came
// back empty instead of guessing.
//
// A "merged" entry — multiple source URLs feeding one catalog row — stores
// its sources newline-separated in entry.url (see collectEntries in the
// builder page). Everything downstream of this function only ever sees one
// URL at a time; the fan-out/merge happens right here.
async function fetchCatalog(entry, skip = 0, keys = {}) {
  const urls = String(entry.url || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length > 1) {
    return fetchMergedCatalog(urls, entry.type, skip, keys);
  }

  const mdblistKey = keys.mdblistKey || MDBLIST_API_KEY;
  const traktKey = keys.traktKey || TRAKT_CLIENT_ID;
  const source = detectSource(entry.url);
  if (source === "mdblist-watchlist") return fetchMdblistWatchlist(entry, skip, mdblistKey);
  if (source === "trakt") return fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "trakt-watchlist") return fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "trakt-history") return fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "tmdb") return fetchTmdb(entry, skip, TMDB_API_KEY);
  if (source === "tmdb-chart") return fetchTmdbChart(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:chart:".length));
  if (source === "tmdb-hidden-gems") return fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY);
  if (source === "tmdb-kids") return fetchTmdbKids(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:kids:".length));
  if (source === "trakt-chart") return fetchTraktChart(entry, skip, traktKey, entry.url.trim().slice("trakt:chart:".length));
  if (source === "simkl-chart") return fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:chart:".length));
  if (source === "channel") return fetchChannelCatalog(entry);
  if (source === "custom-list") return fetchCustomListCatalog(entry);
  if (source === "autotrack") return fetchAutoTrackedCatalog(entry, keys.env);
  if (source === "published-list") return fetchPublishedListCatalog(entry, keys.env);
  return fetchMdblist(entry, skip, mdblistKey);
}

// Fans a merged catalog row out to each source at the same skip/page
// window, then concatenates (in source order) and dedupes by IMDB id —
// first occurrence wins, so a title appearing in an earlier-listed source
// takes priority over a later one.
//
// KNOWN LIMITATION: each source paginates independently, so this only
// dedupes *within* the current page window. A title that's duplicated
// across two sources but happens to fall in different skip windows as a
// catalog is scrolled deeper won't always get caught — this is exact for
// the common case (small/medium lists, and always exact on the first page)
// and only imperfect deep into large multi-source merges. Getting this
// perfectly exact would require fetching and holding each entire source in
// memory rather than paging them, which doesn't fit this add-on's
// stateless, one-request-per-page design.
async function fetchMergedCatalog(urls, type, skip, keys) {
  const perSource = await Promise.all(
    urls.map((u) => fetchCatalog({ url: u, type }, skip, keys).catch(() => []))
  );
  const seen = new Set();
  const merged = [];
  for (const list of perSource) {
    for (const m of list) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  return merged.slice(0, PAGE_SIZE);
}

// --- Channels (synthetic series stitched from hand-picked episodes/movies) -
//
// A Channel entry stores its whole payload directly in entry.url as
// "channel:v1:<JSON>" -- built entirely client-side by the Channel builder
// panel (search a show, pick episodes; search a movie, add it whole), so
// once saved it's fully self-contained: no further TMDB lookups needed to
// serve it. Two things read this payload:
//  - fetchChannelCatalog (below) -- the catalog-row listing, which is just
//    ONE tile (the channel itself, poster + name) like any other meta item.
//  - buildChannelMeta (below) -- the full detail response with the actual
//    episode list, served from the new /meta route since Cinemeta (or
//    whatever meta add-on the person has) has never heard of these
//    synthetic ids.
// Every item's id embeds enough to resolve real streams: an episode's id is
// "<real show's imdb id>:<real season>:<real episode>" (its real show/
// season/episode, not the channel's own numbering), and a movie's id is
// just its own plain imdb id. season/episode on the *video* object itself
// are always sequential (1, 1..N) regardless of source, purely so the
// channel displays as one clean ordered list -- same as the reference
// implementation this feature is modeled on.
function parseChannelPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("channel:v1:")) return null;
    const data = JSON.parse(raw.slice("channel:v1:".length));
    return data && Array.isArray(data.items) ? data : null;
  } catch (e) {
    return null;
  }
}

function fetchChannelCatalog(entry) {
  const payload = parseChannelPayload(entry.url);
  if (!payload || !payload.items.length) return [];
  // payload.channelId/payload.name (not entry.id/entry.name) are the real
  // identity here -- when multiple channels are merged into one row (see
  // mergeChannelsIntoRow client-side), each is fetched independently via
  // fetchMergedCatalog with a synthetic { url, type } that has no entry.id
  // or entry.name at all. Falls back to the row's own for channels saved
  // before these fields existed.
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  return [
    {
      id: "channel_" + channelId,
      type: "series",
      name: name,
      poster: payload.poster || undefined,
      // "square" (1:1) cropped the sides off any wide logo (most network
      // logos are much wider than tall) -- "landscape" (16:9) is the
      // widest shape Stremio/wako support, so it crops far less. Not a
      // perfect fit for every logo's exact proportions, but the closest
      // available.
      posterShape: "landscape",
    },
  ];
}

// --- Custom Lists --------------------------------------------------------------
//
// A hand-picked list of movies OR shows (not mixed -- see payload.type),
// built by search-and-pick in the builder. Unlike a (TV) Channel this
// isn't a single synthetic tile -- each pick is returned as its own
// ordinary, independently-typed catalog item, same as any other list here.
// This also used to be split into "Movie Channels" (movies only) with its
// own merge feature; folded into one generic feature since a movie or show
// picked this way was never actually a "channel" in any meaningful sense
// -- there's no synthetic wrapper to give it one, so it's just a list, and
// simpler to treat it as exactly that (including reusing the same merge-
// into-one-shelf mechanism every other list type already has, rather than
// a bespoke one).
function parseCustomListPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("customlist:v1:")) return null;
    const data = JSON.parse(raw.slice("customlist:v1:".length));
    if (!data || !Array.isArray(data.items)) return null;
    if (data.type !== "movie" && data.type !== "series") return null;
    return data;
  } catch (e) {
    return null;
  }
}

function fetchCustomListCatalog(entry) {
  const payload = parseCustomListPayload(entry.url);
  if (!payload || !payload.items.length) return [];
  // "Randomize order" reshuffles once a day rather than on every single
  // request -- same reasoning as a Channel's "Randomize play order" (see
  // buildChannelMeta): the order stays put if someone reopens the shelf
  // later the same day, but looks freshly shuffled again tomorrow.
  // payload.listId (not entry.id) is the seed source since this list could
  // be merged with others into one row via the ordinary merge mechanism,
  // where there's no outer entry.id for any individual list to use.
  const items = payload.shuffle
    ? seededShuffle(payload.items, daysSinceEpochUTC(new Date()) + hashStringToInt(payload.listId || entry.id))
    : payload.items;
  return items
    .filter((it) => it && it.imdbId)
    .map((it) => ({
      id: it.imdbId,
      type: payload.type,
      name: it.title,
      poster: it.poster || undefined,
      releaseInfo: it.year || undefined,
    }));
}

async function fetchAutoTrackedCatalog(entry, env) {
  if (!env || !env.CONFIGS) return [];
  
  // url format: autotrack:[slug]:[type]:[username]
  // e.g. autotrack:watch-history:movie:brock25
  const parts = String(entry.url || "").split(":");
  if (parts.length < 4) return [];
  
  const slug = parts[1]; // watch-history or continue-watching
  const targetType = parts[2]; // movie or series
  const username = parts[3];
  
  try {
    const blobStr = await env.CONFIGS.get('creatorsync:' + username);
    if (!blobStr) return [];
    const blob = JSON.parse(blobStr);
    const items = slug === 'watch-history' ? blob.watchHistory : blob.continueWatching;
    if (!items || !items.length) return [];
    
    const mappedItems = [];
    
    items.forEach(it => {
      const isMovie = it.kind === 'movie' || it.type === 'movie';
      
      // Filter out types we don't want in this catalog
      if (targetType === 'movie' && !isMovie) return;
      if (targetType === 'series' && isMovie) return;
      
      const mapped = {
        id: isMovie ? (it.imdbId || it.id) : (it.showId || it.imdbId || it.id),
        type: targetType,
        name: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
        poster: isMovie ? it.poster : (it.showPoster || it.poster),
        releaseInfo: it.year || undefined
      };
      
      if (!mapped.id) return;
      
      if (targetType === 'series') {
        if (!mappedItems.some(s => s.id === mapped.id)) {
          mappedItems.push(mapped);
        }
      } else {
        mappedItems.push(mapped);
      }
    });
    
    return mappedItems;
  } catch (e) {
    return [];
  }
}

// A Custom List someone published (see /api/publish-list, or a Creator
// Profile's /api/creator/lists/save, and the public /lists/:username/
// :listname route) can be pointed at as a source the same way an
// mdblist.com URL is -- this resolves it straight from this Worker's own
// KV rather than an HTTP round-trip to itself. Needs the CONFIGS KV
// namespace bound; without one, publishing itself never succeeds in the
// first place, so there's nothing for this to find.
async function fetchPublishedListCatalog(entry, env) {
  if (!env || !env.CONFIGS) return [];
  const parsed = parsePublishedListUrl(entry.url);
  if (!parsed) return [];

  // Same lookup order and private-list handling as the public GET route
  // above: a Creator-owned list that's private is treated exactly like it
  // doesn't exist (not just "can't be added") -- someone pointing another
  // config at a guessed/leaked private-list URL gets nothing, the same
  // outcome as any other broken/nonexistent source.
  let payload = null;
  const creatorRaw = await env.CONFIGS.get(`creatorlist:${parsed.username}:${parsed.listName}`);
  if (creatorRaw) {
    try {
      const data = JSON.parse(creatorRaw);
      if (data.visibility !== "private") payload = data;
    } catch {
      // fall through to anonymous lookup below
    }
  }
  if (!payload) {
    const anonRaw = await env.CONFIGS.get(`publishedlist:${parsed.username}:${parsed.listName}`);
    if (anonRaw) {
      try {
        payload = JSON.parse(anonRaw);
      } catch {
        return [];
      }
    }
  }
  if (!payload || !Array.isArray(payload.items)) return [];
  return payload.items
    .filter((it) => it && it.imdbId)
    .map((it) => ({
      id: it.imdbId,
      type: payload.type,
      name: it.title,
      poster: it.poster || undefined,
      releaseInfo: it.year || undefined,
    }));
}

// NOTE: mixing movies into a channel is a known soft spot -- when someone
// taps a movie "episode", wako/Stremio requests its stream as
// /stream/series/<movie's plain imdb id>.json (type "series", since that's
// the parent meta's type, Stremio doesn't re-derive per-video type). Most
// stream add-ons branch their whole handler on that type param before even
// looking at the id, so a movie embedded this way may not return streams on
// every stream add-on -- Torrentio-style ones tend to be fairly lenient
// about id shape, but this isn't guaranteed across the board. Worth testing
// directly against whichever stream add-on the person actually uses.
//
// A stable string->int hash (not cryptographic, just needs to be a decent
// spread) so each channel's shuffle looks independent of every other
// channel's, rather than every shuffled channel moving in lockstep on the
// same day (see the shuffle seed below).
function hashStringToInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// mulberry32 -- a small, fast, deterministic PRNG. Good enough for shuffling
// a hand-picked list of a few dozen items into a different-but-reproducible
// order; not intended for anything security-sensitive.
function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = seed >>> 0;
  function nextRandom() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// A day's rotation is sized like an actual evening of linear TV, not a
// flat slice of the pool -- with 24 hours in a day and most shows running
// 30-60 minutes, nobody's watching anywhere near 2000 episodes in a day.
// 24 shows x 3 episodes = 72 gives a full day's variety with slack built
// in for skipping around, while still drawing from a much bigger stored
// pool over time (see CHANNEL_POOL_MAX_ITEMS client-side) so the rotation
// itself changes which shows/episodes appear from one day to the next.
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

function buildChannelMeta(entry, origin) {
  const payload = parseChannelPayload(entry.url);
  if (!payload || !payload.items.length) return null;
  // payload.channelId/payload.name (not entry.id/entry.name) are the real
  // identity -- see the same note in fetchChannelCatalog above.
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  // "Randomize play order" (set once in the Channel builder, stored on the
  // payload) reshuffles once a day rather than on every single request --
  // same reasoning as Hidden Gems' daily reshuffle (see daysSinceEpochUTC
  // below): the order stays put if someone reopens the channel later the
  // same day (mid-binge), but looks freshly shuffled again tomorrow.
  //
  // dailyRotate is a step further, set by Quick Add Channel: the payload
  // stores a much bigger pool than what's ever actually shown, and this
  // picks a fresh, structured day's lineup from that pool -- a handful of
  // different shows with a few episodes each (see the constants above),
  // not a flat random slice that could easily skew to dozens of episodes
  // of one show and none of many others. Stable within a day, different
  // the next.
  const seed = daysSinceEpochUTC(new Date()) + hashStringToInt(channelId);
  let items;
  if (payload.dailyRotate) {
    const byShow = new Map();
    payload.items.forEach((it) => {
      const key = it.imdbId || it.kind + ":" + it.title;
      if (!byShow.has(key)) byShow.set(key, []);
      byShow.get(key).push(it);
    });
    const showKeys = seededShuffle([...byShow.keys()], seed).slice(0, CHANNEL_ROTATION_SHOWS_PER_DAY);
    items = [];
    showKeys.forEach((key, i) => {
      const showEpisodes = byShow.get(key);
      const perShow = Math.min(CHANNEL_ROTATION_EPISODES_PER_SHOW, showEpisodes.length);
      // A contiguous block (not scattered episodes) feels like an actual
      // evening's run of a show -- seeded per-show so different shows
      // don't all land on the same relative starting point.
      const maxStart = showEpisodes.length - perShow;
      const starts = seededShuffle(
        Array.from({ length: maxStart + 1 }, (_, n) => n),
        seed + i + 1
      );
      const start = starts.length ? starts[0] : 0;
      items.push(...showEpisodes.slice(start, start + perShow));
    });
  } else if (payload.shuffle) {
    items = seededShuffle(payload.items, seed);
  } else {
    items = payload.items;
  }
  const videos = items.map((it, i) => {
    // TMDB's air_date/release_date (and our own year-only fallback for
    // movies) are bare "YYYY-MM-DD" dates. Stremio Web's core is compiled
    // from Rust (see the stremio-core-web/*.wasm console errors this
    // surfaced during debugging) -- its deserializer likely expects a full
    // ISO 8601 *datetime* here and can silently fail to parse the whole
    // meta object on a bare date, unlike a loose JS parser that wouldn't
    // care. Pinning to midnight UTC costs nothing (we only ever had a date
    // to begin with) and matches the shape a known-working reference
    // implementation's meta responses use.
    const releaseDate = it.released || (it.year ? `${it.year}-01-01` : undefined);
    return {
      id: it.kind === "movie" ? it.imdbId : `${it.imdbId}:${it.season}:${it.episode}`,
      title: it.title,
      season: 1,
      episode: i + 1,
      released: releaseDate ? `${releaseDate}T00:00:00.000Z` : undefined,
      thumbnail: it.thumbnail || it.poster || payload.poster || undefined,
    };
  });
  return {
    id: "channel_" + channelId,
    type: "series",
    name: name,
    poster: payload.poster || `${origin}/icon.png`,
    // Same reasoning as fetchChannelCatalog above -- landscape crops far
    // less of a wide logo than square did.
    posterShape: "landscape",
    background: payload.poster || undefined,
    videos,
  };
}

// mdblist's json feeds (public list feed and the REST API) are both either a
// flat array of items, or an object with `movies` / `shows` arrays depending
// on list contents. This normalizes + filters + maps either shape to metas.
function mapMdblistItems(data, type) {
  const items = Array.isArray(data) ? data : [...(data.movies || []), ...(data.shows || [])];
  return items
    .filter((it) => it.imdb_id)
    .filter((it) => {
      const mt = (it.mediatype || it.type || "").toLowerCase();
      if (type === "series") return mt === "show" || mt === "series" || mt === "tv";
      return mt === "movie" || mt === "";
    })
    .map((it) => ({
      id: it.imdb_id,
      type,
      name: it.title || it.name,
      poster: it.poster || `https://images.metahub.space/poster/medium/${it.imdb_id}/img`,
      releaseInfo: it.release_year ? String(it.release_year) : undefined,
    }));
}

async function fetchMdblist(entry, skip = 0, mdblistKey = "") {
  const src = mdblistJsonUrl(entry.url, mdblistKey);
  if (!src) {
    throw new Error(
      "Couldn't parse that as an mdblist.com list URL (expected .../lists/user/listname)."
    );
  }

  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.3" },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " If this is a private list, paste your MDBList API key into the 'Your API keys' box above."
        : "";
    throw new Error(`mdblist request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  const metas = mapMdblistItems(data, entry.type);
  return enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
}

// Pulls the signed-in user's MDBList watchlist via the official REST API.
// Unlike public list URLs, this always needs a personal MDBList API key —
// there's no public feed for someone else's watchlist.
async function fetchMdblistWatchlist(entry, skip = 0, mdblistKey = "") {
  if (!mdblistKey) {
    throw new Error(
      "Your MDBList watchlist needs your MDBList API key — paste it into the 'Your API keys' box above (get a free one at mdblist.com/preferences)."
    );
  }

  const res = await fetch(
    `https://api.mdblist.com/watchlist/items?apikey=${encodeURIComponent(mdblistKey)}&append_to_response=poster`,
    {
      headers: { "User-Agent": "my-list-addon/1.3" },
      cf: { cacheTtl: 300, cacheEverything: true },
    }
  );
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Double-check your MDBList API key." : "";
    throw new Error(`MDBList watchlist request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  const metas = mapMdblistItems(data, entry.type);
  return enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
}

// Trakt's list-items endpoint returns an array of wrapper objects, each
// holding either a `movie` or a `show` object (depending on `type`) with
// its own `ids` block. We only care about entries that carry an IMDB id,
// since that's what wako/Stremio catalogs key off of.
//
// NOTE: unlike mdblist and TMDB, this doesn't get its own poster/backdrop
// preference -- Trakt's `images` extended data is gated behind a paid VIP
// account, which this add-on's fixed Client ID doesn't have. Metahub.space
// remains the only poster source for Trakt-sourced items.
// Trakt's list-items and most chart endpoints return an array of wrapper
// objects, each holding either a `movie` or a `show` object (depending on
// `type`) with its own `ids` block. A few endpoints (confirmed so far:
// /movies/popular and /shows/popular) instead return the movie/show fields
// directly at the top level with no wrapper at all -- `it.movie || it.show
// || it` handles both shapes: if neither wrapper key is present, it falls
// back to treating the item itself as the movie/show object.
function mapTraktItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  return items
    .map((it) => it.movie || it.show || it)
    .filter((it) => it && it.ids && it.ids.imdb)
    .map((it) => ({
      id: it.ids.imdb,
      type,
      name: it.title,
      poster: `https://images.metahub.space/poster/medium/${it.ids.imdb}/img`,
      releaseInfo: it.year ? String(it.year) : undefined,
    }));
}

// Pulls a public trakt.tv list via the official REST API. Trakt paginates
// server-side (unlike mdblist, which we fetch in full and slice locally),
// so `skip` is translated into a page number using our fixed PAGE_SIZE as
// the page length — this only lines up cleanly if skip always arrives as a
// multiple of PAGE_SIZE, which is how wako/Stremio drive the `skip` extra.
// Every request — public or private — needs a Client ID; there's no
// keyless public feed the way mdblist.com has one. A private list
// additionally needs accessToken (the OAuth token from "Connect Trakt" --
// see /api/trakt/oauth/* below), sent as a Bearer token alongside the
// Client ID.
async function fetchTrakt(entry, skip = 0, traktKey = "", accessToken = "") {
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }

  const parsed = traktListPath(entry.url);
  if (!parsed) {
    throw new Error(
      "Couldn't parse that as a trakt.tv list URL (expected trakt.tv/users/USER/lists/LIST)."
    );
  }

  const itemKind = entry.type === "series" ? "shows" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/${encodeURIComponent(
    parsed.user
  )}/lists/${encodeURIComponent(parsed.list)}/items/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": "my-list-addon/1.4",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(src, {
    headers,
    // A Bearer-authenticated request must never be edge-cached the same
    // way a public one is: Cloudflare's default cache key is the URL
    // alone and ignores headers, so caching this could serve one person's
    // private list response back to a completely different, unauthenticated
    // request for that same URL path later. Only cache when there's no
    // token attached (a genuinely public request).
    cf: accessToken ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? accessToken
          ? " If this is a private list, make sure you're connected as its owner (see Connect Trakt in Settings)."
          : " Double-check the list URL and that the list is public."
        : res.status === 401 || res.status === 403
        ? accessToken
          ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
          : " Double-check your Trakt Client ID."
        : "";
    throw new Error(`Trakt request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// Pulls the connected account's Trakt watchlist -- a genuinely different
// endpoint from a Trakt list (Trakt treats "the watchlist" as its own
// separate thing, never returned alongside /users/me/lists, see
// /api/trakt-my-private-lists below where it's fetched and prepended
// separately). Always needs the OAuth access token from Connect Trakt --
// unlike a list, a watchlist has no public/unauthenticated form at all.
async function fetchTraktWatchlist(entry, skip = 0, traktKey = "", accessToken = "") {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your watchlist needs your own Trakt sign-in, there's no public version of it."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  const itemKind = entry.type === "series" ? "shows" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/me/watchlist/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    },
    // Always authenticated/per-person -- never cached, same reasoning as
    // fetchTrakt above (a shared cache key would risk leaking one
    // person's watchlist into a different, unrelated request).
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
        : "";
    throw new Error(`Trakt watchlist request failed (HTTP ${res.status}).${hint}`);
  }
  const data = await res.json();
  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// History's shape is different from a plain list/watchlist -- each row is
// { watched_at, action, movie } or { watched_at, action, episode, show }
// instead of the { movie } / { show } wrapper mapTraktItems expects.
// Movies map basically like any other Trakt item. TV history is logged
// per-episode by Trakt (there's no per-episode imdb id), so each row keeps
// the show's own imdb id -- same as any other series tile, so it opens the
// real show normally -- with the season/episode/watched date folded into
// the title so a watch event still reads as its own row even when several
// share that id. James wants every watch event shown (rewatches included),
// so this deliberately doesn't dedupe -- the same show/episode can appear
// more than once, same id and all. Known tradeoff: a few Stremio/wako
// clients key catalog rows by id for rendering, so a show watched several
// times in a row could in principle render oddly there; left as-is since
// collapsing to one row per title was explicitly not what was wanted here.
function mapTraktHistoryItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  const watchedLabel = (watchedAt) => {
    if (!watchedAt) return undefined;
    const d = new Date(watchedAt);
    return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
  };
  if (type === "series") {
    return items
      .filter((it) => it && it.episode && it.show && it.show.ids && it.show.ids.imdb)
      .map((it) => {
        const imdbId = it.show.ids.imdb;
        const s = it.episode.season;
        const e = it.episode.number;
        const epTitle = it.episode.title ? ` \u2014 ${it.episode.title}` : "";
        return {
          id: imdbId,
          type,
          name: `${it.show.title} S${s}E${e}${epTitle}`,
          // Plain show title, kept alongside the folded per-episode `name`
          // above -- lets a caller that wants "one tile per show" (Copy to
          // Custom List's Shows mode, see copyListToCustomList) recover
          // the clean title without having to string-parse it back out of
          // "Show S1E5 \u2014 Episode Title". Not used by the live catalog
          // row itself (Stremio/wako only ever see `name`).
          showTitle: it.show.title,
          poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
          releaseInfo: watchedLabel(it.watched_at),
        };
      });
  }
  return items
    .filter((it) => it && it.movie && it.movie.ids && it.movie.ids.imdb)
    .map((it) => ({
      id: it.movie.ids.imdb,
      type,
      name: it.movie.title,
      poster: `https://images.metahub.space/poster/medium/${it.movie.ids.imdb}/img`,
      releaseInfo: watchedLabel(it.watched_at) || (it.movie.year ? String(it.movie.year) : undefined),
    }));
}

// Pulls the connected account's Trakt watch history -- a chronological log
// of every watch event, as opposed to fetchTraktWatchlist (queued-to-watch)
// or fetchTrakt (a saved list). Rewatches show up as separate entries here
// since Trakt logs a fresh row every time something's marked watched.
// Always needs the OAuth access token from Connect Trakt -- same as the
// watchlist, there's no public/unauthenticated form of a personal history.
async function fetchTraktHistory(entry, skip = 0, traktKey = "", accessToken = "") {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your watch history needs your own Trakt sign-in, there's no public version of it."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  // Movies use Trakt's /history/movies; shows use /history/episodes (Trakt
  // logs individual episode watches, not whole shows -- see
  // mapTraktHistoryItems for how that's folded back into a series tile).
  const itemKind = entry.type === "series" ? "episodes" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/me/history/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    },
    // Always authenticated/per-person -- never cached, same reasoning as
    // fetchTraktWatchlist above.
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
        : "";
    throw new Error(`Trakt history request failed (HTTP ${res.status}).${hint}`);
  }
  const data = await res.json();
  return enrichTrailers(mapTraktHistoryItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// --- Simkl trending charts --------------------------------------------------
//
// Unlike Trakt/TMDB charts, these aren't a real paginated API -- Simkl
// publishes pre-built static JSON files (today/week/month trending, split
// by movies/tv/anime) to a CDN, refreshed on their own schedule. So like
// mdblist, we fetch the whole file and slice it locally for paging, rather
// than translating `skip` into a page number.
const SIMKL_CHART_FILES = {
  today: "today_100",
  week: "week_100",
  month: "month_100",
};

// Simkl's items use the same { ids: { imdb, tmdb, ... } } shape Trakt's do.
// Anime entries more often lack an IMDB id than movies/TV do (per Simkl's
// own docs: "IMDB IDs where available") -- those just get filtered out,
// same as any other source's imdb-less items, since this add-on always
// keys catalog items by IMDB id.
function mapSimklItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  return items
    .filter((it) => it && it.ids && it.ids.imdb)
    .map((it) => ({
      id: it.ids.imdb,
      type,
      name: it.title,
      poster: `https://images.metahub.space/poster/medium/${it.ids.imdb}/img`,
      releaseInfo: it.year ? String(it.year) : undefined,
    }));
}

// chartKey is either a plain time window ("today"/"week"/"month" -- movies
// or tv, chosen by entry.type same as every other chart source here) or
// "anime-<window>" for the dedicated Anime Trending row, which always
// pulls the anime category regardless of entry.type (anime trending mixes
// movies and series under one Simkl category, so there's no clean
// movie/series split to key off of -- see SIMKL_ANIME_LIST below).
async function fetchSimklChart(entry, skip, clientId, chartKey) {
  if (!clientId) {
    throw new Error(
      "Simkl charts aren't configured on this add-on yet — the Worker owner needs to set SIMKL_CLIENT_ID."
    );
  }
  const isAnime = chartKey.startsWith("anime-");
  const windowKey = isAnime ? chartKey.slice("anime-".length) : chartKey;
  const file = SIMKL_CHART_FILES[windowKey] || SIMKL_CHART_FILES.today;
  const category = isAnime ? "anime" : entry.type === "series" ? "tv" : "movies";

  const src =
    `https://data.simkl.in/discover/trending/${category}/${file}.json` +
    `?client_id=${encodeURIComponent(clientId)}&app-name=my-lists-addon&app-version=${encodeURIComponent(ADDON_VERSION)}`;
  const res = await fetch(src, {
    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`Simkl chart request failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const metas = mapSimklItems(data, entry.type);
  return enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
}

// Maps our own entry.type ("movie"/"series") to the right path for each of
// Trakt's official chart endpoints. box_office has no shows equivalent --
// weekly box-office gross is inherently a theatrical-movies concept.
const TRAKT_CHART_PATHS = {
  trending: { movie: "movies/trending", series: "shows/trending" },
  popular: { movie: "movies/popular", series: "shows/popular" },
  most_played: { movie: "movies/played/weekly", series: "shows/played/weekly" },
  most_watched: { movie: "movies/watched/weekly", series: "shows/watched/weekly" },
  most_collected: { movie: "movies/collected/weekly", series: "shows/collected/weekly" },
  most_favorited: { movie: "movies/favorited/weekly", series: "shows/favorited/weekly" },
  most_anticipated: { movie: "movies/anticipated", series: "shows/anticipated" },
  box_office: { movie: "movies/boxoffice" },
};

// Pulls one of Trakt's own official charts (trending/most-watched/most-
// collected/box-office), as opposed to fetchTrakt above which pulls a
// specific user's list. These endpoints all wrap each item as
// {movie: {...}} or {show: {...}} plus some stats fields (watchers,
// revenue, etc. depending on chart) -- the same shape fetchTrakt's user-list
// endpoint returns, so mapTraktItems handles both without changes.
async function fetchTraktChart(entry, skip, traktKey, chartKey) {
  if (!traktKey) {
    throw new Error(
      "Trakt charts aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  const wantKind = entry.type === "series" ? "series" : "movie";
  const pathMap = TRAKT_CHART_PATHS[chartKey];
  const chartPath = pathMap && pathMap[wantKind];
  if (!chartPath) {
    throw new Error("Trakt doesn't publish a shows version of this chart.");
  }

  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/${chartPath}?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      "User-Agent": "my-list-addon/1.8",
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Double-check the Trakt Client ID." : "";
    throw new Error(`Trakt chart request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// Runs async `fn` over `items` with at most `limit` running at once, rather
// than firing them all in parallel. Used for TMDB's per-item external_ids
// lookups (see fetchTmdb below) so a single catalog page (up to PAGE_SIZE
// items) doesn't blow past TMDB's soft ~20-simultaneous-connections-per-IP
// limit and start drawing 429s.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- trailers -------------------------------------------------------------
//
// Stremio's meta object supports a trailerStreams field (YouTube-hosted
// trailer/teaser clips) that clients like wako show on the detail view.
// This add-on never implements a separate "meta" resource -- catalog items
// double as the full meta object -- so trailerStreams just needs to be
// attached to the same objects this file already builds.
//
// Picks the best YouTube trailer from a TMDB /videos-style results array:
// an official "Trailer" wins, a "Teaser" is the fallback, anything else
// (Clip, Featurette, Behind the Scenes) is ignored.
function pickTrailerKey(videosResults) {
  if (!Array.isArray(videosResults)) return null;
  const trailer =
    videosResults.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    videosResults.find((v) => v.site === "YouTube" && v.type === "Teaser");
  return trailer ? trailer.key : null;
}

function trailerStreamsFor(ytKey) {
  return ytKey ? [{ title: "Trailer", ytId: ytKey }] : undefined;
}

// For items that only carry an IMDB id (mdblist/Trakt sources never expose
// a TMDB id), resolving a trailer needs an extra round trip: TMDB's /find
// endpoint to translate imdb_id -> tmdb_id, then a /videos call on that id.
// Both legs are hard-cached at Cloudflare's edge (shared across every user
// of the add-on, same as fetchTmdbDetails below), so this only costs a real
// TMDB request the first time any list anywhere references a given title.
// Best-effort: any failure just means no trailer, never a broken catalog.
async function fetchTrailerForImdb(imdbId, type, apiKey) {
  if (!apiKey || !imdbId) return null;
  try {
    const findRes = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`,
      { headers: { "User-Agent": "my-list-addon/1.14" }, cf: { cacheTtl: 604800, cacheEverything: true } }
    );
    if (!findRes.ok) return null;
    const findData = await findRes.json();
    const kind = type === "series" ? "tv" : "movie";
    const resultsKey = kind === "tv" ? "tv_results" : "movie_results";
    const match = (findData[resultsKey] || [])[0];
    if (!match) return null;

    const videosRes = await fetch(
      `https://api.themoviedb.org/3/${kind}/${match.id}/videos?api_key=${encodeURIComponent(apiKey)}`,
      { headers: { "User-Agent": "my-list-addon/1.14" }, cf: { cacheTtl: 604800, cacheEverything: true } }
    );
    if (!videosRes.ok) return null;
    const videosData = await videosRes.json();
    return pickTrailerKey(videosData.results);
  } catch {
    return null;
  }
}

// Attaches trailerStreams to a batch of already-built metas (mdblist/Trakt
// sources only -- TMDB-sourced metas already get theirs for free via
// fetchTmdbDetails's append_to_response=videos, see below). Silently a
// no-op when no TMDB_API_KEY is configured on this Worker.
async function enrichTrailers(metas, type, apiKey) {
  if (!apiKey || !metas.length) return metas;
  await mapWithConcurrency(metas, 8, async (m) => {
    const ytKey = await fetchTrailerForImdb(m.id, type, apiKey);
    if (ytKey) m.trailerStreams = trailerStreamsFor(ytKey);
  });
  return metas;
}

// TMDB's list items only carry a TMDB id, not an IMDB id, so each item needs
// a follow-up call to resolve one. A title's external ids essentially never
// change once assigned, so this is cached hard (a week) at Cloudflare's
// edge — that cache is shared across every user of the add-on, so only the
// very first time *any* list anywhere references a given title does this
// cost a real TMDB request; every catalog load after that hits cache.
// Combines what used to be two separate needs -- resolving an IMDB id, and
// (now) fetching trailer videos -- into the single per-item TMDB request
// this add-on was already making, via append_to_response. Same hard-cached
// cost as before; trailers just ride along for free.
async function fetchTmdbDetails(tmdbId, kind, apiKey) {
  const src = `https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${encodeURIComponent(
    apiKey
  )}&append_to_response=external_ids,videos`;
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return { imdbId: null, videos: null };
  const data = await res.json();
  const imdbId = (data.external_ids && data.external_ids.imdb_id) || data.imdb_id || null;
  const videos = (data.videos && data.videos.results) || null;
  return { imdbId, videos };
}

// Pulls a public themoviedb.org list via TMDB's v4 List Details endpoint.
// NOTE: we deliberately use v4 here, not v3 — v3's /list/{id} endpoint does
// not reliably paginate (TMDB's own support has pointed people at v4 for
// exactly this "my list has more items than I'm getting back" problem), while
// v4 documents proper 20-items-per-page pagination with page/total_pages.
// v4's GET endpoints still accept the same plain api_key query param as v3
// (no separate bearer/read-access token needed), so this uses the same key
// as everything else in this add-on.
//
// v4 list items always carry a media_type ("movie" or "tv"), since v4 lists
// support mixing both — we filter to whichever this catalog row wants.
async function fetchTmdb(entry, skip = 0, apiKey = "") {
  if (!apiKey) {
    throw new Error(
      "TMDB lists aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }

  const listId = tmdbListId(entry.url);
  if (!listId) {
    throw new Error(
      "Couldn't parse that as a themoviedb.org list URL (expected themoviedb.org/list/LIST_ID)."
    );
  }

  const wantKind = entry.type === "series" ? "tv" : "movie";
  const MAX_PAGES = 150; // 150 * 20 = 3000 items; a generous ceiling for personal lists
  const filtered = [];
  let tmdbPage = 1;
  let totalPages = 1;

  while (filtered.length < skip + PAGE_SIZE && tmdbPage <= Math.min(totalPages, MAX_PAGES)) {
    const src = `https://api.themoviedb.org/4/list/${listId}?api_key=${encodeURIComponent(
      apiKey
    )}&page=${tmdbPage}`;
    const res = await fetch(src, {
      headers: { "User-Agent": "my-list-addon/1.6" },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) {
      if (tmdbPage === 1) {
        const hint =
          res.status === 404
            ? " Double-check the list exists and is public."
            : res.status === 401 || res.status === 403
            ? " Double-check the TMDB API key."
            : "";
        throw new Error(`TMDB request failed (HTTP ${res.status}).${hint}`);
      }
      break; // a later page failing shouldn't blank out items we already have
    }

    const data = await res.json();
    // Prefer v4's documented "results" array; fall back to "items" in case
    // a particular list still returns the legacy v3-style shape.
    const items = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.items)
      ? data.items
      : [];
    if (items.length === 0) break; // no more pages
    if (typeof data.total_pages === "number" && data.total_pages > 0) {
      totalPages = data.total_pages;
    }

    for (const it of items) {
      const kind = it.media_type === "tv" || it.media_type === "movie" ? it.media_type : wantKind;
      if (kind === wantKind) filtered.push(it);
    }
    tmdbPage++;
  }

  const page = filtered.slice(skip, skip + PAGE_SIZE);

  const resolved = await mapWithConcurrency(page, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

// Shared meta-shaping for any TMDB item (list, chart, wherever), once its
// IMDB id is known. TMDB's own poster_path/backdrop_path are already
// sitting right there in the response (zero extra requests), and cover
// obscure titles more reliably than metahub.space's IMDB-keyed poster
// database -- preferred over metahub, with metahub only as a fallback for
// the rare item missing a poster_path.
function mapTmdbItem(it, imdbId, type, videos) {
  return {
    id: imdbId,
    type,
    name: it.title || it.name,
    poster: it.poster_path
      ? `https://image.tmdb.org/t/p/w500${it.poster_path}`
      : `https://images.metahub.space/poster/medium/${imdbId}/img`,
    background: it.backdrop_path ? `https://image.tmdb.org/t/p/w1280${it.backdrop_path}` : undefined,
    releaseInfo: (it.release_date || it.first_air_date || "").slice(0, 4) || undefined,
    trailerStreams: trailerStreamsFor(pickTrailerKey(videos)),
  };
}

// Maps our own entry.type ("movie"/"series") to the right TMDB v3 endpoint
// for each official chart. now_playing/upcoming don't have exact TV
// equivalents on TMDB -- airing_today/on_the_air are the closest concepts,
// reused under the same display name for consistency with how the
// Trending/Popular quick-add panels already pair up a movie list and a
// show list under one shared catalog name.
const TMDB_CHART_PATHS = {
  trending: { movie: "trending/movie/week", tv: "trending/tv/week" },
  popular: { movie: "movie/popular", tv: "tv/popular" },
  top_rated: { movie: "movie/top_rated", tv: "tv/top_rated" },
  now_playing: { movie: "movie/now_playing", tv: "tv/airing_today" },
  upcoming: { movie: "movie/upcoming", tv: "tv/on_the_air" },
};

// Fetches a PAGE_SIZE window (starting at `skip`, optionally offset by an
// extra `pageOffset` pages -- used by Hidden Gems below for its daily
// reshuffle) from any standard, reliably-paginated TMDB v3 endpoint fixed
// at 20 items/page. Maps our own pagination onto exactly enough consecutive
// TMDB pages, fetched in parallel, and returns the raw TMDB result objects
// for that window (callers resolve IMDB ids / shape metas themselves).
// Shared by fetchTmdbChart and fetchTmdbHiddenGems so this math -- and its
// "skip may not land on a TMDB page boundary" edge case -- only lives once.
async function fetchTmdbPagedResults(pathAndQuery, apiKey, skip, pageOffset = 0) {
  const totalSkip = skip + pageOffset * 20;
  const firstTmdbPage = Math.floor(totalSkip / 20) + 1;
  const offsetWithinFirstPage = totalSkip % 20;
  // If the effective skip doesn't land on a clean TMDB page boundary, that
  // offset eats into the front of the fetched range -- fetch one extra
  // page's worth so trimming it still leaves a full PAGE_SIZE window
  // rather than coming up short at the tail.
  const pagesNeeded = Math.ceil((PAGE_SIZE + offsetWithinFirstPage) / 20);
  const pageNums = Array.from({ length: pagesNeeded }, (_, i) => firstTmdbPage + i);
  const sep = pathAndQuery.includes("?") ? "&" : "?";

  const pageResults = await Promise.all(
    pageNums.map(async (p) => {
      const src = `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${encodeURIComponent(
        apiKey
      )}&page=${p}`;
      const res = await fetch(src, {
        headers: { "User-Agent": "my-list-addon/1.9" },
        cf: { cacheTtl: 900, cacheEverything: true },
      });
      if (!res.ok) return { ok: false, status: res.status, items: [] };
      const data = await res.json();
      return { ok: true, items: Array.isArray(data.results) ? data.results : [] };
    })
  );

  if (!pageResults[0].ok) {
    const status = pageResults[0].status;
    const hint = status === 401 ? " Double-check the TMDB API key." : "";
    throw new Error(`TMDB request failed (HTTP ${status}).${hint}`);
  }

  const allItems = pageResults.flatMap((p) => p.items);
  return allItems.slice(offsetWithinFirstPage, offsetWithinFirstPage + PAGE_SIZE);
}

// Pulls one of TMDB's own official charts. Unlike fetchTmdb above (which
// fetches a specific user-curated list and has to walk pages defensively
// since v3's /list/{id} pagination is flaky), these are standard, reliably-
// paginated v3 endpoints -- see fetchTmdbPagedResults.
async function fetchTmdbChart(entry, skip, apiKey, chartKey) {
  if (!apiKey) {
    throw new Error(
      "TMDB charts aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const pathMap = TMDB_CHART_PATHS[chartKey];
  const chartPath = pathMap && pathMap[wantKind];
  if (!chartPath) {
    throw new Error("This TMDB chart doesn't have a shows version.");
  }

  const windowItems = await fetchTmdbPagedResults(chartPath, apiKey, skip);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

// --- Hidden Gems: a no-personalization discovery shelf ---------------------
//
// For the "I'm scrolling and don't know what to watch" moment: well-
// reviewed titles that haven't been seen by a blockbuster-sized audience,
// via TMDB's discover endpoint filtered to a rating floor and a vote-count
// band that excludes both obscure/unreliable ratings (too few votes) and
// the same overexposed hits the Trending/Popular panels already surface
// (too many votes). These thresholds are a judgment call, not a precise
// science -- tune them here if the shelf feels too broad or too empty.
const HIDDEN_GEMS_MIN_RATING = 7.5;
const HIDDEN_GEMS_MIN_VOTES = 100;
const HIDDEN_GEMS_MAX_VOTES = 3000;
// How many TMDB discover pages to rotate the daily reshuffle through.
const HIDDEN_GEMS_PAGE_POOL = 40;

// Days-since-epoch in UTC -- used as a simple, stateless daily seed (no KV
// or other storage needed): the shelf shows a different slice of matching
// titles each day, but stays stable (and paginates correctly as someone
// scrolls) within that same day.
function daysSinceEpochUTC(d) {
  return Math.floor(d.getTime() / 86400000);
}

async function fetchTmdbHiddenGems(entry, skip, apiKey) {
  if (!apiKey) {
    throw new Error(
      "Hidden Gems isn't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const discoverPath =
    `discover/${wantKind}?sort_by=vote_average.desc` +
    `&vote_average.gte=${HIDDEN_GEMS_MIN_RATING}` +
    `&vote_count.gte=${HIDDEN_GEMS_MIN_VOTES}` +
    `&vote_count.lte=${HIDDEN_GEMS_MAX_VOTES}` +
    `&include_adult=false`;

  const pageOffset = daysSinceEpochUTC(new Date()) % HIDDEN_GEMS_PAGE_POOL;
  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, pageOffset);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}


async function fetchTmdbKids(entry, skip, apiKey, ratingGroup) {
  if (!apiKey) {
    throw new Error(
      "Kids lists aren't configured on this add-on yet - the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  
  let certification = "";
  if (wantKind === "movie") {
    if (ratingGroup === "g") certification = "G";
    else if (ratingGroup === "pg") certification = "G|PG";
    else if (ratingGroup === "pg13") certification = "G|PG|PG-13";
  } else {
    if (ratingGroup === "g") certification = "TV-Y|TV-Y7|TV-G";
    else if (ratingGroup === "pg") certification = "TV-Y|TV-Y7|TV-G|TV-PG";
    else if (ratingGroup === "pg13") certification = "TV-Y|TV-Y7|TV-G|TV-PG|TV-14";
  }
  
  const discoverPath =
    "discover/" + wantKind + "?sort_by=popularity.desc" +
    "&certification_country=US&certification=" + certification +
    "&include_adult=false";

  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, 0);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

async function fetchTmdbItemDetails(imdbId, apiKey, fallbackType) {
  if (!apiKey) return null;
  let tmdbId = null;
  let type = null;

  // Shows/movies opened from title search (Search Movies & TV Shows) carry
  // a "tmdb:<id>" identifier instead of a real IMDb id -- skip the IMDb
  // lookup below entirely for those and use the TMDB id directly. The type
  // isn't encoded in the id itself, but the client always sends one
  // alongside it (see /api/details above), so fallbackType covers it.
  if (imdbId.startsWith('tmdb:')) {
    tmdbId = imdbId.split(':')[1];
    type = fallbackType === 'series' ? 'tv' : fallbackType;
  }

  if (!tmdbId) {
    const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(imdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
    const findRes = await fetch(findSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (!findRes.ok) return null;
    const findData = await findRes.json();
    
    if (findData.movie_results && findData.movie_results.length > 0) {
      tmdbId = findData.movie_results[0].id;
      type = "movie";
    } else if (findData.tv_results && findData.tv_results.length > 0) {
      tmdbId = findData.tv_results[0].id;
      type = "tv";
    }
  }
  if (!tmdbId) return null;

  const detailSrc = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings";
  const detailRes = await fetch(detailSrc, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!detailRes.ok) return null;
  const match = await detailRes.json();
  
  // Extract content rating (US fallback)
  let contentRating = null;
  if (type === "movie" && match.release_dates && match.release_dates.results) {
    const us = match.release_dates.results.find(r => r.iso_3166_1 === "US");
    if (us && us.release_dates.length > 0) {
      contentRating = us.release_dates.find(r => r.certification)?.certification;
    }
  } else if (type === "tv" && match.content_ratings && match.content_ratings.results) {
    const us = match.content_ratings.results.find(r => r.iso_3166_1 === "US");
    if (us) contentRating = us.rating;
  }
  
  // Extract trailer
  let trailerKey = null;
  if (match.videos && match.videos.results) {
    const trailer = match.videos.results.find((v) => v.site === "YouTube" && v.type === "Trailer") || 
                    match.videos.results.find((v) => v.site === "YouTube" && v.type === "Teaser");
    if (trailer) trailerKey = trailer.key;
  }

  return {
    id: imdbId,
    title: match.title || match.name,
    overview: match.overview || "",
    poster: match.poster_path ? "https://image.tmdb.org/t/p/w500" + match.poster_path : "",
    background: match.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + match.backdrop_path : "",
    rating: match.vote_average ? match.vote_average.toFixed(1) : null,
    releaseYear: (match.release_date || match.first_air_date || "").slice(0, 4),
    releaseDate: match.release_date || match.first_air_date || null,
    seasonsData: type === "tv" && match.seasons ? match.seasons : null,
    runtime: match.runtime || (match.episode_run_time && match.episode_run_time[0]) || null,
    budget: match.budget || null,
    revenue: match.revenue || null,
    contentRating: contentRating || null,
    genres: (match.genres || []).map(g => g.name).join(', '),
    trailerKey: trailerKey
  };
}

async function fetchTmdbSeasonDetails(imdbId, seasonNum, apiKey) {
  if (!apiKey) return null;
  // Shows opened from title search (Search Movies & TV Shows) carry a
  // "tmdb:<id>" identifier instead of a real IMDb id -- skip the IMDb
  // lookup entirely for those and use the TMDB id directly, same as
  // fetchTmdbItemDetails already does above. Without this, TMDB's /find
  // endpoint (which only accepts real external ids) returns nothing for a
  // "tmdb:12345" string, every season fails to load ("Error loading
  // episodes."), and since no episodes ever render there's nothing left to
  // mark watched either.
  let tmdbId;
  if (imdbId.startsWith('tmdb:')) {
    tmdbId = imdbId.split(':')[1];
  } else {
    // First, find TMDB ID from IMDB ID
    const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(imdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
    const findRes = await fetch(findSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (!findRes.ok) return null;
    const findData = await findRes.json();

    if (!findData.tv_results || findData.tv_results.length === 0) return null;
    tmdbId = findData.tv_results[0].id;
  }

  const src = "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + seasonNum + "?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return null;
  const data = await res.json();
  
  return {
    episodes: (data.episodes || []).map(ep => ({
      id: ep.id,
      episode_number: ep.episode_number,
      name: ep.name,
      overview: ep.overview,
      runtime: ep.runtime,
      air_date: ep.air_date,
      vote_average: ep.vote_average,
      still_path: ep.still_path ? "https://image.tmdb.org/t/p/w500" + ep.still_path : null
    }))
  };
}

// Server-side "is this episode aired yet" check -- same rule the client's
// isEpisodeAired uses (19_client-search-and-likes.js), reimplemented here
// because nothing in the client-side files (09 onward) is real, callable
// code from the Worker's own perspective; they're embedded template-literal
// text that only becomes real JS once served to and run by a browser. Used
// by findNextAiredEpisodeForShow below, for the Continue Watching cron
// (see checkForNewEpisodes in 07_source-fetchers-tmdb-simkl.js).
function isEpisodeAiredServer(ep) {
  if (!ep || !ep.air_date) return false;
  const airDate = new Date(ep.air_date);
  if (isNaN(airDate.getTime())) return false;
  return airDate.getTime() <= Date.now();
}

// Given a show and the latest episode known to be watched, looks for the
// next unwatched, already-aired episode -- same season-then-next-season
// logic as the client's updateContinueWatching
// (21_client-custom-list-builder.js), reimplemented server-side for the
// same reason as isEpisodeAiredServer above. Returns { episode, seasonNum }
// or null if nothing new has aired since latestSeasonNum/latestEpisodeNum.
async function findNextAiredEpisodeForShow(imdbId, latestSeasonNum, latestEpisodeNum, apiKey) {
  const data = await fetchTmdbSeasonDetails(imdbId, latestSeasonNum, apiKey);
  if (data && data.episodes) {
    const nextInSeason = data.episodes
      .filter((ep) => isEpisodeAiredServer(ep))
      .find((ep) => ep.episode_number > latestEpisodeNum);
    if (nextInSeason) return { episode: nextInSeason, seasonNum: latestSeasonNum };
  }
  const nextSeasonNum = latestSeasonNum + 1;
  const data2 = await fetchTmdbSeasonDetails(imdbId, nextSeasonNum, apiKey);
  if (data2 && data2.episodes) {
    const aired = data2.episodes.filter((ep) => isEpisodeAiredServer(ep)).sort((a, b) => a.episode_number - b.episode_number);
    if (aired.length) return { episode: aired[0], seasonNum: nextSeasonNum };
  }
  return null;
}

// Continue Watching cron -- invoked from the scheduled() export at the
// bottom of 26_api-creator-and-admin-routes.js, which itself only fires if
// this Worker's owner has added a Cron Trigger in the Cloudflare dashboard
// (Worker -> Triggers -> Cron Triggers); nothing in this source code can
// turn that on by itself, since it's Worker configuration rather than
// something deployable in a paste-in file. See this repo's README for the
// one-time setup step.
//
// Scope: only accounts with a Creator Profile have anything to check here
// at all -- Watch History/Continue Watching for someone using just an
// install link lives solely in their own browser's localStorage, which a
// server-side job has no way to reach. Within an account, only shows
// already in fullyWatchedShowIds (as of the last time anything ran there,
// client-side or here) get checked -- a show with a known next-unwatched
// episode already sitting in continueWatching doesn't need TMDB re-checked
// on a timer; nothing about "what's next" changes there until the person
// actually watches it, which already updates things instantly client-side.
//
// Processes a bounded batch of accounts per run (ACCOUNT_BATCH_SIZE) and a
// bounded number of show lookups across that whole batch
// (SHOW_CHECK_BUDGET), resuming from a stored KV cursor next run rather
// than sweeping every account in one pass -- with enough self-hosted
// accounts, one pass could easily exceed a single invocation's time/TMDB-
// rate budget. The tradeoff: on a busy deployment, any one account's "how
// long since this was actually checked" drifts from a strict 6 hours to
// more like "gets covered every so often as the cursor cycles back
// around" -- there's no hard per-account freshness guarantee here, just
// steady, bounded progress.
async function checkForNewEpisodes(env) {
  if (!env || !env.CONFIGS || !env.TMDB_API_KEY) return;

  const ACCOUNT_BATCH_SIZE = 25;
  const SHOW_CHECK_BUDGET = 150;

  const cursorRaw = await env.CONFIGS.get('cron:continuewatching:cursor');
  const listOpts = { prefix: 'creator:', limit: ACCOUNT_BATCH_SIZE };
  if (cursorRaw) listOpts.cursor = cursorRaw;
  const listResult = await env.CONFIGS.list(listOpts);

  // Cycle back to the start once the full account list has been swept,
  // rather than stopping -- so the next run picks up fresh with account
  // #1 again instead of sitting idle.
  await env.CONFIGS.put('cron:continuewatching:cursor', listResult.list_complete ? '' : (listResult.cursor || ''));

  let showChecksUsed = 0;

  for (const key of listResult.keys) {
    if (showChecksUsed >= SHOW_CHECK_BUDGET) break;
    const username = key.name.slice('creator:'.length);
    const syncRaw = await env.CONFIGS.get(`creatorsync:${username}`);
    if (!syncRaw) continue;

    let blob;
    try {
      blob = JSON.parse(syncRaw);
    } catch (e) {
      continue;
    }

    const fullyWatched = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
    if (!fullyWatched.length) continue;

    const continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
    const alreadyQueued = new Set(continueWatching.map((it) => it.showId));
    const watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
    const dismissed = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === 'object' ? blob.dismissedContinueWatching : {};

    let blobChanged = false;
    const stillFullyWatched = [];

    for (const showId of fullyWatched) {
      if (showChecksUsed >= SHOW_CHECK_BUDGET) {
        stillFullyWatched.push(showId); // ran out of budget -- leave it queued for next run rather than dropping it
        continue;
      }
      if (alreadyQueued.has(showId)) {
        stillFullyWatched.push(showId); // shouldn't normally happen (see comment above), but preserve rather than lose data if it does
        continue;
      }

      const watchedEps = watchHistory.filter((it) => it.type === 'episode' && it.showId === showId && it.seasonNum != null && it.episodeNum != null);
      if (!watchedEps.length) continue; // nothing watched at all -- stale entry, drop it
      const latest = watchedEps.reduce((best, ep) => {
        if (ep.seasonNum > best.seasonNum) return ep;
        if (ep.seasonNum === best.seasonNum && ep.episodeNum > best.episodeNum) return ep;
        return best;
      }, watchedEps[0]);

      showChecksUsed++;
      let next = null;
      try {
        next = await findNextAiredEpisodeForShow(showId, latest.seasonNum, latest.episodeNum, env.TMDB_API_KEY);
      } catch (e) {
        stillFullyWatched.push(showId); // network hiccup -- try again next run instead of assuming still fully watched
        continue;
      }
      if (!next) {
        stillFullyWatched.push(showId); // still nothing new -- stays in the check list for next time
        continue;
      }

      // Respect an explicit removal the same way updateContinueWatching
      // already does client-side -- see dismissContinueWatchingShow's own
      // comment (21_client-custom-list-builder.js) for why this compares
      // against the exact watched snapshot rather than just "was this
      // show ever dismissed."
      const stillDismissed = dismissed[showId] && dismissed[showId].seasonNum === latest.seasonNum && dismissed[showId].episodeNum === latest.episodeNum;
      if (stillDismissed) {
        stillFullyWatched.push(showId);
        continue;
      }

      continueWatching.unshift({
        id: String(next.episode.id),
        type: 'episode',
        name: next.episode.name,
        // Continue Watching cards show the series poster, not the episode
        // still -- matches updateContinueWatching's own client-side
        // behavior (11_ ... client-list functions) and keeps the shelf
        // visually consistent with every other poster-based row.
        poster: latest.showPoster || '',
        showId: showId,
        showTitle: latest.showTitle || '',
        showPoster: latest.showPoster || '',
        seasonNum: next.seasonNum,
        episodeNum: next.episode.episode_number,
      });
      // No longer "fully watched" -- it has a known next episode now,
      // same as if updateContinueWatching had just found it client-side.
      blobChanged = true;
    }

    if (blobChanged || stillFullyWatched.length !== fullyWatched.length) {
      blob.continueWatching = continueWatching;
      blob.fullyWatchedShowIds = stillFullyWatched;
      blob.updatedAt = Date.now();
      await env.CONFIGS.put(`creatorsync:${username}`, JSON.stringify(blob));
    }
  }
}



// --- config UI (served at / and /:config/configure) -----------------------

// --- Streaming Top 10 / Streaming quick-add lists ---------------------------
//
// TO ADD YOUR REAL LINKS: find the provider's row below and replace its
// movieUrl / showUrl with the real mdblist.com list URL. Anything still set
// to "CHANGE-ME" is a placeholder — swap it and redeploy.
//
// There are two tables: STREAMING_TOP10 (the "Streaming Top 10" panel /
// charts) and STREAMING_ALL (the plain "Streaming" panel / full catalog).
// They're independent, so the same provider can have different links in each.
const STREAMING_TOP10 = [
  {
    name: "Apple TV+",
    movieUrl: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today",
    showUrl: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today",
  },
  {
    name: "Disney+",
    movieUrl: "https://mdblist.com/lists/andykai/disney-top-10-no-hulu",
    showUrl: "https://mdblist.com/lists/andykai/disney-trending-no-hulu",
  },
  {
    name: "HBO Max",
    movieUrl: "https://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q",
    showUrl: "https://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd",
  },
  {
    name: "Hulu",
    movieUrl: "https://mdblist.com/lists/hulupiv/hulu-top-10-movies",
    showUrl: "https://mdblist.com/lists/hulupiv/hulu-top-10-shows",
  },
  {
    name: "Netflix",
    movieUrl: "https://mdblist.com/lists/hdlists/netflix-top-10-trending-movies",
    showUrl: "https://mdblist.com/lists/hdlists/netflix-top-10-trending-shows",
  },
  {
    name: "Paramount+",
    movieUrl: "https://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today",
    showUrl: "https://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today",
  },
  {
    name: "Prime Video",
    movieUrl: "https://mdblist.com/lists/diimaan/amazon-prime-top-10-movies",
    showUrl: "https://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows",
  },
  {
    name: "Peacock",
    movieUrl: "https://mdblist.com/lists/diimaan/peacock-top-10-movies",
    showUrl: "https://mdblist.com/lists/peacockpiv/peacock-top-10-shows",
  },
];

const STREAMING_ALL = [
  {
    name: "Apple TV+",
    movieUrl: "https://mdblist.com/lists/slimshizn/apple-tv-movies",
    showUrl: "https://mdblist.com/lists/snoak/latest-apple-tv-plus-tv-shows",
  },
  {
    name: "Disney+",
    movieUrl: "https://mdblist.com/lists/garycrawfordgc/disney-movies",
    showUrl: "https://mdblist.com/lists/garycrawfordgc/disney-shows",
  },
  {
    name: "Discovery+",
    movieUrl: "https://mdblist.com/lists/k0meta/discovery-movies",
    showUrl: "https://mdblist.com/lists/marko8426/discovery-shows",
  },
  {
    name: "HBO Max",
    movieUrl: "https://mdblist.com/lists/snoak/latest-max-movies",
    showUrl: "https://mdblist.com/lists/garycrawfordgc/hbo-shows",
  },
  {
    name: "Hulu",
    movieUrl: "https://mdblist.com/lists/garycrawfordgc/hulu-movies",
    showUrl: "https://mdblist.com/lists/garycrawfordgc/hulu-shows",
  },
  {
    name: "Netflix",
    movieUrl: "https://mdblist.com/lists/garycrawfordgc/netflix-movies",
    showUrl: "https://mdblist.com/lists/garycrawfordgc/netflix-shows",
  },
  {
    name: "Netflix Kids",
    movieUrl: "https://mdblist.com/lists/poodlehead/netflix-kids-movies",
    showUrl: "https://mdblist.com/lists/poodlehead/netflix-kids-tv",
  },
  {
    name: "Paramount+",
    movieUrl: "https://mdblist.com/lists/snoak/latest-paramount-plus-movies",
    showUrl: "https://mdblist.com/lists/snoak/latest-paramount-plus-tv-shows",
  },
  {
    name: "Prime Video",
    movieUrl: "https://mdblist.com/lists/garycrawfordgc/amazon-prime-movies",
    showUrl: "https://mdblist.com/lists/garycrawfordgc/amazon-prime-shows",
  },
  {
    name: "Peacock",
    movieUrl: "https://mdblist.com/lists/tvgeniekodi/peacock-movies",
    showUrl: "https://mdblist.com/lists/tvgeniekodi/peacock-tv-shows",
  },
];

// Builds the static HTML rows for a streaming quick-add panel from one of
// the tables above. `labelSuffix` is appended to the row name (e.g. "Top
function getProviderIconBadge(name, group) {
  const n = (name || '').toLowerCase();
  if (group === 'Combined Charts' || n === 'popular' || n === 'trending' || n.includes('(all services)')) {
    return '<span class="provider-chip-icon" style="background:var(--accent);color:#fff;font-weight:800;font-size:0.7rem;letter-spacing:-0.02em;">ML</span>';
  }
  if (group === 'MDBList Charts' || n.includes('mdblist') || n.includes('streaming charts') || n.includes('moviemeter') || n.includes('us daily')) {
    return '<span class="provider-chip-icon" style="background:#007AFF;color:#fff;font-weight:700;">M</span>';
  }
  if (n.includes('netflix')) return '<span class="provider-chip-icon netflix">N</span>';
  if (n.includes('prime') || n.includes('amazon')) return '<span class="provider-chip-icon prime">P</span>';
  if (n.includes('apple')) return '<span class="provider-chip-icon apple">A</span>';
  if (n.includes('disney')) return '<span class="provider-chip-icon disney">D+</span>';
  if (n.includes('max') || n.includes('hbo')) return '<span class="provider-chip-icon max">M</span>';
  if (n.includes('hulu')) return '<span class="provider-chip-icon hulu">h</span>';
  if (n.includes('paramount')) return '<span class="provider-chip-icon paramount">P+</span>';
  if (n.includes('peacock')) return '<span class="provider-chip-icon peacock">P</span>';
  if (n.includes('discovery')) return '<span class="provider-chip-icon discovery">D</span>';
  if (n.includes('tmdb')) return '<span class="provider-chip-icon" style="background:#01b4e4;color:#fff;">T</span>';
  if (n.includes('trakt')) return '<span class="provider-chip-icon" style="background:#ed1c24;color:#fff;">T</span>';
  if (n.includes('simkl')) return '<span class="provider-chip-icon" style="background:#000;border:1px solid #333;color:#fff;">S</span>';
  if (group === 'Kids') return '<span class="provider-chip-icon" style="background:#FF9900;color:#fff;">K</span>';
  return '<span class="provider-chip-icon" style="background:#8e8e93;color:#fff;">&#x2605;</span>';
}

// Builds the static HTML rows for a streaming quick-add panel from one of
// the tables above. `labelSuffix` is appended to the row name (e.g. "Top
// 10"). Computed server-side (rather than in the client <script>) so the
// URLs never have to fight the nested template-literal escaping used
// elsewhere in the builder page's inline script.
function buildStreamingRowsHtml(list, labelSuffix, group) {
  const rows = list.map((p) => {
    const label = labelSuffix ? `${p.name} ${labelSuffix}` : p.name;
    const badge = getProviderIconBadge(p.name, group);
    let btns = '';
    if (p.movieUrl && p.showUrl) {
      btns = `
        <button type="button" class="lc-btn secondary" onclick="addRow('${label}', '${p.movieUrl}', 'movie', true, '${group}')">+ Movies</button>
        <button type="button" class="lc-btn secondary" onclick="addRow('${label}', '${p.showUrl}', 'series', true, '${group}')">+ Shows</button>`;
    } else if (p.url && p.type) {
      const btnText = p.type === 'movie' ? '+ Movies' : '+ Shows';
      btns = `
        <button type="button" class="lc-btn secondary" onclick="addRow('${p.name}', '${p.url}', '${p.type}', true, '${group}')">${btnText}</button>`;
    }
    return `
    <div class="discover-chart-card">
      <div class="discover-chart-header">
        ${badge}
        <div class="discover-chart-info">
          <div class="discover-chart-title">${p.name}</div>
          <div class="discover-chart-sub">${labelSuffix ? labelSuffix : (p.type === 'movie' ? 'Theatrical Box Office' : (p.type === 'series' ? 'Anime Trending' : 'Movies & Shows'))}</div>
        </div>
      </div>
      <div class="discover-chart-btns">
        ${btns}
      </div>
    </div>`;
  }).join("");
  return `<div class="quick-grid">${rows}</div>`;
}

function buildStreamingTop10Html() {
  return buildStreamingRowsHtml(STREAMING_TOP10, "Top 10", "Streaming Top 10");
}

function buildStreamingHtml() {
  return buildStreamingRowsHtml(STREAMING_ALL, "", "Streaming");
}

// --- mdblist Charts: mdblist's own real Official Lists ---------------------
//
// mdblist.com DOES run its own distinct official-charts system, separate
// from community lists -- see https://mdblist.com/lists/official. These
// live at a different URL shape (/lists/official/{movies|shows}/{slug},
// one segment deeper than a normal user list at /lists/{user}/{slug}),
// which mdblistJsonUrl above handles by preserving however many path
// segments are given rather than assuming exactly two.
// TO ADD OR CHANGE A LINK: edit the matching row below.
const MDBLIST_OFFICIAL_CHARTS = [
  {
    name: "MDBList Popular",
    movieUrl: "https://mdblist.com/lists/official/movies/popular",
    showUrl: "https://mdblist.com/lists/official/shows/popular",
  },
  {
    name: "US Daily Streaming Charts",
    movieUrl: "https://mdblist.com/lists/official/movies/justwatch-streaming-charts",
    showUrl: "https://mdblist.com/lists/official/shows/justwatch-streaming-charts",
  },
  {
    name: "Streaming Charts (Extended)",
    movieUrl: "https://mdblist.com/lists/official/movies/streaming-charts",
    showUrl: "https://mdblist.com/lists/official/shows/streaming-charts",
  },
  {
    name: "IMDb MovieMeter",
    movieUrl: "https://mdblist.com/lists/official/movies/moviemeter",
    showUrl: "https://mdblist.com/lists/official/shows/moviemeter",
  },
];

function buildMdblistChartsHtml() {
  return buildStreamingRowsHtml(MDBLIST_OFFICIAL_CHARTS, "", "MDBList Charts");
}

// --- TMDB / Trakt official charts (one-click quick-adds) -------------------
//
// Unlike the Trending/Popular/etc panels above (each backed by a real,
// community-curated mdblist.com list), these use small sentinel "URLs"
// (tmdb:chart:X / trakt:chart:X) that detectSource/fetchCatalog recognize
// and route to fetchTmdbChart/fetchTraktChart -- hitting TMDB's and Trakt's
// own official chart endpoints directly instead of a third party's list.
// The same sentinel is reused for both the Movies and Shows button on a
// row; entry.type (set by which button was clicked) picks the right side
// of that chart's path map at fetch time.
const TMDB_CHART_LISTS = [
  { name: "TMDB Trending", movieUrl: "tmdb:chart:trending", showUrl: "tmdb:chart:trending" },
  { name: "TMDB Popular", movieUrl: "tmdb:chart:popular", showUrl: "tmdb:chart:popular" },
  { name: "TMDB Top Rated", movieUrl: "tmdb:chart:top_rated", showUrl: "tmdb:chart:top_rated" },
  { name: "TMDB Now Playing", movieUrl: "tmdb:chart:now_playing", showUrl: "tmdb:chart:now_playing" },
  { name: "TMDB Upcoming", movieUrl: "tmdb:chart:upcoming", showUrl: "tmdb:chart:upcoming" },
];

// All of Trakt's official charts below (see TRAKT_CHART_PATHS/
// fetchTraktChart), pulled directly from Trakt's own API. These used to
// point at community-curated mdblist.com lists mirroring Trakt's charts
// instead, because Trakt's API had started rejecting this add-on's shared
// Client ID with a 403 ("invalid or unapproved app") -- that Client ID has
// since been replaced, so these go straight to Trakt's API again. If it
// happens again, the Worker owner needs a fresh app from
// https://trakt.tv/oauth/applications, or a person can supply their own
// Client ID in the meantime (see the Trakt Client ID box above).
const TRAKT_CHART_LISTS = [
  { name: "Trakt Trending", movieUrl: "trakt:chart:trending", showUrl: "trakt:chart:trending" },
  { name: "Trakt Popular", movieUrl: "trakt:chart:popular", showUrl: "trakt:chart:popular" },
  { name: "Trakt Most Played", movieUrl: "trakt:chart:most_played", showUrl: "trakt:chart:most_played" },
  { name: "Trakt Most Watched", movieUrl: "trakt:chart:most_watched", showUrl: "trakt:chart:most_watched" },
  { name: "Trakt Most Collected", movieUrl: "trakt:chart:most_collected", showUrl: "trakt:chart:most_collected" },
  { name: "Trakt Most Favorited", movieUrl: "trakt:chart:most_favorited", showUrl: "trakt:chart:most_favorited" },
  {
    name: "Trakt Most Anticipated",
    movieUrl: "trakt:chart:most_anticipated",
    showUrl: "trakt:chart:most_anticipated",
  },
];

// Weekly box-office gross is inherently a theatrical-movies concept -- no
// shows equivalent, so this is a single-button (movies-only) row like In
// Theaters above, not a movies+shows pair.
const TRAKT_BOXOFFICE_LIST = [
  { name: "Trakt Box Office", url: "trakt:chart:box_office", type: "movie" },
];

const SIMKL_CHART_LISTS = [
  { name: "Simkl Trending Today", movieUrl: "simkl:chart:today", showUrl: "simkl:chart:today" },
  { name: "Simkl Trending This Week", movieUrl: "simkl:chart:week", showUrl: "simkl:chart:week" },
  { name: "Simkl Trending This Month", movieUrl: "simkl:chart:month", showUrl: "simkl:chart:month" },
];

// Simkl tracks anime as its own category, mixing movies and series together
// rather than splitting them the way its movies/tv charts do -- so this is
// a single-button row (like Trakt Box Office above), added as Shows since
// most of what shows up here is ongoing series rather than standalone films.
const SIMKL_ANIME_LIST = [
  { name: "Simkl Anime Trending", url: "simkl:chart:anime-week", type: "series" },
];

function buildTmdbChartsHtml() {
  return buildStreamingRowsHtml(TMDB_CHART_LISTS, "", "TMDB Charts");
}

function buildTraktChartsHtml() {
  return buildStreamingRowsHtml([...TRAKT_CHART_LISTS, ...TRAKT_BOXOFFICE_LIST], "", "Trakt Charts");
}

function buildSimklChartsHtml() {
  return buildStreamingRowsHtml([...SIMKL_CHART_LISTS, ...SIMKL_ANIME_LIST], "", "Simkl Charts");
}

// --- Combined charts (blend multiple sources into one shelf) ---------------
//
// Reuses the exact same multi-source merge mechanism as the "+ Add another
// source" button on a manually built row (see fetchMergedCatalog): a row's
// entry.url can hold several newline-separated sources, fetched in
// parallel and deduped by IMDB id (first-listed source wins on a tie).
// These quick-adds just pre-fill that merge -- either the same chart from
// each of MDBList/TMDB/Trakt, or every streaming service's Top 10/catalog
// at once -- instead of making someone add each source by hand.
const COMBINED_CHART_LISTS = [
  {
    name: "Popular",
    movieUrls: [
      "https://mdblist.com/lists/official/movies/popular",
      "tmdb:chart:popular",
      "trakt:chart:popular",
    ],
    showUrls: [
      "https://mdblist.com/lists/official/shows/popular",
      "tmdb:chart:popular",
      "trakt:chart:popular",
    ],
  },
  {
    name: "Trending",
    // MDBList's official lists don't include a "Trending" chart of their
    // own (just Popular / JustWatch streaming charts / IMDb MovieMeter),
    // so this blends TMDB + Trakt + all three Simkl trending windows
    // (same simkl:chart:today/week/month URLs as SIMKL_CHART_LISTS above,
    // each dispatches to movies or shows at fetch time based on the
    // merged row's own type -- same one URL works for both movieUrls and
    // showUrls here for that reason).
    movieUrls: ["tmdb:chart:trending", "trakt:chart:trending", "simkl:chart:today", "simkl:chart:week", "simkl:chart:month"],
    showUrls: ["tmdb:chart:trending", "trakt:chart:trending", "simkl:chart:today", "simkl:chart:week", "simkl:chart:month"],
  },
  {
    // Every service's Top 10 (see STREAMING_TOP10 above) merged into one
    // shelf -- computed from that same table rather than duplicated here,
    // so adding/removing a service there keeps this in sync automatically.
    name: "Streaming Top 10 (All Services)",
    movieUrls: STREAMING_TOP10.map((s) => s.movieUrl),
    showUrls: STREAMING_TOP10.map((s) => s.showUrl),
  },
  {
    // Every service's full catalog (see STREAMING_ALL above) merged into
    // one shelf -- same sync-from-the-table approach as above.
    name: "Streaming (All Services)",
    movieUrls: STREAMING_ALL.map((s) => s.movieUrl),
    showUrls: STREAMING_ALL.map((s) => s.showUrl),
  },
];

// Renders each source list as a single-quoted JS array literal (e.g.
// ['a','b']) so it can sit inside an onclick="..." attribute -- which is
// itself double-quoted -- without the two colliding.
function jsStringArrayLiteral(arr) {
  return "[" + arr.map((s) => "'" + String(s).replace(/'/g, "\\'") + "'").join(",") + "]";
}

function buildCombinedChartsHtml() {
  const rows = COMBINED_CHART_LISTS.map((p) => {
    const badge = getProviderIconBadge(p.name, 'Combined Charts');
    return `
    <div class="discover-chart-card">
      <div class="discover-chart-header">
        ${badge}
        <div class="discover-chart-info">
          <div class="discover-chart-title">${p.name}</div>
          <div class="discover-chart-sub">Blended Multi-Source Catalog</div>
        </div>
      </div>
      <div class="discover-chart-btns">
        <button type="button" class="lc-btn secondary" onclick="addCombinedRow('${p.name}', ${jsStringArrayLiteral(p.movieUrls)}, 'movie', 'Combined Charts')">+ Movies</button>
        <button type="button" class="lc-btn secondary" onclick="addCombinedRow('${p.name}', ${jsStringArrayLiteral(p.showUrls)}, 'series', 'Combined Charts')">+ Shows</button>
      </div>
    </div>`;
  }).join("");
  return `<div class="quick-grid">${rows}</div>`;
}

// Generates the client-side addAllCombinedCharts() function body straight
// from COMBINED_CHART_LISTS -- the individual "+ Movies"/"+ Shows"
// buttons on each row already get their (baked-in, hand-copy-free) source
// arrays this same way via jsStringArrayLiteral (see buildCombinedChartsHtml
// above). "Add all" used to be a second, hand-maintained copy of this same
// data that referenced STREAMING_TOP10/STREAMING_ALL directly -- both of
// which are server-side-only constants with no client-side equivalent, so
// clicking "Add all" threw a ReferenceError partway through (right after
// the hardcoded Popular/Trending/Streaming-Top-10-movies entries, which
// happened to not need those variables) and silently never added Streaming
// Top 10 Shows or Streaming (All Services) at all. Generating this
// function from the same single source of truth as the per-row buttons
// fixes that and makes a repeat impossible. Evaluated here at template-
// render time (this is a genuine top-level function, not text sitting
// inside the client-script template literal), so its ${...} use below is
// just an ordinary interpolation producing static text -- like
// combinedChartsHtml above, not a client-side call.
function buildAddAllCombinedChartsJs() {
  const calls = COMBINED_CHART_LISTS.map(function (p) {
    const nameLit = "'" + String(p.name).replace(/'/g, "\\'") + "'";
    return "  addCombinedRow(" + nameLit + ", " + jsStringArrayLiteral(p.movieUrls) + ", 'movie', 'Combined Charts');\n" +
           "  addCombinedRow(" + nameLit + ", " + jsStringArrayLiteral(p.showUrls) + ", 'series', 'Combined Charts');";
  }).join("\n");
  return "function addAllCombinedCharts() {\n" + calls + "\n  saveState();\n}";
}

// Same fix, generalized to the other six quick-add panels: each panel's
// individual "+ Movies"/"+ Shows"/"+ Add" buttons already build their
// addRow() calls from a data table (via buildStreamingRowsHtml /
// buildSimpleListRowsHtml above) -- Add All used to be a second,
// hand-typed copy of each table instead of reading from it, and one of
// them (Streaming Top 10) had silently drifted to drop the "Top 10"
// suffix from every row's name (Netflix Top 10 -> just "Netflix") since
// nothing kept the two copies in sync. Generating all of them from their
// tables here, the same way Combined Charts' Add All does above, closes
// that off for good instead of just patching the one that had drifted.
function buildAddAllPairsCallsJs(list, group, labelSuffix) {
  return list.map(function (p) {
    const label = labelSuffix ? p.name + " " + labelSuffix : p.name;
    return "  addRow(" + JSON.stringify(label) + ", " + JSON.stringify(p.movieUrl) + ", 'movie', true, " + JSON.stringify(group) + ");\n" +
           "  addRow(" + JSON.stringify(label) + ", " + JSON.stringify(p.showUrl) + ", 'series', true, " + JSON.stringify(group) + ");";
  }).join("\n");
}
function buildAddAllSimpleCallsJs(list, group) {
  return list.map(function (l) {
    return "  addRow(" + JSON.stringify(l.name) + ", " + JSON.stringify(l.url) + ", " + JSON.stringify(l.type) + ", true, " + JSON.stringify(group) + ");";
  }).join("\n");
}
function buildAddAllFnJs(fnName, callsJs) {
  return "function " + fnName + "() {\n" + callsJs + "\n  saveState();\n}";
}

// Discovery shelf for "I don't know what to watch" -- see fetchTmdbHiddenGems.
const HIDDEN_GEMS_LIST = [
  { name: "Hidden Gems", movieUrl: "tmdb:hidden-gems", showUrl: "tmdb:hidden-gems" },
];

function buildHiddenGemsHtml() {
  return buildStreamingRowsHtml(HIDDEN_GEMS_LIST, "", "Hidden Gems");
}

const KIDS_LISTS = [
  { name: "Rated G & Under", movieUrl: "tmdb:kids:g", showUrl: "tmdb:kids:g" },
  { name: "Rated PG & Under", movieUrl: "tmdb:kids:pg", showUrl: "tmdb:kids:pg" },
  { name: "Rated PG-13 & Under", movieUrl: "tmdb:kids:pg13", showUrl: "tmdb:kids:pg13" },
];
function buildKidsHtml() {
  return buildStreamingRowsHtml(KIDS_LISTS, "", "Kids");
}

function renderBuilder(
  origin,
  { initialEntries = [], initialKeys = {}, isConfigureMode = false } = {}
) {
  const initialTmdbKey = initialKeys.tmdbKey || "";
  const initialMdblistKey = initialKeys.mdblistKey || "";
  const initialTraktKey = initialKeys.traktKey || "";
  const initialTraktUsername = initialKeys.traktUsername || "";
  const initialTraktAccessToken = initialKeys.traktAccessToken || "";
  const streamingTop10Html = buildStreamingTop10Html();
  const streamingHtml = buildStreamingHtml();
  const mdblistChartsHtml = buildMdblistChartsHtml();
  const tmdbChartsHtml = buildTmdbChartsHtml();
  const traktChartsHtml = buildTraktChartsHtml();
  const simklChartsHtml = buildSimklChartsHtml();
  const combinedChartsHtml = buildCombinedChartsHtml();
  const hiddenGemsHtml = buildHiddenGemsHtml();
  const kidsHtml = buildKidsHtml();
  const hasInitial = initialEntries.length > 0;
  const initialEntriesJson = JSON.stringify(
    hasInitial
      ? initialEntries
      : [
          { name: "Popular", url: "https://mdblist.com/lists/official/movies/popular\ntmdb:chart:popular\ntrakt:chart:popular", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Popular", url: "https://mdblist.com/lists/official/shows/popular\ntmdb:chart:popular\ntrakt:chart:popular", type: "series", enabled: true, group: "Combined Charts" },
          { name: "Trending", url: "tmdb:chart:trending\ntrakt:chart:trending\nsimkl:chart:today\nsimkl:chart:week\nsimkl:chart:month", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Trending", url: "tmdb:chart:trending\ntrakt:chart:trending\nsimkl:chart:today\nsimkl:chart:week\nsimkl:chart:month", type: "series", enabled: true, group: "Combined Charts" },
          { name: "Streaming Top 10 (All Services)", url: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today\nhttps://mdblist.com/lists/andykai/disney-top-10-no-hulu\nhttps://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q\nhttps://mdblist.com/lists/hulupiv/hulu-top-10-movies\nhttps://mdblist.com/lists/hdlists/netflix-top-10-trending-movies\nhttps://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today\nhttps://mdblist.com/lists/diimaan/amazon-prime-top-10-movies\nhttps://mdblist.com/lists/diimaan/peacock-top-10-movies", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Streaming Top 10 (All Services)", url: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today\nhttps://mdblist.com/lists/andykai/disney-trending-no-hulu\nhttps://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd\nhttps://mdblist.com/lists/hulupiv/hulu-top-10-shows\nhttps://mdblist.com/lists/hdlists/netflix-top-10-trending-shows\nhttps://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today\nhttps://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows\nhttps://mdblist.com/lists/peacockpiv/peacock-top-10-shows", type: "series", enabled: true, group: "Combined Charts" },
          { name: "Streaming (All Services)", url: "https://mdblist.com/lists/slimshizn/apple-tv-movies\nhttps://mdblist.com/lists/garycrawfordgc/disney-movies\nhttps://mdblist.com/lists/k0meta/discovery-movies\nhttps://mdblist.com/lists/snoak/latest-max-movies\nhttps://mdblist.com/lists/garycrawfordgc/hulu-movies\nhttps://mdblist.com/lists/garycrawfordgc/netflix-movies\nhttps://mdblist.com/lists/poodlehead/netflix-kids-movies\nhttps://mdblist.com/lists/snoak/latest-paramount-plus-movies\nhttps://mdblist.com/lists/garycrawfordgc/amazon-prime-movies\nhttps://mdblist.com/lists/tvgeniekodi/peacock-movies", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Streaming (All Services)", url: "https://mdblist.com/lists/snoak/latest-apple-tv-plus-tv-shows\nhttps://mdblist.com/lists/garycrawfordgc/disney-shows\nhttps://mdblist.com/lists/marko8426/discovery-shows\nhttps://mdblist.com/lists/garycrawfordgc/hbo-shows\nhttps://mdblist.com/lists/garycrawfordgc/hulu-shows\nhttps://mdblist.com/lists/garycrawfordgc/netflix-shows\nhttps://mdblist.com/lists/poodlehead/netflix-kids-tv\nhttps://mdblist.com/lists/snoak/latest-paramount-plus-tv-shows\nhttps://mdblist.com/lists/garycrawfordgc/amazon-prime-shows\nhttps://mdblist.com/lists/tvgeniekodi/peacock-tv-shows", type: "series", enabled: true, group: "Combined Charts" }
      ]
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#F2F2F7">
<link rel="manifest" href="${origin}/app.webmanifest">
<title>${ADDON_NAME}</title>
<link rel="icon" type="image/png" href="${origin}/icon.png">
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
    /* Wako-inspired iOS-native modern light theme */
    --bg:           #F2F2F7;
    --surface:      #FFFFFF;
    --panel:        #FFFFFF;
    --panel-strong: #E5E5EA;
    --border:       rgba(0,0,0,0.08);
    --border-strong:rgba(0,0,0,0.13);
    --text:         #1C1C1E;
    --text-2:       #3A3A3C;
    --muted:        #8E8E93;
    --accent:       #007AFF;
    --accent-hover: #0062CC;
    --accent-2:     #34AADC;
    --danger:       #FF3B30;
    --success:      #34C759;
    --warn:         #FF9500;
    --rating-high:  #34C759;
    --rating-mid:   #FF9500;
    --rating-low:   #FF3B30;
    --shadow-sm:    0 1px 3px rgba(0,0,0,0.06);
    --shadow:       0 2px 10px rgba(0,0,0,0.08);
    --shadow-md:    0 4px 20px rgba(0,0,0,0.10);
    --font-display: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
    --font-body:    'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', monospace;
    --sb-track:     transparent;
    --sb-thumb:     rgba(0,0,0,0.15);
    --sb-thumb-hover:rgba(0,0,0,0.25);
    --radius:       14px;
    --radius-sm:    10px;
    --radius-pill:  999px;
  }
  :root.dark-theme {
    --bg:           #000000;
    --surface:      #1C1C1E;
    --panel:        #1C1C1E;
    --panel-strong: #2C2C2E;
    --border:       rgba(255,255,255,0.15);
    --border-strong:rgba(255,255,255,0.25);
    --text:         #FFFFFF;
    --text-2:       #EBEBF5;
    --muted:        #8E8E93;
    --sb-thumb:     rgba(255,255,255,0.15);
    --sb-thumb-hover:rgba(255,255,255,0.25);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html { touch-action: manipulation; width: 100%; max-width: 100%; overflow-x: hidden; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    padding: 16px 12px calc(80px + env(safe-area-inset-bottom));
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    display: grid;
    gap: 12px;
    overflow-x: hidden;
  }

  /* --- Top App Header ---------------------------------------------------- */
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding: 6px 4px 8px;
  }
  .app-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .app-header-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    object-fit: cover;
  }
  .app-header-title-group {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .app-header-title {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-sub {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .header-icon-btn {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    padding: 0;
  }

  /* --- Top Tab Bar (Desktop View) ---------------------------------------------- */
  .tab-bar {
    display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px;
    margin-bottom: 4px; -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-btn {
    flex: none;
    background: var(--surface);
    color: var(--text-2);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: unset;
    transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
    box-shadow: var(--shadow-sm);
  }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    box-shadow: 0 2px 10px rgba(0,122,255,0.30);
  }
  .tab-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
  .tab-panel { display: grid; gap: 14px; width: 100%; max-width: 100%; min-width: 0; }
  .tab-panel[hidden] { display: none; }
  /* Each direct child of .tab-panel (the subnav pill bar, each
     .lists-subpanel) is a grid item and inherits the same default
     min-width:auto issue .tab-panel itself was already guarded against
     above -- setting min-width:0 on the parent only protects the parent,
     not these children individually. */
  .lists-subpanel { min-width: 0; }

  /* --- Bottom Nav (Mobile Only - Persistent Glassmorphism) ---------------- */
  .bottom-nav { display: none; }
  @media (max-width: 640px) {
    .tab-bar { display: none; }
    body { padding: 12px 12px calc(84px + env(safe-area-inset-bottom)); }
    .bottom-nav {
      display: flex;
      position: fixed !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 9999 !important;
      background: rgba(255,255,255,0.94);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      border-top: 1px solid var(--border);
      padding: 5px 0 calc(5px + env(safe-area-inset-bottom));
      box-shadow: 0 -1px 0 rgba(0,0,0,0.08), 0 -4px 16px rgba(0,0,0,0.05);
    }
    .bottom-nav-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 3px 1px;
      min-height: 48px;
      background: none;
      border: none;
      border-radius: 0;
      color: var(--muted);
      font-size: 0.60rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: color 0.12s ease;
      white-space: nowrap;
      line-height: 1;
    }
    .bottom-nav-item svg {
      width: 22px; height: 22px; flex: none;
      transition: transform 0.12s ease;
      stroke-width: 1.8;
    }
    .bottom-nav-item.active { color: var(--accent); }
    .bottom-nav-item.active svg { transform: translateY(-1px); stroke-width: 2.2; }
    .bottom-nav-item:active { opacity: 0.6; }
  }

  /* --- Segmented Top Submenus (Matching Screenshot 3) --------------------- */
  .subnav-pills-bar {
    display: flex;
    gap: 8px;
    width: 100%;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 2px 0 6px;
    align-items: center;
  }
  .subnav-pills-bar::-webkit-scrollbar { display: none; }
  .subnav-pill {
    flex: none;
    padding: 7px 16px;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text-2);
    font-size: 0.86rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: unset;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;
    box-shadow: var(--shadow-sm);
    font-family: inherit;
  }
  .subnav-pill.active {
    background: var(--accent);
    color: #ffffff;
    border-color: var(--accent);
    box-shadow: 0 2px 8px rgba(0,122,255,0.28);
  }
  .subnav-pill:hover:not(.active) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .subnav-pill .check-icon {
    font-weight: 800;
    font-size: 0.85rem;
  }

  /* --- Streaming Providers Chips Bar (Discover Tab) ----------------------- */
  .provider-bar {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 0 8px;
  }
  .provider-bar::-webkit-scrollbar { display: none; }
  .provider-chip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 13px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    white-space: nowrap;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .provider-chip:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow);
    border-color: var(--accent);
  }
  .provider-chip-icon {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 0.72rem;
    color: #fff;
    flex: none;
  }
  .provider-chip-icon.netflix { background: #E50914; }
  .provider-chip-icon.prime   { background: #00A8E1; }
  .provider-chip-icon.apple   { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.disney  { background: #113CCF; }
  .provider-chip-icon.max     { background: #5B00C5; }
  .provider-chip-icon.hulu    { background: #1CE783; color: #000; }
  .provider-chip-icon.paramount { background: #0064FF; }
  .provider-chip-icon.peacock { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.discovery { background: #002244; }
  .provider-chip-icon.kids { background: #FF9900; }
  /* --- Discover Chart Cards & Quick Grids -------------------------------- */
  .quick-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .quick-grid {
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
  }
  .discover-chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 10px;
    transition: transform 0.12s, box-shadow 0.12s;
  }
  .discover-chart-card:hover {
    box-shadow: var(--shadow);
    transform: translateY(-1px);
  }
  .discover-chart-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .discover-chart-info {
    flex: 1;
    min-width: 0;
  }
  .discover-chart-title {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .discover-chart-sub {
    font-size: 0.74rem;
    color: var(--muted);
    font-weight: 500;
    margin-top: 1px;
  }
  .discover-chart-btns {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .discover-chart-btns .lc-btn {
    flex: 1;
    justify-content: center;
    font-size: 0.78rem;
    padding: 6px 8px;
  }

  /* --- Shelves & Horizontal Poster Strips (Discover Tab) ------------------- */
  .shelf-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }
  .shelf-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    /* Some shelf headers (e.g. Live Preview & Editor's title + 4 action
       buttons) have more content than fits on one line on a phone --
       without wrapping, that row forces the whole card (and everything
       else sharing its grid track) wider than the viewport. */
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 0 2px;
  }
  .shelf-title {
    min-width: 0;
    font-size: 1.08rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    letter-spacing: -0.015em;
  }
  .see-all-link {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .see-all-link:hover { opacity: 0.75; }
  .shelf-scroll-wrap {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 2px 8px;
    width: 100%;
    max-width: 100%;
  }
  .shelf-scroll-wrap::-webkit-scrollbar { display: none; }

  /* --- Poster Cards (Wako Design) ----------------------------------------- */
  .poster-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 105px;
    flex: none;
    cursor: pointer;
    position: relative;
  }
  @media (min-width: 641px) {
    .poster-card {
      width: 125px;
    }
  }
  .poster-card.grid-item {
    width: 100%;
  }
  .poster-image-wrap {
    width: 100%;
    aspect-ratio: 2 / 3;
    position: relative;
    border-radius: 9px;
    overflow: hidden;
    background: var(--panel-strong);
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border);
  }
  .poster-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .rating-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 2px 5px;
    border-radius: 5px;
    font-size: 0.68rem;
    font-weight: 800;
    color: #fff;
    line-height: 1.15;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    letter-spacing: -0.01em;
    background: #48484A;
  }
  .rating-badge.rating-high { background: var(--rating-high); }
  .rating-badge.rating-mid  { background: var(--rating-mid); }
  .rating-badge.rating-low  { background: var(--rating-low); }

  .poster-provider-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    font-weight: 900;
    color: #fff;
  }
  .poster-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }
  .poster-meta {
    font-size: 0.7rem;
    color: var(--muted);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }

  /* --- 3-Column / 9-Column Poster Grid (Global Standard) ------------------ */
  .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 8px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
      grid-template-columns: repeat(9, 1fr);
      gap: 12px 8px;
    }
  }

  /* --- Wako List Cards Feed (Lists Tab - Matching Screenshot 3) ------------ */
  .list-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 13px 13px 11px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: box-shadow: 0.15s;
    margin-bottom: 10px;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
    min-width: 0;
  }
  .list-card:hover { box-shadow: var(--shadow); }
  .list-card-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }
  .list-card-icon {
    width: 44px; height: 44px;
    border-radius: 12px;
    flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 1.1rem;
    color: #fff; text-transform: uppercase;
  }
  .list-card-icon.src-mdblist { background: var(--accent); }
  .list-card-icon.src-trakt   { background: #FF3B30; }
  .list-card-icon.src-mylist  { background: var(--accent); }
  .list-card-icon.src-custom  { background: #5856D6; }
  .list-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .list-card-title {
    font-weight: 700; font-size: 0.96rem; color: var(--text);
    margin: 0 0 2px; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .list-card-meta {
    font-size: 0.76rem; color: var(--muted);
    display: flex; flex-wrap: wrap; gap: 0 5px; align-items: center;
    line-height: 1.4;
  }
  .list-card-meta-sep { color: var(--border-strong); }
  .list-card-actions {
    display: flex; gap: 5px; align-items: center; flex-shrink: 0; flex-wrap: wrap;
  }
  .lc-btn {
    padding: 6px 12px; min-height: unset;
    font-size: 0.8rem; font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-strong);
    background: var(--bg); color: var(--text-2);
    cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    font-family: inherit; white-space: nowrap;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .lc-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .lc-btn.primary:hover:not(:disabled) { opacity: 0.85; }
  .lc-btn.liked { color: var(--danger); border-color: rgba(255,59,48,0.4); }
  .lc-btn.view-btn { color: var(--accent); border-color: transparent; background: transparent; padding: 0; font-size: 0.82rem; }

  /* 9-Poster Preview Strip in List Cards (Desktop) / 3-Poster (Mobile) */
  .list-card-posters, .list-card-5posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 4px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  @media (max-width: 640px) {
    .list-card-posters .list-card-mini-poster:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster:nth-child(n+4),
    .list-card-posters .list-card-mini-poster-tile:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster-tile:nth-child(n+4) {
      display: none;
    }
    .list-card-header {
      flex-wrap: wrap;
    }
    .list-card-body {
      flex-basis: calc(100% - 54px);
    }
    .list-card-actions {
      width: 100%;
      margin-top: 4px;
    }
  }
  @media (min-width: 641px) {
    .list-card-posters, .list-card-5posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
    }
  }
  .list-card-mini-poster {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .list-card-mini-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  /* Same 9/3-across grid cell as .list-card-mini-poster above, but with a
     name (and optional second-line subtitle, e.g. an episode's "S07E10")
     visible underneath instead of only on hover -- used on the "Your
     Custom Lists" dashboard, where a bare grid of unlabeled thumbnails
     doesn't say which item is which. Kept as a separate class rather than
     changing .list-card-mini-poster itself, since that class is also used
     for the Find Lists search-preview thumbnails, which don't have room
     for a label and rely on the "+" / count overlays sitting flush over
     the full aspect-ratio box. */
  .list-card-mini-poster-tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    min-width: 0;
  }
  .list-card-mini-poster-img-wrap {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .cw-remove-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    box-sizing: border-box;
    border-radius: 50%;
    /* Solid theme color rather than a translucent black overlay -- the
       translucent version blended with whatever poster sat underneath it
       (often reading as a muddy brown against warm-toned posters). */
    background: var(--danger);
    color: #fff;
    border: none;
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    font-size: 16px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.35);
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 10;
    transition: filter 0.2s;
  }
  .cw-remove-btn:hover {
    filter: brightness(0.88);
  }
  .list-card-mini-poster-img-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  .list-card-mini-poster-img-wrap img.clickable-poster:hover {
    transform: scale(1.05);
  }
  .list-card-mini-poster-name {
    font-size: 0.68rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-card-mini-poster-subtitle {
    font-size: 0.64rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clickable-poster {
    cursor: pointer;
  }
  .clickable-poster:hover img {
    transform: scale(1.05);
  }
  .poster-add-overlay {
    position: absolute;
    bottom: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: bold;
    opacity: 0.85;
    transition: opacity 0.2s, background 0.2s;
    z-index: 2;
  }
  .clickable-poster:hover .poster-add-overlay {
    opacity: 1;
  }
  .poster-add-overlay:hover {
    background: var(--brand);
  }
  .list-card-count-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.65);
    color: #fff;
    font-weight: 700;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(1px);
  }
  .list-card-count-overlay.mobile-only {
    display: flex;
  }
  .list-card-count-overlay.desktop-only {
    display: none;
  }
  @media (min-width: 641px) {
    .list-card-count-overlay.mobile-only {
      display: none;
    }
    .list-card-count-overlay.desktop-only {
      display: flex;
    }
  }

  /* --- Cards & Panels ---------------------------------------------------- */
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 16px;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
  }
  .panel-title {
    font-size: 1.1rem;
    font-weight: 700;
    margin: 0 0 10px;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  /* --- Search Bar Wrap (Screenshot 4) ------------------------------------- */
  .search-bar-wrap {
    position: relative; display: flex; align-items: center; width: 100%;
  }
  .search-bar-wrap .sb-icon {
    position: absolute; left: 14px;
    width: 18px; height: 18px; color: var(--muted);
    pointer-events: none; flex: none;
  }
  .search-bar-wrap input {
    padding-left: 42px; padding-right: 40px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    font-size: 0.95rem;
    box-shadow: var(--shadow-sm);
  }
  .search-bar-clear {
    position: absolute; right: 10px;
    width: 22px; height: 22px; min-height: unset;
    border-radius: 50%; background: rgba(0,0,0,0.12);
    color: var(--text-2); border: none; padding: 0;
    font-size: 0.75rem; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  }

  /* --- Form controls & Helpers -------------------------------------------- */
  input, select, textarea {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input[type="file"] {
    padding: 0;
    min-height: unset;
    border: none;
    background: transparent;
    color: var(--text-2);
  }
  input[type="file"]::file-selector-button {
    background: var(--surface-2);
    color: var(--text);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    margin-right: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  input[type="file"]::file-selector-button:hover {
    background: var(--surface-3);
    border-color: var(--text-2);
  }
  input[type="checkbox"], input[type="radio"] {
    width: 20px; height: 20px; min-height: unset;
    padding: 0; flex: none; accent-color: var(--accent);
  }
  
  /* Toggle Switch */
  .ui-toggle {
    position: relative; display: inline-block; width: 44px; height: 24px;
  }
  .ui-toggle input { opacity: 0; width: 0; height: 0; }
  .ui-toggle-slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background-color: var(--border); transition: .3s; border-radius: 24px;
  }
  .ui-toggle-slider:before {
    position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
    background-color: white; transition: .3s; border-radius: 50%; box-shadow: var(--shadow-sm);
  }
  .ui-toggle input:checked + .ui-toggle-slider { background-color: var(--accent); }
  .ui-toggle input:checked + .ui-toggle-slider:before { transform: translateX(20px); }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,122,255,0.15);
  }
  .custom-list-pick-poster {
    width: 36px; height: 54px; object-fit: cover; border-radius: 4px; flex: none; cursor: pointer;
  }
  .custom-list-pick-poster.empty-poster { background: transparent; }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 10px; width: 100%; }
  .field-row { display: grid; grid-template-columns: 1fr; gap: 10px; width: 100%; }
  button, .actions a {
    padding: 11px 18px;
    min-height: 44px;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.925rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.12s, transform 0.12s;
    font-family: inherit;
  }
  button.secondary, .btn-copy, .btn-watchlist, .btn-test {
    background: var(--surface);
    color: var(--text-2);
    border: 1.5px solid var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
  button:hover:not(:disabled), .actions a:hover { opacity: 0.85; }
  button:disabled { opacity: 0.38; cursor: default; }
  .btn-stremio { background: linear-gradient(135deg, #9B8FFF, #6D48FF); color: #fff; }
  .btn-wako    { background: linear-gradient(135deg, #007AFF, #34AADC); color: #fff; }
  .actions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }

  /* --- Catalog Shelves (#lists in My Catalogs Tab) ------------------------ */
  #lists { display: grid; gap: 10px; grid-template-columns: 1fr; width: 100%; max-width: 100%; }
  .entry {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    margin-bottom: 12px;
    padding: 14px;
    position: relative;
    box-shadow: var(--shadow-sm);
    /* A grid item's default min-width is auto (shrink no further than its
       widest content), not 0 -- without this, a wide Live Preview poster
       grid inside can force this whole row (and #lists's single column
       track) past the viewport edge on a phone instead of the poster grid
       itself shrinking to fit. */
    min-width: 0;
  }
  .entry.dragging {
    opacity: 0.4;
    box-shadow: 0 8px 16px rgba(0,0,0,0.15);
    border-color: var(--accent);
  }
  .entry-card-top {
    display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; width: 100%;
  }
  .entry-avatar {
    width: 42px; height: 42px; border-radius: 11px; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 1.05rem; color: #fff;
    text-transform: uppercase;
  }
  .entry-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .entry-name-row { display: flex; align-items: center; gap: 6px; width: 100%; }
  .entry-name-row .name {
    flex: 1; min-width: 0; padding: 6px 10px;
    min-height: unset; font-size: 0.92rem; font-weight: 600;
    border-radius: 8px;
  }
  .entry-type-row { display: flex; align-items: center; gap: 6px; }
  .entry-type-row .type {
    padding: 5px 10px; min-height: unset; font-size: 0.82rem;
    border-radius: 8px; width: auto;
  }
  .entry-pos-wrap .pos {
    width: 48px; min-height: unset; padding: 5px 6px;
    font-size: 0.82rem; border-radius: 7px; text-align: center;
    background: var(--bg); border: 1.5px solid var(--border-strong);
  }
  .entry-ctrl-row {
    display: flex; gap: 4px; align-items: center; flex-shrink: 0;
  }
  .ec-btn {
    width: 32px; height: 32px; min-height: unset; padding: 0;
    border-radius: 8px; background: var(--bg); border: 1.5px solid var(--border-strong);
    color: var(--muted); display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; font-size: 0.9rem;
  }
  .ec-btn:hover:not(:disabled) { color: var(--text); background: var(--panel-strong); }
  .ec-btn.danger { color: var(--danger); border-color: rgba(255,59,48,0.25); background: rgba(255,59,48,0.07); }
  .sources { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .source-row { width: 100%; }
  .source-row + .source-row { padding-top: 10px; border-top: 1px dashed var(--border-strong); }
  .testrow { display: flex; align-items: center; gap: 10px; margin-top: 4px; flex-wrap: wrap; width: 100%; }
  .testresult { width: 100%; }
  .testresult.ok { color: var(--success); }
  .testresult.err { color: var(--danger); }
  .testresult.pending { color: var(--muted); }

  /* Compact view for #lists */
  #lists.compact .sources,
  #lists.compact .add-source-btn,
  #lists.compact .watchlist-note {
    display: none !important;
  }
  .premade-shelf .sources,
  .premade-shelf .add-source-btn {
    display: none !important;
  }
  #lists.compact .entry {
    padding: 8px 12px;
  }
  #lists.compact .entry-card-top {
    margin-bottom: 0;
  }

  /* Configured Shelves Test results: 1-row 5-posters strip on desktop, 1-row 3-posters on mobile */
  .preview-thumbs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 6px;
    max-width: 240px;
    width: 100%;
  }
  @media (max-width: 640px) {
    .preview-thumbs .preview-thumb:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .preview-thumbs {
      grid-template-columns: repeat(5, 1fr);
      max-width: 440px;
      gap: 8px;
    }
  }
  .preview-thumb {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-strong);
    display: block;
  }

  /* --- Live Preview Shelves (Home Screen) --------------------------------- */
  .live-preview-shelf {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    box-shadow: var(--shadow-sm);
    margin-bottom: 12px;
    width: 100%;
  }
  .live-preview-shelf-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-weight: 700;
    font-size: 0.95rem;
    color: var(--text);
  }
  .live-preview-shelf-title span {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .live-preview-shelf-title .text-action-btn {
    margin-left: auto;
    color: var(--accent);
    background: none;
    border: none;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 4px;
    flex: none;
    white-space: nowrap;
  }
  .live-preview-shelf-title .text-action-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .live-preview-posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    width: 100%;
  }
  @media (max-width: 640px) {
    .live-preview-posters .live-preview-poster-card:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .live-preview-posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 8px;
    }
  }
  .live-preview-poster-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    width: 100%;
  }
  .live-preview-poster {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: block;
  }
  .live-preview-poster.landscape {
    aspect-ratio: 16 / 9;
  }
  .live-preview-poster-placeholder {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .live-preview-poster-name {
    font-size: 0.70rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Second line under a poster for episode entries -- e.g. the episode's
     own title under a "Show Name S03E07" first line (see
     formatWatchItemLabel / livePreviewPosterHtml). Omitted entirely for
     anything without one (movies, shows, every other shelf on the site),
     so this never adds empty space to a normal poster card. */
  .live-preview-poster-subtitle {
    font-size: 0.66rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* --- Detail Overlay ("See All" / Full List View - Screenshot 5) --------- */
  #detailOverlay {
    position: fixed; inset: 0; background: var(--bg);
    z-index: 1500; overflow-y: auto; display: none;
    padding: 16px 14px calc(80px + env(safe-area-inset-bottom));
  }
  #detailOverlay.active { display: block; }
  .detail-top-nav {
    display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; position: sticky; top: 0; background: var(--bg);
    padding: 8px 0; z-index: 10;
  }
  .detail-back-btn {
    display: flex; align-items: center; gap: 6px;
    background: none; border: none; font-size: 1.1rem;
    font-weight: 700; color: var(--accent); cursor: pointer; padding: 4px 0;
  }
  .detail-header-info h1 {
    font-size: 1.3rem; font-weight: 800; margin: 0 0 2px;
  }
  .detail-header-info p {
    margin: 0; font-size: 0.85rem; color: var(--muted);
  }

  /* --- Modals & Toasts ---------------------------------------------------- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 1000;
  }
  .modal-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 22px; max-width: 440px; width: 100%;
    max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-md);
  }
  .modal-card.modal-card-wide {
    max-width: 1100px;
    width: 95vw;
  }
  .modal-close-x {
    float: right; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 1rem; cursor: pointer;
    padding: 4px 10px; border-radius: 8px;
  }
  .undo-toast {
    position: fixed; left: 50%;
    bottom: calc(66px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: var(--text); color: var(--surface);
    border-radius: 14px; padding: 12px 18px;
    display: flex; align-items: center; gap: 14px;
    box-shadow: var(--shadow-md); z-index: 1000;
  }
  .action-toast {
    position: fixed;
    left: 50%;
    bottom: calc(72px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(20px);
    background: rgba(28, 28, 30, 0.95);
    color: #ffffff;
    padding: 10px 18px;
    border-radius: var(--radius-pill);
    font-size: 0.86rem;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 99999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    white-space: nowrap;
    max-width: 90vw;
    overflow: hidden;
    text-overflow: ellipsis;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .action-toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  @media (max-width: 640px) {
    .customListMoveBtn { display: none !important; }
    .customListPosInput { display: none !important; }
  }

  @media (min-width: 641px) {
    body { padding: 24px 20px 52px; }
    .page { gap: 16px; }
    .actions { flex-direction: row; flex-wrap: wrap; }
    .actions button, .actions a { width: auto; }
    .custom-list-pick-poster { width: 72px; height: 108px; }
    .row { flex-direction: row; }
    .field-row { grid-template-columns: minmax(0, 1fr) auto; }
    #lists { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

    /* Live Preview & Editor CSS */
    
    /* Default (Preview Mode) */
    #lists:not(.live-preview-edit-mode) .entry-ctrl-row,
    #lists:not(.live-preview-edit-mode) .entry-name-row,
    #lists:not(.live-preview-edit-mode) .entry-type-row,
    #lists:not(.live-preview-edit-mode) .sources,
    #lists:not(.live-preview-edit-mode) .add-source-btn,
    #lists:not(.live-preview-edit-mode) .watchlist-note {
      display: none !important;
    }
    
    #lists:not(.live-preview-edit-mode) .entry {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      padding: 0 !important;
    }

    #lists:not(.live-preview-edit-mode) {
      grid-template-columns: 1fr !important;
    }

    /* In Edit Mode, hide the posters because they get in the way of drag-and-drop */
    #lists.live-preview-edit-mode .live-preview-posters {
      display: none !important;
    }
    
    #lists.live-preview-edit-mode .entry {
      border: 1px solid var(--border) !important;
      background: var(--bg) !important;
      padding: 12px !important;
    }

  
  .watch-indicator-overlay {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    box-sizing: border-box;
    border-radius: 50%;
    background: #007aff;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
    z-index: 5;
    pointer-events: none;
  }

  /* A show with a watched episode still waiting on an unwatched, aired
     one -- i.e. currently in Continue Watching. Same badge, amber instead
     of blue; flips back to the default blue checkmark the moment the
     show's last episode is watched (see setShowFullyWatched/
     setShowInProgress). */
  .watch-indicator-overlay.watch-indicator-partial {
    background: #ff9500;
    font-size: 12px;
  }

  .is-watch-history-shelf .watch-indicator-overlay {
    display: none !important;
  }
  </style>
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"></script>
</head>
<body>
<div class="page">
  <!-- Top App Bar -->
  <header class="app-header">
    <div class="app-header-left">
      <img class="app-header-avatar" src="${origin}/icon.png" alt="App Icon">
      <div class="app-header-title-group">
        <div style="display:flex; align-items:center; gap:8px;">
          <h1 class="app-header-title" id="pageMainTitle">Discover</h1>
          <button class="dark-mode-toggle" onclick="document.documentElement.classList.toggle('dark-theme'); localStorage.setItem('theme', document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light');" style="background:transparent; border:none; color:var(--text); font-size:1.2rem; cursor:pointer; padding:0; margin-top:2px;" title="Toggle Dark Mode">🌓</button>
        </div>
        <span class="app-header-sub" id="pageSubtitle">Explore Popular &amp; Streaming</span>
      </div>
    </div>
    <button type="button" id="headerCreateListBtn" class="header-icon-btn" style="display:none; flex: 0 0 auto; font-size: 1.4rem; font-weight: 300; cursor:pointer;" onclick="openCreateListModal()" title="Create List">+</button>
    <button type="button" id="headerAddShelfBtn" class="header-icon-btn" style="display:none; flex: 0 0 auto; font-size: 1.4rem; font-weight: 300; cursor:pointer;" onclick="openAddShelfModal()" title="Add Custom Shelf">+</button>
    <div class="app-header-actions">
      <div id="creatorProfileBar"></div>
    </div>
  </header>

  <!-- Top Tab Bar (Desktop View) -->
  <div class="tab-bar" role="tablist">
    <button type="button" class="tab-btn" data-tab="catalogs" onclick="switchTab('catalogs')">My Catalogs</button>
    <button type="button" class="tab-btn" data-tab="lists" onclick="switchTab('lists')">Lists</button>
    <button type="button" class="tab-btn active" data-tab="discover" onclick="switchTab('discover')">Discover</button>
    <button type="button" class="tab-btn" data-tab="search" onclick="switchTab('search')">Search</button>
    <button type="button" class="tab-btn" data-tab="settings" onclick="switchTab('settings')">Settings</button>
  </div>

  <!-- Bottom Nav Bar (Mobile View - Persistent Glassmorphism) -->
  <nav class="bottom-nav" role="tablist" aria-label="Main navigation">
    <button type="button" class="bottom-nav-item" data-tab="catalogs" onclick="switchTab('catalogs')" title="My Catalogs">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
      </svg>
      Catalogs
    </button>
    <button type="button" class="bottom-nav-item" data-tab="lists" onclick="switchTab('lists')" title="Lists">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
      </svg>
      Lists
    </button>
    <button type="button" class="bottom-nav-item active" data-tab="discover" onclick="switchTab('discover')" title="Discover">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      Discover
    </button>
    <button type="button" class="bottom-nav-item" data-tab="search" onclick="switchTab('search')" title="Search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      Search
    </button>
    <button type="button" class="bottom-nav-item" data-tab="settings" onclick="switchTab('settings')" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      Settings
    </button>
  </nav>

  <!-- Action Notification Toast -->
  <div id="actionToast" class="action-toast"></div>

  <!-- Detail / See All Full View Overlay (Matching Screenshot 5) -->
  <div id="detailOverlay">
    <div class="detail-top-nav">
      <button type="button" class="detail-back-btn" onclick="closeDetailOverlay()">&larr; Back</button>
      <button type="button" class="lc-btn primary" id="detailAddAllBtn">+ Add to Catalogs</button>
    </div>
    <div class="detail-header-info" style="margin-bottom:14px;">
      <h1 id="detailTitle">List Title</h1>
      <p id="detailSubtitle">Author &bull; Shows &bull; 100 items</p>
    </div>
    <div class="poster-grid-3" id="detailGrid"></div>
  </div>

  <div class="tab-panel" data-tab-panel="item-details" id="content-item-details" hidden>
    <div style="margin-bottom: 20px;">
      <button type="button" class="lc-btn secondary" onclick="switchTab(window._previousTab || 'discover')" style="padding: 6px 12px; font-size: 0.9rem;">&larr; Back</button>
    </div>
    <div id="itemDetailsBody" style="display: flex; flex-direction: column; gap: 24px;">
      <!-- Filled dynamically -->
    </div>
  </div>

  <div id="createListModal" class="modal-overlay" style="display:none; z-index: 10001; background: rgba(0,0,0,0.45); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 340px; padding: 22px; background: var(--bg); border-radius: 20px; box-shadow: var(--shadow); display: flex; flex-direction: column;">
      <h2 style="margin-top:0; font-size:1.3rem; font-weight:600; color:var(--text);">Create List</h2>
      
      <div style="margin-top: 16px;">
        <input type="text" id="createListModalName" placeholder="List name" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="document.getElementById('createListModalBtn').disabled = !this.value.trim(); document.getElementById('createListModalBtn').style.opacity = this.value.trim() ? '1' : '0.5';">
      </div>
      
      <div style="margin-top: 24px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.95rem; font-weight:500; color: var(--text);">Public</span>
        <label class="ui-toggle">
          <input type="checkbox" id="createListModalPublic" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      
      <div style="display: flex; justify-content: flex-end; gap: 20px;">
        <button type="button" style="background:none; border:none; color:var(--text); font-weight:600; font-size:1rem; cursor:pointer;" onclick="document.getElementById('createListModal').style.display = 'none'">Cancel</button>
        <button type="button" id="createListModalBtn" style="background:none; border:none; color:var(--accent); font-weight:600; font-size:1rem; cursor:pointer; opacity: 0.5;" disabled onclick="submitCreateListModal()">Create</button>
      </div>
    </div>
  </div>

  <!-- Add Shelf Modal -->
  <div id="addShelfModal" class="modal-overlay" style="display:none; z-index: 10001; background: rgba(0,0,0,0.45); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 340px; padding: 22px; background: var(--bg); border-radius: 20px; box-shadow: var(--shadow); display: flex; flex-direction: column;">
      <h2 style="margin-top:0; font-size:1.3rem; font-weight:600; color:var(--text);">Add Shelf</h2>
      
      <div style="margin: 16px 0;">
        <input type="text" id="addShelfModalName" placeholder="Shelf name" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem; margin-bottom:12px;" oninput="validateAddShelfModal()">
        
        <div id="addShelfModalLinksContainer">
          <div class="add-shelf-link-row" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <input type="url" class="addShelfModalLinkInput" placeholder="URL (e.g. Trakt, Letterboxd)" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">
          </div>
        </div>
        
        <button type="button" class="lc-btn secondary" style="width: 100%; margin-bottom: 12px; font-size: 0.9rem;" onclick="addShelfModalAddLink()">+ Add another link (Combined List)</button>
        
        <select id="addShelfModalType" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem; margin-bottom:12px;" onchange="validateAddShelfModal()">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
        </select>
      </div>
      
      <div style="display:flex; justify-content:flex-end; gap:16px; margin-top: 8px;">
        <button type="button" style="background:none; border:none; color:var(--text); font-weight:600; font-size:1rem; cursor:pointer;" onclick="document.getElementById('addShelfModal').style.display = 'none'">Cancel</button>
        <button type="button" id="addShelfModalBtn" style="background:none; border:none; color:var(--accent); font-weight:600; font-size:1rem; cursor:pointer; opacity: 0.5;" disabled onclick="submitAddShelfModal()">Add</button>
      </div>
    </div>
  </div>

  <div id="selectListModal" class="modal-overlay" style="display:none; z-index: 10001; background: rgba(0,0,0,0.45); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 440px; padding: 22px; background: #fff; border-radius: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; max-height: 90vh;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <h2 style="margin-top:0; color:#001f3f;">Lists</h2>
        <button type="button" class="modal-close-x" id="selectListModalCloseBtn">\u2715</button>
      </div>
      <div id="selectListModalBody" style="display: flex; flex-direction: column; gap: 0; max-height: 40vh; overflow-y: auto; margin-bottom: 24px;">
        <!-- Filled dynamically -->
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" id="addSelectedListsBtn" style="background: transparent; color: #003366; font-weight: 600; border: none; padding: 8px 16px; font-size: 1rem; cursor: pointer;">Done</button>
      </div>
    </div>
  </div>

<script>
/* Chart data tables -- injected at render time for renderDiscoverChartsList */
window._CHARTS_TMDB = ${JSON.stringify(TMDB_CHART_LISTS)};
window._CHARTS_TRAKT = ${JSON.stringify(TRAKT_CHART_LISTS)};
window._CHARTS_TRAKT_BO = ${JSON.stringify(TRAKT_BOXOFFICE_LIST)};
window._CHARTS_MDBLIST = ${JSON.stringify(MDBLIST_OFFICIAL_CHARTS)};
window._CHARTS_SIMKL = ${JSON.stringify(SIMKL_CHART_LISTS)};
window._CHARTS_SIMKL_ANIME = ${JSON.stringify(SIMKL_ANIME_LIST)};
window._CHARTS_STREAMING_TOP10 = ${JSON.stringify(STREAMING_TOP10)};
window._CHARTS_STREAMING_ALL = ${JSON.stringify(STREAMING_ALL)};
window._CHARTS_KIDS = ${JSON.stringify(KIDS_LISTS)};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.error(e));
}
</script>

<div class="tab-panel" data-tab-panel="catalogs" hidden>
  <!-- Top Submenu Pills for Catalogs -->
  <div class="subnav-pills-bar" id="catalogsFilterBar">
    <button type="button" class="subnav-pill active" onclick="switchCatalogsSubmenu('all', this)"><span class="check-icon">&#x2713;</span> Shelves</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('channels', this)">Channels</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('bulk', this)">Bulk Add</button>
  </div>

  <div class="lists-subpanel" id="catalogsSubShelves">
  <!-- Catalogs Management Card -->
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:12px;">
      <h2 class="shelf-title">Live Preview &amp; Editor</h2>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" onclick="toggleLivePreviewEdit()">Edit</button>
        <button type="button" class="secondary lc-btn" onclick="renderLivePreview()">Refresh Preview</button>
        <button type="button" class="secondary lc-btn" id="compactToggleBtn" onclick="toggleCompactView(this)">Compact</button>
        <button type="button" class="secondary lc-btn" id="testAllBtn" onclick="testAllSources()">Test all</button>
      </div>
    </div>

    <div class="row" style="margin-bottom:12px; gap:8px;">
      <input type="text" id="listFilterInput" placeholder="Filter shelves by name..." oninput="filterLists()">
      <select id="listGroupFilterSelect" onchange="filterLists()" style="flex:none; width:auto;">
        <option value="">All groups</option>
      </select>
    </div>

    <!-- Reorderable Catalog Shelves -->
    <div id="lists"></div>

    <div class="actions" style="margin-top:16px;">
      <button type="button" onclick="removeAllLists()" class="secondary" style="color:var(--danger); border-color:rgba(255,59,48,0.25);">Remove all</button>
      <button type="button" class="primary" onclick="generate()">${isConfigureMode ? "Update Add-on" : "Generate Install Link"}</button>
    </div>
  </div>

  <!-- Undo Toast -->
  <div id="undoToast" class="undo-toast" style="display:none;">
    <span id="undoToastMsg"></span>
    <button type="button" class="secondary" onclick="performUndo()">Undo</button>
  </div>

  <!-- Generated Install Link Result Box -->
  <div id="result"></div>

    </div>
  
  <div class="lists-subpanel" id="catalogsSubBulk" style="display:none;">
  <div class="panel" style="margin-top:0;">
    <h2 class="panel-title">Bulk Import Lists</h2>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste multiple list URLs at once, one per line. Each list is automatically detected and added to your catalogs.</p>
    <textarea id="bulkPasteBox" rows="5" style="width:100%;font-family:monospace;font-size:15px;" placeholder="https://mdblist.com/lists/user/list-one&#10;https://trakt.tv/users/user/lists/list-two&#10;https://www.themoviedb.org/list/12345"></textarea>
    <div class="actions" style="margin-top:12px;">
      <button type="button" class="primary" onclick="bulkAddLists(this)">Add All Lines as Catalogs</button>
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubQuickAdd" style="display:none;">
    <div id="catalogsQuickAddContainer">

    <!-- Combined Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Combined Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="combined-charts">+ Add all</button>
      </div>
      ${combinedChartsHtml}
    </div>

    <!-- TMDB Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">TMDB Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="tmdb-charts">+ Add all</button>
      </div>
      ${tmdbChartsHtml}
    </div>

    <!-- Trakt Official Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Trakt Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="trakt-charts">+ Add all</button>
      </div>
      ${traktChartsHtml}
    </div>

    <!-- MDBList Official Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">MDBList Official</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="mdblist-charts">+ Add all</button>
      </div>
      ${mdblistChartsHtml}
    </div>

    <!-- Simkl Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Simkl Anime &amp; Trending</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="simkl-charts">+ Add all</button>
      </div>
      ${simklChartsHtml}
    </div>

    <!-- Streaming Top 10 Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Streaming Top 10</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-top10">+ Add all</button>
      </div>
      ${streamingTop10Html}
    </div>

    <!-- Streaming Catalogs Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Streaming Catalogs</h2>
        <button type="button" class="qa-add-all-btn lc-btn secondary" data-add-all-action="streaming-catalogs">+ Add all</button>
      </div>
      ${streamingHtml}
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubChannels" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">TV Channel Creator <span class="badge" id="channelDraftCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Turn any show into a 24/7 style continuous episode stream channel catalog item.</p>

      <div style="margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">My Created Channels:</p>
        <div id="myCreatedChannelsList"><p style="color:var(--muted); font-size:0.85rem;"><small>No created channels yet.</small></p></div>
      </div>

    <div style="margin-bottom:16px;">
      <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">Quick Add Popular TV Channels:</p>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; gap:6px;">
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="CBS Network" data-networkid="16">CBS</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="NBC Network" data-networkid="6">NBC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="ABC Network" data-networkid="2">ABC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FOX Network" data-networkid="19">FOX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="The CW" data-networkid="71">The CW</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HBO Classics" data-networkid="49">HBO</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Disney Channel" data-networkid="54">Disney Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Nickelodeon" data-networkid="13">Nickelodeon</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Comedy Central" data-networkid="47">Comedy Central</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="USA Network" data-networkid="30">USA Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Adult Swim" data-networkid="80">Adult Swim</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Cartoon Network" data-networkid="56">Cartoon Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FX Hits" data-networkid="88">FX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="AMC Series" data-networkid="174">AMC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Syfy" data-networkid="149">Syfy</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MTV" data-networkid="33">MTV</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Discovery" data-networkid="64">Discovery Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="History Channel" data-networkid="65">History</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="A&amp;E" data-networkid="129">A&amp;E</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="BBC One" data-networkid="4">BBC One</button>
      </div>
      <div id="channelQuickAddStatus" style="margin-top:6px;"></div>
    </div>

    <div style="margin-top:14px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Search and Build Channel Episodes:</p>
      <div class="row">
        <input type="text" id="channelSearchInput" placeholder="Search a show by name" onkeydown="if(event.key==='Enter'){event.preventDefault();runChannelTitleSearch();}">
        <button type="button" class="secondary" onclick="runChannelTitleSearch()">Search</button>
      </div>
      <div id="channelSearchResult"></div>
      <div id="channelEpisodePicker"></div>

      <div id="channelDraftPicksDetails" style="margin-top:12px;">
        <p style="margin:0 0 6px; font-weight:600; font-size:0.85rem;">Channel Picks <span class="badge" id="channelDraftPicksCountBadge"></span>:</p>
        <div id="channelDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
        <div class="actions" style="margin-top:8px;">
          <button type="button" class="secondary lc-btn" onclick="shuffleChannelDraft()">Shuffle picks</button>
          <button type="button" class="secondary lc-btn" onclick="removeAllChannelDraftPicks()">Remove all</button>
        </div>
      </div>

      <div class="row" style="margin-top:8px; align-items:center;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="channelRandomizeCheck">
          <span style="font-size:0.85rem;">Randomize play order (daily reshuffle)</span>
        </label>
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelNameInput" placeholder="Channel name (e.g. Cartoon Central)">
        <button type="button" class="primary" id="channelSaveBtn" onclick="saveChannel()">Save as Channel</button>
        <button type="button" id="channelCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditChannel()">Cancel edit</button>
      </div>
    </div>

    <div style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">Import Channel from a Link:</p>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Paste any show list URL (MDBList or Trakt) to automatically generate a TV channel shelf.</p>
      <div class="row">
        <input type="text" id="channelImportUrlInput" placeholder="Show list URL (mdblist.com or trakt.tv)">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelImportNameInput" placeholder="Channel name (e.g. Sitcom Central)">
        <button type="button" class="secondary" onclick="importChannelFromLink(this)">Import channel</button>
      </div>
    </div>

    <div style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Merge Saved Channels into One Shelf:</p>
      <div class="actions" style="margin-bottom:8px;">
        <button type="button" class="secondary lc-btn" onclick="renderChannelMergeList()">Refresh list</button>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.85rem;">
          <input type="checkbox" id="channelMergeSelectAllCheck" onchange="toggleAllChannelMergeChecks(this)">
          <span>Select all</span>
        </label>
      </div>
      <div id="channelMergeList"><p style="color:var(--muted); font-size:0.85rem;"><small>No saved channels yet.</small></p></div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelMergeNameInput" placeholder="Combined shelf name (e.g. Live TV)">
        <button type="button" class="secondary" onclick="mergeChannelsIntoRow()">Merge into shelf</button>
      </div>
    </div>
  </div>
  </div>
</div>

<div class="tab-panel" data-tab-panel="discover">
  <!-- Discover Top Submenu Pills -->
  <div class="subnav-pills-bar" id="discoverSubnavBar">
    <button type="button" class="subnav-pill active" onclick="filterDiscoverShelves('all', this)"><span class="check-icon">&#x2713;</span> All</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('movie', this)">Movies</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('series', this)">Shows</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('gems', this)">Hidden Gems</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('kids', this)">Kids</button>
  </div>

  <!-- Discover Shelves Feed -->
  <div id="discoverShelvesContainer">
    <!-- Combined Charts Shelf -->
    ${combinedChartsHtml}

    <!-- TMDB Charts Shelf -->
    ${tmdbChartsHtml}

    <!-- Trakt Official Charts Shelf -->
    ${traktChartsHtml}

    <!-- MDBList Official Charts Shelf -->
    ${mdblistChartsHtml}

    <!-- Simkl Charts Shelf -->
    ${simklChartsHtml}

    <!-- Streaming Top 10 Shelf -->
    ${streamingTop10Html}

    <!-- Streaming Catalogs Shelf -->
    ${streamingHtml}

    <!-- Hidden Gems Shelf -->
    ${hiddenGemsHtml}

    <!-- Kids Shelf -->
    ${kidsHtml}
  </div>

  <!-- Discover Lists Feed (Movies / Shows list view matching search) -->
  <div id="discoverListsFeed" style="display:none;"></div>
</div>
<div class="tab-panel" data-tab-panel="lists" hidden>
  <!-- Top Submenu Pills for Lists -->
  <div class="subnav-pills-bar" id="listsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchListsSubmenu('my-lists', this)"><span class="check-icon">&#x2713;</span> My Lists</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('liked', this)">Liked</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('popular', this)">Popular</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('curated', this)">Curated</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('list-search', this)">Find Lists</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('import', this)">Import</button>
  </div>

  <!-- Submenu 1: User's Connected Account & Custom Lists -->
  <div class="lists-subpanel" id="listsSubMyLists">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Your Custom Lists</h2>
        <button type="button" class="secondary lc-btn" onclick="renderCreatorDashboard()">Refresh</button>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Custom lists you've created locally or on your profile.</p>
      <div id="creatorDashboard"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Your MDBList Lists</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists belonging to your MDBList API key configured in Settings.</p>
      <div id="myMdblistListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Trakt Lists</h2>
        <button type="button" class="secondary lc-btn" id="listsTraktConnectBtn" onclick="toggleListsTraktConnection()">Connect Trakt</button>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Public and personal lists from your Trakt username/account.</p>
      <div id="myTraktListsResult"></div>
      <div id="myPrivateTraktListsResult" style="margin-top:10px;"></div>
    </div>
  </div>

  <!-- Submenu 2: Liked Lists Feed -->
  <div class="lists-subpanel" id="listsSubLiked" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Lists You Liked</h2>
      <button type="button" class="secondary lc-btn" onclick="renderLikedListsFeed()">Refresh</button>
    </div>
    <div id="likedListsFeed"><p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p></div>
  </div>

  <!-- Submenu 3: Popular Lists Feed -->
  <div class="lists-subpanel" id="listsSubPopular" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Popular Community Lists</h2>
      <button type="button" class="secondary lc-btn" onclick="loadPopularListsFeed()">Refresh</button>
    </div>
    <div id="popularListsFeed"></div>
  </div>

  <!-- Submenu 4: Curated Lists Feed -->
  <div class="lists-subpanel" id="listsSubCurated" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Curated &amp; Official Lists</h2>
    </div>
    <div id="curatedListsFeed"></div>
  </div>

  <!-- Submenu 5: Create Custom List Builder -->
  <div class="lists-subpanel" id="listsSubCreateList" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="customListEditorTitle">Create a Custom List <span class="badge" id="customListDraftCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Build a hand-picked list of movies or shows by searching and adding them one at a time. After saving, your list will appear under <strong>My Lists</strong>.</p>

      <div class="row">
        <input type="text" id="customListSearchInput" placeholder="Search a movie or show by name" onkeydown="if(event.key==='Enter'){event.preventDefault();runCustomListSearch();}">
        <select id="customListSearchType" style="flex:none; width:auto;">
          <option value="movie">&#x1F3AC; Movies</option>
          <option value="tv">&#x1F4FA; Shows</option>
        </select>
        <button type="button" class="secondary" onclick="runCustomListSearch()">Search</button>
      </div>
      <div id="customListSearchResult"></div>

      <p style="margin-top:14px; margin-bottom:6px; font-weight:600; font-size:0.85rem;">Picks so far (in play order):</p>
      <div id="customListDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="shuffleCustomListDraft()">Shuffle picks now</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:8px;">
        <input type="checkbox" id="customListRandomizeCheck">
        <span style="font-size:0.85rem;">Randomize order (reshuffles once a day)</span>
      </label>

      <div class="row" id="customListVisibilityRow" style="display:none; margin-top:8px; align-items:center; gap:8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <span style="font-size:0.85rem;">Visibility:</span>
          <select id="customListVisibilitySelect" style="flex:none; width:auto;">
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
      </div>
      <div id="customListTypeToggles" style="margin-top:8px; display:flex; gap:16px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="movie" onchange="setCustomListDraftTypeToggle('movie')" checked>
          <span style="font-size:0.85rem;">Movies</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="series" onchange="setCustomListDraftTypeToggle('series')">
          <span style="font-size:0.85rem;">Shows</span>
        </label>
      </div>
      <div class="row" style="margin-top:10px;">
        <input type="text" id="customListNameInput" placeholder="List name (e.g. My Favorites)">
        <button type="button" class="primary" id="customListSaveBtn" onclick="saveCustomList()">Save List</button>
        <button type="button" id="customListCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditCustomList()">Cancel edit</button>
      </div>
    </div>
  </div>

  <!-- Submenu 7: Import from a Link -->
  <div class="lists-subpanel" id="listsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Import from a link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div class="row">
        <input type="text" id="customListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="customListImportNameInput" placeholder="Name (e.g. My Favorites)">
        <button type="button" class="secondary" id="customListImportBtn" onclick="importCustomListFromLink(this)">Import from link</button>
      </div>
    </div>
  </div>



  <!-- Submenu 6: Find Lists -->
<div class="lists-subpanel" id="listsSubListSearch" style="display:none;">

  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Public Lists &amp; Catalogs</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search across hundreds of public MDBList, Trakt, and community lists to add to your catalogs.</p>
    
    <div class="row">
      <input type="text" id="listSearchInput" placeholder="Search lists by title or keyword..." onkeydown="if(event.key==='Enter'){event.preventDefault();runListSearch();}">
      <button type="button" class="primary" onclick="runListSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="listSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setListSearchFilter('all', this)"><span class="check-icon">&#x2713;</span> All</button>
      <button type="button" class="subnav-pill" onclick="setListSearchFilter('movie', this)">Movies</button>
      <button type="button" class="subnav-pill" onclick="setListSearchFilter('series', this)">Shows</button>
    </div>

    <div id="listSearchResult" style="margin-top:14px;"></div>
  </div>
</div>
</div>
<div class="tab-panel" data-tab-panel="search" hidden>
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Movies &amp; TV Shows</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search the TMDB catalog to find movies and shows to add to your lists.</p>
    
    <div class="row">
      <input type="text" id="catalogSearchInput" placeholder="Search by title..." onkeydown="if(event.key==='Enter'){event.preventDefault();runCatalogSearch();}">
      <button type="button" class="primary" onclick="runCatalogSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="catalogSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setCatalogSearchFilter('movie', this)"><span class="check-icon">&#x2713;</span> Movies</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('tv', this)">Shows</button>
    </div>

    <div id="catalogSearchResult" style="margin-top:14px;"></div>
  </div>
</div>
<div class="tab-panel" data-tab-panel="settings" hidden>
  <!-- Settings Top Submenu Pills -->
  <div class="subnav-pills-bar" id="settingsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchSettingsSubmenu('keys', this)"><span class="check-icon">&#x2713;</span> Keys &amp; Account</button>
    <button type="button" class="subnav-pill" onclick="switchSettingsSubmenu('backup', this)">&#x1F4BE; Presets &amp; Backup</button>
  </div>

  <!-- Submenu 2: Presets & Backup -->
  <div class="settings-subpanel" id="settingsSubBackup" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">My Presets <span class="badge" id="presetsCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Save your current setup as a named preset to reuse or download as a file.</p>
      <div class="row">
        <input type="text" id="presetNameInput" placeholder="Preset name (e.g. Home Cinema)">
        <button type="button" class="secondary" onclick="saveCurrentAsPreset()">Save preset</button>
      </div>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="document.getElementById('presetFileInput').click()">Upload preset file</button>
        <input type="file" id="presetFileInput" accept="application/json,.json" style="display:none;" onchange="uploadPresetFile(this)">
      </div>
      <div id="presetsList" style="margin-top:10px;"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Backup &amp; Restore</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Export your complete setup as JSON or import an existing configuration.</p>
      <textarea id="configJsonBox" rows="5" style="width:100%;font-family:monospace;font-size:14px;" placeholder="Paste config JSON here to restore..."></textarea>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="exportConfigJson()">Export current</button>
        <button type="button" class="secondary lc-btn" onclick="importConfigJson()">Import JSON</button>
        <button type="button" class="secondary lc-btn" onclick="downloadConfigJson()">Download file</button>
        <button type="button" class="secondary lc-btn" onclick="document.getElementById('configFileInput').click()">Upload file</button>
        <input type="file" id="configFileInput" accept="application/json,.json" style="display:none;" onchange="uploadConfigFile(this)">
      </div>

      <div style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Import from Install / Configure Link:</p>
        <div class="row">
          <input type="text" id="importLinkInput" placeholder="Paste an install or configure link here">
          <button type="button" class="secondary" onclick="importFromLink()">Import link</button>
        </div>
      </div>
    </div>
  </div>
  <!-- Submenu 1: Keys & Account -->
  <div class="settings-subpanel" id="settingsSubKeys">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Auto-Track Playback</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Automatically marks episodes and movies as watched the moment you start playing them in Stremio or wako &mdash; from any addon, not just this one. Works by declaring a subtitles resource that Stremio/wako call whenever any video starts playing; this addon returns no real subtitles, it just uses that request as a "just started playing" signal.</p>
      <div id="trackPlaybackSection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Your API Keys (Optional)</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">These are yours alone &mdash; they're baked into your install link, not stored on any server.</p>

      <div class="row">
        <input type="text" id="mdblistKeyInput" placeholder="MDBList API key — needed for private lists / your watchlist" value="${initialMdblistKey}" oninput="saveState(); scheduleMyMdblistListsRefresh();">
      </div>
      <p><small>Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" style="color:var(--accent-2);">mdblist.com/preferences</a>.</small></p>

      <div class="row" style="margin-top:14px;">
        <input type="text" id="traktKeyInput" placeholder="Trakt Client ID — for searching Trakt and importing your lists" value="${initialTraktKey}" oninput="saveState(); scheduleMyTraktListsRefresh();">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="traktUsernameInput" placeholder="Trakt username — to show your personal lists" value="${initialTraktUsername}" oninput="saveState(); scheduleMyTraktListsRefresh();">
      </div>
      <p><small>Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" style="color:var(--accent-2);">trakt.tv/oauth/applications</a>.</small></p>

      <div id="traktConnectSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Private Trakt Lists</p>
        <p><small>Connect your Trakt account to pull in private watchlists and lists. Only asks for read access.</small></p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap;">
          <button type="button" class="secondary" id="traktConnectBtn" onclick="startTraktConnect()">Connect Trakt</button>
          <button type="button" class="secondary" id="traktDisconnectBtn" style="display:none;" onclick="disconnectTrakt()">Disconnect</button>
        </div>
        <p id="traktConnectStatus" style="margin-top:8px;"></p>
      </div>

      <div id="traktExportImportSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Import from Trakt VIP Export</p>
        <p><small>Upload your Trakt VIP .zip export (history, watchlist, ratings) to convert into a Custom List locally in your browser.</small></p>
        <div class="row" style="margin-top:8px;">
          <input type="file" id="traktExportFileInput" accept=".zip">
        </div>
        <div id="traktExportImportResult"></div>
      </div>

      <div id="letterboxdExportImportSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Import from Letterboxd Export</p>
        <p><small>Upload your Letterboxd .zip export (watched, watchlist, diary, ratings). The addon will resolve them via TMDB to create a Custom List.</small></p>
        <div class="row" style="margin-top:8px;">
          <input type="file" id="letterboxdExportFileInput" accept=".zip">
        </div>
        <div id="letterboxdExportImportResult"></div>
      </div>
    </div>
  </div>
</div>
</div>
<script>
const ORIGIN = ${JSON.stringify(origin)};
const IS_CONFIGURE = ${isConfigureMode};
// Global state variables
var suppressSave = false;
var activeCreator = null;
var livePreviewShelfData = [];
// No dedicated text input for this one (unlike the other keys) -- it's set
// via the Connect Trakt button/OAuth flow, not typed in, so it lives as
// its own piece of state instead of being read from a DOM field.
var activeTraktToken = null;
let traktAccessToken = ${JSON.stringify(initialTraktAccessToken)};

async function compressJsonToBase64(obj) {
  try {
    const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 16384;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (e) {
    return null;
  }
}
async function decompressBase64ToJson(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// --- Tab & Submenu Navigation ---------------------------------------------
function switchTab(name) {
  if (name === 'backup') {
    switchTab('settings');
    switchSettingsSubmenu('backup', document.querySelector('#settingsSubnavBar button:nth-child(4)'));
    return;
  }
  if (name === 'keys') {
    switchTab('settings');
    switchSettingsSubmenu('keys', document.querySelector('#settingsSubnavBar button:nth-child(1)'));
    return;
  }
  if (name === 'quick-add' || name === 'toplists') {
    switchTab('catalogs');
    switchCatalogsSubmenu('quickadd', document.querySelector('#catalogsFilterBar button:nth-child(2)'));
    return;
  }

  const titles = {
    discover: { title: 'Discover', sub: 'Explore Popular & Streaming' },
    catalogs: { title: 'My Catalogs', sub: 'Manage Configured Shelves' },
    lists: { title: 'Lists', sub: 'Community & Curated Lists' },
    channels: { title: 'Channels', sub: '24/7 Continuous TV Streaming' },
    search: { title: 'Search', sub: 'Find Movies, Shows & Lists' },
    settings: { title: 'Settings', sub: 'Accounts, API Keys & Tools' }
  };
  const t = titles[name] || { title: 'My Lists Addon', sub: '' };
  const titleEl = document.getElementById('pageMainTitle');
  const subEl = document.getElementById('pageSubtitle');
  if (titleEl) titleEl.textContent = t.title;
  if (subEl) subEl.textContent = t.sub;

  const createListBtn = document.getElementById('headerCreateListBtn');
  if (createListBtn) {
    createListBtn.style.display = name === 'lists' ? 'block' : 'none';
  }
  const addShelfBtn = document.getElementById('headerAddShelfBtn');
  if (addShelfBtn) {
    addShelfBtn.style.display = name === 'catalogs' ? 'block' : 'none';
  }

  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.hidden = (p.getAttribute('data-tab-panel') !== name);
  });
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  document.querySelectorAll('.bottom-nav-item').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  try {
    localStorage.setItem('myListAddon:activeTab', name);
  } catch (e) {}

  if (name === 'lists') {
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    if (typeof renderMyLists === 'function') renderMyLists();
  }
  if (name === 'discover') {
    filterDiscoverShelves('all', document.querySelector('#discoverSubnavBar button:nth-child(1)'));
  }
  if (name === 'catalogs') {
    // Same "load automatically when the tab opens" treatment Lists/Discover
    // already get above -- Catalogs was the one tab still requiring a
    // manual "Refresh Preview" click just to see anything, even on the
    // very first visit with shelves already configured (e.g. from an
    // existing install link).
    if (typeof renderLivePreview === 'function') renderLivePreview();
  }
}

function showAddedToast(msg) {
  let toast = document.getElementById('actionToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'actionToast';
    toast.className = 'action-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg || 'Added to My Catalogs \u2713';
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

function restoreActiveTab() {
  let tab = 'discover';
  try {
    tab = localStorage.getItem('myListAddon:activeTab') || 'discover';
  } catch (e) {}
  if (tab === 'item-details') tab = 'discover';
  switchTab(tab);
}

function switchListsSubmenu(name, btn) {
  document.querySelectorAll('#listsSubnavBar .subnav-pill').forEach(function(p) {
    p.classList.remove('active');
    const c = p.querySelector('.check-icon');
    if (c) c.remove();
  });
  if (btn) {
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const subpanels = {
    'popular': 'listsSubPopular',
    'my-lists': 'listsSubMyLists',
    'liked': 'listsSubLiked',
    'curated': 'listsSubCurated',
    'bulk': 'listsSubBulk',
    'create-list': 'listsSubCreateList',
      'list-search': 'listsSubListSearch',
      'import': 'listsSubImport'
  };
  Object.keys(subpanels).forEach(function(k) {
    const el = document.getElementById(subpanels[k]);
    if (el) el.style.display = 'none';
  });
  const activeId = subpanels[name];
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.style.display = 'block';

  if (name === 'popular') loadPopularListsFeed();
  if (name === 'my-lists') {
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    if (typeof runMyMdblistLists === 'function') runMyMdblistLists();
    if (typeof runMyTraktLists === 'function') runMyTraktLists();
  }
  if (name === 'liked') renderLikedListsFeed();
  if (name === 'curated') loadCuratedListsFeed();
}

function switchSettingsSubmenu(name, btn) {
  if (btn) {
    document.querySelectorAll('#settingsSubnavBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const subpanels = {
    'keys': 'settingsSubKeys',
    'backup': 'settingsSubBackup'
  };
  Object.keys(subpanels).forEach(function(k) {
    const el = document.getElementById(subpanels[k]);
    if (el) el.style.display = 'none';
  });
  const activeId = subpanels[name];
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.style.display = 'block';
}

function filterDiscoverShelves(filter, btn) {
  if (btn) {
    document.querySelectorAll('#discoverSubnavBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const shelvesContainer = document.getElementById('discoverShelvesContainer');
  const feedContainer = document.getElementById('discoverListsFeed');
  
  // Now 'all' also uses the feed container since the shelves have been moved to Catalogs
  if (filter === 'movie' || filter === 'series' || filter === 'gems' || filter === 'kids' || filter === 'all') {
    if (shelvesContainer) shelvesContainer.style.display = 'none';
    if (feedContainer) {
      feedContainer.style.display = 'block';
      if (typeof renderDiscoverChartsList === 'function') {
        renderDiscoverChartsList(filter);
      }
    }
  } else {
    if (feedContainer) feedContainer.style.display = 'none';
    if (shelvesContainer) {
      shelvesContainer.style.display = 'block';
      const shelves = shelvesContainer.querySelectorAll('.discover-shelf');
      shelves.forEach(function(shelf) {
        const st = shelf.getAttribute('data-shelf-type') || 'all';
        if (filter === 'all') {
          shelf.style.display = '';
        } else if (filter === 'gems') {
          shelf.style.display = (st === 'gems') ? '' : 'none';
        } else {
          shelf.style.display = '';
        }
      });
    }
  }
}

// Renders the chart lists for the Movies or Shows tab in Discover as list-cards
// (matching how search results and the Lists tab look) by converting the
// baked-in chart data tables into the same object shape render5PosterListsFeed expects.
function renderDiscoverChartsList(type) {
  const container = document.getElementById('discoverListsFeed');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading charts\u2026</p>';

  // Build list objects from all chart tables, filtered to the right type.
  const lists = [];

  // Helper: push a pair entry
  function pushPair(name, movieUrl, showUrl, group) {
    if ((type === 'movie' || type === 'all') && movieUrl) {
      lists.push({ name: name, url: movieUrl, type: 'movie', user: group, likes: 0 });
    }
    if ((type === 'series' || type === 'all') && showUrl) {
      lists.push({ name: name, url: showUrl, type: 'series', user: group, likes: 0 });
    }
  }
  // Helper: push single-type entry
  function pushSingle(name, url, entryType, group) {
    if (type === entryType || type === 'all') {
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    } else if (type === 'gems' && entryType === 'movie') {
      // Hidden Gems only has movies, but if they click gems tab, show it
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    } else if (type === 'kids') {
      // Kids tab shows all items in kids lists
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    }
  }

  // Each data table is baked in at render time via the server-side template.
  // They are exposed as window._CHARTS_* globals by 09_page-shell.js.

  if (type !== 'gems' && type !== 'kids') {
    if (window._CHARTS_TMDB) {
      window._CHARTS_TMDB.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'TMDB'); });
    }
    if (window._CHARTS_TRAKT) {
      window._CHARTS_TRAKT.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Trakt'); });
    }
    if (window._CHARTS_TRAKT_BO) {
      window._CHARTS_TRAKT_BO.forEach(function(p) { pushSingle(p.name, p.url, p.type, 'Trakt'); });
    }
    if (window._CHARTS_MDBLIST) {
      window._CHARTS_MDBLIST.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'MDBList'); });
    }
    if (window._CHARTS_SIMKL) {
      window._CHARTS_SIMKL.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Simkl'); });
    }
    if (window._CHARTS_SIMKL_ANIME) {
      window._CHARTS_SIMKL_ANIME.forEach(function(p) { pushSingle(p.name, p.url, p.type, 'Simkl'); });
    }
    if (window._CHARTS_STREAMING_TOP10) {
      window._CHARTS_STREAMING_TOP10.forEach(function(p) { pushPair(p.name + ' Top 10', p.movieUrl, p.showUrl, 'Streaming Top 10'); });
    }
    if (window._CHARTS_STREAMING_ALL) {
      window._CHARTS_STREAMING_ALL.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Streaming'); });
    }
  }

  if (type === 'gems' || type === 'all') {
    pushSingle('Hidden Gems', 'tmdb:hidden-gems', 'movie', 'Hidden Gems');
  }

  if (type === 'kids' || type === 'all') {
    if (window._CHARTS_KIDS) {
      window._CHARTS_KIDS.forEach(function(item) {
        pushSingle(item.name, item.movieUrl, 'movie', 'Kids Movies');
        pushSingle(item.name, item.showUrl, 'series', 'Kids Shows');
      });
    }
  }

  if (typeof render5PosterListsFeed === 'function') {
    render5PosterListsFeed(container, lists);
  } else {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Could not load chart lists.</p>';
  }
}

function switchCatalogsSubmenu(filter, btn) {
  if (btn) {
    document.querySelectorAll('#catalogsFilterBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }

  const panels = {
    'all': document.getElementById('catalogsSubShelves'),
    'quickadd': document.getElementById('catalogsSubQuickAdd'),
    'channels': document.getElementById('catalogsSubChannels'),
    'bulk': document.getElementById('catalogsSubBulk')
  };

  for (const key in panels) {
    if (panels[key]) {
      panels[key].style.display = (key === filter) ? 'block' : 'none';
    }
  }

  const undoToast = document.getElementById('undoToast');
  const resultDiv = document.getElementById('result');
  if (filter !== 'all') {
    if (undoToast) undoToast.style.display = 'none';
    if (resultDiv) resultDiv.style.display = 'none';
  } else {
    // Make sure all list rows are visible since we no longer have row-level filters
    document.querySelectorAll('#lists .entry').forEach(function(e) {
      e.style.display = '';
    });
  }
}

function setListSearchChip(filter, btn) {
  if (btn) {
    document.querySelectorAll('#listSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const resultContainer = document.getElementById('listSearchResult');
  if (resultContainer) {
    resultContainer.setAttribute('data-type-filter', filter);
  }
  const cards = document.querySelectorAll('#listSearchResult .list-card');
  cards.forEach(function(card) {
    const cardType = card.getAttribute('data-list-type') || '';
    if (filter === 'all') {
      card.style.display = '';
    } else if (filter === 'movie') {
      card.style.display = (cardType === 'movie' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'series') {
      card.style.display = (cardType === 'series' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'lists') {
      card.style.display = '';
    }
  });
}

function quickAddProvider(name) {
  const providerData = {
    'Netflix': {
      top10Movie: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-movies',
      top10Series: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/netflix-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/netflix-shows'
    },
    'Prime Video': {
      top10Movie: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-movies',
      top10Series: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/amazon-prime-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/amazon-prime-shows'
    },
    'Apple TV+': {
      top10Movie: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today',
      top10Series: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today',
      movie: 'https://mdblist.com/lists/slimshizn/apple-tv-movies',
      series: 'https://mdblist.com/lists/snoak/latest-apple-tv-plus-tv-shows'
    },
    'Disney+': {
      top10Movie: 'https://mdblist.com/lists/andykai/disney-top-10-no-hulu',
      top10Series: 'https://mdblist.com/lists/andykai/disney-trending-no-hulu',
      movie: 'https://mdblist.com/lists/garycrawfordgc/disney-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/disney-shows'
    },
    'HBO Max': {
      top10Movie: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q',
      top10Series: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd',
      movie: 'https://mdblist.com/lists/snoak/latest-max-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/hbo-shows'
    },
    'Hulu': {
      top10Movie: 'https://mdblist.com/lists/hulupiv/hulu-top-10-movies',
      top10Series: 'https://mdblist.com/lists/hulupiv/hulu-top-10-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/hulu-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/hulu-shows'
    },
    'Paramount+': {
      top10Movie: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today',
      top10Series: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today',
      movie: 'https://mdblist.com/lists/snoak/latest-paramount-plus-movies',
      series: 'https://mdblist.com/lists/snoak/latest-paramount-plus-tv-shows'
    },
    'Peacock': {
      top10Movie: 'https://mdblist.com/lists/diimaan/peacock-top-10-movies',
      top10Series: 'https://mdblist.com/lists/peacockpiv/peacock-top-10-shows',
      movie: 'https://mdblist.com/lists/tvgeniekodi/peacock-movies',
      series: 'https://mdblist.com/lists/tvgeniekodi/peacock-tv-shows'
    }
  };
  const data = providerData[name];
  if (data) {
    if (data.top10Movie) addRow(name + ' Top 10', data.top10Movie, 'movie', true, 'Streaming Top 10');
    if (data.top10Series) addRow(name + ' Top 10', data.top10Series, 'series', true, 'Streaming Top 10');
    if (data.movie) addRow(name, data.movie, 'movie', true, name);
    if (data.series) addRow(name, data.series, 'series', true, name);
    saveState();
    switchTab('catalogs');
  }
}

function closeDetailOverlay() {
  const el = document.getElementById('detailOverlay');
  if (el) el.classList.remove('active');
}


// Renders one source URL row. A "merged" entry (multiple sources feeding
// one shelf) has several of these inside its .sources container; a normal
// entry has exactly one. Kept as its own function so addSourceRow can also
// generate one when the person clicks "+ Add another source".
function sourceRowHtml(u, readonly) {
  if (readonly) {
    return '<div class="source-row">' +
      '<div class="row field-row">' +
      '<input type="text" class="url" value="mdblist:watchlist" readonly style="opacity:0.75;">' +
      '</div>' +
      '<div class="testrow">' +
      '<button type="button" class="btn-test secondary" onclick="testSourceRow(this)">Test</button>' +
      '<div class="testresult"></div>' +
      '</div>' +
      '</div>';
  }
  return '<div class="source-row">' +
    '<div class="row field-row">' +
    '<input type="text" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL" class="url" value="' + escapeAttr(u) + '" oninput="checkDuplicateUrl(this)">' +
    '<button type="button" class="movebtn removebtn remove-source-btn" onclick="removeSourceRow(this)" style="display:none;">\u2715</button>' +
    '</div>' +
    '<small class="dup-warning" style="display:none;">\u26a0 Already added elsewhere in this list.</small>' +
    '<div class="testrow">' +
    '<button type="button" class="btn-test secondary" onclick="testSourceRow(this)">Test</button>' +
    '<div class="testresult"></div>' +
    '</div>' +
    '</div>';
}

// Shared with editChannel below -- client-side twin of the server's
// parseChannelPayload, since the builder page needs to read a channel's
// payload back out too (to render its summary, and now to load it back
// into the picker for editing).
function parseChannelPayloadClient(u) {
  try {
    const raw = String(u || '').trim();
    if (!raw.startsWith('channel:v1:')) return null;
    const data = JSON.parse(raw.slice('channel:v1:'.length));
    return data && Array.isArray(data.items) ? data : null;
  } catch (e) {
    return null;
  }
}

function channelSourceRowHtml(u) {
  let summary = 'Custom Channel';
  const payload = parseChannelPayloadClient(u);
  if (payload) {
    const items = payload.items || [];
    const epCount = items.filter((it) => it.kind === 'episode').length;
    const movieCount = items.filter((it) => it.kind === 'movie').length;
    const parts = [];
    if (epCount) parts.push(epCount + ' episode' + (epCount === 1 ? '' : 's'));
    if (movieCount) parts.push(movieCount + ' movie' + (movieCount === 1 ? '' : 's'));
    summary = items.length + ' pick' + (items.length === 1 ? '' : 's') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
    if (payload.dailyRotate) {
      summary = items.length + '-episode pool \u2014 shows ' + CHANNEL_ROTATION_SHOWS_PER_DAY + ' shows \u00d7 ' +
        CHANNEL_ROTATION_EPISODES_PER_SHOW + ' episodes each, refreshed daily';
    } else if (payload.shuffle) {
      summary += ' \u2014 shuffled daily';
    }
  }
  return '<div class="source-row">' +
    '<p style="margin:0;"><small>' + escapeHtml(summary) + ' \u2014 built with the Channels panel above.</small> ' +
    '<button type="button" class="secondary channelEditBtn" style="padding:4px 10px; min-height:unset;" onclick="editChannel(this)">Edit</button></p>' +
    '<input type="hidden" class="url" value="' + escapeAttr(u) + '">' +
    '</div>';
}

// Custom Lists don't need the channelId/name-embedding machinery Channels
// do -- each pick is already its own real, independently resolvable movie
// or show (see fetchCustomListCatalog), so there's no synthetic identity
// to keep stable across a merge the way a Channel's is; the ordinary
// merge-into-one-shelf mechanism every other list type uses works fine
// here unmodified.
function parseCustomListPayloadClient(u) {
  try {
    const raw = String(u || '').trim();
    if (!raw.startsWith('customlist:v1:')) return null;
    const data = JSON.parse(raw.slice('customlist:v1:'.length));
    if (!data || !Array.isArray(data.items)) return null;
    if (data.type !== 'movie' && data.type !== 'series') return null;
    return data;
  } catch (e) {
    return null;
  }
}

function customListSourceRowHtml(u) {
  let summary = 'Custom List';
  const payload = parseCustomListPayloadClient(u);
  let publishedLinkHtml = '';
  if (payload) {
    const items = payload.items || [];
    const label = payload.type === 'movie' ? 'movie' : 'show';
    summary = items.length + ' ' + label + (items.length === 1 ? '' : 's');
    if (payload.shuffle) summary += ' \u2014 shuffled daily';
    if (payload.publishedUrl) {
      publishedLinkHtml = '<p style="margin:6px 0 0;"><small>Shared at: <a href="' + escapeAttr(payload.publishedUrl) + '" target="_blank" style="color:var(--accent-2); word-break:break-all;">' + escapeHtml(payload.publishedUrl) + '</a></small></p>';
    }
  }
  return '<div class="source-row">' +
    '<p style="margin:0;"><small>' + escapeHtml(summary) + ' \u2014 built with the Custom List panel above.</small> ' +
    '<button type="button" class="secondary customListEditBtn" style="padding:4px 10px; min-height:unset;" onclick="editCustomList(this)">Edit</button> ' +
    '<button type="button" class="secondary customListShareBtn" style="padding:4px 10px; min-height:unset;" onclick="startSaveListFlow(this)">Save List</button></p>' +
    publishedLinkHtml +
    '<input type="hidden" class="url" value="' + escapeAttr(u) + '">' +
    '</div>';
}

// A short, stable random id for a Channel row -- generated once when the
// channel is first saved (see saveChannel), then carried forward as-is on
// every reload/restore (see the addRow(..., e.id) calls below) rather than
// being re-derived from content. Channels used to fall through to the
// generic slugify(url)-based id like every other row, but a channel's
// "url" is its whole JSON payload -- slugifying that just truncates to the
// poster URL's prefix, producing a meaningless (and collision-prone) id.
function generateChannelId() {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-4);
  return 'ch' + rand + time;
}

// Maps a list group/name string to one of 8 accent colours for the avatar dot.
function entryAvatarColor(s) {
  var palette = ['#007AFF','#FF9500','#34C759','#FF3B30','#AF52DE','#5856D6','#00C7BE','#FF6B35'];
  var h = 0;
  var str = s || '';
  for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

function openAddShelfModal() {
  document.getElementById('addShelfModalName').value = '';
  document.getElementById('addShelfModalLinksContainer').innerHTML = 
    '<div class="add-shelf-link-row" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">' +
      '<input type="url" class="addShelfModalLinkInput" placeholder="URL (e.g. Trakt, Letterboxd)" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">' +
    '</div>';
  document.getElementById('addShelfModalType').value = 'movie';
  validateAddShelfModal();
  document.getElementById('addShelfModal').style.display = 'flex';
  document.getElementById('addShelfModalName').focus();
}

function addShelfModalAddLink() {
  const container = document.getElementById('addShelfModalLinksContainer');
  const div = document.createElement('div');
  div.className = 'add-shelf-link-row';
  div.style.display = 'flex';
  div.style.alignItems = 'center';
  div.style.gap = '8px';
  div.style.marginBottom = '12px';
  div.innerHTML = 
    '<input type="url" class="addShelfModalLinkInput" placeholder="Additional URL" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">' +
    '<button type="button" class="lc-btn secondary" style="padding: 12px;" onclick="this.closest(&quot;.add-shelf-link-row&quot;).remove(); validateAddShelfModal()">\u2715</button>';
  container.appendChild(div);
  validateAddShelfModal();
}

function validateAddShelfModal() {
  const name = document.getElementById('addShelfModalName').value.trim();
  const links = Array.from(document.querySelectorAll('.addShelfModalLinkInput')).map(el => el.value.trim()).filter(Boolean);
  const btn = document.getElementById('addShelfModalBtn');
  if (name && links.length > 0) {
    btn.disabled = false;
    btn.style.opacity = '1';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }
}

function onAddShelfModalLinkInput(inputEl) {
  const link = inputEl.value.trim().toLowerCase();
  const typeSelect = document.getElementById('addShelfModalType');
  // Only auto-switch type if it's the first input or type is currently 'movie' and we detect a show
  if (link.includes('type=show') || link.includes('shows') || link.includes('series') || link.includes('tv')) {
    typeSelect.value = 'series';
  } else if (link.includes('movie') && typeSelect.value === 'series' && document.querySelectorAll('.addShelfModalLinkInput').length === 1) {
    typeSelect.value = 'movie';
  }
}

function submitAddShelfModal() {
  const name = document.getElementById('addShelfModalName').value.trim();
  const links = Array.from(document.querySelectorAll('.addShelfModalLinkInput')).map(el => el.value.trim()).filter(Boolean);
  const type = document.getElementById('addShelfModalType').value;
  if (!name || links.length === 0) return;
  
  if (links.length === 1) {
    addRow(name, links[0], type, true, 'Custom');
  } else {
    addCombinedRow(name, links, type, 'Custom');
  }
  
  document.getElementById('addShelfModal').style.display = 'none';
  saveState();
}

function addRow(name, url, type, enabled, group, channelId) {
  if (enabled === undefined) enabled = true;
  const container = document.getElementById('lists');
  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.group = group || 'Custom';
  const isWatchlist = url === 'mdblist:watchlist';
  const isChannel = String(url || '').startsWith('channel:v1:');
  const isCustomList = String(url || '').startsWith('customlist:v1:');
  
  if (group && group !== 'Custom' && group !== 'Custom Lists' && !isChannel && !isCustomList) {
    div.classList.add('premade-shelf');
  }
  
  if (isChannel) {
    div.dataset.channelId = channelId || generateChannelId();
  }
  const urlList = isWatchlist
    ? ['mdblist:watchlist']
    : String(url || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const rowsHtml = isChannel
    ? urlList.map((u) => channelSourceRowHtml(u)).join('')
    : isCustomList
      ? urlList.map((u) => customListSourceRowHtml(u)).join('')
      : (urlList.length ? urlList : ['']).map((u) => sourceRowHtml(u, isWatchlist)).join('');

  // Avatar: first letter of name (or group), coloured by group
  const avatarLetter = escapeHtml(((name || group || 'L').trim()[0] || 'L'));
  const avatarBg = entryAvatarColor(group || name || '');

  div.innerHTML = \`
    <div class="entry-card-top" style="flex-direction: column;">
      <div class="entry-ctrl-row" style="width: 100%; justify-content: flex-start; margin-bottom: 2px;">
        <div class="entry-pos-wrap" style="display:flex; align-items:center;">
          <input type="number" class="pos" min="1" title="Type a position number to move this list there" onchange="movePosTo(this)">
        </div>
        <span class="drag-handle ec-btn" draggable="true" title="Drag to reorder" style="cursor:grab; font-size:1rem;">&#9776;</span>
        <button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, -1)" title="Move up">&#8593;</button>
        <button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, 1)" title="Move down">&#8595;</button>
        \${(isCustomList || isChannel) ? \`<button type="button" class="ec-btn secondary" style="margin-left: auto; margin-right: 6px; font-weight:600; padding: 2px 10px;" onclick="\${isCustomList ? 'editEntryCustomList(this)' : 'editEntryChannel(this)'}">Edit</button>\` : ''}
        <button type="button" class="ec-btn movebtn removebtn danger" onclick="removeEntryWithUndo(this)" title="Remove this list" aria-label="Remove this list" style="\${!(isCustomList || isChannel) ? 'margin-left: auto;' : ''}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            <path d="M10 11v6"></path><path d="M14 11v6"></path>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
          </svg>
        </button>
      </div>
      <div style="display: flex; gap: 8px; width: 100%; align-items: center;">
        <div class="entry-card-body" style="flex-direction: row; gap: 10px; align-items: center; width: 100%;">
          <div class="entry-name-row" style="flex: 1;">
            <input type="text" placeholder="Name (e.g. Trending Movies)" class="name" value="\${escapeHtml(name||'')}">
          </div>
          <div class="entry-type-row" style="width: auto;">
            <select class="type" \${(isChannel || isCustomList) ? 'disabled title="Type is fixed for this list kind"' : ''}>
              <option value="movie" \${(type==='movie'||(isCustomList&&type==='movie'))?'selected':''}>Movies</option>
              <option value="series" \${(type==='series'||isChannel||(isCustomList&&type==='series'))?'selected':''}>Shows</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="sources">\${rowsHtml}</div>
    \${isWatchlist
      ? '<p class="watchlist-note"><small>Uses the MDBList API key from Settings.</small></p>'
      : (isChannel || isCustomList)
        ? ''
        : '<button type="button" class="secondary add-source-btn" onclick="addSourceRow(this)">+ Add another source (merge into one shelf)</button>'}
    <div class="live-preview-shelf" style="padding:0; margin:0; border:none; background:transparent;"><div class="live-preview-shelf-title"><span>\${escapeHtml(name||'Unnamed')} - \${type === 'series' ? 'Series' : 'Movies'}</span><button type="button" class="text-action-btn" disabled>See All \›</button></div><div class="live-preview-posters"><p style="color:var(--muted); font-size:0.88rem; text-align:center; padding: 20px;"><small>Click "Refresh Preview" above to load posters.</small></p></div></div>
  \`;
  container.appendChild(div);
  updateSourceRemoveButtons(div);
  relocateAddSourceBtn(div);
  initTouchDrag(div.querySelector('.drag-handle'));
  checkAllDuplicateUrls();
  renumber();
  if (!suppressSave) {
    showAddedToast('"' + (name || 'Shelf') + '" added to My Catalogs \u2713');
  }
  return div;
}


// Combined Charts quick-adds pass an array of sources instead of one URL --
// this joins them the same newline-separated way a manually merged row's
// sources end up joined (see collectEntries/addSourceRow), then hands off
// to the regular addRow() so it's just an ordinary multi-source row from
// here on, editable/removable a source at a time like any other.
function addCombinedRow(name, urls, type, group) {
  addRow(name, urls.join('\\n'), type, true, group);
}

function addQuickAddRowsFromPairs(list, group, labelSuffix = "") {
  list.forEach((p) => {
    const label = labelSuffix ? p.name + " " + labelSuffix : p.name;
    if (p.movieUrl) addRow(label, p.movieUrl, "movie", true, group);
    if (p.showUrl) addRow(label, p.showUrl, "series", true, group);
  });
  saveState();
}

function addQuickAddRowsFromSimpleList(list, group) {
  list.forEach((l) => {
    addRow(l.name, l.url, l.type, true, group);
  });
  saveState();
}

${buildAddAllFnJs("addAllMdblistCharts", buildAddAllPairsCallsJs(MDBLIST_OFFICIAL_CHARTS, "MDBList Charts", ""))}

${buildAddAllFnJs("addAllTmdbCharts", buildAddAllPairsCallsJs(TMDB_CHART_LISTS, "TMDB Charts", ""))}

${buildAddAllFnJs("addAllTraktCharts", buildAddAllPairsCallsJs(TRAKT_CHART_LISTS, "Trakt Charts", "") + "\n" + buildAddAllSimpleCallsJs(TRAKT_BOXOFFICE_LIST, "Trakt Charts"))}

${buildAddAllFnJs("addAllSimklCharts", buildAddAllPairsCallsJs(SIMKL_CHART_LISTS, "Simkl Charts", "") + "\n" + buildAddAllSimpleCallsJs(SIMKL_ANIME_LIST, "Simkl Charts"))}

${buildAddAllFnJs("addAllStreaming", buildAddAllPairsCallsJs(STREAMING_ALL, "Streaming", ""))}

${buildAddAllFnJs("addAllStreamingTop10", buildAddAllPairsCallsJs(STREAMING_TOP10, "Streaming Top 10", "Top 10"))}

// Generates the client-side addAllCombinedCharts() function body straight
// from COMBINED_CHART_LISTS -- the individual "+ Movies"/"+ Shows"
// buttons on each row already get their (baked-in, hand-copy-free) source
// arrays this same way via jsStringArrayLiteral (see buildCombinedChartsHtml
// above). "Add all" used to be a second, hand-maintained copy of this same
// data that referenced STREAMING_TOP10/STREAMING_ALL directly -- both of
// which are server-side-only constants with no client-side equivalent, so
// clicking "Add all" threw a ReferenceError partway through (right after
// the hardcoded Popular/Trending/Streaming-Top-10-movies entries, which
// happened to not need those variables) and silently never added Streaming
// Top 10 Shows or Streaming (All Services) at all. Generating this
// function from the same single source of truth as the per-row buttons
// fixes that and makes a repeat impossible.
${buildAddAllCombinedChartsJs()}

function addAllHiddenGems() {
  addRow("Hidden Gems", "tmdb:hidden-gems", "movie", true, "Hidden Gems");
  addRow("Hidden Gems", "tmdb:hidden-gems", "series", true, "Hidden Gems");
  saveState();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-add-all-action]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.getAttribute('data-add-all-action');
  if (action === 'mdblist-charts') addAllMdblistCharts();
  else if (action === 'tmdb-charts') addAllTmdbCharts();
  else if (action === 'trakt-charts') addAllTraktCharts();
  else if (action === 'simkl-charts') addAllSimklCharts();
  else if (action === 'streaming') addAllStreaming();
  else if (action === 'streaming-top10') addAllStreamingTop10();
  else if (action === 'combined-charts') addAllCombinedCharts();
  else if (action === 'hidden-gems') addAllHiddenGems();
});

// Adds a blank source row to an existing entry -- this is how a normal
// single-source row becomes a "merged" one: the server dedupes by IMDB id
// across whatever sources end up here (see fetchMergedCatalog).
function addSourceRow(btn) {
  const entry = btn.closest('.entry');
  const sources = entry.querySelector('.sources');
  const wrap = document.createElement('div');
  wrap.innerHTML = sourceRowHtml('', false);
  sources.appendChild(wrap.firstElementChild);
  updateSourceRemoveButtons(entry);
  relocateAddSourceBtn(entry);
  saveState();
}

function removeSourceRow(btn) {
  const entry = btn.closest('.entry');
  btn.closest('.source-row').remove();
  updateSourceRemoveButtons(entry);
  relocateAddSourceBtn(entry);
  checkAllDuplicateUrls();
  saveState();
}

// The per-source "remove" (\u2715) button only makes sense once an entry has
// more than one source -- hide it on a lone source so people aren't tempted
// to remove their only URL from here instead of using "Remove" on the
// whole row.
function updateSourceRemoveButtons(entry) {
  const rows = entry.querySelectorAll('.source-row');
  rows.forEach((row) => {
    const btn = row.querySelector('.remove-source-btn');
    if (btn) btn.style.display = rows.length > 1 ? '' : 'none';
  });
}

// "+ Add another source" is rendered once per entry (there's only ever one,
// regardless of how many source rows exist), while Test is rendered once
// per source row inside .testrow -- moving the single add-source button
// into the last row's .testrow puts them in the same flex container so
// they sit on one line together (wrapping only if the combined text
// genuinely can't fit), instead of the button rendering as its own
// separate block below the whole .sources stack. Re-run after every
// add/remove of a source row, since "the last row" changes each time.
function relocateAddSourceBtn(entry) {
  const btn = entry.querySelector('.add-source-btn');
  if (!btn) return; // watchlist/channel/customlist rows don't have one
  const testrows = entry.querySelectorAll('.sources .testrow');
  const lastTestrow = testrows[testrows.length - 1];
  if (!lastTestrow) return;
  const testresult = lastTestrow.querySelector('.testresult');
  if (testresult) lastTestrow.insertBefore(btn, testresult);
  else lastTestrow.appendChild(btn);
}

// Warns (doesn't block) when the same URL has been pasted into more than
// one source field anywhere in the builder -- catches an accidental double
// add, whether within one merged entry or across two separate rows.
function checkDuplicateUrl(input) {
  const val = input.value.trim();
  const row = input.closest('.source-row');
  const warn = row ? row.querySelector('.dup-warning') : null;
  if (!warn) return;
  if (!val || val === 'mdblist:watchlist') { warn.style.display = 'none'; return; }
  const all = [...document.querySelectorAll('#lists .url')];
  const dupCount = all.filter((el) => el.value.trim() === val).length;
  warn.style.display = dupCount > 1 ? '' : 'none';
}

function checkAllDuplicateUrls() {
  document.querySelectorAll('#lists .url').forEach((el) => checkDuplicateUrl(el));
}

function editEntryCustomList(btn) {
  const row = btn.closest('.entry');
  if (!row) return;
  const urlInput = row.querySelector('.sources .url');
  if (urlInput) {
    if (typeof editCustomList === 'function') {
      editCustomList(urlInput); // editCustomList in 21_client-custom-list-builder.js uses btn.closest('.source-row'), so we pass an element inside .source-row
    }
  }
}

function editEntryChannel(btn) {
  const row = btn.closest('.entry');
  if (!row) return;
  const urlInput = row.querySelector('.sources .url');
  if (urlInput) {
    if (typeof editChannel === 'function') {
      editChannel(urlInput); // editChannel in 20_client-channel-builder.js uses btn.closest('.source-row')
    }
  }
}


// --- "Your MDBList/Trakt Lists" ----------------------------------------------
//
// Once a key (and, for Trakt, a username) is entered above, shows every
// list that account actually owns -- not just the one built-in watchlist
// shortcut above. Debounced (fires a bit after typing stops, not on every
// keystroke) since it's a real network call.
let myMdblistListsTimer = null;
function scheduleMyMdblistListsRefresh() {
  clearTimeout(myMdblistListsTimer);
  myMdblistListsTimer = setTimeout(runMyMdblistLists, 600);
}

let myTraktListsTimer = null;
function scheduleMyTraktListsRefresh() {
  clearTimeout(myTraktListsTimer);
  myTraktListsTimer = setTimeout(runMyTraktLists, 600);
}

async function runMyMdblistLists() {
  const box = document.getElementById('myMdblistListsResult');
  const key = document.getElementById('mdblistKeyInput').value.trim();
  if (!key) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your MDBList lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/mdblist-my-lists?apikey=' + encodeURIComponent(key), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your MDBList lists.') + '</p>';
      return;
    }
    renderMyMdblistLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your MDBList lists.</p>';
  }
}

function renderMyMdblistLists(lists) {
  const box = document.getElementById('myMdblistListsResult');
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const watchlistAddedMovie = alreadyAdded.has('mdblist:watchlist|movie');
  const watchlistAddedSeries = alreadyAdded.has('mdblist:watchlist|series');
  const watchlistCard = '<div class="list-card" data-list-type="mixed">' +
    '<div class="list-card-header">' +
      '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">My Watchlist</div>' +
        '<div class="list-card-meta">' +
          '<span>Official MDBList Watchlist</span>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
        '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="My Watchlist" data-url="mdblist:watchlist" data-type="unknown">Copy</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (watchlistAddedMovie ? 'disabled' : '') + ' data-name="My Watchlist" data-url="mdblist:watchlist" data-type="movie">' + (watchlistAddedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (watchlistAddedSeries ? 'disabled' : '') + ' data-name="My Watchlist" data-url="mdblist:watchlist" data-type="series">' + (watchlistAddedSeries ? '&#10003;' : '+ Shows') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="list-card-posters poster-preview-slot" data-url="mdblist:watchlist" data-type="movie"></div>' +
  '</div>';

  if (!lists || !lists.length) {
    box.innerHTML = watchlistCard + '<p style="margin-top:6px; color:var(--muted);"><small>No other custom lists found on this account.</small></p>';
    if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
    return;
  }

  const cardsHtml = lists.map((l) => {
    const isSingleType = (l.mediatype === 'movie' || l.mediatype === 'show');
    const type = l.mediatype === 'show' ? 'series' : 'movie';
    const typeLabel = l.mediatype === 'show' ? 'Shows' : (l.mediatype === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + (isSingleType ? type : 'unknown') + '">Copy</button>';
    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }
    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = watchlistCard + cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myMdblistListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
  }
});

async function runMyTraktLists() {
  const box = document.getElementById('myTraktListsResult');
  const username = document.getElementById('traktUsernameInput').value.trim();
  const traktKey = document.getElementById('traktKeyInput').value.trim();
  if (!username) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your Trakt lists\u2026</small></p>';
  try {
    const params = 'username=' + encodeURIComponent(username) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : '');
    const res = await fetch(ORIGIN + '/api/trakt-my-lists?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Trakt lists.') + '</p>';
      return;
    }
    renderMyTraktLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Trakt lists.</p>';
  }
}

function renderMyTraktLists(lists) {
  const box = document.getElementById('myTraktListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No public lists found for that Trakt username.</small></p>';
    return;
  }
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.map((l) => {
    const isSingleType = (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + (isSingleType ? type : 'unknown') + '">Copy</button>';
    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }
    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
  }
});

// --- Trakt OAuth (private lists) -----------------------------------------
//
// A full-page redirect (not a popup) -- Trakt's own login page doesn't
// need any special embedding, and a popup would need postMessage plumbing
// back to this window for no real benefit. /api/trakt/oauth/callback
// redirects back here with the resulting token in the URL fragment; see
// pickUpTraktTokenFromUrl below, called once from this page's own init.
function startTraktConnect() {
  window.location.href = ORIGIN + '/api/trakt/oauth/start';
}

function disconnectTrakt() {
  traktAccessToken = '';
  saveState();
  renderTraktConnectStatus();
}

function renderTraktConnectStatus() {
  const statusEl = document.getElementById('traktConnectStatus');
  const connectBtn = document.getElementById('traktConnectBtn');
  const disconnectBtn = document.getElementById('traktDisconnectBtn');
  const listsBtn = document.getElementById('listsTraktConnectBtn');
  const connected = !!traktAccessToken;
  
  if (listsBtn) {
    listsBtn.innerText = connected ? 'Disconnect' : 'Connect Trakt';
  }
  
  if (statusEl) {
    statusEl.innerHTML = connected
      ? '<small style="color:#7ce7b6;">Connected to Trakt.</small>'
      : '<small style="color:var(--muted);">Not connected.</small>';
  }
  if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  const box = document.getElementById('myPrivateTraktListsResult');
  if (connected) {
    scheduleMyPrivateTraktListsRefresh();
  } else if (box) {
    box.innerHTML = '';
  }
}

// Reads the token handed back in the URL fragment right after
// /api/trakt/oauth/callback redirects here (#trakt_token=...) -- a
// fragment, not a query param, since fragments never reach any server on
// subsequent requests. Also surfaces a plain message for ?trakt_error=...,
// the callback's own failure path. Either way, strips whatever it found
// from the address bar immediately so a page refresh or a copied/shared
// URL never carries it forward.
function pickUpTraktTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])trakt_token=([^&]+)/.exec(hash);
  if (match) {
    traktAccessToken = decodeURIComponent(match[1]);
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    alert('Connected to Trakt.');
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('trakt_error');
  if (err) {
    const detail = params.get('trakt_error_detail') || '';
    const messages = {
      no_client_id: 'Trakt OAuth Client ID is not configured on this server.',
      no_code: 'Trakt did not return an authorization code.',
      token_exchange_failed: 'Failed to exchange authorization code for a Trakt token.',
      access_denied: 'Trakt sign-in was cancelled.',
    };
    alert(messages[err] || ('Could not connect to Trakt (' + err + (detail ? ': ' + detail : '') + ').'));
    params.delete('trakt_error');
    params.delete('trakt_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

let myPrivateTraktListsTimer = null;
function scheduleMyPrivateTraktListsRefresh() {
  clearTimeout(myPrivateTraktListsTimer);
  myPrivateTraktListsTimer = setTimeout(runMyPrivateTraktLists, 200);
}

async function runMyPrivateTraktLists() {
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!box) return;
  if (!traktAccessToken) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your Trakt lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/trakt-my-private-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: traktAccessToken }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Trakt lists.') + '</p>';
      return;
    }
    renderMyPrivateTraktLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Trakt lists.</p>';
  }
}

// Every row here -- public or private -- becomes a perfectly normal
// trakt.tv list URL once added (see collectEntries/fetchTrakt): the
// connected access token travels with every Trakt fetch this config makes
// from here on (see the dispatch in fetchCatalog), not just ones added
// from this specific panel, so a private list keeps resolving correctly
// wherever it's referenced.
function renderMyPrivateTraktLists(lists) {
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No lists found on your Trakt account.</small></p>';
    return;
  }
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.map((l) => {
    const isHistory = l.url === 'trakt:history';
    const isSingleType = (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="shows">Copy (Shows)</button>' +
        '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="episodes">Copy (Episodes)</button>'
      : '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '">Copy</button>';

    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + (l.private ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myPrivateTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myPrivateListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myPrivateListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn, copyBtn.dataset.historyMode);
  }
});

// Pulls every item from a list URL (paginated via /api/preview, the same
// Fetches every item for one list+type via /api/preview (paginated, same
// mechanism Live Preview's "See All" uses), mapped into the shape a
// Custom List's items expect.
function toggleListsTraktConnection() {
  if (traktAccessToken) {
    disconnectTrakt();
  } else {
    startTraktConnect();
  }
}

async function fetchAllItemsForList(listUrl, type, btn, progressLabel) {
  const keys = collectKeys();
  const items = [];
  let skip = 0;
  let pagesLoaded = 0;
  const MAX_PAGES = 250; // safety cap (~25,000 items) -- generous headroom above the
  // 6000-item-per-list cap below so a big Watch History copy can still split across
  // several numbered lists instead of silently truncating (see copyListToCustomList)
  while (pagesLoaded < MAX_PAGES) {
    const body = { url: listUrl, type: type, skip: skip, sample: 100 };
    if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
    if (keys.traktKey) body.traktKey = keys.traktKey;
    if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
    const res = await fetch(ORIGIN + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown error');
    const pageItems = data.sample || [];
    pageItems.forEach((m) => {
      items.push({ imdbId: m.id, title: m.name, year: m.year || '', poster: m.poster || null, showTitle: m.showTitle || null });
    });
    skip += pageItems.length;
    pagesLoaded++;
    if (btn) btn.textContent = 'Copying' + (progressLabel ? ' ' + progressLabel : '') + '\u2026 (' + items.length + ' so far)';
    if (!data.maybeMore || pageItems.length === 0) break;
  }
  return items;
}

// Saves a fresh Custom List directly -- to the account if signed in
// (mirroring confirmSaveAsCreator's /api/creator/lists/save call, Public
// by default same as that picker's own default), to this browser's local
// store otherwise (mirroring saveLocalCustomList). Unlike either of those,
// there's no existing row/draft involved here at all -- this always
// creates a brand new saved list, never edits one in place.
async function saveItemsAsNewCustomList(name, type, items, visibility) {
  visibility = visibility === 'private' ? 'private' : 'public';
  if (activeCreator) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: type,
          items: items,
          visibility: visibility,
        }),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error || 'unknown error' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'network error' };
    }
  }
  const map = loadLocalCustomLists();
  const base = slugify(name) || 'list';
  let slug = base;
  let n = 2;
  while (map[slug]) {
    slug = base + '-' + n;
    n++;
  }
  const now = Date.now();
  map[slug] = { slug: slug, name: name, type: type, items: items, visibility: visibility, createdAt: now, updatedAt: now };
  const persisted = saveLocalCustomListsMap(map);
  if (!persisted) {
    return { ok: false, error: 'localStorage save failed (likely full \u2014 try clearing out some old Custom Lists, or importing fewer categories at once)' };
  }
  return { ok: true };
}

// Copies a Trakt (or any) list straight into a saved Custom List -- no
// detour through the draft picker for a manual "Save as a List" click,
// since there's nothing to review here that isn't already decided (the
// whole list, as-is). Unlike the live "+ Add" button (which keeps
// re-fetching the source every time the catalog loads), this is a one-time
// snapshot: useful for a private Trakt list specifically, since the copy
// keeps working on its own even after the Trakt connection eventually
// expires, where a live row referencing that same private list would stop
// resolving once it does.
//
// A Custom List can only ever be one type (movies or shows, never mixed --
// same rule the manual picker already enforces), but a source list often
// isn't -- a Trakt watchlist especially. So an ambiguous/mixed source
// (contentType anything other than a clean 'movie' or 'series') gets
// copied as *two* separate Custom Lists instead of one, each named with a
// "(Movies)"/"(Shows)" suffix to tell them apart, silently skipping
// whichever half turns out to have nothing in it (e.g. a "mixed"-looking
// list that's actually all movies).
// Per-list item cap for Copy to Custom List -- a source bigger than this
// splits across multiple numbered lists (see copyListToCustomList) rather
// than truncating or growing one list without bound.
const CUSTOM_LIST_CHUNK_SIZE = 6000;

async function copyListToCustomList(name, listUrl, contentType, btn, historyMode) {
  const typesToCopy = contentType === 'movie' || contentType === 'series' ? [contentType] : ['movie', 'series'];
  const isSplit = typesToCopy.length > 1;
  // Restored on the way out below -- this is called from several different
  // buttons (search results, My Lists, and the Custom List panel's own
  // "Import from link"), each with its own resting label, so hardcoding one
  // back would leave the others mislabeled after their first use.
  const originalLabel = btn ? btn.textContent : '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Copying\u2026';
  }

  const created = [];
  const failed = [];
  for (const type of typesToCopy) {
    const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
    let items;
    try {
      items = await fetchAllItemsForList(listUrl, type, btn, isSplit ? typeLabel : '');
    } catch (e) {
      failed.push({ name: isSplit ? name + ' (' + typeLabel + ')' : name, error: e.message || 'network error' });
      continue;
    }
    if (!items.length) continue; // e.g. a "mixed" list that turns out to be all one type -- skip the empty half quietly
    // Watch History's per-episode rows all carry the same show id with a
    // "Show S1E5 \u2014 Title" name (see mapTraktHistoryItems) -- Shows mode
    // collapses that down to one tile per show (first occurrence wins,
    // since history comes back most-recently-watched first) using the
    // plain showTitle field carried alongside each item for exactly this.
    // Only ever applies to type 'series' items that actually have one;
    // everything else (movies, any other list) passes through untouched.
    if (historyMode === 'shows' && type === 'series') {
      const seen = new Map();
      items.forEach((it) => {
        if (!seen.has(it.imdbId)) {
          seen.set(it.imdbId, { imdbId: it.imdbId, title: it.showTitle || it.title, year: it.year, poster: it.poster });
        }
      });
      items = Array.from(seen.values());
    }
    // showTitle was only ever needed for the dedupe step above -- strip it
    // before saving so a Custom List's items stay the same shape they've
    // always been.
    items = items.map((it) => ({ imdbId: it.imdbId, title: it.title, year: it.year, poster: it.poster }));
    const baseListName = isSplit ? name + ' (' + typeLabel + ')' : name;
    // A single Custom List is capped at CUSTOM_LIST_CHUNK_SIZE items. A
    // source bigger than that (mainly a large Watch History copy, since
    // that source is the raw undeduped episode-watch feed -- see
    // fetchTraktHistory) gets split across multiple numbered lists
    // ("Name", "Name 2", "Name 3"...) instead of the old flat 2000-item
    // cap, which silently truncated mid-history with no way to get the rest.
    for (let i = 0; i * CUSTOM_LIST_CHUNK_SIZE < items.length; i++) {
      const chunk = items.slice(i * CUSTOM_LIST_CHUNK_SIZE, (i + 1) * CUSTOM_LIST_CHUNK_SIZE);
      const listName = i === 0 ? baseListName : baseListName + ' ' + (i + 1);
      const result = await saveItemsAsNewCustomList(listName, type, chunk, 'private');
      if (result.ok) {
        created.push({ name: listName, count: chunk.length });
      } else {
        failed.push({ name: listName, error: result.error });
      }
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }

  if (!created.length && !failed.length) {
    alert('That list has no items to copy.');
    return;
  }
  if (created.length) renderCreatorDashboard();

  let msg = '';
  if (created.length) {
    msg += 'Created ' + created.map((c) => '"' + c.name + '" (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')').join(' and ') +
      ' in your Custom Lists \u2014 find them under the Custom Lists tab to add them to your lists.';
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not copy: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  alert(msg);
}

// --- Import from Trakt export --------------------------------------------
//
// Trakt VIP's own export (Settings > Data > Export on trakt.tv) is a .zip
// of the account's data as JSON, one file (or numbered file series) per
// category -- and every category turns out to be exactly the shape
// Trakt's own REST API already returns (see mapTraktItems /
// mapTraktHistoryItems), just dumped straight to disk rather than a
// custom export schema. Parsed entirely client-side with fflate (loaded
// in <head>) -- the zip never reaches this Worker, matching the rest of
// this add-on's local-first approach to personal data.
let traktExportZipEntries = null; // { filename: Uint8Array }, set once a zip is picked

const TRAKT_EXPORT_CATEGORIES = [
  // These patterns need DOUBLED backslashes in source (\\d, \\.) even
  // though a real regex only wants a single backslash-d / backslash-dot --
  // this whole block sits inside renderBuilder()'s giant outer template
  // literal, so the outer literal's own escape parsing runs over this
  // text once already (at Worker-render time) before it ever reaches the
  // browser. A single backslash-d isn't a recognized JS string escape, so
  // that pass silently drops the backslash and leaves a bare "d" -- which
  // is exactly what shipped here originally and is why History (and half
  // of Watched) never matched any files despite the filenames being right
  // there. Same root cause as this codebase's documented newline-escaping
  // trap, just hitting a regex instead of a literal newline. Verified
  // post-render this time (extracted the actual rendered client script
  // and confirmed the backslashes survive), not just eyeballed.
  { key: 'history', label: 'Watch History', filePattern: /^watched-history-\\d+\\.json$/ },
  { key: 'watched', label: 'Watched (all-time list)', filePattern: /^watched-(movies-\\d+|shows(-\\d+)?)\\.json$/ },
  { key: 'watchlist', label: 'Watchlist', filePattern: /^lists-watchlist\\.json$/ },
  { key: 'ratings', label: 'Ratings', filePattern: /^ratings-(movies|shows)\\.json$/ },
];

// Returns { items, matchedFiles, errors } rather than just an item array --
// if a category's files exist in the zip but come back with zero items,
// this lets the caller tell "nothing in the export" apart from "found the
// files but couldn't parse them", and surface the real reason instead of
// just silently omitting the category (which is what happened before this
// -- see the debugging note below).
function readTraktExportJsonFiles(pattern) {
  const items = [];
  const errors = [];
  let matchedFiles = 0;
  for (const filename in traktExportZipEntries) {
    // Match on the basename only, not the full zip path -- Trakt's export
    // structure isn't guaranteed stable release to release (this add-on
    // has already seen it both flat and, apparently, occasionally folder-
    // nested), and matching the full path against an anchored pattern
    // would silently miss every file if a folder prefix shows up, with no
    // visible error at all since a 0-match category isn't treated as a
    // failure below.
    const basename = filename.split('/').pop() || filename;
    if (!pattern.test(basename)) continue;
    matchedFiles++;
    try {
      const text = fflate.strFromU8(traktExportZipEntries[filename]);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items.push.apply(items, parsed);
    } catch (e) {
      errors.push(filename + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { items: items, matchedFiles: matchedFiles, errors: errors };
}

document.getElementById('traktExportFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  const box = document.getElementById('traktExportImportResult');
  if (!file || !box) return;
  box.innerHTML = '<p style="margin-top:10px;"><small>Reading zip\u2026</small></p>';
  try {
    if (typeof fflate === 'undefined') {
      throw new Error('the zip-reading library (fflate, loaded from a CDN) never loaded \u2014 check your network connection or an ad/script blocker, then reload the page and try again');
    }
    const buf = await file.arrayBuffer();
    traktExportZipEntries = fflate.unzipSync(new Uint8Array(buf));
    // Debug aid: if a category still doesn't show up as a checkbox below,
    // open devtools and check this list against TRAKT_EXPORT_CATEGORIES'
    // patterns above -- Trakt's export layout isn't guaranteed stable.
    console.log('Trakt export zip contains:', Object.keys(traktExportZipEntries));
  } catch (err) {
    box.innerHTML = '<p class="testresult err">\u2717 Could not read that zip: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    return;
  }
  const diagnostics = [];
  const rowsHtml = TRAKT_EXPORT_CATEGORIES.map((cat) => {
    const result = readTraktExportJsonFiles(cat.filePattern);
    if (!result.matchedFiles) return ''; // this category's file(s) just aren't in this zip -- not an error
    if (!result.items.length) {
      // Files matched the expected name pattern but every one of them
      // failed to parse -- surface exactly why instead of quietly
      // dropping the category (this is the case James hit: the checkbox
      // for a whole category just never appeared, with no explanation).
      diagnostics.push(cat.label + ': found ' + result.matchedFiles + ' file(s) but couldn\u2019t read any of them \u2014 ' + result.errors.slice(0, 2).join('; '));
      return '';
    }
    // History is the one category with episode-level rows (see
    // mapTraktExportEntry) -- give it a Shows/Episodes choice right under
    // its checkbox, same idea as the Copy to Custom List toggle for the
    // live version of this same source. Every other category is already
    // whole-title data, no such choice to make.
    const historyToggle = cat.key === 'history'
      ? '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="radio" name="traktExportHistoryMode" value="shows" checked> Shows only</label>' +
        ' &nbsp; <label><input type="radio" name="traktExportHistoryMode" value="episodes"> Individual episodes</label>' +
        '</small></div>' +
        // Deliberately independent of the Shows/Episodes radio above --
        // that radio only controls how the *Custom List* folds rows for
        // display; Watch History always needs the real per-episode
        // identifiers regardless, which mapTraktExportEntryToWatchHistoryItem
        // reads straight off each raw row.
        '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="checkbox" id="traktExportMarkWatchedCheck" checked> Also add these to Watch History &amp; Continue Watching (marks them watched)</label>' +
        '</small></div>'
      : '';
    return '<div class="row searchresult-row" style="flex-direction:column; align-items:flex-start;">' +
      '<div><label><input type="checkbox" class="traktExportCatCheck" value="' + cat.key + '" checked> <strong>' + cat.label + '</strong> \u2014 ' + result.items.length + ' entries</label></div>' +
      historyToggle +
      '</div>';
  }).join('');
  const diagnosticsHtml = diagnostics.length
    ? '<p class="testresult err">\u2717 ' + diagnostics.map(escapeHtml).join('<br>') + '</p>'
    : '';
  if (!rowsHtml) {
    box.innerHTML = diagnosticsHtml || '<p class="testresult err">\u2717 Didn\u2019t recognize any Trakt export files in that zip.</p>';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Found these categories \u2014 pick which to import (each becomes its own Custom List, split into Movies/Shows automatically, deduped so a rewatched title only appears once):</small></p>' +
    rowsHtml + diagnosticsHtml +
    '<div class="actions" style="flex-direction:row; width:auto; margin-top:8px;">' +
    '<button type="button" class="secondary" id="traktExportImportBtn">Import selected</button>' +
    '</div>';
  const importBtn = document.getElementById('traktExportImportBtn');
  if (importBtn) importBtn.addEventListener('click', runTraktExportImport);
});

// Maps one raw exported row (a history/watchlist/ratings entry) to the
// {imdbId, title, year, type} shape needed before it becomes a Custom
// List item. History's episode rows default to folding up to their parent
// show (a Custom List is normally a flat title picker with no per-episode
// concept), but historyMode === 'episodes' (from the radio under the
// History checkbox) keeps each one as its own "Show S1E5 \u2014 Title" row
// instead, same style mapTraktHistoryItems already uses for the live
// version of this source -- carrying a dedupeKey scoped to the exact
// episode rather than just the show, so a rewatched episode still
// collapses to one row but distinct episodes of the same show don't.
function mapTraktExportEntry(it, category, historyMode) {
  if (category === 'history' && it.type === 'episode' && it.show && it.show.ids && it.show.ids.imdb) {
    if (historyMode === 'episodes') {
      const s = it.episode.season;
      const e = it.episode.number;
      const epTitle = it.episode.title ? ' \u2014 ' + it.episode.title : '';
      return {
        imdbId: it.show.ids.imdb,
        title: it.show.title + ' S' + s + 'E' + e + epTitle,
        year: it.show.year || '',
        type: 'series',
        dedupeKey: it.show.ids.imdb + ':' + s + ':' + e,
      };
    }
    return { imdbId: it.show.ids.imdb, title: it.show.title, year: it.show.year || '', type: 'series' };
  }
  const obj = it.movie || it.show || null;
  if (!obj || !obj.ids || !obj.ids.imdb) return null;
  return { imdbId: obj.ids.imdb, title: obj.title, year: obj.year || '', type: it.movie ? 'movie' : 'series' };
}

// Maps one raw History row to the shape addItemsToWatchHistory expects --
// used by the "Also add these to Watch History" checkbox. An episode row
// needs a real TMDB episode id (the same id space Watch History uses
// everywhere else in this add-on, e.g. toggleWatchStatus/markSeasonWatched)
// to key on; Trakt's own export includes one at it.episode.ids.tmdb, so a
// row missing that (older export format, or an episode TMDB has since
// delisted) is skipped rather than guessed at with a Trakt-specific id
// that nothing else in this app would recognize.
function mapTraktExportEntryToWatchHistoryItem(it) {
  if (it.type === 'episode' && it.show && it.show.ids && it.show.ids.imdb && it.episode) {
    const epId = it.episode.ids && it.episode.ids.tmdb ? String(it.episode.ids.tmdb) : null;
    if (!epId) return null;
    const showPoster = 'https://images.metahub.space/poster/medium/' + it.show.ids.imdb + '/img';
    return {
      id: epId,
      type: 'episode',
      name: it.episode.title || '',
      // Trakt's export carries no per-episode still image -- fall back to
      // the show poster (see this function's own comment above).
      poster: showPoster,
      showId: it.show.ids.imdb,
      showTitle: it.show.title || '',
      showPoster: showPoster,
      seasonNum: it.episode.season,
      episodeNum: it.episode.number,
    };
  }
  const obj = it.movie;
  if (!obj || !obj.ids || !obj.ids.imdb) return null;
  return {
    id: obj.ids.imdb,
    type: 'movie',
    name: obj.title || '',
    poster: 'https://images.metahub.space/poster/medium/' + obj.ids.imdb + '/img',
  };
}

async function runTraktExportImport() {
  const btn = document.getElementById('traktExportImportBtn');
  const catChecked = new Set(Array.from(document.querySelectorAll('.traktExportCatCheck:checked')).map((c) => c.value));
  const historyModeEl = document.querySelector('input[name="traktExportHistoryMode"]:checked');
  const historyMode = historyModeEl ? historyModeEl.value : 'shows';
  const markWatchedEl = document.getElementById('traktExportMarkWatchedCheck');
  const markWatched = !!(markWatchedEl && markWatchedEl.checked);
  // A category is worth processing here if either its own "create a
  // Custom List" checkbox is on, or (History only) "mark as watched" is on
  // -- these are independent choices, not one gating the other, so
  // someone can mark History as watched without also wanting a redundant
  // "Trakt Watch History" Custom List cluttering their Custom Lists tab.
  const relevantCats = TRAKT_EXPORT_CATEGORIES.filter((cat) => catChecked.has(cat.key) || (cat.key === 'history' && markWatched));
  if (!relevantCats.length) { alert('Pick at least one category first.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Importing\u2026'; }

  const created = [];
  const failed = [];
  let watchedAdded = 0;
  let cwSucceeded = 0;
  let cwTotal = 0;
  for (const cat of relevantCats) {
    const catKey = cat.key;
    const rawItems = readTraktExportJsonFiles(cat.filePattern).items;

    if (catChecked.has(catKey)) {
      const byType = { movie: new Map(), series: new Map() };
      rawItems.forEach((it) => {
        const mapped = mapTraktExportEntry(it, cat.key, historyMode);
        if (!mapped) return;
        // Dedupe within each type -- unlike the live "Watch History" catalog
        // row (which deliberately keeps every rewatch as its own tile), a
        // Custom List is a browsable collection, not a rewatch log. Shows
        // mode dedupes by show id (a title watched several times only
        // appears once); Episodes mode dedupes by the finer-grained
        // dedupeKey mapTraktExportEntry attaches instead, so distinct
        // episodes of the same show still both appear.
        byType[mapped.type].set(mapped.dedupeKey || mapped.imdbId, mapped);
      });
      for (const type of ['movie', 'series']) {
        const items = Array.from(byType[type].values()).map((m) => ({
          imdbId: m.imdbId,
          title: m.title,
          year: m.year,
          // The export carries no poster art of its own -- same metahub
          // fallback mapTraktItems already uses for every other Trakt source.
          poster: 'https://images.metahub.space/poster/medium/' + m.imdbId + '/img',
        }));
        if (!items.length) continue;
        const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
        const listName = 'Trakt ' + cat.label + ' (' + typeLabel + ')';
        // Debug aid: if a list still silently doesn't appear after this,
        // devtools console will show exactly which save call failed and why.
        console.log('Trakt export import: saving', listName, '-', items.length, 'items\u2026');
        const result = await saveItemsAsNewCustomList(listName, type, items, 'private');
        console.log('Trakt export import: result for', listName, '->', result);
        if (result.ok) {
          created.push({ name: listName, count: items.length });
        } else {
          failed.push({ name: listName, error: result.error });
        }
      }
    }

    if (catKey === 'history' && markWatched) {
      const whItems = [];
      const seenIds = new Set();
      rawItems.forEach((it) => {
        const mapped = mapTraktExportEntryToWatchHistoryItem(it);
        if (!mapped || seenIds.has(mapped.id)) return; // a rewatch logs one row per play -- Watch History only needs one entry per item
        seenIds.add(mapped.id);
        whItems.push(mapped);
      });
      if (whItems.length && typeof addItemsToWatchHistory === 'function') {
        if (btn) btn.textContent = 'Checking Continue Watching for ' + new Set(whItems.filter((it) => it.showId).map((it) => it.showId)).size + ' show(s)\u2026';
        const whResult = await addItemsToWatchHistory(whItems);
        watchedAdded += whResult.added;
        cwSucceeded += whResult.cwSucceeded || 0;
        cwTotal += whResult.cwTotal || 0;
      }
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Import selected'; }
  if (created.length) renderCreatorDashboard();

  let msg = '';
  if (created.length) {
    msg += 'Created ' + created.map((c) => '"' + c.name + '" (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')').join(', ') +
      ' in your Custom Lists \u2014 find them under the Custom Lists tab to add them to your lists.';
  }
  if (watchedAdded) {
    msg += (msg ? '\\n\\n' : '') + 'Marked ' + watchedAdded + ' item' + (watchedAdded === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
    if (cwTotal) {
      msg += ' Continue Watching checked for ' + cwSucceeded + ' of ' + cwTotal + ' show' + (cwTotal === 1 ? '' : 's') +
        (cwSucceeded < cwTotal ? ' \u2014 the rest hit a network hiccup or TMDB rate limit; reopening one of those shows will retry it, or just run this import again.' : '.');
    }
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not create: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  if (!msg) msg = 'Nothing to import in the selected categories.';
  alert(msg);
}

// Turns a pasted list URL's last path segment into a readable starter name
// (e.g. .../lists/user/best-of-2026 -> "Best Of 2026") -- just a starting
// point, the person can rename the row afterward like any other.
// --- Import from Letterboxd export --------------------------------------------

let letterboxdExportZipEntries = null;

const LETTERBOXD_EXPORT_CATEGORIES = [
  { key: 'watched', label: 'Watched (all-time list)', filePattern: /^watched\.csv$/ },
  { key: 'watchlist', label: 'Watchlist', filePattern: /^watchlist\.csv$/ },
  { key: 'ratings', label: 'Ratings', filePattern: /^ratings\.csv$/ },
  { key: 'diary', label: 'Diary', filePattern: /^diary\.csv$/ },
];

function parseLetterboxdCsv(csvText) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let val = '';
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const nextC = csvText[i + 1];
    if (!inQuotes && c === ',') {
      row.push(val);
      val = '';
    } else if (c === '"' && inQuotes && nextC === '"') {
      val += '"';
      i++; // skip next quote
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (c === '\\n' || c === '\\r')) {
      if (c === '\\r' && nextC === '\\n') i++;
      row.push(val);
      if (row.length > 0 || val) lines.push(row);
      row = [];
      val = '';
    } else {
      val += c;
    }
  }
  if (val || row.length > 0) {
    row.push(val);
    lines.push(row);
  }
  return lines;
}

function readLetterboxdExportCsvFiles(pattern) {
  const items = [];
  const errors = [];
  let matchedFiles = 0;
  for (const filename in letterboxdExportZipEntries) {
    const basename = filename.split('/').pop() || filename;
    if (!pattern.test(basename)) continue;
    matchedFiles++;
    try {
      const text = fflate.strFromU8(letterboxdExportZipEntries[filename]);
      const csv = parseLetterboxdCsv(text);
      if (csv.length > 1) {
        const header = csv[0].map(h => h.trim());
        const nameIdx = header.indexOf('Name');
        const yearIdx = header.indexOf('Year');
        const uriIdx = header.indexOf('Letterboxd URI');
        
        if (nameIdx === -1 || yearIdx === -1) {
          throw new Error('CSV missing Name or Year column');
        }
        
        for (let i = 1; i < csv.length; i++) {
          const row = csv[i];
          if (row.length <= Math.max(nameIdx, yearIdx)) continue;
          items.push({
            title: row[nameIdx],
            year: row[yearIdx],
            uri: uriIdx !== -1 ? row[uriIdx] : '',
          });
        }
      }
    } catch (e) {
      errors.push(filename + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { items: items, matchedFiles: matchedFiles, errors: errors };
}

document.getElementById('letterboxdExportFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  const box = document.getElementById('letterboxdExportImportResult');
  if (!file || !box) return;
  box.innerHTML = '<p style="margin-top:10px;"><small>Reading zip\u2026</small></p>';
  try {
    if (typeof fflate === 'undefined') {
      throw new Error('the zip-reading library (fflate) never loaded \u2014 check your network connection or an ad/script blocker, then reload the page and try again');
    }
    const buf = await file.arrayBuffer();
    letterboxdExportZipEntries = fflate.unzipSync(new Uint8Array(buf));
    console.log('Letterboxd export zip contains:', Object.keys(letterboxdExportZipEntries));
  } catch (err) {
    box.innerHTML = '<p class="testresult err">\u2717 Could not read that zip: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    return;
  }
  
  const diagnostics = [];
  const rowsHtml = LETTERBOXD_EXPORT_CATEGORIES.map((cat) => {
    const result = readLetterboxdExportCsvFiles(cat.filePattern);
    if (!result.matchedFiles) return '';
    if (!result.items.length) {
      diagnostics.push(cat.label + ': found ' + result.matchedFiles + ' file(s) but couldn\u2019t read any entries \u2014 ' + result.errors.slice(0, 2).join('; '));
      return '';
    }
    // "Watched" and "Diary" are the two categories that represent movies
    // the person has actually seen (Watchlist is explicitly the opposite,
    // and Ratings alone doesn't reliably imply a watch date/event) -- only
    // those two get the option to also mark them watched in this add-on.
    const markWatchedToggle = (cat.key === 'watched' || cat.key === 'diary')
      ? '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="checkbox" class="letterboxdExportMarkWatchedCheck" value="' + cat.key + '" checked> Also add these to Watch History (marks them watched)</label>' +
        '</small></div>'
      : '';
    return '<div class="row searchresult-row" style="flex-direction:column; align-items:flex-start;">' +
      '<div><label><input type="checkbox" class="letterboxdExportCatCheck" value="' + cat.key + '" checked> <strong>' + cat.label + '</strong> \u2014 ' + result.items.length + ' entries</label></div>' +
      markWatchedToggle +
      '</div>';
  }).join('');
  
  const diagnosticsHtml = diagnostics.length
    ? '<p class="testresult err">\u2717 ' + diagnostics.map(escapeHtml).join('<br>') + '</p>'
    : '';
  if (!rowsHtml) {
    box.innerHTML = diagnosticsHtml || '<p class="testresult err">\u2717 Didn\u2019t recognize any Letterboxd export files in that zip.</p>';
    return;
  }
  box.innerHTML = diagnosticsHtml +
    '<div class="catalog-list" style="margin-top:8px;">' + rowsHtml + '</div>' +
    '<div style="margin-top:12px;"><button type="button" class="primary" id="letterboxdExportImportBtn" onclick="runLetterboxdExportImport()">Resolve and Import</button></div>' +
    '<p style="margin-top:8px; font-size:0.85rem; color:var(--muted);" id="letterboxdImportProgress"></p>';
});

window.runLetterboxdExportImport = async function() {
  const btn = document.getElementById('letterboxdExportImportBtn');
  const progressLine = document.getElementById('letterboxdImportProgress');
  const catChecked = new Set(Array.from(document.querySelectorAll('.letterboxdExportCatCheck:checked')).map((c) => c.value));
  const markWatchedChecked = new Set(Array.from(document.querySelectorAll('.letterboxdExportMarkWatchedCheck:checked')).map((c) => c.value));
  // Same independence as the Trakt Export importer -- a category matters
  // here if either its own "create a Custom List" checkbox is on, or its
  // "mark as watched" checkbox is on, not only when both are.
  const relevantCats = LETTERBOXD_EXPORT_CATEGORIES.filter((cat) => catChecked.has(cat.key) || markWatchedChecked.has(cat.key));
  if (!relevantCats.length) {
    alert('Please select at least one category to import.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Importing\u2026'; }
  
  const created = [];
  const failed = [];
  let watchedAdded = 0;
  
  for (const cat of relevantCats) {
    const result = readLetterboxdExportCsvFiles(cat.filePattern);
    if (!result.items.length) continue;
    
    // Dedupe by title and year
    const byKey = new Map();
    result.items.forEach((it) => {
      const key = (it.title + '|' + it.year).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, it);
    });
    const uniqueItems = Array.from(byKey.values());
    
    if (progressLine) progressLine.textContent = 'Resolving TMDB IDs for ' + cat.label + ' (' + uniqueItems.length + ' items)...';
    
    // Bulk resolve
    const resolvedItems = [];
    try {
      const res = await fetch(ORIGIN + '/api/bulk-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: uniqueItems }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'unknown error');
      
      for (const m of data.resolved) {
        if (!m.imdbId) continue;
        resolvedItems.push({
          imdbId: m.imdbId,
          title: m.title,
          year: m.year,
          type: 'movie',
          poster: 'https://images.metahub.space/poster/medium/' + m.imdbId + '/img',
        });
      }
    } catch (err) {
      console.error('Bulk resolve error:', err);
      failed.push({ name: 'Letterboxd ' + cat.label, error: err.message || String(err) });
      continue;
    }
    
    if (!resolvedItems.length) {
      failed.push({ name: 'Letterboxd ' + cat.label, error: 'Could not resolve any items.' });
      continue;
    }

    if (catChecked.has(cat.key)) {
      const listName = 'Letterboxd ' + cat.label;
      if (progressLine) progressLine.textContent = 'Saving ' + listName + ' (' + resolvedItems.length + ' items)...';

      const saveResult = await saveItemsAsNewCustomList(listName, 'movie', resolvedItems, 'private');
      if (saveResult.ok) {
        created.push({ name: listName, count: resolvedItems.length });
      } else {
        failed.push({ name: listName, error: saveResult.error });
      }
    }

    if (markWatchedChecked.has(cat.key) && typeof addItemsToWatchHistory === 'function') {
      if (progressLine) progressLine.textContent = 'Marking ' + cat.label + ' as watched...';
      const whItems = resolvedItems.map((it) => ({ id: it.imdbId, type: 'movie', name: it.title, poster: it.poster }));
      const whResult = await addItemsToWatchHistory(whItems);
      watchedAdded += whResult.added;
    }
  }
  
  if (progressLine) progressLine.textContent = '';
  if (btn) { btn.disabled = false; btn.textContent = 'Resolve and Import'; }
  if (created.length) renderCreatorDashboard();
  
  let msg = '';
  if (created.length) {
    msg += 'Successfully created:\\n' + created.map((c) => c.name + ' (' + c.count + ' items)').join('\\n');
  }
  if (watchedAdded) {
    msg += (msg ? '\\n\\n' : '') + 'Marked ' + watchedAdded + ' item' + (watchedAdded === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not create: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  if (!msg) msg = 'Nothing to import in the selected categories.';
  alert(msg);
};
function setListSearchFilter(filter, btn) {
  if (btn) {
    document.querySelectorAll('#listSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const cards = document.querySelectorAll('#listSearchResult .list-card');
  cards.forEach(function(card) {
    const cardType = card.getAttribute('data-list-type') || 'movie';
    if (filter === 'all') {
      card.style.display = '';
    } else if (filter === 'movie') {
      card.style.display = (cardType === 'movie' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'series') {
      card.style.display = (cardType === 'series' || cardType === 'mixed') ? '' : 'none';
    } else {
      card.style.display = '';
    }
  });
}

function guessNameFromUrl(u) {
  try {
    const parts = String(u).split('/').filter(Boolean);
    let last = parts[parts.length - 1] || u;
    last = last.replace(/[-_]+/g, ' ').trim();
    if (!last) return 'List';
    return last.replace(/\\b\\w/g, (c) => c.toUpperCase());
  } catch (e) {
    return 'List';
  }
}

// Checks a pasted URL against both types via the same /api/preview endpoint
// the "Test" button uses, and picks whichever comes back with more items --
// this is how bulk-add tells Movies from Shows instead of guessing blind.
// A mixed list (rare, but TMDB v4 lists can hold both) just goes with
// whichever side has more; a list that fails on both sides (bad URL, needs
// a key, etc.) falls back to Movies same as before, so a broken link never
// blocks the rest of the paste -- the person can fix it in its row after.
async function detectListType(url, mdblistKey) {
  async function checkType(type) {
    try {
      const res = await fetch(ORIGIN + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, type: type, mdblistKey: mdblistKey || '' }),
        cache: 'no-store',
      });
      return await res.json();
    } catch (e) {
      return { ok: false };
    }
  }
  try {
    const [movieRes, seriesRes] = await Promise.all([checkType('movie'), checkType('series')]);
    const movieCount = movieRes && movieRes.ok ? movieRes.count : 0;
    const seriesCount = seriesRes && seriesRes.ok ? seriesRes.count : 0;
    return seriesCount > movieCount ? 'series' : 'movie';
  } catch (e) {
    return 'movie';
  }
}

// Bulk paste -- one list URL per line instead of adding rows one at a time.
// Each line is checked live (see detectListType) so it lands as the right
// type instead of always defaulting to Movies; blank lines are ignored.
async function bulkAddLists(btn) {
  const box = document.getElementById('bulkPasteBox');
  const lines = box.value.split('\\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    alert('Paste at least one list URL first, one per line.');
    return;
  }
  const mdblistKey = document.getElementById('mdblistKeyInput').value.trim();
  const origLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking ' + lines.length + ' list(s)…';
  }
  try {
    const types = await Promise.all(lines.map((u) => detectListType(u, mdblistKey)));
    lines.forEach((u, i) => addRow(guessNameFromUrl(u), u, types[i], true, 'Custom'));
    box.value = '';
    saveState();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

// mdblist's Popular Lists is a fixed curated set (not a live search), so we
// load it once lazily on first search and then just filter it client-side
// by name/curator on every search -- feels instant. Trakt's side is a real
// live search hitting their API each time (see runListSearch below).
let mdblistPopularCache = null;

async function ensureMdblistPopularLoaded() {
  if (mdblistPopularCache) return mdblistPopularCache;
  try {
    const res = await fetch(ORIGIN + '/api/toplists');
    const data = await res.json();
    mdblistPopularCache = data.ok ? data.lists.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)) : [];
  } catch (e) {
    mdblistPopularCache = [];
  }
  return mdblistPopularCache;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

async function runListSearch() {
  const q = document.getElementById('listSearchInput').value.trim();
  const box = document.getElementById('listSearchResult');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';

  const qLower = q.toLowerCase();
  const traktKey = document.getElementById('traktKeyInput').value.trim();
  const [mdblistAll, traktResult, myListsResult] = await Promise.all([
    ensureMdblistPopularLoaded(),
    fetch(ORIGIN + '/api/trakt-search?q=' + encodeURIComponent(q) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : ''), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({ ok: false, error: 'Network error searching trakt.tv.' })),
    fetch(ORIGIN + '/api/search-published-lists?q=' + encodeURIComponent(q), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({ ok: false, lists: [] })),
  ]);

  const mdblistMatches = mdblistAll
    .filter((l) => l.name.toLowerCase().includes(qLower) || l.user.toLowerCase().includes(qLower))
    .slice(0, 30);
  const traktMatches = traktResult.ok ? traktResult.lists.slice(0, 30) : [];
  const myListsMatches = myListsResult.ok ? myListsResult.lists : [];

  renderListSearchResults(mdblistMatches, traktMatches, traktResult.ok ? null : traktResult.error, myListsMatches);
}

function renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches) {
  const box = document.getElementById('listSearchResult');
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach((entry) => {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach((el) => {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const combinedCards = [];

  // Build one .list-card per mdblist result
  mdblistMatches.forEach((l) => {
    const added = alreadyAdded.has(l.url + '|' + l.type);
    const alreadyLikedExt = getLikedListsSet().has(l.url);
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>&#9829; ' + l.likes + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? '&#10003; Added' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  // Build one .list-card per Trakt result
  traktMatches.forEach((l) => {
    const addedMovie = alreadyAdded.has(l.url + '|movie');
    const addedSeries = alreadyAdded.has(l.url + '|series');
    const viewType = (l.contentType === 'movie' || l.contentType === 'series') ? l.contentType : 'movie';
    const alreadyLikedExt = getLikedListsSet().has(l.url);
    // Determine the card's data-list-type for chip filtering
    const cardType = (l.contentType === 'movie' || l.contentType === 'series') ? l.contentType : 'mixed';

    let addBtns;
    if (l.contentType === 'movie' || l.contentType === 'series') {
      const added = l.contentType === 'movie' ? addedMovie : addedSeries;
      addBtns = '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.contentType + '">' +
        (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      addBtns =
        '<button type="button" class="lc-btn primary searchAddBtn" ' + (addedMovie ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' +
        (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary searchAddBtn" ' + (addedSeries ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' +
        (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }

    const cardHtml = '<div class="list-card" data-list-type="' + cardType + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>&#9829; ' + l.likes + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      addBtns +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' +
      (l.contentType === 'movie' || l.contentType === 'series' ? l.contentType : 'movie') + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  // My Lists results
  (myListsMatches || []).forEach((l) => {
    const added = alreadyAdded.has(l.url + '|' + l.type);
    let usernameSlug = '';
    try {
      const parts = (l.url || '').split('/lists/')[1]?.split('/');
      if (parts && parts.length >= 2) usernameSlug = parts[0] + '/' + parts[1];
    } catch (e) {}
    const alreadyLiked = usernameSlug && getLikedListsSet().has(usernameSlug);
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-mylist" aria-label="My Lists">&#9733;</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.creatorName || 'Anonymous') + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span class="like-count">&#9829; ' + (l.likes || 0) + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeBtn' + (alreadyLiked ? ' liked' : '') + '" data-username-slug="' + escapeAttr(usernameSlug) + '">' +
      (alreadyLiked ? '&#9829;' : '&#9825;') +
      '</button>' +
      '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? '&#10003; Added' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  combinedCards.sort((a, b) => b.likes - a.likes);
  let html = combinedCards.map(c => c.html).join('');
  
  if (combinedCards.length === 0) {
    html = '<p style="color:var(--muted); font-size:0.9rem; padding:8px 0;"><small>No lists match that search.</small></p>';
  }
  if (traktError) {
    html += '<p class="testresult err" style="margin-top:8px;">&#10007; Trakt search: ' + escapeHtml(traktError) + '</p>';
  }
  box.innerHTML = html;

  // Re-apply active chip filter to newly rendered cards
  const activeChip = document.querySelector('#listSearchTypeChips .chip.active');
  if (activeChip && typeof setListSearchChip === 'function') setListSearchChip(activeChip);

  populateSearchResultPosters();
}

async function populateSearchResultPosters() {
  const slots = [...document.querySelectorAll('.poster-preview-slot')];
  let idx = 0;
  const CONCURRENCY = 5;
  async function worker() {
    while (idx < slots.length) {
      const slot = slots[idx++];
      const listUrl = slot.dataset.url;
      const type = slot.dataset.type || 'movie';
      try {
        const payload = { url: listUrl, type: type, sample: 12 };
        const mkInput = document.getElementById('mdblistKeyInput');
        if (mkInput && mkInput.value) payload.mdblistKey = mkInput.value.trim();
        const tkInput = document.getElementById('tmdbKeyInput');
        if (tkInput && tkInput.value) payload.tmdbKey = tkInput.value.trim();
        const trkInput = document.getElementById('traktKeyInput');
        if (trkInput && trkInput.value) payload.traktKey = trkInput.value.trim();

        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        });
        const data = await res.json();
        if (data.ok && data.sample && data.sample.length) {
          const validPosters = data.sample.filter((s) => s.poster).slice(0, 9);
          if (validPosters.length) {
            const totalCount = data.count || (validPosters.length * 10);
            let inner = '';
            validPosters.forEach((s, i) => {
              const isMobileEnd = (i === 2 && validPosters.length > 3);
              const isDesktopEnd = (i === validPosters.length - 1 && validPosters.length >= 4);

              let overlays = '';
              if (isMobileEnd) {
                overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn" data-name="' + escapeAttr(listUrl) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }
              if (isDesktopEnd) {
                overlays += '<div class="list-card-count-overlay desktop-only searchViewListBtn" data-name="' + escapeAttr(listUrl) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }

              inner += '<div class="list-card-mini-poster-tile">' +
                '<div class="list-card-mini-poster-img-wrap clickable-poster" data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(type || '') + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '">' +
                  '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
                  '<div class="poster-add-overlay">+</div>' +
                  overlays +
                '</div>' +
                '<div class="list-card-mini-poster-name">' + escapeHtml(s.name || '') + '</div>' +
              '</div>';
            });
            slot.className = 'list-card-posters';
            slot.innerHTML = inner;
          }
        }
      } catch (e) {
        // Posters are a nice-to-have here
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slots.length) }, () => worker()));
}

function getLikedListsSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem('myListAddon:likedLists') || '[]'));
  } catch (e) {
    return new Set();
  }
}

function rememberLikedList(usernameSlug) {
  const set = getLikedListsSet();
  set.add(usernameSlug);
  try {
    localStorage.setItem('myListAddon:likedLists', JSON.stringify([...set]));
  } catch (e) {}
}

function forgetLikedList(usernameSlug) {
  const set = getLikedListsSet();
  set.delete(usernameSlug);
  try {
    localStorage.setItem('myListAddon:likedLists', JSON.stringify([...set]));
  } catch (e) {}
}

document.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('.searchViewListBtn');
  if (viewBtn) {
    openListPreviewModal(viewBtn.dataset.name, viewBtn.dataset.type, viewBtn.dataset.url);
    return;
  }
  const addBtn = e.target.closest('.searchAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.disabled = true;
    addBtn.textContent = 'Added \u2713';
    return;
  }
  const likeBtn = e.target.closest('.searchLikeBtn');
  if (likeBtn && !likeBtn.disabled) {
    const usernameSlug = likeBtn.dataset.usernameSlug || '';
    const parts = usernameSlug.split('/');
    if (parts.length !== 2) return;
    const wasLiked = likeBtn.classList.contains('liked');
    likeBtn.disabled = true;
    try {
      const res = await fetch(ORIGIN + '/api/lists/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: parts[0], slug: parts[1], action: wasLiked ? 'unlike' : 'like' }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not update this like: ' + (data.error || 'unknown error'));
        return;
      }
      if (wasLiked) {
        forgetLikedList(usernameSlug);
        likeBtn.classList.remove('liked');
        likeBtn.textContent = '\u2661 Like';
      } else {
        rememberLikedList(usernameSlug);
        likeBtn.classList.add('liked');
        likeBtn.textContent = '\u2665 Unlike';
      }
      const row = likeBtn.closest('.searchresult-row');
      const countEl = row && row.querySelector('.like-count');
      if (countEl) countEl.textContent = '\u2665 ' + data.likes;
      if (activeCreator) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/sync/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, usernameSlug: usernameSlug, liked: !wasLiked }),
        }).catch(() => {});
      }
    } catch (err) {
      alert('Network error while updating this like.');
    } finally {
      likeBtn.disabled = false;
    }
    return;
  }
  const likeExternalBtn = e.target.closest('.searchLikeExternalBtn');
  if (likeExternalBtn && !likeExternalBtn.disabled) {
    const listUrl = likeExternalBtn.dataset.url || '';
    if (!listUrl) return;
    const wasLiked = likeExternalBtn.classList.contains('liked');
    likeExternalBtn.disabled = true;
    try {
      const res = await fetch(ORIGIN + '/api/lists/like-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: listUrl, action: wasLiked ? 'unlike' : 'like' }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not update this like: ' + (data.error || 'unknown error'));
        return;
      }
      if (wasLiked) {
        forgetLikedList(listUrl);
        likeExternalBtn.classList.remove('liked');
        likeExternalBtn.textContent = '\u2661 Like';
      } else {
        rememberLikedList(listUrl);
        likeExternalBtn.classList.add('liked');
        likeExternalBtn.textContent = '\u2665 Unlike';
      }
      if (activeCreator) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/sync/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, usernameSlug: listUrl, liked: !wasLiked }),
        }).catch(() => {});
      }
    } catch (err) {
      alert('Network error while updating this like.');
    } finally {
      likeExternalBtn.disabled = false;
    }
  }
});

let popularListsFeedLoaded = false;
async function loadPopularListsFeed() {
  const container = document.getElementById('popularListsFeed');
  if (!container) return;
  if (!popularListsFeedLoaded) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading popular community lists…</p>';
  }
  try {
    const [toplists, published] = await Promise.all([
      ensureMdblistPopularLoaded(),
      fetch(ORIGIN + '/api/search-published-lists?q=').then(r => r.json()).catch(() => ({ lists: [] }))
    ]);
    const allLists = [...(published.lists || []), ...(toplists || [])];
    if (!allLists.length) {
      container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No community lists found.</p>';
      return;
    }
    render5PosterListsFeed(container, allLists);
    popularListsFeedLoaded = true;
  } catch (e) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading community lists.</p>';
  }
}

async function loadCuratedListsFeed() {
  const container = document.getElementById('curatedListsFeed');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading curated lists…</p>';
  const toplists = await ensureMdblistPopularLoaded();
  const curated = (toplists || []).filter(l => (l.user || '').toLowerCase() === 'official' || (l.likes || 0) > 50);
  render5PosterListsFeed(container, curated);
}

async function renderLikedListsFeed() {
  const container = document.getElementById('likedListsFeed');
  if (!container) return;
  const likedUrls = [...getLikedListsSet()];
  if (!likedUrls.length) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p>';
    return;
  }
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading your ' + likedUrls.length + ' liked list(s)...</p>';
  try {
    const toplists = await ensureMdblistPopularLoaded();
    const topMap = new Map();
    (toplists || []).forEach(l => {
      if (l.url) topMap.set(l.url, l);
      if (l.user && l.slug) topMap.set(l.user + '/' + l.slug, l);
    });

    const likedListObjects = likedUrls.map(u => {
      if (topMap.has(u)) return topMap.get(u);
      const name = guessNameFromUrl(u);
      const isSeries = u.toLowerCase().includes('show') || u.toLowerCase().includes('series') || u.toLowerCase().includes('tv');
      return {
        url: u,
        name: name,
        user: 'Community',
        type: isSeries ? 'series' : 'movie',
        items: 50,
        likes: 1
      };
    });

    render5PosterListsFeed(container, likedListObjects);
  } catch (e) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading liked lists.</p>';
  }
}

function render5PosterListsFeed(container, lists) {
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.slice(0, 40).map(function(l) {
    const type = l.type || (l.mediatype === 'show' ? 'series' : 'movie');
    const added = alreadyAdded.has(l.url + '|' + type);
    const alreadyLiked = getLikedListsSet().has(l.url);
    const author = l.user || l.creatorName || 'Official';
    const itemCount = l.items || l.count || null;

    return '<div class="list-card" data-list-type="' + escapeAttr(type) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon ' + (l.user ? 'src-mdblist' : 'src-mylist') + '">' + (l.user ? 'M' : '&#x2605;') + '</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>by ' + escapeHtml(author) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
            (itemCount ? '<span class="list-card-meta-sep">&middot;</span><span>' + itemCount + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
            (alreadyLiked ? '&#x2665;' : '&#x2661;') +
          '</button>' +
          '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
            ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
            (added ? '&#x2713; Added' : '+ Add') +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '"></div>' +
    '</div>';
  }).join('');

  container.innerHTML = cardsHtml;
  populateSearchResultPosters();
}

function openSeeAllDetail(title, categoryKey) {
  const overlay = document.getElementById('detailOverlay');
  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSubtitle');
  const gridEl = document.getElementById('detailGrid');
  const addAllBtn = document.getElementById('detailAddAllBtn');
  if (!overlay || !gridEl) return;

  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = 'Discover \u2022 Popular & Trending Catalogs';
  if (addAllBtn) {
    addAllBtn.onclick = function() {
      const targetBtn = document.querySelector('[data-add-all-action="' + categoryKey + '"]');
      if (targetBtn) targetBtn.click();
      closeDetailOverlay();
      switchTab('catalogs');
    };
  }

  // Find the matching shelf preview and clone its cards into the 3-column grid
  let sourceScroll = null;
  if (categoryKey === 'combined-charts') sourceScroll = document.getElementById('shelfScrollCombined');
  else if (categoryKey === 'tmdb-charts') sourceScroll = document.getElementById('shelfScrollTmdb');
  else if (categoryKey === 'streaming-top10') sourceScroll = document.getElementById('shelfScrollStreamingTop10');
  else if (categoryKey === 'trakt-charts') sourceScroll = document.getElementById('shelfScrollTrakt');
  else if (categoryKey === 'mdblist-charts') sourceScroll = document.getElementById('shelfScrollMdblist');
  else if (categoryKey === 'simkl-charts') sourceScroll = document.getElementById('shelfScrollSimkl');
  else if (categoryKey === 'streaming') sourceScroll = document.getElementById('shelfScrollStreaming');
  else if (categoryKey === 'hidden-gems') sourceScroll = document.getElementById('shelfScrollHiddenGems');

  if (sourceScroll) {
    gridEl.innerHTML = sourceScroll.innerHTML;
  } else {
    gridEl.innerHTML = '<p style="color:var(--muted); font-size:0.9rem;">No items available in this category.</p>';
  }

  overlay.classList.add('active');
  overlay.scrollTop = 0;
}

// --- Clickable Posters & Add to List Modal Logic ---
document.addEventListener('click', async (e) => {
  const addOverlayBtn = e.target.closest('.poster-add-overlay');
  const posterEl = e.target.closest('.clickable-poster');
  
  if (addOverlayBtn) {
    e.stopPropagation(); // prevent opening the details modal
    openSelectListModal(posterEl.dataset.id, posterEl.dataset.type, posterEl.dataset.title, posterEl.dataset.poster);
    return;
  }
  
  if (posterEl && !e.target.closest('.searchViewListBtn')) {
    openItemDetailsModal(posterEl.dataset.id, posterEl.dataset.type);
    return;
  }
});

function openEpisodeDetails(epNum) {
  const ep = window._episodeDataCache && window._episodeDataCache[epNum];
  if (!ep) return;
  
  const still = ep.still_path ? escapeAttr(ep.still_path) : '';
  const runtime = ep.runtime ? ep.runtime + ' min' : '';
  const date = ep.air_date ? ep.air_date : '';
  
  let infoHtml = '';
  if (date) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(date) + '</div>';
  if (runtime) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(runtime) + '</div>';
  if (ep.vote_average) infoHtml += '<div style="margin-bottom:6px;">\u2605 ' + escapeHtml(Number(ep.vote_average).toFixed(1)) + ' TMDB</div>';
  
  const innerHtml = 
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<div style="display:flex; flex-direction:row; gap:32px; flex-wrap:wrap; margin-top:20px;">' +
      '<div style="flex: 0 0 300px; max-width: 100%;">' +
        (still ? '<img src="' + still + '" style="width:100%; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">' : '') +
      '</div>' +
      '<div style="flex: 1; min-width: 300px;">' +
        '<h1 style="margin:0 0 16px; font-size:2.5rem; font-family: serif;">E' + ep.episode_number + ' - ' + escapeHtml(ep.name) + '</h1>' +
          '<div style="margin-bottom:20px;">' +
            '<button type="button" id="btnMarkWatched" class="lc-btn ' + (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? 'secondary' : 'primary') + '" onclick="toggleEpisodeWatchStatus(' + ep.episode_number + ')">' +
              (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
            '</button>' +
          '</div>' +
        '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
        '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(ep.overview || 'No overview available.') + '</p>' +
      '</div>' +
    '</div>';
    
  showModal(innerHtml, 'modal-card-wide');
}

// An episode counts as "aired" once it has a real air_date that isn't in
// the future -- used to keep unaired/TBA episodes out of both the batch
// "mark watched" actions and Continue Watching's idea of what's next.
function isEpisodeAired(ep) {
  if (!ep || !ep.air_date) return false;
  const airDate = new Date(ep.air_date);
  if (isNaN(airDate.getTime())) return false;
  return airDate.getTime() <= Date.now();
}

// Toggles a single episode's watched status via the generic toggleWatchStatus
// (same one movies use) -- that function already embeds show/season/episode
// context and refreshes Continue Watching for episode toggles, so this is
// just a clean, backslash-free way to call it from the onclick attribute.
function toggleEpisodeWatchStatus(epNum) {
  const ep = window._episodeDataCache && window._episodeDataCache[epNum];
  if (!ep) return;
  window.toggleWatchStatus(String(ep.id), 'episode', ep.name || '', ep.still_path || '');
}


async function openItemDetailsModal(id, type) {
  if (!id || id.startsWith('channel_')) return;
  
  // A poster clicked from inside an open showModal()-based overlay (e.g.
  // the "View all" list preview) needs that overlay closed here --
  // switchTab below only changes which full-page tab-panel is active
  // underneath it, and does nothing to the overlay itself, which is a
  // separate, always-on-top element appended straight to <body>. Without
  // this, the destination page loads correctly in the background but stays
  // hidden behind the still-open modal.
  if (typeof closeModal === 'function') closeModal();
  
  window._previousTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'discover';
  switchTab('item-details');
  
  const body = document.getElementById('itemDetailsBody');
  body.innerHTML = '<p style="color:var(--muted); text-align:center; padding: 40px;">Fetching information from TMDB...</p>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';
  
  try {
    const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(id) + '&tmdbKey=' + encodeURIComponent(tmdbKey) + (type ? '&type=' + encodeURIComponent(type) : ''));
    const data = await res.json();
    if (!data.ok || !data.details) throw new Error(data.error || 'Failed to load details');
    
    const d = data.details;
    window._currentItemDetails = d;
    
    // There's no server-side cron pushing updates into a browser's own
    // localStorage, so a newly-aired episode can't add itself to Continue
    // Watching in the background -- the closest thing to "automatic" is
    // refreshing it here, so simply reopening a show you're partway
    // through picks up anything that's aired since you last looked,
    // without needing to watch/unwatch something first to trigger it.
    // Only bothers if this show has any Watch History to begin with.
    if (type === 'series' && typeof updateContinueWatching === 'function') {
      const historyMap = loadLocalCustomLists();
      const history = historyMap['watch-history'];
      const hasWatchedEpisode = history && (history.items || []).some(it => it.type === 'episode' && it.showId === d.id);
      if (hasWatchedEpisode) updateContinueWatching(d.id).catch(() => {});
    }
    
    // Formatting helpers
    let dateStr = d.releaseYear || '';
    if (d.releaseDate) {
      try {
        const dateObj = new Date(d.releaseDate);
        if (!isNaN(dateObj)) {
          dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
      } catch(e) {}
    }

    let runtimeStr = '';
    if (d.runtime) {
      const h = Math.floor(d.runtime / 60);
      const m = d.runtime % 60;
      runtimeStr = (h > 0 ? h + 'h ' : '') + m + 'm';
    }

    const formatMoney = (val) => val ? '$' + val.toLocaleString('en-US') : '';
    const budgetStr = formatMoney(d.budget);
    const revenueStr = formatMoney(d.revenue);

    let infoHtml = '';
    if (dateStr) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(dateStr) + '</div>';
    if (d.seasons) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(d.seasons + ' season' + (d.seasons > 1 ? 's' : '')) + '</div>';
    if (runtimeStr) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(runtimeStr) + '</div>';
    if (d.contentRating) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(d.contentRating) + '</div>';
    if (d.rating) infoHtml += '<div style="margin-bottom:6px;">\u2605 ' + escapeHtml(d.rating) + ' TMDB</div>';
    if (budgetStr) infoHtml += '<div style="margin-bottom:6px;">Budget ' + escapeHtml(budgetStr) + '</div>';
    if (revenueStr) infoHtml += '<div style="margin-bottom:6px;">Box Office ' + escapeHtml(revenueStr) + '</div>';
    if (d.genres) infoHtml += '<div style="margin-bottom:20px;">' + escapeHtml(d.genres) + '</div>';
    
    const trailerHtml = d.trailerKey ? 
      '<h3 style="margin: 0 0 16px; font-family:serif; font-size:1.5rem;">Trailer</h3>' +
      '<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:8px;">' +
      '<iframe style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;" src="https://www.youtube.com/embed/' + escapeAttr(d.trailerKey) + '" allowfullscreen></iframe>' +
      '</div>' : '';

    let seasonsHtml = '';
    if (d.seasonsData && d.seasonsData.length > 0) {
      seasonsHtml += '<h3 style="margin: 32px 0 16px; font-family:serif; font-size:1.5rem;">Seasons</h3>';
      seasonsHtml += '<div style="display:flex; flex-direction:column; gap:16px;">';
      d.seasonsData.forEach(season => {
        if (season.season_number === 0) return; // Skip specials usually
        const sPoster = season.poster_path ? 'https://image.tmdb.org/t/p/w200' + season.poster_path : '';
        seasonsHtml += 
          '<div style="background:var(--surface-light); border:1px solid var(--border); border-radius:8px; overflow:hidden;">' +
            '<div style="display:flex; gap:16px; padding:16px; cursor:pointer; align-items:center;" onclick="toggleSeasonEpisodes(this, ' + season.season_number + ', &quot;' + escapeAttr(d.id) + '&quot;)">' +
              (sPoster ? '<img src="' + escapeAttr(sPoster) + '" style="width:80px; border-radius:4px; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.3);">' : '<div style="width:80px; height:120px; background:#333; border-radius:4px; flex-shrink:0;"></div>') +
              '<div style="display:flex; flex-direction:column; justify-content:center; flex:1;">' +
                '<h4 style="margin:0 0 4px; font-size:1.2rem;">' + escapeHtml(season.name) + '</h4>' +
                '<div style="color:var(--muted); font-size:0.9rem;">' + season.episode_count + ' episodes</div>' +
              '</div>' +
              '<button type="button" class="lc-btn primary season-watch-btn" onclick="event.stopPropagation(); markSeasonWatched(this, &quot;' + escapeAttr(d.id) + '&quot;, ' + season.season_number + ', &quot;' + escapeAttr(season.name) + '&quot;)">Mark Season Watched</button>' +
            '</div>' +
            '<div class="season-episodes-container" style="display:none; padding:16px; border-top:1px solid var(--border); background:rgba(0,0,0,0.2);">' +
              '<div class="episodes-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:16px;"></div>' +
            '</div>' +
          '</div>';
      });
      seasonsHtml += '</div>';
    }

    body.innerHTML = 
      '<div style="display:flex; flex-direction:row; gap:32px; flex-wrap:wrap;">' +
        '<div style="flex: 0 0 300px; max-width: 100%;">' +
          (d.poster ? '<img src="' + escapeAttr(d.poster) + '" style="width:100%; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">' : '') +
        '</div>' +
        '<div style="flex: 1; min-width: 300px;">' +
          '<h1 style="margin:0 0 16px; font-size:2.5rem; font-family: serif;">' + escapeHtml(d.title) + '</h1>' +
          '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
          '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(d.overview || 'No overview available.') + '</p>' +
          '<div style="display:flex; gap:16px; flex-wrap:wrap;">' +
            '<button type="button" class="lc-btn primary" onclick="openSelectListModal(&quot;' + escapeAttr(d.id) + '&quot;, &quot;' + escapeAttr(type) + '&quot;, &quot;' + escapeAttr(d.title) + '&quot;)">+ Add to list</button>' +
            (type === 'movie' ?
              '<button type="button" id="btnMarkWatched" class="lc-btn ' + (window._watchedItemIds && window._watchedItemIds.has(String(d.id)) ? 'secondary' : 'primary') + '" onclick="toggleWatchStatus(&quot;' + escapeAttr(d.id) + '&quot;, &quot;movie&quot;, &quot;' + escapeAttr(d.title) + '&quot;, &quot;' + escapeAttr(d.poster || '') + '&quot;)">' +
                (window._watchedItemIds && window._watchedItemIds.has(String(d.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
              '</button>'
            : type === 'series' ?
              '<button type="button" id="btnMarkShowWatched" class="lc-btn primary" onclick="markShowWatched(this, &quot;' + escapeAttr(d.id) + '&quot;, &quot;' + escapeAttr(d.title) + '&quot;, &quot;' + escapeAttr(d.poster || '') + '&quot;)">Mark Whole Show Watched</button>'
            : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      (trailerHtml ? '<div style="margin-top:32px;">' + trailerHtml + '</div>' : '') +
      (seasonsHtml ? '<div style="margin-top:32px;">' + seasonsHtml + '</div>' : '');
      
  } catch (err) {
    body.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(err.message) + '</p>';
  }
}

async function toggleSeasonEpisodes(headerEl, seasonNum, imdbId) {
  window._currentSeasonNum = seasonNum;
  const container = headerEl.nextElementSibling;
  const grid = container.querySelector('.episodes-grid');
  
  if (container.style.display === 'block') {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  if (grid.innerHTML.trim() !== '') return; // already loaded
  
  grid.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding: 20px; color:var(--muted);">Loading episodes...</div>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';
  
  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error(data.error || 'Failed to load season');
    
    let epsHtml = '';
    if (!window._episodeDataCache) window._episodeDataCache = {};
    data.season.episodes.forEach(ep => {
      ep.season_number = seasonNum;
      window._episodeDataCache[ep.episode_number] = ep;
      const still = ep.still_path ? escapeAttr(ep.still_path) : '';
      epsHtml += 
        '<div class="clickable-episode" data-id="' + ep.id + '" style="display:flex; flex-direction:column; gap:4px; cursor:pointer;" onclick="openEpisodeDetails(' + ep.episode_number + ')">' +
          '<div style="width:100%; aspect-ratio:16/9; background:#222; border-radius:6px; overflow:hidden; position:relative; box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
            (still ? '<img src="' + still + '" style="width:100%; height:100%; object-fit:cover;">' : '') +
            '<div style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,0.8); color:var(--brand); padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8rem;">E' + ep.episode_number + '</div>' +
          '</div>' +
          '<div style="font-size:0.9rem; color:var(--text); line-height:1.2; padding-top:4px;">' + escapeHtml(ep.name) + '</div>' +
        '</div>';
    });
    grid.innerHTML = epsHtml || '<div style="grid-column: 1 / -1; color:var(--muted);">No episodes found.</div>';
  } catch (err) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; color:red;">Error loading episodes.</div>';
  }
}

// Fetches every aired episode of a single season and batch-marks them
// watched (or unwatched if all already watched) via toggleBatchWatchStatus.
async function markSeasonWatched(btnEl, imdbId, seasonNum, seasonName) {
  if (!btnEl || btnEl.disabled) return;
  const origLabel = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = 'Fetching episodes...';

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes || !data.season.episodes.length) {
      throw new Error(data.error || 'No episodes found for this season.');
    }

    const d = window._currentItemDetails;
    const episodes = data.season.episodes
      .filter(ep => isEpisodeAired(ep))
      .map(ep => ({
        id: String(ep.id),
        type: 'episode',
        name: ep.name,
        poster: ep.still_path || '',
        showId: d ? d.id : null,
        showTitle: d ? d.title : null,
        showPoster: d ? (d.poster || '') : '',
        seasonNum: seasonNum,
        episodeNum: ep.episode_number
      }));

    if (!episodes.length) {
      btnEl.disabled = false;
      btnEl.textContent = origLabel;
      alert('No aired episodes found for this season yet.');
      return;
    }

    const result = window.toggleBatchWatchStatus(episodes);

    btnEl.disabled = false;
    if (result.nowWatched) {
      btnEl.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched';
      btnEl.classList.remove('primary');
      btnEl.classList.add('secondary');
    } else {
      btnEl.textContent = 'Mark Season Watched';
      btnEl.classList.remove('secondary');
      btnEl.classList.add('primary');
    }
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = origLabel;
    alert('Could not load episodes for ' + (seasonName || 'this season') + ': ' + err.message);
  }
}

// Loops over every season in the open show, fetching in batches of 4,
// marks all aired episodes watched (or unwatched if all already marked).
async function markShowWatched(btnEl, imdbId, title, poster) {
  if (!btnEl || btnEl.disabled) return;

  const d = window._currentItemDetails;
  const seasonsData = (d && d.seasonsData) ? d.seasonsData.filter(s => s.season_number > 0) : [];
  if (!seasonsData.length) {
    alert('No seasons found for this show.');
    return;
  }

  const origLabel = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = 'Fetching episodes...';

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  const allEpisodes = [];
  let hadError = false;
  const concurrency = 4;

  for (let i = 0; i < seasonsData.length; i += concurrency) {
    const batch = seasonsData.slice(i, i + concurrency);
    btnEl.textContent = 'Fetching episodes... (' + Math.min(i + concurrency, seasonsData.length) + '/' + seasonsData.length + ')';
    const results = await Promise.all(batch.map(season =>
      fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + season.season_number + '&tmdbKey=' + encodeURIComponent(tmdbKey))
        .then(r => r.json())
        .catch(() => ({ ok: false }))
    ));
    results.forEach((seasonRes, ri) => {
      if (seasonRes.ok && seasonRes.season && seasonRes.season.episodes) {
        const sNum = batch[ri] ? batch[ri].season_number : null;
        seasonRes.season.episodes
          .filter(ep => isEpisodeAired(ep))
          .forEach(ep => {
            allEpisodes.push({
              id: String(ep.id),
              type: 'episode',
              name: ep.name,
              poster: ep.still_path || '',
              showId: imdbId,
              showTitle: title,
              showPoster: poster || '',
              seasonNum: sNum,
              episodeNum: ep.episode_number
            });
          });
      } else {
        hadError = true;
      }
    });
  }

  if (!allEpisodes.length) {
    btnEl.disabled = false;
    btnEl.textContent = origLabel;
    alert('Could not load any aired episodes for this show.');
    return;
  }

  const result = window.toggleBatchWatchStatus(allEpisodes);

  btnEl.disabled = false;
  if (result.nowWatched) {
    btnEl.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched';
    btnEl.classList.remove('primary');
    btnEl.classList.add('secondary');
  } else {
    btnEl.textContent = 'Mark Whole Show Watched';
    btnEl.classList.remove('secondary');
    btnEl.classList.add('primary');
  }

  if (hadError) alert('Some seasons could not be loaded, so this show may only be partially marked.');
}

function openSelectListModal(id, type, title, poster) {
  const modal = document.getElementById('selectListModal');
  const body = document.getElementById('selectListModalBody');
  
  // Every Custom List the person could add this item to, from three
  // places: (1) lists already added to the live catalog as a #lists row
  // (editable in place via that row's own <input class="url">), (2)
  // local-only Custom Lists that were saved (e.g. via Import from a link,
  // or Copy to Custom List) but never added as a row, and (3) this
  // account's server-synced Creator lists, same story. (2) and (3) used to
  // be invisible here entirely -- only lists someone had explicitly
  // "+ Add"-ed to their catalog ever showed up, so anything imported and
  // left sitting under Your Custom Lists had no way to receive new items
  // from this picker. seenSlugs dedupes a list that's in both a row and
  // the local/creator source it came from, preferring the row (it's the
  // live, currently-configured copy).
  const customLists = [];
  const seenSlugs = new Set();

  document.querySelectorAll('#lists .entry').forEach(row => {
    const urlInput = row.querySelector('.url');
    if (urlInput && urlInput.value.startsWith('customlist:v1:')) {
      try {
        const payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        // Only include lists that have been properly saved
        if (!payload.localSlug && !payload.creatorSlug) return;
        // Filter by item type: if list has a type (movie or series), it must match the item being added
        if (payload.type && payload.type !== type) return;
        const nameInput = row.querySelector('.name');
        const slug = payload.localSlug || payload.creatorSlug;
        if (slug) seenSlugs.add((payload.localSlug ? 'local:' : 'creator:') + slug);
        customLists.push({
          name: nameInput ? nameInput.value : (payload.listName || 'Unnamed List'),
          source: 'row',
          row: row,
          items: payload.items || []
        });
      } catch(e) {}
    }
  });

  if (typeof loadLocalCustomLists === 'function') {
    const localMap = loadLocalCustomLists();
    Object.keys(localMap).forEach(slug => {
      // Watch History / Continue Watching are auto-managed, not something
      // to manually file items into from this picker.
      if (slug === 'watch-history' || slug === 'continue-watching') return;
      if (seenSlugs.has('local:' + slug)) return;
      const l = localMap[slug];
      if (l.type && l.type !== type) return;
      customLists.push({ name: l.name, source: 'local', slug: slug, type: l.type, visibility: l.visibility, items: l.items || [] });
    });
  }

  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    lastCreatorListsData.forEach(l => {
      if (seenSlugs.has('creator:' + l.slug)) return;
      if (l.type && l.type !== type) return;
      customLists.push({ name: l.name, source: 'creator', slug: l.slug, type: l.type, visibility: l.visibility, items: l.items || [] });
    });
  }
  
  let html = '';
  if (customLists.length === 0) {
    html += '<p style="text-align:center; padding:20px; color:#001f3f;">You have not created any Custom Lists yet. <a href="#" id="emptyCreateListLink" style="color:#003366; font-weight:600;">Create one now</a></p>';
    document.getElementById('addSelectedListsBtn').style.display = 'none';
    setTimeout(() => {
      const lnk = document.getElementById('emptyCreateListLink');
      if (lnk) {
        lnk.onclick = function(e) {
          e.preventDefault();
          document.getElementById('selectListModal').style.display = 'none';
          document.body.style.overflow = '';
          switchTab('lists');
          // Create List has no pill of its own -- see the matching fix in
          // editCreatorList/editLocalCustomList for why this doesn't try
          // to grab one to highlight.
          if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
        };
      }
    }, 0);
  } else {
    document.getElementById('addSelectedListsBtn').style.display = 'block';
    customLists.forEach((list, idx) => {
      const isChecked = (list.items || []).some(it => (it.imdbId === id) || (it.id === id) || (it.imdbId === 'tmdb:' + id));
      
      html += 
        '<label style="display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom: 1px solid rgba(0,0,0,0.05); cursor:pointer; color:#001f3f; font-size:1rem;">' +
          '<span>' + escapeHtml(list.name) + '</span>' +
          '<input type="checkbox" class="list-select-cb" data-idx="' + idx + '" ' + (isChecked ? 'checked ' : '') + 'style="width:20px; height:20px; cursor:pointer; accent-color:#003366;">' +
        '</label>';
    });
    
    // Store globally so the onclick handler can access it
    window._selectListModalTempLists = customLists;
    window._selectListModalCurrentItem = { id: id, type: type, title: title, poster: poster };
  }
  
  body.innerHTML = html;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

  document.getElementById('selectListModal').addEventListener('click', (e) => {
    if (e.target.id === 'selectListModal' || e.target.id === 'selectListModalCloseBtn') {
      document.getElementById('selectListModal').style.display = 'none';
      document.body.style.overflow = '';
    }
  });

document.getElementById('addSelectedListsBtn').addEventListener('click', async () => {
  if (!window._selectListModalTempLists || !window._selectListModalCurrentItem) return;
  const { id, type, title, poster } = window._selectListModalCurrentItem;
  
  const btn = document.getElementById('addSelectedListsBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  
  let finalImdbId = id;
  if (!String(finalImdbId).startsWith('tt')) {
    const endpoint = type === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
    try {
      const res = await fetch(endpoint + finalImdbId);
      const data = await res.json();
      if (data.ok) finalImdbId = data.imdbId;
      else finalImdbId = 'tmdb:' + finalImdbId;
    } catch(e) {
      finalImdbId = 'tmdb:' + finalImdbId;
    }
  }

  const checkboxes = document.querySelectorAll('.list-select-cb');
  let anyAdded = false;
  let anyRemoved = false;
  
  for (const cb of checkboxes) {
    const listIdx = parseInt(cb.dataset.idx, 10);
    const isChecked = cb.checked;
    const result = await toggleItemInSelectedList(id, finalImdbId, type, listIdx, isChecked, title, poster);
    if (result === 'added') anyAdded = true;
    else if (result === 'removed') anyRemoved = true;
  }
  
  document.getElementById('selectListModal').style.display = 'none';
  document.body.style.overflow = '';
  
  btn.disabled = false;
  btn.textContent = 'Done';
  
  if (anyAdded) showAddedToast('Added ' + title + ' to lists.');
  else if (anyRemoved && typeof showAddedToast === 'function') showAddedToast('Removed ' + title + ' from lists.');
});

// Adds or removes one item from one list picked in the Add-to-List modal.
// A list can be one of three things (see openSelectListModal): a live
// catalog row (mutated in place via its own <input class="url">, same as
// always), or a local/creator Custom List that was never added as a row --
// those don't have a DOM row to write to at all, so this builds the same
// {localSlug|creatorSlug, type, items, visibility} shape
// syncCustomListPayload already knows how to persist (to localStorage or
// the server respectively) and hands off to that, rather than a second,
// parallel save path.
async function toggleItemInSelectedList(originalId, imdbId, type, listIdx, shouldBeInList, title, poster) {
  if (!window._selectListModalTempLists || !window._selectListModalTempLists[listIdx]) return 'failed';
  const list = window._selectListModalTempLists[listIdx];

  if (list.source === 'row') {
    const changed = toggleItemInCustomListUrl(originalId, imdbId, type, listIdx, shouldBeInList, title, poster);
    if (!changed) return 'unchanged';
    return shouldBeInList ? 'added' : 'removed';
  }

  const matches = (it) => (it.imdbId === imdbId) || (it.id === originalId) || (it.imdbId === 'tmdb:' + originalId);
  const items = (list.items || []).slice();
  const idx = items.findIndex(matches);
  const exists = idx !== -1;
  if (shouldBeInList === exists) return 'unchanged';
  if (shouldBeInList) items.push({ imdbId, type, title, poster: poster || undefined });
  else items.splice(idx, 1);

  const payload = {
    type: list.type || type,
    items: items,
    visibility: list.visibility || 'public',
  };
  if (list.source === 'creator') payload.creatorSlug = list.slug;
  else payload.localSlug = list.slug;

  list.items = items; // keep this in sync in case the same list gets toggled again before the modal closes
  await syncCustomListPayload(payload, list.name);
  return shouldBeInList ? 'added' : 'removed';
}

function toggleItemInCustomListUrl(originalId, imdbId, type, listIdx, shouldBeInList, title, poster) {
  if (!window._selectListModalTempLists || !window._selectListModalTempLists[listIdx]) return false;
  const list = window._selectListModalTempLists[listIdx];
  
  try {
    const urlInput = list.row.querySelector('.url');
    if (!urlInput) return false;
    const payloadStr = urlInput.value.slice('customlist:v1:'.length);
    const payload = JSON.parse(payloadStr);
    
    // We check for existing items using imdbId, or fall back to checking originalId (tmdb fallback)
    const idx = payload.items.findIndex(it => (it.imdbId === imdbId) || (it.id === originalId) || (it.imdbId === 'tmdb:' + originalId));
    const exists = idx !== -1;
    
    let changed = false;
    if (shouldBeInList && !exists) {
      payload.items.push({ imdbId, type, title, poster: poster || undefined });
      changed = true;
    } else if (!shouldBeInList && exists) {
      payload.items.splice(idx, 1);
      changed = true;
    }
    
    if (changed) {
      const newUrl = 'customlist:v1:' + JSON.stringify(payload);
      const urlInput = list.row.querySelector('.url');
      if (urlInput) {
        urlInput.value = newUrl;
        if (typeof autoSaveDebounced === 'function') autoSaveDebounced();
      }
      
      // Sync to backend -- read the display name from the row's name input
      const nameInput = list.row.querySelector('.name');
      const rowName = (nameInput ? nameInput.value : '') || list.name || '';
      syncCustomListPayload(payload, rowName);
    }
    return changed;
    
  } catch (err) {
    console.error('Error adding to custom list', err);
    return false;
  }
}

async function syncCustomListPayload(payload, name) {
  if (payload.creatorSlug) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey');
    const creatorName = localStorage.getItem('myListAddon:creatorName');
    if (creatorKey && creatorName && name) {
      try {
        const res = await fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: creatorName,
            creatorKey: creatorKey,
            slug: payload.creatorSlug,
            name: name,
            type: payload.type,
            items: payload.items,
            visibility: payload.visibility || 'private'
          })
        });
        const data = await res.json();
        if (!data.ok) {
          alert('Could not sync item to list: ' + (data.error || 'unknown error'));
        }
      } catch(e) {
        alert('Network error syncing list: ' + String(e));
      }
    }
  } else if (payload.localSlug) {
    if (typeof loadLocalCustomLists === 'function' && typeof saveLocalCustomListsMap === 'function') {
      const map = loadLocalCustomLists();
      if (map[payload.localSlug]) {
        map[payload.localSlug].items = payload.items;
        saveLocalCustomListsMap(map);
      }
    }
  }
}


let currentCatalogSearchType = 'movie';

function setCatalogSearchFilter(filter, btn) {
  if (btn) {
    document.querySelectorAll('#catalogSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  currentCatalogSearchType = filter;
  if (document.getElementById('catalogSearchInput').value.trim()) {
    runCatalogSearch();
  }
}

async function runCatalogSearch() {
  const q = document.getElementById('catalogSearchInput').value.trim();
  const resEl = document.getElementById('catalogSearchResult');
  if (!q) {
    resEl.innerHTML = '';
    return;
  }
  resEl.innerHTML = '<p><small>Searching...</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?type=' + currentCatalogSearchType + '&q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok) {
      resEl.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    if (!data.results || !data.results.length) {
      resEl.innerHTML = '<p><small>No results found.</small></p>';
      return;
    }
    
    const postersHtml = data.results.map(m => {
      const posterClass = 'live-preview-poster';
      const posterEl = m.poster
        ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy">'
        : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
      
      const title = m.year ? (m.title + ' (' + m.year + ')') : m.title;
      const type = currentCatalogSearchType === 'tv' ? 'series' : 'movie';
      const id = (type === 'series' ? 'tmdb:' : 'tmdb:') + m.tmdbId; // Usually we just use m.id directly if it's a number, but wait - let's check how openItemDetailsModal handles it.
      // Usually TMDB ids are passed directly. Let's assume m.id is the raw ID and type is 'movie' or 'series'.
      
      return '<div class="live-preview-poster-card clickable-poster" ' +
        'data-id="' + escapeAttr(id || '') + '" ' +
        'data-type="' + escapeAttr(type) + '" ' +
        'data-title="' + escapeAttr(m.title || '') + '" ' +
        '>' +
        '<div style="position:relative; width:100%;">' +
          posterEl +
        '</div>' +
        '<div class="live-preview-poster-name">' + escapeHtml(title) + '</div></div>';
    }).join('');
    
    resEl.innerHTML = '<div class="poster-grid-3">' + postersHtml + '</div>';
  } catch (e) {
    resEl.innerHTML = '<p class="testresult err">✗ Network error.</p>';
  }
}






// --- Channel builder ---------------------------------------------------------
//
// Builds one synthetic "series" out of hand-picked real episodes (from any
// shows) and/or whole movies. channelDraftItems holds the in-progress picks
// until "Save as a Channel" bundles them into one entry -- same shape a
// server-side channel payload needs (see parseChannelPayload/
// buildChannelMeta in the Worker): { kind: 'episode', imdbId, season,
// episode, title, released, thumbnail } or { kind: 'movie', imdbId, title,
// year, thumbnail }.
let channelDraftItems = [];
let channelDraftPoster = null;

async function runChannelTitleSearch() {
  const q = document.getElementById('channelSearchInput').value.trim();
  const box = document.getElementById('channelSearchResult');
  document.getElementById('channelEpisodePicker').innerHTML = '';
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=tv', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderChannelTitleResults(data.results);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderChannelTitleResults(results) {
  const box = document.getElementById('channelSearchResult');
  if (!results.length) {
    box.innerHTML = '<p><small>No matches.</small></p>';
    return;
  }
  box.innerHTML = results.map((r) => {
    const label = r.year ? escapeHtml(r.title) + ' (' + escapeHtml(r.year) + ')' : escapeHtml(r.title);
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy">'
      : '';
    return '<div class="row searchresult-row">' +
      '<div style="display:flex; gap:10px; align-items:center;">' + posterImg + '<strong>' + label + '</strong></div>' +
      '<button type="button" class="secondary channelTitleBtn"' +
      ' data-tmdbid="' + r.tmdbId + '"' +
      ' data-title="' + escapeAttr(r.title) + '" data-poster="' + escapeAttr(r.poster || '') + '">+ Browse episodes</button>' +
      '</div>';
  }).join('');
}

document.getElementById('channelSearchResult').addEventListener('click', (e) => {
  const btn = e.target.closest('.channelTitleBtn');
  if (!btn) return;
  browseChannelShow(btn.dataset.tmdbid, btn.dataset.title, btn.dataset.poster);
});

async function browseChannelShow(tmdbId, showName, showPoster) {
  const box = document.getElementById('channelEpisodePicker');
  box.innerHTML = '<p><small>Loading seasons\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load seasons.') + '</p>';
      return;
    }
    const poster = data.poster || showPoster || '';
    const seasonNumbers = data.seasons.map((s) => s.season).join(',');
    const seasonButtons = data.seasons.map((s) =>
      '<button type="button" class="secondary channelSeasonBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-season="' + s.season + '">' +
      escapeHtml(s.name || ('Season ' + s.season)) + ' (' + s.episodeCount + ')</button>'
    ).join(' ');
    box.innerHTML = '<p><small>Pick a season of <strong>' + escapeHtml(showName) + '</strong>, or:</small></p>' +
      '<div class="actions" style="flex-wrap:wrap; margin-bottom:10px;">' +
      '<button type="button" class="secondary channelAddAllSeasonsBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-seasons="' + seasonNumbers + '">Add every season (all episodes)</button>' +
      '</div>' +
      '<div class="actions" style="flex-wrap:wrap;">' + seasonButtons + '</div>' +
      '<div id="channelEpisodeList"></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading seasons.</p>';
  }
}

document.getElementById('channelEpisodePicker').addEventListener('click', (e) => {
  const seasonBtn = e.target.closest('.channelSeasonBtn');
  if (seasonBtn) {
    loadChannelSeasonEpisodes(
      seasonBtn.dataset.tmdbid, seasonBtn.dataset.imdbid, seasonBtn.dataset.showname,
      seasonBtn.dataset.poster, seasonBtn.dataset.season
    );
    return;
  }
  const addAllSeasonsBtn = e.target.closest('.channelAddAllSeasonsBtn');
  if (addAllSeasonsBtn) {
    addAllSeasonsToChannel(
      addAllSeasonsBtn.dataset.tmdbid, addAllSeasonsBtn.dataset.imdbid, addAllSeasonsBtn.dataset.showname,
      addAllSeasonsBtn.dataset.poster, addAllSeasonsBtn.dataset.seasons, addAllSeasonsBtn
    );
    return;
  }
  const addAllBtn = e.target.closest('.channelAddAllEpisodesBtn');
  if (addAllBtn) {
    addAllEpisodesToChannel(addAllBtn.dataset.imdbid, addAllBtn.dataset.showname, addAllBtn.dataset.poster);
    return;
  }
  const addBtn = e.target.closest('.channelAddEpisodesBtn');
  if (addBtn) {
    addCheckedEpisodesToChannel(addBtn.dataset.imdbid, addBtn.dataset.showname, addBtn.dataset.poster);
  }
});

// Fetches every season's episode list (in parallel -- server-cached anyway,
// see /api/show-episodes) and adds all of them in original broadcast order,
// for "just give me the whole show" instead of clicking through season by
// season.
async function addAllSeasonsToChannel(tmdbId, imdbId, showName, showPoster, seasonsCsv, btn) {
  const seasons = String(seasonsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seasons.length) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding every season\u2026';
  }
  try {
    const results = await Promise.all(seasons.map((season) =>
      fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season), { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => ({ season: parseInt(season, 10), episodes: data.ok ? data.episodes : [] }))
        .catch(() => ({ season: parseInt(season, 10), episodes: [] }))
    ));
    const showEpisodes = [];
    results
      .sort((a, b) => a.season - b.season)
      .forEach(({ season, episodes }) => {
        episodes.forEach((ep) => {
          showEpisodes.push({
            kind: 'episode',
            imdbId: imdbId,
            season: season,
            episode: ep.episode,
            title: (showName ? showName + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
            released: ep.released,
            thumbnail: ep.thumbnail || showPoster,
          });
        });
      });
    // Same safety caps as Quick Add Channel -- a single long-running show
    // (soap, game show, talk show, news magazine) can have thousands of
    // episodes, which is exactly what crashed Stremio the last time this
    // wasn't capped.
    let finalEpisodes = showEpisodes.length > CHANNEL_MAX_EPISODES_PER_SHOW
      ? showEpisodes.slice(-CHANNEL_MAX_EPISODES_PER_SHOW)
      : showEpisodes;
    const trimmedForShowLength = finalEpisodes.length < showEpisodes.length;
    const remainingBudget = CHANNEL_MAX_TOTAL_ITEMS - channelDraftItems.length;
    const trimmedForTotalBudget = finalEpisodes.length > remainingBudget;
    if (trimmedForTotalBudget) finalEpisodes = finalEpisodes.slice(0, Math.max(0, remainingBudget));
    finalEpisodes.forEach((it) => channelDraftItems.push(it));
    if (!channelDraftPoster) channelDraftPoster = showPoster || null;
    renderChannelDraftList();
    if (btn) {
      let label = 'Added ' + finalEpisodes.length + ' episodes \u2713';
      if (trimmedForShowLength) label = 'Added most recent ' + CHANNEL_MAX_EPISODES_PER_SHOW + ' episodes \u2713';
      if (trimmedForTotalBudget) label = 'Added ' + finalEpisodes.length + ' (channel size limit reached)';
      btn.textContent = label;
    }
  } catch (e) {
    alert('Something went wrong adding every season -- try again, or add seasons one at a time.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Add every season (all episodes)';
    }
  }
}

async function loadChannelSeasonEpisodes(tmdbId, imdbId, showName, showPoster, season) {
  const listBox = document.getElementById('channelEpisodeList');
  if (!listBox) return;
  listBox.innerHTML = '<p><small>Loading episodes\u2026</small></p>';
  try {
    const res = await fetch(
      ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season),
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (!data.ok) {
      listBox.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load episodes.') + '</p>';
      return;
    }
    const rows = data.episodes.map((ep) => {
      const epJson = escapeAttr(JSON.stringify({
        season: parseInt(season, 10), episode: ep.episode, title: ep.name, released: ep.released, thumbnail: ep.thumbnail,
      }));
      return '<label class="row quick-row" style="cursor:pointer;">' +
        '<span><input type="checkbox" class="channelEpisodeCheck" data-ep="' + epJson + '"> ' +
        'S' + season + 'E' + ep.episode + ' \u2014 ' + escapeHtml(ep.name || '') + '</span>' +
        '</label>';
    }).join('');
    listBox.innerHTML = rows +
      '<div class="actions" style="margin-top:8px;">' +
      '<button type="button" class="secondary channelAddEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '">Add checked episodes</button>' +
      '<button type="button" class="secondary channelAddAllEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '">Add all episodes</button>' +
      '</div>';
    listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    listBox.innerHTML = '<p class="testresult err">\u2717 Network error loading episodes.</p>';
  }
}

function addCheckedEpisodesToChannel(imdbId, showName, showPoster) {
  const checks = document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck:checked');
  if (!checks.length) {
    alert('Check at least one episode first.');
    return;
  }
  checks.forEach((cb) => {
    let ep;
    try {
      ep = JSON.parse(cb.dataset.ep);
    } catch (e) {
      return;
    }
    channelDraftItems.push({
      kind: 'episode',
      imdbId: imdbId,
      season: ep.season,
      episode: ep.episode,
      title: (showName ? showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.title || ('Episode ' + ep.episode)),
      released: ep.released,
      thumbnail: ep.thumbnail || showPoster,
    });
  });
  if (!channelDraftPoster) channelDraftPoster = showPoster || null;
  renderChannelDraftList();
}

// Checks every episode box for the currently-loaded season, then reuses
// addCheckedEpisodesToChannel above rather than duplicating its logic.
function addAllEpisodesToChannel(imdbId, showName, showPoster) {
  document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck').forEach((cb) => {
    cb.checked = true;
  });
  addCheckedEpisodesToChannel(imdbId, showName, showPoster);
}

function renderChannelDraftList() {
  const box = document.getElementById('channelDraftList');
  const badge = document.getElementById('channelDraftCountBadge');
  if (badge) badge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ' picked)' : '';
  const picksBadge = document.getElementById('channelDraftPicksCountBadge');
  if (picksBadge) picksBadge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ')' : '';
  if (!channelDraftItems.length) {
    box.innerHTML = '<p><small>Nothing added yet -- search above to get started.</small></p>';
    return;
  }
  box.innerHTML = channelDraftItems.map((it, i) => {
    const label = it.kind === 'movie'
      ? escapeHtml(it.title) + (it.year ? ' (' + escapeHtml(it.year) + ')' : '') + ' \u2014 Movie'
      : escapeHtml(it.title) + ' \u2014 S' + it.season + 'E' + it.episode;
    return '<div class="row quick-row channel-pick" data-idx="' + i + '" style="align-items:center; flex-wrap:nowrap;">' +
      '<span class="drag-handle" draggable="true" style="cursor:grab; touch-action:none; padding:6px;">\u2630</span>' +
      '<input type="number" class="pos channelPosInput" min="1" max="' + channelDraftItems.length + '" value="' + (i + 1) + '" style="width:60px; flex:none;" title="Type a position to move this pick there">' +
      '<span style="flex:1;">' + label + '</span>' +
      '<button type="button" class="movebtn secondary channelMoveBtn" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>\u2191</button>' +
      '<button type="button" class="movebtn secondary channelMoveBtn" data-dir="1"' + (i === channelDraftItems.length - 1 ? ' disabled' : '') + '>\u2193</button>' +
      '<button type="button" class="secondary channelRemovePickBtn">Remove</button>' +
      '</div>';
  }).join('');
  document.querySelectorAll('#channelDraftList .drag-handle').forEach((h) => initChannelTouchDrag(h));
}

// A channel built from a whole show (or several) can easily run into the
// hundreds of picks -- letting someone clear the slate in one click beats
// hitting Remove hundreds of times to start over.
function removeAllChannelDraftPicks() {
  if (!channelDraftItems.length) return;
  if (!confirm('Remove all ' + channelDraftItems.length + ' picks? This can\\'t be undone.')) return;
  channelDraftItems = [];
  renderChannelDraftList();
}

document.getElementById('channelDraftList').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.channelRemovePickBtn');
  if (removeBtn) {
    const row = removeBtn.closest('.channel-pick');
    const idx = parseInt(row.dataset.idx, 10);
    channelDraftItems.splice(idx, 1);
    renderChannelDraftList();
    return;
  }
  const moveBtn = e.target.closest('.channelMoveBtn');
  if (moveBtn) {
    const row = moveBtn.closest('.channel-pick');
    const idx = parseInt(row.dataset.idx, 10);
    const swapWith = idx + parseInt(moveBtn.dataset.dir, 10);
    if (swapWith < 0 || swapWith >= channelDraftItems.length) return;
    const tmp = channelDraftItems[idx];
    channelDraftItems[idx] = channelDraftItems[swapWith];
    channelDraftItems[swapWith] = tmp;
    renderChannelDraftList();
  }
});

// Lets someone type a new position directly into a pick's number box
// instead of clicking the up arrow repeatedly -- same idea as
// movePosTo()/the Custom List draft's own position input, adapted for
// this array-backed draft.
document.getElementById('channelDraftList').addEventListener('change', (e) => {
  const posInput = e.target.closest('.channelPosInput');
  if (!posInput) return;
  const row = posInput.closest('.channel-pick');
  const from = parseInt(row.dataset.idx, 10);
  const typed = parseInt(posInput.value, 10);
  if (!typed || isNaN(typed)) {
    renderChannelDraftList();
    return;
  }
  const to = Math.min(Math.max(typed, 1), channelDraftItems.length) - 1;
  if (to === from) {
    renderChannelDraftList();
    return;
  }
  const [item] = channelDraftItems.splice(from, 1);
  channelDraftItems.splice(to, 0, item);
  renderChannelDraftList();
});

// Mouse drag-and-drop -- same live-DOM-reorder-then-read-back-order
// technique the Custom List draft's own drag uses (see
// reorderCustomListDraftFromDom's own comment for the full rationale),
// adapted for channelDraftItems/.channel-pick instead.
let channelDragRow = null;

document.getElementById('channelDraftList').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) { e.preventDefault(); return; }
  channelDragRow = handle.closest('.channel-pick');
  channelDragRow.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('channelDraftList').addEventListener('dragend', () => {
  if (channelDragRow) channelDragRow.classList.remove('dragging');
  channelDragRow = null;
  reorderChannelDraftFromDom();
});

document.getElementById('channelDraftList').addEventListener('dragover', (e) => {
  if (!channelDragRow) return;
  e.preventDefault();
  const container = document.getElementById('channelDraftList');
  const afterEl = getChannelDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(channelDragRow);
  } else if (afterEl !== channelDragRow) {
    container.insertBefore(channelDragRow, afterEl);
  }
});

function getChannelDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.channel-pick:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    }
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

function reorderChannelDraftFromDom() {
  const container = document.getElementById('channelDraftList');
  const rows = [...container.querySelectorAll('.channel-pick')];
  channelDraftItems = rows.map((row) => channelDraftItems[parseInt(row.dataset.idx, 10)]);
  renderChannelDraftList();
}

// Touch/pen drag-to-reorder -- native HTML5 drag-and-drop above generally
// doesn't fire on touch devices at all; the \u2191/\u2193 buttons and
// editable position number both still work fine on touch regardless.
let channelTouchDragRow = null;

function initChannelTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    channelTouchDragRow = handle.closest('.channel-pick');
    channelTouchDragRow.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onChannelTouchDragMove);
    document.addEventListener('pointerup', onChannelTouchDragEnd, { once: true });
    document.addEventListener('pointercancel', onChannelTouchDragEnd, { once: true });
  });
}

function onChannelTouchDragMove(e) {
  if (!channelTouchDragRow) return;
  const container = document.getElementById('channelDraftList');
  const afterEl = getChannelDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(channelTouchDragRow);
  } else if (afterEl !== channelTouchDragRow) {
    container.insertBefore(channelTouchDragRow, afterEl);
  }
}

function onChannelTouchDragEnd() {
  document.removeEventListener('pointermove', onChannelTouchDragMove);
  if (channelTouchDragRow) channelTouchDragRow.classList.remove('dragging');
  channelTouchDragRow = null;
  reorderChannelDraftFromDom();
}

// One-time shuffle of the picks *while building* -- separate from the
// "Randomize play order" checkbox below, which reshuffles the saved
// channel itself once a day. This one just saves having to drag everything
// into a random order by hand before saving.
function shuffleChannelDraft() {
  if (channelDraftItems.length < 2) return;
  for (let i = channelDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = channelDraftItems[i];
    channelDraftItems[i] = channelDraftItems[j];
    channelDraftItems[j] = tmp;
  }
  renderChannelDraftList();
}

// Set by editChannel below while an existing channel's picks are loaded
// into the draft for editing; null means "Save" creates a brand new
// channel, same as always.
let editingChannelUrlInput = null;

function saveChannel() {
  const nameInput = document.getElementById('channelNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this channel first.');
    return;
  }
  if (!channelDraftItems.length) {
    alert('Add at least one episode or movie first.');
    return;
  }
  const poster = channelDraftPoster || (channelDraftItems[0] && channelDraftItems[0].thumbnail) || null;
  const shuffle = document.getElementById('channelRandomizeCheck').checked;

  if (editingChannelUrlInput) {
    // Update in place: reuse the channel's existing channelId so any
    // merged siblings (see mergeChannelsIntoRow) and its own already-
    // generated meta id keep resolving to the same channel, just with
    // fresh contents.
    const oldPayload = parseChannelPayloadClient(editingChannelUrlInput.value) || {};
    const channelId = oldPayload.channelId || generateChannelId();
    const payload = { channelId: channelId, name: name, poster: poster, items: channelDraftItems, shuffle: shuffle };
    const newUrl = 'channel:v1:' + JSON.stringify(payload);
    const sourceRow = editingChannelUrlInput.closest('.source-row');
    if (sourceRow) sourceRow.outerHTML = channelSourceRowHtml(newUrl);
    // A row holding just this one channel also uses its own name as the
    // row's name -- keep those in sync. A merged row's name is the shared
    // shelf name instead, so that's left alone.
    const rowDiv = editingChannelUrlInput.closest('.entry');
    if (rowDiv && rowDiv.querySelectorAll('.url').length === 1) {
      const rowNameInput = rowDiv.querySelector('.name');
      if (rowNameInput) rowNameInput.value = name;
    }
    editingChannelUrlInput = null;
    renumber();
    checkAllDuplicateUrls();
    saveState();
    alert('Channel "' + name + '" updated.');
  } else {
    // channelId AND name are both embedded in the payload itself (not just
    // the row's own id/name) so this channel keeps its own identity even if
    // it's later merged with other channels into one row -- see
    // mergeChannelsIntoRow, where multiple channel payloads get newline-
    // joined into a single entry's url and fetched independently server-
    // side. In that context there's no single "entry.id"/"entry.name" to
    // fall back on for any individual channel -- only the merged row's own,
    // which every channel in it would otherwise incorrectly share.
    const channelId = generateChannelId();
    const payload = { channelId: channelId, name: name, poster: poster, items: channelDraftItems, shuffle: shuffle };
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    alert('Channel "' + name + '" added to your list below.');
  }

  channelDraftItems = [];
  channelDraftPoster = null;
  nameInput.value = '';
  document.getElementById('channelRandomizeCheck').checked = false;
  document.getElementById('channelSearchInput').value = '';
  document.getElementById('channelSearchResult').innerHTML = '';
  document.getElementById('channelEpisodePicker').innerHTML = '';
  renderChannelDraftList();
  renderChannelMergeList();
  updateChannelSaveButtonLabel();
}

// Loads an existing channel's picks back into the draft picker so they can
// be adjusted and saved back over the same channel, instead of needing to
// delete and rebuild it from scratch.
function editChannel(btnOrRow) {
  const sourceRow = btnOrRow.closest ? btnOrRow.closest('.source-row') || btnOrRow : btnOrRow;
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this channel to edit it.');
    return;
  }
  const payload = parseChannelPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this channel to edit it.');
    return;
  }
  channelDraftItems = (payload.items || []).slice();
  channelDraftPoster = payload.poster || null;
  document.getElementById('channelNameInput').value = payload.name || '';
  document.getElementById('channelRandomizeCheck').checked = !!payload.shuffle;
  editingChannelUrlInput = urlInput;
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  
  const picksDetails = document.getElementById('channelDraftPicksDetails');
  if (picksDetails) picksDetails.open = false;

  window.scrollTo({ top: document.getElementById('catalogsSubChannels').offsetTop - 20, behavior: 'smooth' });
  const searchInput = document.getElementById('channelSearchInput');
  if (searchInput) searchInput.focus();
}

function renderMyCreatedChannelsList() {
  const box = document.getElementById('myCreatedChannelsList');
  if (!box) return;
  const rows = [...document.querySelectorAll('#lists .entry')].filter((div) =>
    [...div.querySelectorAll('.url')].some((el) => el.value.trim().startsWith('channel:v1:'))
  );
  if (!rows.length) {
    box.innerHTML = '<p><small>No created channels yet.</small></p>';
    return;
  }
  box.innerHTML = rows.map((div, i) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl && nameEl.value.trim()) || 'Untitled channel';
    const channelCount = [...div.querySelectorAll('.url')].filter((el) => el.value.trim().startsWith('channel:v1:')).length;
    const label = channelCount > 1
      ? escapeHtml(name) + ' (Combined: ' + channelCount + ' channels)'
      : escapeHtml(name);
    
    // We assign an ID to the row so we can reliably find it when Edit or Delete is clicked
    if (!div.id) div.id = 'channel-row-' + i + '-' + Date.now();
    
    return '<div class="row quick-row" style="display:flex; justify-content:space-between; align-items:center;">' +
      '<div style="font-weight:600; font-size:0.9rem; flex:1;">' + label + '</div>' +
      '<div class="actions" style="flex-wrap:nowrap; gap:8px;">' +
        '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="editChannel(document.getElementById(&quot;' + div.id + '&quot;).querySelector(&quot;.source-row&quot;))">Edit</button>' +
        '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--red);" onclick="document.getElementById(&quot;' + div.id + '&quot;).remove(); saveState(); renderMyCreatedChannelsList(); renderChannelMergeList();">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function cancelEditChannel() {
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  document.getElementById('channelNameInput').value = '';
  document.getElementById('channelRandomizeCheck').checked = false;
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  const picksDetails = document.getElementById('channelDraftPicksDetails');
  if (picksDetails) picksDetails.open = true;
}

// Swaps the Save button's label/behavior hint between "new channel" and
// "updating an existing one", and shows/hides the Cancel-edit button next
// to it, so it's obvious which mode the picker is in.
function updateChannelSaveButtonLabel() {
  const saveBtn = document.getElementById('channelSaveBtn');
  const cancelBtn = document.getElementById('channelCancelEditBtn');
  if (!saveBtn) return;
  if (editingChannelUrlInput) {
    saveBtn.textContent = 'Save changes to this Channel';
    if (cancelBtn) cancelBtn.style.display = '';  } else {
    saveBtn.textContent = 'Save as a Channel';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

document.querySelectorAll('.channelQuickAddBtn').forEach((btn) => {
  btn.addEventListener('click', () => quickAddChannel(btn.dataset.name, btn.dataset.listurl || null, btn.dataset.networkid || null, btn));
});

// Builds a whole channel automatically from either a curated mdblist.com
// show list or a TMDB network id directly: resolves every show to TMDB
// (one request, server-side -- see /api/quick-channel-shows), then walks
// each show's seasons/episodes via the same /api/show-seasons +
// /api/show-episodes endpoints the manual picker uses. Deliberately
// sequential across shows (one at a time, each show's own seasons fetched
// in parallel) rather than firing everything at once -- slower, but keeps
// a live "show 4 of 18" status line honest and avoids hammering either
// this Worker or TMDB with a burst of concurrent requests for a large
// lineup.
// Stremio has been observed to crash outright on a channel with 100,000+
// episodes -- a full network lineup list can include a handful of decades-
// long-running game shows, talk shows, or soaps that alone contribute
// thousands of episodes each, and nothing here was capping that. These two
// limits keep any single show from dominating a channel, and keep the
// channel's overall size well under whatever broke last time, with a
// comfortable safety margin.
const CHANNEL_MAX_EPISODES_PER_SHOW = 50;
const CHANNEL_MAX_TOTAL_ITEMS = 2000;
// Quick Add Channel (network-id based) stores a bigger pool than what's
// ever shown and marks the payload for daily rotation (see dailyRotate
// below and buildChannelMeta server-side) -- the server picks a fresh
// day's lineup from this pool on a schedule, so the channel's actual
// lineup changes over time instead of being permanently fixed to whatever
// happened to build first. This is the storage-side cap for that pool;
// CHANNEL_MAX_TOTAL_ITEMS above stays the safe upper bound (and the only
// cap that applies to the manual "Add every season" button, which has no
// pool/rotation concept).
const CHANNEL_POOL_MAX_ITEMS = 6000;
// What a rotating day's lineup actually looks like -- must match
// CHANNEL_ROTATION_SHOWS_PER_DAY / CHANNEL_ROTATION_EPISODES_PER_SHOW
// server-side. Used here only for display text (the real selection logic
// lives in buildChannelMeta).
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

async function quickAddChannel(name, listUrl, networkId, btn) {
  const statusBox = document.getElementById('channelQuickAddStatus');
  // Restored on the way out below -- this is called both from the fixed
  // Quick Add network buttons ("Quick Add CBS") and from "Import from
  // link", each with its own resting label, so hardcoding one back would
  // leave the other mislabeled after its first use.
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building ' + name + '\u2026';
  }
  if (statusBox) statusBox.innerHTML = '<p><small>Fetching ' + escapeHtml(name) + ' show list\u2026</small></p>';
  try {
    let params = networkId ? 'networkId=' + encodeURIComponent(networkId) : 'url=' + encodeURIComponent(listUrl);
    if (!networkId) {
      // Only the link-import path needs these -- a curated network id never
      // touches a personal mdblist/Trakt list, but a pasted link might be a
      // private one.
      const keys = collectKeys();
      if (keys.mdblistKey) params += '&mdblistKey=' + encodeURIComponent(keys.mdblistKey);
      if (keys.traktKey) params += '&traktKey=' + encodeURIComponent(keys.traktKey);
      if (keys.traktAccessToken) params += '&traktAccessToken=' + encodeURIComponent(keys.traktAccessToken);
    }
    const res = await fetch(ORIGIN + '/api/quick-channel-shows?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not build ' + name + ': ' + (data.error || 'unknown error'));
      return;
    }
    // Shuffled so repeated clicks surface different shows -- otherwise the
    // total-item cap below always cuts off at the same point in list order,
    // meaning the same handful of shows (whatever happens to sort first)
    // would win every single time.
    const shows = data.shows.slice();
    for (let i = shows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shows[i];
      shows[i] = shows[j];
      shows[j] = tmp;
    }
    const items = [];
    // Used to be routed through /api/logo-pad, an SVG that referenced the
    // network's logo (CBS eye, NBC peacock, etc.) by URL and drew it
    // smaller within a padded frame -- looked fine in this page's own Live
    // Preview (a real browser will happily fetch that nested image), but
    // wako and Stremio's own apps never actually loaded it, since neither
    // one's meta-poster pipeline fetches/renders an SVG that itself points
    // at another remote image. Using the network's logo URL directly here
    // instead -- exactly the same kind of plain TMDB image URL every other
    // poster in this add-on already uses successfully -- trades away the
    // padded/shrunk look for actually showing up everywhere.
    let poster = data.networkLogo || null;
    let showsIncluded = 0;
    let showsTrimmed = 0;
    let stoppedEarly = false;
    for (let i = 0; i < shows.length; i++) {
      if (items.length >= CHANNEL_POOL_MAX_ITEMS) {
        stoppedEarly = true;
        break;
      }
      const show = shows[i];
      if (statusBox) {
        statusBox.innerHTML = '<p><small>Building ' + escapeHtml(name) + '\u2026 show ' + (i + 1) + ' of ' + shows.length +
          ' (' + escapeHtml(show.name) + ')</small></p>';
      }
      if (!poster && show.poster) poster = show.poster;
      try {
        const seasonsRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(show.tmdbId), { cache: 'no-store' });
        const seasonsData = await seasonsRes.json();
        if (!seasonsData.ok) continue;
        const seasonResults = await Promise.all(seasonsData.seasons.map((s) =>
          fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(show.tmdbId) + '&season=' + encodeURIComponent(s.season), { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => ({ season: s.season, episodes: d.ok ? d.episodes : [] }))
            .catch(() => ({ season: s.season, episodes: [] }))
        ));
        const showEpisodes = [];
        seasonResults
          .sort((a, b) => a.season - b.season)
          .forEach(({ season, episodes }) => {
            episodes.forEach((ep) => {
              showEpisodes.push({
                kind: 'episode',
                imdbId: show.imdbId,
                season: season,
                episode: ep.episode,
                title: (show.name ? show.name + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
                released: ep.released,
                thumbnail: ep.thumbnail || show.poster,
              });
            });
          });
        // A show that's run for decades (soaps, game shows, talk shows,
        // news magazines) can rack up thousands of episodes on its own --
        // keep the most recent ones rather than pulling in its entire
        // history wholesale.
        let finalShowEpisodes = showEpisodes.length > CHANNEL_MAX_EPISODES_PER_SHOW
          ? showEpisodes.slice(-CHANNEL_MAX_EPISODES_PER_SHOW)
          : showEpisodes;
        if (finalShowEpisodes.length < showEpisodes.length) showsTrimmed++;
        const remainingBudget = CHANNEL_POOL_MAX_ITEMS - items.length;
        if (finalShowEpisodes.length > remainingBudget) {
          finalShowEpisodes = finalShowEpisodes.slice(0, remainingBudget);
          stoppedEarly = true;
        }
        if (finalShowEpisodes.length) showsIncluded++;
        items.push(...finalShowEpisodes);
      } catch (e) {
        // One show failing (network hiccup, no seasons data, etc.) shouldn't
        // abort the whole channel -- just skip it and keep going.
        continue;
      }
    }
    if (!items.length) {
      alert('Could not build ' + name + ' -- no episodes were found.');
      return;
    }
    const channelId = generateChannelId();
    // dailyRotate: the server picks a fresh random 2000-item slice of this
    // stored pool each day (see buildChannelMeta) rather than always
    // showing the exact same fixed set -- so the actual lineup someone
    // sees changes over time, drawn from everything gathered here.
    const payload = { channelId: channelId, name: name, poster: poster, items: items, shuffle: false, dailyRotate: true };
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    renderChannelMergeList();
    let summary = name + ' channel added \u2014 ' + items.length + ' episodes across ' + showsIncluded + ' show(s) gathered. ' +
      'It\\'ll show ' + CHANNEL_ROTATION_SHOWS_PER_DAY + ' shows \u00d7 ' + CHANNEL_ROTATION_EPISODES_PER_SHOW + ' episodes each from that pool, refreshed daily.';
    if (showsTrimmed) summary += ' ' + showsTrimmed + ' long-running show(s) were trimmed to their most recent ' + CHANNEL_MAX_EPISODES_PER_SHOW + ' episodes.';
    if (stoppedEarly) summary += ' Stopped gathering early to keep the pool a safe size (some shows in the list weren\\'t included).';
    alert(summary);
  } catch (e) {
    alert('Network error while building ' + name + '.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
    if (statusBox) statusBox.innerHTML = '';
  }
}

// Companion to the fixed Quick Add network buttons above -- same
// quickAddChannel machinery, just fed a pasted list link instead of a
// TMDB network id. The server side (/api/quick-channel-shows) requests
// type "series" from that link regardless of source, so any movies mixed
// into the list are silently dropped rather than erroring out.
async function importChannelFromLink(btn) {
  const urlInput = document.getElementById('channelImportUrlInput');
  const nameInput = document.getElementById('channelImportNameInput');
  const listUrl = urlInput.value.trim();
  const name = nameInput.value.trim();
  if (!listUrl) {
    alert('Paste a list URL first.');
    return;
  }
  if (!name) {
    alert('Name this channel first.');
    return;
  }
  await quickAddChannel(name, listUrl, null, btn);
  urlInput.value = '';
  nameInput.value = '';
}


//
// A channel is already just one item (one poster tile) in whatever catalog
// it belongs to -- so putting several channels side by side in one shelf is
// the exact same "merge multiple sources into one row" mechanism every
// other list type here already uses (newline-joined urls, fanned out and
// concatenated by fetchMergedCatalog server-side). This just needs a UI for
// picking which already-saved channels to fold together.
let channelMergeRows = [];

function renderChannelMergeList() {
  renderMyCreatedChannelsList();
  const box = document.getElementById('channelMergeList');
  if (!box) return;
  const selectAllCheck = document.getElementById('channelMergeSelectAllCheck');
  if (selectAllCheck) selectAllCheck.checked = false;
  const rows = [...document.querySelectorAll('#lists .entry')].filter((div) =>
    [...div.querySelectorAll('.url')].some((el) => el.value.trim().startsWith('channel:v1:'))
  );
  channelMergeRows = rows;
  if (!rows.length) {
    box.innerHTML = '<p><small>No saved channels yet -- build one above first.</small></p>';
    return;
  }
  box.innerHTML = rows.map((div, i) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl && nameEl.value.trim()) || 'Untitled channel';
    const channelCount = [...div.querySelectorAll('.url')].filter((el) => el.value.trim().startsWith('channel:v1:')).length;
    const label = channelCount > 1
      ? escapeHtml(name) + ' (' + channelCount + ' channels already merged here)'
      : escapeHtml(name);
    return '<label class="row quick-row" style="cursor:pointer;">' +
      '<span><input type="checkbox" class="channelMergeCheck" data-rowidx="' + i + '"> ' + label + '</span>' +
      '</label>';
  }).join('');
}

// Bulk-checks (or unchecks) every saved channel in the merge list -- the
// individual checkboxes get wiped out on every renderChannelMergeList()
// re-render, so this checkbox is reset there too rather than trying to
// track a stale "was everything checked" state across a refresh.
function toggleAllChannelMergeChecks(checkbox) {
  document.querySelectorAll('#channelMergeList .channelMergeCheck').forEach((cb) => {
    cb.checked = checkbox.checked;
  });
}

function mergeChannelsIntoRow() {
  const checks = document.querySelectorAll('#channelMergeList .channelMergeCheck:checked');
  if (checks.length < 2) {
    alert('Check at least two channels to merge.');
    return;
  }
  const nameInput = document.getElementById('channelMergeNameInput');
  const combinedName = nameInput.value.trim();
  if (!combinedName) {
    alert('Name the combined shelf first.');
    return;
  }
  const selectedRows = [...checks].map((cb) => channelMergeRows[parseInt(cb.dataset.rowidx, 10)]).filter(Boolean);
  const urls = [];
  selectedRows.forEach((div) => {
    [...div.querySelectorAll('.url')].forEach((el) => {
      const v = el.value.trim();
      if (v.startsWith('channel:v1:')) urls.push(v);
    });
  });
  if (!urls.length) {
    alert('Could not read those channels -- try refreshing the list and try again.');
    return;
  }
  // The originals are folded into the new merged row, so they'd otherwise
  // just be exact duplicates left behind -- same brief-undo safety net as
  // any other row removal, in case this was a misclick.
  captureUndoSnapshot();
  selectedRows.forEach((div) => div.remove());
  addRow(combinedName, urls.join('\\n'), 'series', true, 'Channels');
  nameInput.value = '';
  renumber();
  checkAllDuplicateUrls();
  renderChannelMergeList();
  showUndoToast('Merged ' + urls.length + ' channel(s) into "' + combinedName + '".');
}






// --- Custom Lists ---------------------------------------------------------------
//
// A hand-picked list of movies OR shows (not both -- see customListDraftType):
// each pick is saved as-is, no episode-picker step, and the resulting shelf is
// just multiple normal catalog tiles rather than one synthetic item -- see
// fetchCustomListCatalog server-side for why that's the deliberate design.
let customListDraftItems = [];
let customListDraftType = 'movie'; // 'movie' or 'series', set by user toggle

// Skips the search-and-pick draft entirely -- copyListToCustomList already
// does exactly "fetch this list's items and save them as a Custom List"
// (splitting into "(Movies)"/"(Shows)" lists on its own if the source turns
// out to be mixed), same machinery the My Lists/Search Lists panels' own
// "Copy to Custom List" buttons use, just fed a freely-pasted link and a
// name instead of a link the client already had metadata for.
async function importCustomListFromLink(btn) {
  const urlInput = document.getElementById('customListImportUrlInput');
  const nameInput = document.getElementById('customListImportNameInput');
  const listUrl = urlInput.value.trim();
  if (!listUrl) {
    alert('Paste a list URL first.');
    return;
  }
  const name = nameInput.value.trim() || guessNameFromUrl(listUrl);
  await copyListToCustomList(name, listUrl, 'unknown', btn);
  urlInput.value = '';
  nameInput.value = '';
}

async function runCustomListSearch() {
  const q = document.getElementById('customListSearchInput').value.trim();
  const searchType = document.getElementById('customListSearchType').value; // 'movie' or 'tv'
  const box = document.getElementById('customListSearchResult');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=' + searchType, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderCustomListSearchResults(data.results, searchType);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderCustomListSearchResults(results, searchType) {
  const box = document.getElementById('customListSearchResult');
  if (!results.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No matches found.</small></p>';
    return;
  }
  const cardsHtml = results.map((r) => {
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy">'
      : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;">No poster</div>';
    return '<div class="custom-list-search-item" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0;">' +
      posterImg +
      '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(r.title) + '">' +
        escapeHtml(r.title) +
      '</div>' +
      (r.year ? '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px;">' + escapeHtml(r.year) + '</div>' : '<div style="height:14px; margin-bottom:4px;"></div>') +
      '<button type="button" class="lc-btn secondary customListAddBtn" style="width:100%; padding:4px 6px; font-size:0.75rem;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-searchtype="' + searchType + '"' +
      ' data-title="' + escapeAttr(r.title) + '" data-year="' + escapeAttr(r.year || '') + '"' +
      ' data-poster="' + escapeAttr(r.poster || '') + '">+ Add</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
}

document.getElementById('customListSearchResult').addEventListener('click', (e) => {
  const btn = e.target.closest('.customListAddBtn');
  if (!btn) return;
  addToCustomListDraft(btn.dataset.searchtype, btn.dataset.tmdbid, btn.dataset.title, btn.dataset.year, btn.dataset.poster, btn);
});

async function addToCustomListDraft(searchType, tmdbId, title, year, poster, btn) {
  const itemType = searchType === 'tv' ? 'series' : 'movie';
  if (customListDraftType && customListDraftType !== itemType) {
    alert('This list is set to ' + (customListDraftType === 'movie' ? 'Movies' : 'Shows') + ' -- start a new list (or save/clear this one first) to add a ' + (itemType === 'movie' ? 'movie' : 'show') + '.');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding\u2026';
  }
  try {
    const endpoint = itemType === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
    const res = await fetch(ORIGIN + endpoint + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not add "' + title + '": ' + (data.error || 'unknown error'));
      if (btn) {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
      return;
    }
    customListDraftItems.push({
      imdbId: data.imdbId,
      title: title,
      year: year || undefined,
      poster: poster || undefined,
    });
    customListDraftType = itemType;
    updateCustomListTypeRadio(itemType);
    renderCustomListDraftList();
    if (btn) btn.textContent = 'Added \u2713';
  } catch (e) {
    alert('Network error adding "' + title + '".');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ Add';
    }
  }
}

function renderCustomListDraftList() {
  const box = document.getElementById('customListDraftList');
  const badge = document.getElementById('customListDraftCountBadge');
  if (badge) badge.textContent = customListDraftItems.length ? '(' + customListDraftItems.length + ' picked)' : '';
  if (!customListDraftItems.length) {
    box.innerHTML = '<p><small>Nothing added yet -- search above to get started.</small></p>';
    return;
  }
  box.innerHTML = customListDraftItems.map((it, i) => {
    const label = escapeHtml(it.title || it.name || 'Untitled') + (it.year ? ' (' + escapeHtml(it.year) + ')' : '');
    const idStr = it.imdbId || it.id || '';
    const onClickStr = idStr ? ' onclick="showItemDetails(&quot;' + escapeAttr(idStr) + '&quot;, &quot;' + escapeAttr(customListDraftType || 'movie') + '&quot;)"' : '';
    const posterImg = it.poster
      ? '<img src="' + escapeAttr(it.poster) + '" alt="" loading="lazy" class="custom-list-pick-poster"' + onClickStr + '>'
      : '<span class="custom-list-pick-poster empty-poster"></span>';
    return '<div class="custom-list-pick" data-idx="' + i + '" style="display:flex; flex-direction:row; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px; width:100%;">' +
      '<span class="drag-handle" draggable="true" style="cursor:grab; touch-action:none; padding:6px; flex:none;">\u2630</span>' +
      '<input type="number" class="pos customListPosInput" min="1" max="' + customListDraftItems.length + '" value="' + (i + 1) + '" style="width:50px; flex:none; text-align:center;" title="Type a position to move this pick there">' +
      posterImg +
      '<span style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + escapeAttr(label) + '">' + label + '</span>' +
      '<button type="button" class="movebtn secondary customListMoveBtn" data-dir="-1"' + (i === 0 ? ' disabled' : '') + ' style="flex:none; padding:8px;">\u2191</button>' +
      '<button type="button" class="movebtn secondary customListMoveBtn" data-dir="1"' + (i === customListDraftItems.length - 1 ? ' disabled' : '') + ' style="flex:none; padding:8px;">\u2193</button>' +
      '<button type="button" class="secondary customListRemovePickBtn" style="flex:none; padding:8px 12px;">Remove</button>' +
      '</div>';
  }).join('');
  document.querySelectorAll('#customListDraftList .drag-handle').forEach((h) => initCustomListTouchDrag(h));
}

document.getElementById('customListDraftList').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.customListRemovePickBtn');
  if (removeBtn) {
    const row = removeBtn.closest('.custom-list-pick');
    const idx = parseInt(row.dataset.idx, 10);
    customListDraftItems.splice(idx, 1);
    renderCustomListDraftList();
    return;
  }
  const moveBtn = e.target.closest('.customListMoveBtn');
  if (moveBtn) {
    const row = moveBtn.closest('.custom-list-pick');
    const idx = parseInt(row.dataset.idx, 10);
    const swapWith = idx + parseInt(moveBtn.dataset.dir, 10);
    if (swapWith < 0 || swapWith >= customListDraftItems.length) return;
    const tmp = customListDraftItems[idx];
    customListDraftItems[idx] = customListDraftItems[swapWith];
    customListDraftItems[swapWith] = tmp;
    renderCustomListDraftList();
  }
});

// Lets someone type a new position directly into a pick's number box
// instead of clicking the up arrow repeatedly -- same idea as movePosTo()
// for the main list, adapted for this array-backed draft.
document.getElementById('customListDraftList').addEventListener('change', (e) => {
  const posInput = e.target.closest('.customListPosInput');
  if (!posInput) return;
  const row = posInput.closest('.custom-list-pick');
  const from = parseInt(row.dataset.idx, 10);
  const typed = parseInt(posInput.value, 10);
  if (!typed || isNaN(typed)) {
    renderCustomListDraftList();
    return;
  }
  const to = Math.min(Math.max(typed, 1), customListDraftItems.length) - 1;
  if (to === from) {
    renderCustomListDraftList();
    return;
  }
  const [item] = customListDraftItems.splice(from, 1);
  customListDraftItems.splice(to, 0, item);
  renderCustomListDraftList();
});

// Mouse drag-and-drop -- same live-DOM-reorder-then-read-back-order
// technique the main list's drag uses, adapted for this array-backed
// draft rather than persistent .entry elements: rows move around freely
// during the drag, and the final DOM order (via each row's data-idx,
// which still points at its ORIGINAL array index) gets read back into
// customListDraftItems once the drag ends.
let customListDragRow = null;

document.getElementById('customListDraftList').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) { e.preventDefault(); return; }
  customListDragRow = handle.closest('.custom-list-pick');
  customListDragRow.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('customListDraftList').addEventListener('dragend', () => {
  if (customListDragRow) customListDragRow.classList.remove('dragging');
  customListDragRow = null;
  const container = document.getElementById('customListDraftList');
  const newOrder = [...container.querySelectorAll('.custom-list-pick')].map((r) => customListDraftItems[parseInt(r.dataset.idx, 10)]);
  customListDraftItems = newOrder;
  renderCustomListDraftList();
});

document.getElementById('customListDraftList').addEventListener('dragover', (e) => {
  if (!customListDragRow) return;
  e.preventDefault();
  const container = document.getElementById('customListDraftList');
  const afterEl = getCustomListDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(customListDragRow);
  } else if (afterEl !== customListDragRow) {
    container.insertBefore(customListDragRow, afterEl);
  }
});

function getCustomListDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.custom-list-pick:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

// position number both still work fine on touch regardless.
let customListTouchDragRow = null;

function initCustomListTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    customListTouchDragRow = handle.closest('.custom-list-pick');
    customListTouchDragRow.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onCustomListTouchDragMove);
    document.addEventListener('pointerup', onCustomListTouchDragEnd, { once: true });
    document.addEventListener('pointercancel', onCustomListTouchDragEnd, { once: true });
  });
}

function onCustomListTouchDragMove(e) {
  if (!customListTouchDragRow) return;
  const container = document.getElementById('customListDraftList');
  const afterEl = getCustomListDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(customListTouchDragRow);
  } else if (afterEl !== customListTouchDragRow) {
    container.insertBefore(customListTouchDragRow, afterEl);
  }
}

function onCustomListTouchDragEnd() {
  document.removeEventListener('pointermove', onCustomListTouchDragMove);
  if (customListTouchDragRow) customListTouchDragRow.classList.remove('dragging');
  customListTouchDragRow = null;
  reorderCustomListDraftFromDom();
}

function shuffleCustomListDraft() {
  if (customListDraftItems.length < 2) return;
  for (let i = customListDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = customListDraftItems[i];
    customListDraftItems[i] = customListDraftItems[j];
    customListDraftItems[j] = tmp;
  }
  renderCustomListDraftList();
}

// Set by editCustomList below while an existing Custom List's picks are
// loaded into the draft for editing; null means "Save" creates a brand
// new list, same as always.
let editingCustomListUrlInput = null;

// Carries a stable id across an edit (see editCustomList) so a shuffled
// list's daily reshuffle seed stays consistent rather than resetting every
// time it's edited -- same reasoning as a Channel's channelId, and needed
// for the same reason: this list could end up merged with others into one
// row (the ordinary merge-into-one-shelf mechanism, not a dedicated
// feature here), where there's no outer entry.id to fall back on for any
// individual list's own seed.
let customListDraftListId = null;

function saveCustomList() {
  const nameInput = document.getElementById('customListNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this list first.');
    return;
  }

  if (editingCreatorListSlug) {
    saveCreatorListEdit(name);
    return;
  }
  if (editingLocalCustomListSlug) {
    saveLocalCustomListEdit(name);
    return;
  }

  const shuffle = document.getElementById('customListRandomizeCheck').checked;
  const listId = customListDraftListId || generateChannelId();
  // Allow empty lists -- type defaults to 'movie' if nothing was added yet
  const listType = customListDraftType || 'movie';
  const payload = { listId: listId, type: listType, items: customListDraftItems, shuffle: shuffle };
  const newUrl = 'customlist:v1:' + JSON.stringify(payload);

  // Locate (or create) the row's actual DOM node so it can be handed
  // straight into the save flow below -- using replaceWith + a direct
  // reference to the freshly-parsed node, rather than outerHTML + a stale
  // reference, since pendingSaveListContext needs a node still attached to
  // the document when the save flow eventually writes the published URL
  // back into it.
  let sourceRow;
  if (editingCustomListUrlInput) {
    const oldSourceRow = editingCustomListUrlInput.closest('.source-row');
    const temp = document.createElement('div');
    temp.innerHTML = customListSourceRowHtml(newUrl);
    sourceRow = temp.firstElementChild;
    if (oldSourceRow) oldSourceRow.replaceWith(sourceRow);
    // A row holding just this one Custom List also uses its own name as
    // the row's name -- keep those in sync. A merged row's name is the
    // shared shelf name instead, so that's left alone.
    const rowDiv = sourceRow.closest('.entry');
    if (rowDiv && rowDiv.querySelectorAll('.url').length === 1) {
      const rowNameInput = rowDiv.querySelector('.name');
      if (rowNameInput) rowNameInput.value = name;
    }
    editingCustomListUrlInput = null;
    renumber();
    checkAllDuplicateUrls();
    saveState();
  } else {
    const newRowDiv = addRow(name, newUrl, customListDraftType, true, 'Custom Lists');
    sourceRow = newRowDiv ? newRowDiv.querySelector('.source-row') : null;
  }

  customListDraftItems = [];
  customListDraftType = 'movie';
  updateCustomListTypeRadio('movie');
  customListDraftListId = null;
  nameInput.value = '';
  document.getElementById('customListRandomizeCheck').checked = false;
  document.getElementById('customListSearchInput').value = '';
  document.getElementById('customListSearchResult').innerHTML = '';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();

  // Straight into the same save flow the row's own "Save List" button
  // uses (creator-profile signed-in -> visibility picker directly;
  // otherwise the anonymous-vs-create-a-profile choice) -- no separate
  // trip down to the list below and a second click needed.
  const urlInput = sourceRow ? sourceRow.querySelector('.url') : null;
  if (sourceRow && urlInput) {
    beginSaveListFlow(sourceRow, urlInput, name);
  } else {
    alert('List "' + name + '" saved, but the save dialog couldn\\'t open automatically -- use the "Save List" button on it below.');
  }
}

// Saves changes to a list already living on the creator's profile --
// straight back to the server (no local row involved at all, unlike every
// other save path here), since a Creator-owned list's canonical copy is
// the one on the server, not a row in this particular install link.
async function saveCreatorListEdit(name) {
  if (!activeCreator) {
    alert('Your Creator Profile session expired -- please restore it again.');
    editingCreatorListSlug = null;
    updateCustomListSaveButtonLabel();
    return;
  }
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  const visSelect = document.getElementById('customListVisibilitySelect');
  const visibility = visSelect && visSelect.value === 'private' ? 'private' : 'public';
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        slug: editingCreatorListSlug,
        name: name,
        type: customListDraftType,
        items: customListDraftItems,
        visibility: visibility,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not save changes: ' + (data.error || 'unknown error'));
      return;
    }
    alert('"' + name + '" updated.');
    cancelEditCustomList();
    renderCreatorDashboard();
  } catch (e) {
    alert('Network error while saving.');
  }
}

// Local equivalent of saveCreatorListEdit above -- same role, writes to
// the local store instead of the server, no visibility to preserve since
// local lists don't have one.
function saveLocalCustomListEdit(name) {
  const map = loadLocalCustomLists();
  const slug = editingLocalCustomListSlug;
  const existing = map[slug];
  map[slug] = {
    slug: slug,
    name: name,
    type: customListDraftType,
    items: customListDraftItems,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  saveLocalCustomListsMap(map);
  cancelEditCustomList();
  renderCreatorDashboard();
}

// Loads an existing Custom List's picks back into the draft so they can be
// adjusted and saved back over the same list, instead of needing to
// delete and rebuild it from scratch.
function editCustomList(btn) {
  const sourceRow = btn.closest('.source-row');
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this list to edit it.');
    return;
  }
  const payload = parseCustomListPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this list to edit it.');
    return;
  }
  customListDraftItems = (payload.items || []).slice();
  customListDraftType = payload.type || 'movie';
  updateCustomListTypeRadio(customListDraftType);
  customListDraftListId = payload.listId || null;
  const rowDiv = urlInput.closest('.entry');
  const currentName = rowDiv && rowDiv.querySelectorAll('.url').length === 1 && rowDiv.querySelector('.name')
    ? rowDiv.querySelector('.name').value.trim()
    : '';
  document.getElementById('customListNameInput').value = currentName;
  document.getElementById('customListSearchType').value = payload.type === 'series' ? 'tv' : 'movie';
  document.getElementById('customListRandomizeCheck').checked = !!payload.shuffle;
  editingCustomListUrlInput = urlInput;
  editingCreatorListSlug = null;
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();

  switchTab('lists');
  // Create List has no pill of its own -- see the matching fix in
  // editCreatorList/editLocalCustomList for why this doesn't try to grab
  // one to highlight.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditCustomList() {
  editingCustomListUrlInput = null;
  editingCreatorListSlug = null;
  editingLocalCustomListSlug = null;
  customListDraftItems = [];
  customListDraftType = 'movie';
  updateCustomListTypeRadio('movie');
  customListDraftListId = null;
  document.getElementById('customListNameInput').value = '';
  const searchInput = document.getElementById('customListSearchInput');
  if (searchInput) searchInput.value = '';
  const searchRes = document.getElementById('customListSearchResult');
  if (searchRes) searchRes.innerHTML = '';
  document.getElementById('customListRandomizeCheck').checked = false;
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  
  if (typeof switchListsSubmenu === 'function') {
    switchListsSubmenu('my-lists', document.querySelector('#listsSubnavBar button:nth-child(1)'));
  }
}

function updateCustomListSaveButtonLabel() {
  const saveBtn = document.getElementById('customListSaveBtn');
  const cancelBtn = document.getElementById('customListCancelEditBtn');
  const visRow = document.getElementById('customListVisibilityRow');
  if (!saveBtn) return;
  const titleEl = document.getElementById('customListEditorTitle');
  const isEditing = editingCreatorListSlug || editingLocalCustomListSlug || editingCustomListUrlInput;
  if (titleEl) {
    titleEl.innerHTML = (isEditing ? 'Edit Custom List' : 'Create a Custom List') + ' <span class="badge" id="customListDraftCountBadge"></span>';
    // Must update badge text again since we just rewrote innerHTML
    const badge = document.getElementById('customListDraftCountBadge');
    if (badge) badge.textContent = customListDraftItems.length ? '(' + customListDraftItems.length + ' picked)' : '';
  }

  if (editingCreatorListSlug) {
    saveBtn.textContent = 'Save changes to your Creator list';
    if (cancelBtn) cancelBtn.style.display = '';
    if (visRow) visRow.style.display = '';
  } else if (editingLocalCustomListSlug) {
    saveBtn.textContent = 'Save changes to this list';
    if (cancelBtn) cancelBtn.style.display = '';
    if (visRow) visRow.style.display = 'none';
  } else if (editingCustomListUrlInput) {
    saveBtn.textContent = 'Save changes to this List';
    if (cancelBtn) cancelBtn.style.display = '';
    if (visRow) visRow.style.display = 'none';
  } else {
    saveBtn.textContent = 'Save as a List';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (visRow) visRow.style.display = 'none';
  }
}



function closeCreateListModal() {
  document.getElementById('listsSubCreateList').style.display = 'none';
  document.getElementById('listsSubMyLists').style.display = 'block';
}

function setCustomListDraftTypeToggle(type) {
  if (customListDraftItems.length > 0 && customListDraftType !== type) {
    alert('This list already contains ' + (customListDraftType === 'movie' ? 'movies' : 'shows') + '. Clear the list first to change its type.');
    updateCustomListTypeRadio(customListDraftType);
    return;
  }
  customListDraftType = type;
}

function updateCustomListTypeRadio(type) {
  const radios = document.getElementsByName('customListTypeRadio');
  for (let i = 0; i < radios.length; i++) {
    if (radios[i].value === type) {
      radios[i].checked = true;
    }
  }
}

// --- Watch History --------------------------------------------------------

window._watchedItemIds = new Set();
// Shows where every currently-aired episode has been watched -- separate
// from _watchedItemIds (which only ever holds movie/episode ids, never a
// show's own id) since a show's poster is never itself added to Watch
// History, only its episodes are. Computed by updateContinueWatching
// below whenever it can't find a next unwatched, aired episode.
window._fullyWatchedShowIds = new Set();
// Shows with at least one watched episode but still an unwatched, aired
// episode waiting -- i.e. currently sitting in Continue Watching. Gets the
// amber "in progress" badge instead of the blue checkmark; a show moves
// out of this set and into _fullyWatchedShowIds the moment its last
// episode is watched. Derived the same way _fullyWatchedShowIds is
// (initWatchHistory on load, updateContinueWatching as things change), so
// the two sets are always mutually exclusive for a given showId.
window._inProgressShowIds = new Set();

// Finds the position:relative box a watched-checkmark badge should be
// inserted into for a given .clickable-poster/.clickable-episode element.
// Poster markup isn't consistent across the app -- some wrap the image in
// its own positioned box (livePreviewPosterHtml), some set
// position:relative on the clickable element itself via a CSS class
// rather than an inline style (.list-card-mini-poster-img-wrap), and some
// put .clickable-poster directly on the <img> (the Custom Lists /
// Continue Watching dashboard cards) -- and an <img> can't hold rendered
// children, so that last case falls back to the image's own parent
// instead of the image itself.
function findWatchBadgeWrap(el) {
  const wrap = el.querySelector('div[style*="position:relative"]') || el.querySelector('.poster-image-wrap') || el.querySelector('div[style*="aspect-ratio"]');
  if (wrap) return wrap;
  if (el.tagName === 'IMG') return el.parentElement;
  return el;
}

// Returns 'full' (blue checkmark), 'partial' (amber circle), or null (no
// badge) for a given poster/episode element's id+type. A show's own
// poster (data-type="series") is checked against the two show-level sets
// instead of the regular per-item watched set, since the show's id itself
// never lands in Watch History -- only its episodes do. Episodes/movies
// have no data-type "series", so they fall through to the plain
// watched-item check same as always.
function computeWatchBadgeState(id, type) {
  if (type === 'series') {
    if (window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(id)) return 'full';
    if (window._inProgressShowIds && window._inProgressShowIds.has(id)) return 'partial';
    return null;
  }
  return (window._watchedItemIds && window._watchedItemIds.has(id)) ? 'full' : null;
}

// Builds the badge markup for a given state -- shared by the observer and
// refreshWatchBadge below so the two can never drift out of sync on markup.
function watchBadgeHtml(state) {
  return state === 'partial'
    ? '<div class="watch-indicator-overlay watch-indicator-partial">&#x25D0;</div>'
    : '<div class="watch-indicator-overlay">&#x2713;</div>';
}

function initWatchHistory() {
  if (typeof loadLocalCustomLists === 'function') {
    const map = loadLocalCustomLists();
    if (map['watch-history']) {
      const items = map['watch-history'].items || [];
      items.forEach(it => window._watchedItemIds.add(String(it.id)));
    }
    if (map['continue-watching']) {
      const items = map['continue-watching'].items || [];
      items.forEach(it => { if (it.showId) window._inProgressShowIds.add(String(it.showId)); });
    }
  }
  try {
    const raw = localStorage.getItem('myListAddon:fullyWatchedShows');
    if (raw) JSON.parse(raw).forEach(id => window._fullyWatchedShowIds.add(String(id)));
  } catch (e) {
    // non-critical -- badges just won't show for shows until the next
    // time updateContinueWatching recomputes them
  }

  const observer = new MutationObserver(mutations => {
    if (!window._watchedItemIds) return;
    document.querySelectorAll('.clickable-poster, .clickable-episode').forEach(el => {
      const id = el.dataset.id;
      if (!id) return;
      const state = computeWatchBadgeState(id, el.dataset.type);
      if (!state) return;
      const wrap = findWatchBadgeWrap(el);
      if (!wrap) return;
      // Checking wrap (not el) for an existing badge matters: when el is
      // an <img> (it can't hold children), wrap is el.parentElement --
      // checking el itself here would always find nothing, insert another
      // badge into wrap every time this observer fires, and since that
      // insertion is itself a mutation under the very subtree being
      // observed, immediately re-trigger this same callback -- an
      // unbounded loop that floods the DOM and freezes the tab.
      if (!wrap.querySelector('.watch-indicator-overlay')) {
        wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
setTimeout(initWatchHistory, 500);

// Adds/removes/updates the watched badge on every currently on-screen
// poster/episode card matching this id. Called right after toggling
// something, so the change shows up immediately rather than waiting on
// the MutationObserver above (which only reacts to new DOM nodes
// appearing, not to the watch-state sets changing underneath content
// that's already on screen).
function refreshWatchBadge(id, type) {
  const strId = String(id);
  const state = computeWatchBadgeState(strId, type);
  document.querySelectorAll('.clickable-poster[data-id="' + escapeAttr(strId) + '"], .clickable-episode[data-id="' + escapeAttr(strId) + '"]').forEach(el => {
    const wrap = findWatchBadgeWrap(el);
    if (!wrap) return;
    // See the matching comment in initWatchHistory's observer above -- this
    // has to check wrap, not el, for the same reason.
    const overlay = wrap.querySelector('.watch-indicator-overlay');
    if (state) {
      if (!overlay) {
        wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
      } else {
        // Swap in place (rather than remove+reinsert) when a show flips
        // straight from partial to full on its last episode -- keeps the
        // existing badge element instead of a flicker of removal.
        overlay.className = 'watch-indicator-overlay' + (state === 'partial' ? ' watch-indicator-partial' : '');
        overlay.innerHTML = state === 'partial' ? '&#x25D0;' : '&#x2713;';
      }
    } else if (overlay) {
      overlay.remove();
    }
  });
}

// Updates the fully-watched set for one show (persisting it so the badge
// survives a refresh) and immediately refreshes that show's badge
// wherever its poster is currently on screen. Fully watched and in
// progress are mutually exclusive, so marking one clears the other.
function setShowFullyWatched(showId, isFullyWatched) {
  if (!window._fullyWatchedShowIds) window._fullyWatchedShowIds = new Set();
  const had = window._fullyWatchedShowIds.has(showId);
  if (isFullyWatched) {
    window._fullyWatchedShowIds.add(showId);
    if (window._inProgressShowIds) window._inProgressShowIds.delete(showId);
  } else {
    window._fullyWatchedShowIds.delete(showId);
  }
  if (had !== isFullyWatched) {
    try {
      localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify([...window._fullyWatchedShowIds]));
    } catch (e) {
      // non-critical
    }
  }
  refreshWatchBadge(showId, 'series');
}

// Companion to setShowFullyWatched above -- marks a show as having an
// unwatched-but-aired episode waiting (the amber badge) or clears that
// state. Not persisted to its own localStorage key the way
// fullyWatchedShows is: it's fully derivable from the Continue Watching
// list itself, which initWatchHistory already re-reads on every page
// load, so a second persisted copy would just be one more place for the
// two to drift out of sync.
function setShowInProgress(showId, isInProgress) {
  if (!window._inProgressShowIds) window._inProgressShowIds = new Set();
  if (isInProgress) {
    window._inProgressShowIds.add(showId);
  } else {
    window._inProgressShowIds.delete(showId);
  }
  refreshWatchBadge(showId, 'series');
}

function getOrCreateWatchHistoryList() {
  const map = loadLocalCustomLists();
  if (!map['watch-history']) {
    map['watch-history'] = {
      slug: 'watch-history',
      localSlug: 'watch-history',
      name: 'Watch History',
      description: 'Automatically tracking your watched movies, shows, and episodes.',
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveLocalCustomListsMap(map);
  } else if (!map['watch-history'].slug) {
    // Backfills a slug on a Watch History list saved before this list
    // started needing one -- without it, "Your Custom Lists" can't match
    // its View/Edit/Delete/+Add buttons back to this entry.
    map['watch-history'].slug = 'watch-history';
    saveLocalCustomListsMap(map);
  }
  return map['watch-history'];
}

window.toggleWatchStatus = function(id, type, name, poster) {
  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();
  
  const existingIdx = list.items.findIndex(it => it.id === id);
  if (existingIdx >= 0) {
    list.items.splice(existingIdx, 1);
    window._watchedItemIds.delete(id);
  } else {
    // If this is an episode, embed show/season/episode context so
    // updateContinueWatching() can find "next unwatched" without extra API calls.
    let item = { id, type, name, poster };
    if (type === 'episode') {
      const d = window._currentItemDetails;
      if (d) {
        item.showId = d.id;
        item.showTitle = d.title;
        item.showPoster = d.poster || '';
        const cache = window._episodeDataCache || {};
        const found = Object.values(cache).find(ep => String(ep.id) === String(id));
        // Prefer the season number stamped onto the cached episode itself
        // (set when that season's episode grid was loaded) over the single
        // "last season expanded" global, since more than one season can be
        // expanded at once and that global can point at the wrong one.
        item.seasonNum = (found && found.season_number != null) ? found.season_number : (window._currentSeasonNum || null);
        item.episodeNum = found ? found.episode_number : null;
      }
    }
    list.items.unshift(item);
    window._watchedItemIds.add(id);
  }
  
  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();

  // Update Continue Watching for episode toggles
  if (type === 'episode') {
    const d = window._currentItemDetails;
    if (d && d.id) updateContinueWatching(d.id).catch(() => {});
  }
  
  // Re-render UI
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  
  // Update button if we are in the details modal
  const btn = document.getElementById('btnMarkWatched');
  if (btn) {
    if (window._watchedItemIds.has(id)) {
      btn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched';
      btn.classList.remove('primary');
      btn.classList.add('secondary');
    } else {
      btn.innerHTML = 'Mark as Watched';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
  }
  
  // To update posters dynamically, we need to refresh the grid if possible
  // For now, let's just let the user see it next time, or we can toggle class on existing DOM elements
  refreshWatchBadge(id, type);
};

// Batch-adds or batch-removes many items (episodes, mainly) to/from the
// Watch History list in a single localStorage write.
window.toggleBatchWatchStatus = function(items) {
  if (!items || !items.length) return { added: 0, removed: 0, nowWatched: false };

  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();

  const allWatched = items.every(it => window._watchedItemIds.has(String(it.id)));
  let added = 0;
  let removed = 0;

  if (allWatched) {
    const removeIds = new Set(items.map(it => String(it.id)));
    list.items = list.items.filter(it => !removeIds.has(String(it.id)));
    removeIds.forEach(id => {
      if (window._watchedItemIds.has(id)) {
        window._watchedItemIds.delete(id);
        removed++;
      }
    });
  } else {
    const existingIds = new Set(list.items.map(it => String(it.id)));
    items.forEach(it => {
      const id = String(it.id);
      if (!existingIds.has(id)) {
        list.items.unshift({ id: id, type: it.type, name: it.name, poster: it.poster,
          showId: it.showId || null, showTitle: it.showTitle || null, showPoster: it.showPoster || '',
          seasonNum: it.seasonNum || null, episodeNum: it.episodeNum || null });
        existingIds.add(id);
        added++;
      }
      window._watchedItemIds.add(id);
    });
  }

  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();

  updateContinueWatchingForBatch(items).catch(() => {});

  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

  items.forEach(it => refreshWatchBadge(it.id, it.type));

  return { added: added, removed: removed, nowWatched: !allWatched };
};

// One-way add to Watch History as watched -- unlike toggleBatchWatchStatus
// above (which flips a fully-watched batch back to unwatched, since it's a
// toggle), this only ever adds and skips anything already present. Used by
// the Trakt Export / Letterboxd Export importers' "mark as watched"
// option: re-running an import over the same export file (or one that
// overlaps an earlier one) should never accidentally unmark something that
// was already logged as watched, which a toggle-based call would risk the
// moment every item in a batch happened to already be watched.
window.addItemsToWatchHistory = async function(items) {
  if (!items || !items.length) return { added: 0, cwSucceeded: 0, cwTotal: 0 };
  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();
  const existingIds = new Set(list.items.map(it => String(it.id)));
  let added = 0;
  items.forEach(it => {
    const id = String(it.id);
    if (existingIds.has(id)) return;
    list.items.unshift({
      id: id, type: it.type, name: it.name, poster: it.poster,
      showId: it.showId || null, showTitle: it.showTitle || null, showPoster: it.showPoster || '',
      seasonNum: it.seasonNum != null ? it.seasonNum : null, episodeNum: it.episodeNum != null ? it.episodeNum : null,
    });
    existingIds.add(id);
    window._watchedItemIds.add(id);
    added++;
  });
  if (!added) return { added: 0, cwSucceeded: 0, cwTotal: 0 };
  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  // Awaited (unlike toggleBatchWatchStatus's own fire-and-forget call
  // above) -- this is what a bulk importer processing dozens or hundreds
  // of shows actually needs: the caller's own "done" message shouldn't
  // fire while most of the batch is still mid-flight, and cwSucceeded/
  // cwTotal below let it report real numbers instead of assuming success.
  const cwResult = await updateContinueWatchingForBatch(items);
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  items.forEach(it => refreshWatchBadge(it.id, it.type));
  return { added: added, cwSucceeded: cwResult.succeeded, cwTotal: cwResult.total };
};

// --- Continue Watching --------------------------------------------------------

function getOrCreateContinueWatchingList() {
  const map = loadLocalCustomLists();
  if (!map['continue-watching']) {
    map['continue-watching'] = {
      slug: 'continue-watching',
      localSlug: 'continue-watching',
      name: 'Continue Watching',
      description: 'Next unwatched episode for each show you have started.',
      type: 'series',
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveLocalCustomListsMap(map);
  } else if (!map['continue-watching'].slug) {
    map['continue-watching'].slug = 'continue-watching';
    saveLocalCustomListsMap(map);
  }
  return map['continue-watching'];
}

async function updateContinueWatching(showId) {
  if (!showId) return { ok: false };

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  const map = loadLocalCustomLists();
  const history = map['watch-history'];
  const cwList = getOrCreateContinueWatchingList();

  cwList.items = cwList.items.filter(it => it.showId !== showId);

  const watchedEps = (history ? history.items : []).filter(it =>
    it.type === 'episode' && it.showId === showId && it.seasonNum != null && it.episodeNum != null
  );

  if (!watchedEps.length) {
    map['continue-watching'] = cwList;
    cwList.updatedAt = Date.now();
    saveLocalCustomListsMap(map);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    setShowFullyWatched(showId, false);
    setShowInProgress(showId, false);
    return { ok: true };
  }

  const latest = watchedEps.reduce((best, ep) => {
    if (ep.seasonNum > best.seasonNum) return ep;
    if (ep.seasonNum === best.seasonNum && ep.episodeNum > best.episodeNum) return ep;
    return best;
  }, watchedEps[0]);

  // Whether every currently-aired episode has been watched -- stays null
  // if a fetch below fails, so a network hiccup can't flip the badge one
  // way or the other; it just leaves whatever was already known. Also
  // doubles as this function's own success signal (see the "ok" returned
  // below) -- a caller processing many shows at once (see
  // updateContinueWatchingForBatch) needs to tell "genuinely fully
  // watched" apart from "the fetch failed", since both leave no Continue
  // Watching entry behind but only one of them should be retried.
  let showFullyWatched = null;

  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(showId) +
      '&seasonNum=' + latest.seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error('no data');

    const eps = data.season.episodes.filter(ep => isEpisodeAired(ep));
    const nextInSeason = eps.find(ep => ep.episode_number > latest.episodeNum);

    if (nextInSeason) {
      cwList.items.unshift({
        id: String(nextInSeason.id),
        type: 'episode',
        // Bare episode name -- matching Watch History's own item.name
        // convention. formatWatchItemLabel already reconstructs "Show
        // SxxExx" from showTitle/seasonNum/episodeNum for display, so a
        // pre-formatted composite string here would show that same
        // show/season/episode prefix twice (once from formatWatchItemLabel
        // itself, once baked into this string as its subtitle).
        name: nextInSeason.name,
        poster: latest.showPoster || '',
        showId: showId,
        showTitle: latest.showTitle || '',
        showPoster: latest.showPoster || '',
        seasonNum: latest.seasonNum,
        episodeNum: nextInSeason.episode_number
      });
      showFullyWatched = false;
      setShowInProgress(showId, true);
    } else {
      const nextSeasonNum = latest.seasonNum + 1;
      const res2 = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(showId) +
        '&seasonNum=' + nextSeasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
      const data2 = await res2.json();
      if (data2.ok && data2.season && data2.season.episodes) {
        const nextEps = data2.season.episodes.filter(ep => isEpisodeAired(ep));
        const firstNext = nextEps[0];
        if (firstNext) {
          cwList.items.unshift({
            id: String(firstNext.id),
            type: 'episode',
            name: firstNext.name,
            poster: latest.showPoster || '',
            showId: showId,
            showTitle: latest.showTitle || '',
            showPoster: latest.showPoster || '',
            seasonNum: nextSeasonNum,
            episodeNum: firstNext.episode_number
          });
          showFullyWatched = false;
          setShowInProgress(showId, true);
        } else {
          // TMDB knows about the next season but it hasn't started airing
          // yet -- nothing unwatched-and-aired remains right now.
          showFullyWatched = true;
        }
      } else {
        // No further season at all -- this was the last one, and it's
        // fully watched.
        showFullyWatched = true;
      }
    }
  } catch (e) {
    // Silent failure -- showFullyWatched stays null, see comment above.
  }

  map['continue-watching'] = cwList;
  cwList.updatedAt = Date.now();
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (showFullyWatched !== null) setShowFullyWatched(showId, showFullyWatched);
  return { ok: showFullyWatched !== null };
}

// Runs updateContinueWatching for every distinct show in a batch, a few at
// a time rather than strictly one-at-a-time -- a large batch (e.g. a
// fresh Trakt/Letterboxd "mark as watched" import, which can easily span
// dozens to hundreds of distinct shows) doing one full TMDB round trip per
// show in sequence was slow enough, and any one transient failure (rate
// limit, network blip) silently dropped that show from Continue Watching
// forever with no visibility, that it looked like the feature just "didn't
// add all shows it should have" -- which it didn't, but not because
// anything was actually broken beyond not reporting the gap. Tracks real
// success/failure (via updateContinueWatching's own return value, since it
// swallows its own network errors internally rather than throwing) so a
// caller doing a large bulk operation can report honest numbers instead of
// assuming everything worked.
async function updateContinueWatchingForBatch(items) {
  const showIds = [...new Set(items.map(it => it.showId).filter(Boolean))];
  if (!showIds.length) return { succeeded: 0, total: 0 };
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let succeeded = 0;
  async function worker() {
    while (nextIdx < showIds.length) {
      const showId = showIds[nextIdx++];
      try {
        const result = await updateContinueWatching(showId);
        if (result && result.ok) succeeded++;
      } catch (e) {
        // updateContinueWatching doesn't normally throw (see its own
        // try/catch), but guard anyway so one unexpected error can't abort
        // the rest of the batch.
      }
    }
  }
  const workers = Array(Math.min(CONCURRENCY, showIds.length)).fill(0).map(worker);
  await Promise.all(workers);
  return { succeeded: succeeded, total: showIds.length };
}

// --- Creator Profile system --------------------------------------------------
//
// No accounts, no email, no passwords -- see the matching server-side
// comment above authenticateCreator for the security model. This is the
// entry point every "Save List" click goes through: build the list first
// (search/add/reorder/"Save as a List" above, all unchanged), then this
// button is what actually persists it somewhere with a URL, either
// activeCreator is declared globally at script start
let pendingSaveListContext = null; // { sourceRow, urlInput, payload, name } while a save modal flow is in progress
let editingCreatorListSlug = null; // set by editCreatorList() below while editing an existing Creator-owned list
let editingLocalCustomListSlug = null; // set by editLocalCustomList() below while editing an existing browser-only list
let lastLocalCustomListsData = null; // cached result of the last local-dashboard render, so Edit/Add-to-config don't need to re-read localStorage

// --- Local (browser-only) Custom Lists ----------------------------------
//
// Saving a Custom List used to require a Creator Profile -- clicking "Save
// as a List" without one popped up an explainer and blocked further
// progress until an account existed. That's gone: anyone can build and
// save Custom Lists now, signed in or not. The only real difference is
// *where* the saved list lives afterward -- a Creator Profile's lists live
// on the server (so they follow you to another browser/device); without
// one, they live here in localStorage instead, and everything else about
// the experience -- the dashboard showing your saved lists with
// Edit/Delete/Add-to-your-lists, editing one back into the picker, all of
// it -- works identically either way. There's deliberately no
// Public/Private choice for a local list the way there is for a
// Creator-owned one: without a server there's no shareable link for
// "Public" to mean anything, so a local save just saves, no modal at all.
const LOCAL_CUSTOM_LISTS_KEY = 'myListAddon:localCustomLists';

function loadLocalCustomLists() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CUSTOM_LISTS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}
function saveLocalCustomListsMap(map) {
  try {
    localStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // Most commonly a QuotaExceededError -- localStorage is capped
    // (~5-10MB per origin depending on browser) and every Custom List
    // lives in one combined blob under this key, so a large import (or
    // just a lot of accumulated lists already) can push a save over the
    // limit. Callers now get told about this instead of it failing
    // silently -- see saveItemsAsNewCustomList below, which used to
    // report { ok: true } here unconditionally even when this write
    // never actually landed.
    console.error('saveLocalCustomListsMap failed:', e);
    return false;
  }
}

// Saves (or re-saves, if this row already has a localSlug from a previous
// save) a Custom List row to the local store, and stamps the row's own
// payload with that slug so a later re-save or the row-level "Save List"
// button targets the same local entry instead of creating a duplicate --
// the same role creatorSlug plays for a Creator-owned list.
function saveLocalCustomList(sourceRow, urlInput, payload, name) {
  const map = loadLocalCustomLists();
  let slug = payload.localSlug;
  if (!slug || !map[slug]) {
    const base = slugify(name) || 'list';
    slug = base;
    let n = 2;
    while (map[slug]) {
      slug = base + '-' + n;
      n++;
    }
  }
  const now = Date.now();
  const existing = map[slug];
  map[slug] = {
    slug: slug,
    name: name,
    type: payload.type,
    items: payload.items,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  saveLocalCustomListsMap(map);

  const updatedPayload = Object.assign({}, payload, { localSlug: slug });
  sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
  saveState();
  renderCreatorDashboard();
}

// Runs once, right after a brand-new account is created -- uploads every
// list from this browser's local store to the new account (as Public, the
// same default the visibility picker itself defaults to) so nothing built
// before signing up gets left behind. Any row in #lists that pointed at a
// migrated local list gets repointed at the new server copy (creatorSlug
// instead of localSlug) so a future edit or re-save targets the right
// place. Best-effort per list -- one failing (e.g. a dropped connection
// partway through) doesn't lose the others; anything that didn't migrate
// stays in the local store rather than being deleted, so it isn't lost.
async function migrateLocalCustomListsToAccount() {
  if (!activeCreator) return;
  const localMap = loadLocalCustomLists();
  // Watch History and Continue Watching are auto-generated tracking data,
  // not something anyone hand-built to share -- migrating them through
  // here would silently turn private watch history into a public server
  // list (see visibility: 'public' below) and then delete the local copy.
  // They do still get synced to the account, just privately and through
  // pushCreatorSync/loadCreatorSync's own blob instead of this endpoint --
  // that already runs right after this function returns (see
  // submitCreateProfile), so nothing here needs to push them itself.
  const AUTO_TRACKED_SLUGS = ['watch-history', 'continue-watching'];
  const slugs = Object.keys(localMap).filter((slug) => !AUTO_TRACKED_SLUGS.includes(slug));
  if (!slugs.length) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  let migratedCount = 0;
  let failedCount = 0;
  for (const slug of slugs) {
    const list = localMap[slug];
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: list.name,
          type: list.type,
          items: list.items,
          visibility: 'public',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        failedCount++;
        continue;
      }
      migratedCount++;
      delete localMap[slug];
      // Repoint any row already in #lists that was built from this local
      // list so it now saves/edits against the account instead.
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (!rowPayload || rowPayload.localSlug !== slug) return;
        const updatedPayload = Object.assign({}, rowPayload, {
          publishedUrl: data.url,
          creatorSlug: data.slug,
          creatorOwner: activeCreator.creatorName,
          visibility: 'public',
        });
        delete updatedPayload.localSlug;
        const sourceRow = urlInput.closest('.source-row');
        if (sourceRow) sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
      });
    } catch (e) {
      failedCount++;
    }
  }
  saveLocalCustomListsMap(localMap);
  if (migratedCount) {
    renumber();
    checkAllDuplicateUrls();
    saveState();
    renderCreatorDashboard();
  }
  if (failedCount) {
    alert(
      migratedCount
        ? migratedCount + ' list' + (migratedCount === 1 ? '' : 's') + ' moved to your account, but ' + failedCount + ' couldn\\'t be moved -- they\\'re still saved locally, try again from this browser.'
        : 'Could not move your local lists to your account -- they\\'re still saved locally, try again from this browser.'
    );
  }
}

let lastCreatorListsData = null; // cached result of the last dashboard fetch, so Edit/Share don't need a round-trip

function showModal(innerHtml, extraClass) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'activeModalOverlay';
  overlay.innerHTML = '<div class="modal-card' + (extraClass ? ' ' + extraClass : '') + '">' + innerHtml + '</div>';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
}
function closeModal() {
  const existing = document.getElementById('activeModalOverlay');
  if (existing) existing.remove();
}

function renderCreatorProfileBar() {
  const bar = document.getElementById('creatorProfileBar');
  if (!bar) return;
  if (activeCreator) {
    bar.innerHTML =
      '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<span class="subnav-pill active" style="margin:0; font-size:0.82rem; padding:6px 12px; cursor:pointer;" onclick="switchTab(&quot;keys&quot;)">&#x1F464; ' + escapeHtml(activeCreator.displayName) + '</span>' +
      '<button type="button" class="lc-btn" style="padding:5px 9px; font-size:0.78rem;" onclick="switchCreatorProfile()" title="Sign Out / Switch">Sign Out</button>' +
      '</div>' +
      '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
      '</div>';
  } else {
    bar.innerHTML =
      '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
      '<div style="display:flex; align-items:center; gap:6px;">' +
      '<button type="button" class="lc-btn primary" onclick="openCreateProfileModal()" style="padding:6px 12px; font-size:0.82rem; font-weight:700;">+ Create Account</button>' +
      '<button type="button" class="lc-btn" onclick="openRestoreModal()" style="padding:6px 12px; font-size:0.82rem;">Restore</button>' +
      '</div>' +
      '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
      '</div>';
  }
}

// Lives in Settings -> Keys & Account
function renderAccountKeySection() {
  const box = document.getElementById('accountKeySection');
  if (!box) return;
  if (!activeCreator) {
    box.innerHTML =
      '<p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Save and sync your lists, channels, presets, likes, and settings across all your devices automatically. No email or password needed &mdash; just a username and key.</p>' +
      '<div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-top:12px;">' +
      '<button type="button" class="primary" onclick="openCreateProfileModal()">Create Free Account</button>' +
      '<button type="button" class="secondary" onclick="openRestoreModal()">Restore Existing Account</button>' +
      '</div>';
    return;
  }
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  box.innerHTML =
    '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">' +
    '<div>' +
    '<span style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); font-weight:700;">Signed in as</span>' +
    '<h3 style="margin:2px 0 0; font-size:1.1rem; font-weight:800; color:var(--text);">&#x1F464; ' + escapeHtml(activeCreator.displayName) + '</h3>' +
    '</div>' +
    '<button type="button" class="secondary lc-btn" onclick="switchCreatorProfile()">Sign Out / Switch</button>' +
    '</div>' +
    '<p style="margin:0 0 4px;"><small>Account Key</small></p>' +
    '<div class="creator-key-display" id="accountKeyDisplay">' + '\u2022'.repeat(Math.max(8, key.length)) + '</div>' +
    '<div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-top:10px;">' +
    '<button type="button" class="secondary" id="accountKeyToggleBtn" onclick="toggleAccountKeyVisibility()">Show Key</button>' +
    '<button type="button" class="secondary" onclick="copyAccountKey()">Copy Key</button>' +
    '</div>' +
    '<p style="margin-top:10px;"><small>Anyone with this key can sign in as you and edit your lists &mdash; keep it somewhere safe, and don\\'t share it.</small></p>';
}

function toggleAccountKeyVisibility() {
  const display = document.getElementById('accountKeyDisplay');
  const btn = document.getElementById('accountKeyToggleBtn');
  if (!display || !btn) return;
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  const isHidden = btn.textContent === 'Show Key';
  if (isHidden) {
    display.textContent = key;
    btn.textContent = 'Hide Key';
  } else {
    display.textContent = '\u2022'.repeat(Math.max(8, key.length));
    btn.textContent = 'Show Key';
  }
}

// "Auto-track playback" panel on Settings -- see buildManifest's comment
// (05_catalog-core.js) for the full mechanism this powers. Requires a
// Creator Profile: a bare Stremio/wako request has no cookies and no
// login of its own, so the only way the server-side handler for it knows
// whose Watch History to update is whatever's baked into the install
// link itself -- and a Creator Profile's Watch History is the only kind
// that persists anywhere outside a single browser for that link to
// point at in the first place.
function renderTrackPlaybackSection() {
  const box = document.getElementById('trackPlaybackSection');
  if (!box) return;
  if (!activeCreator) {
    box.innerHTML = '<p><small>Sign in to a Creator Profile above to turn this on \u2014 without one, there\u2019s no account on file for a bare Stremio/wako request to update.</small></p>';
    return;
  }
  let enabled = false;
  try { enabled = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}
  box.innerHTML =
    '<label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.92rem;">' +
      '<input type="checkbox" id="trackPlaybackCheck" ' + (enabled ? 'checked' : '') + ' onchange="onTrackPlaybackToggle(this)">' +
      '<span>Enabled</span>' +
    '</label>' +
    '<p style="margin-top:8px;"><small>Takes effect on your next install link \u2014 generate a fresh one from Configure &amp; Install after turning this on or off.</small></p>' +
    '<div id="trackPlaybackStatus" style="margin-top:10px;"></div>';
  if (enabled) refreshTrackPlaybackStatus();
}

function onTrackPlaybackToggle(cb) {
  try { localStorage.setItem('myListAddon:trackPlayback', cb.checked ? '1' : '0'); } catch (e) {}
  if (typeof saveState === 'function') saveState();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (cb.checked) {
    refreshTrackPlaybackStatus();
  } else {
    const statusBox = document.getElementById('trackPlaybackStatus');
    if (statusBox) statusBox.innerHTML = '';
  }
}

async function refreshTrackPlaybackStatus() {
  const statusBox = document.getElementById('trackPlaybackStatus');
  if (!statusBox || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  statusBox.innerHTML = '<small>Checking last ping\u2026</small>';
  try {
    const res = await fetch(ORIGIN + '/api/creator/track-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok || !data.lastPingAt) {
      statusBox.innerHTML = '<small>No ping received yet. If you\u2019ve played something in Stremio/wako since installing with this on and it still says that, the subtitle-request hook likely isn\u2019t firing for that app/platform \u2014 that would mean this approach doesn\u2019t work there, not that it\u2019s just slow.</small>';
      return;
    }
    const when = new Date(data.lastPingAt).toLocaleString();
    statusBox.innerHTML = '<small>Last ping: ' + escapeHtml(when) + ' \u2014 id: <code>' + escapeHtml(data.lastPingId || '') + '</code>, matched: ' + escapeHtml(data.matched || 'unknown') + '</small>';
  } catch (e) {
    statusBox.innerHTML = '<small>Could not check status right now.</small>';
  }
}

function copyAccountKey() {
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!key) return;
  navigator.clipboard.writeText(key).then(() => {
    alert('Key copied to your clipboard.');
  }).catch(() => {
    prompt('Copy your Key:', key);
  });
}

function switchCreatorProfile() {
  activeCreator = null;
  editingCreatorListSlug = null;
  lastCreatorListsData = null;
  localStorage.removeItem('myListAddon:creatorName');
  localStorage.removeItem('myListAddon:creatorKey');
  renderCreatorProfileBar();
  renderAccountKeySection();
  renderTrackPlaybackSection();
  renderCreatorDashboard();
}

function openRestoreModal() {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>Restore Account</h2>' +
    '<p class="modal-sub">Enter your Username and Account Key to restore and sync your lists.</p>' +
    '<div class="row"><input type="text" id="restoreNameInput" placeholder="Username"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="restoreKeyInput" placeholder="Key (e.g. MYL-XXXX-XXXX-XXXX)"></div>' +
    '<div id="restoreModalError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitRestoreProfile()">Restore Account</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openCreateProfileModal();">Need an account? Create one</button>' +
    '</div>'
  );
}

async function submitRestoreProfile() {
  const name = document.getElementById('restoreNameInput').value.trim();
  const key = document.getElementById('restoreKeyInput').value.trim();
  const errBox = document.getElementById('restoreModalError');
  if (!name || !key) {
    errBox.innerHTML = '<p class="testresult err">Enter both your Username and Key.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name, creatorKey: key }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' +
        escapeHtml(data.error === 'no-kv' ? 'This Worker has no CONFIGS KV namespace bound.' : (data.error || 'Could not restore.')) + '</p>';
      return;
    }
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', key);
    closeModal();
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderTrackPlaybackSection();
    renderCreatorDashboard();
    loadCreatorSync();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}

// Silent on failure by design -- a browser with a stale/invalid stored key
// (e.g. the profile was somehow deleted) just falls back to logged-out
// rather than throwing an error at page load.
async function tryAutoRestoreCreatorProfile() {
  const name = localStorage.getItem('myListAddon:creatorName');
  const key = localStorage.getItem('myListAddon:creatorKey');
  if (!name || !key) return;
  try {
    const res = await fetch(ORIGIN + '/api/creator/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name, creatorKey: key }),
    });
    const data = await res.json();
    if (data.ok) {
      activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
      renderCreatorProfileBar();
      renderAccountKeySection();
      renderTrackPlaybackSection();
      renderCreatorDashboard();
      loadCreatorSync();
    }
  } catch (e) {
    // stay logged out
  }
}

// --- Site-wide account sync --------------------------------------------
//
// Derives a stable key for a collapsible panel from its own <summary>
// text rather than requiring every one of them to carry an explicit id --
// there's about 20 of these across the page already, and titles like
// "Custom Lists" or "Channels" are already unique and don't change, so
// this avoids a large, purely-mechanical HTML edit for no behavioral
// difference.
function collapsiblePanelKey(details) {
  const summary = details.querySelector('summary');
  const text = summary ? summary.textContent.trim() : '';
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'panel';
}
function collectCollapsedPanelsState() {
  const state = {};
  document.querySelectorAll('details.panel.collapsible').forEach((d) => {
    state[collapsiblePanelKey(d)] = d.open;
  });
  return state;
}
function applyCollapsedPanelsState(state) {
  if (!state || typeof state !== 'object') return;
  document.querySelectorAll('details.panel.collapsible').forEach((d) => {
    const key = collapsiblePanelKey(d);
    if (Object.prototype.hasOwnProperty.call(state, key)) d.open = !!state[key];
  });
}

let creatorSyncSaveTimer = null;
// Debounced -- reordering a list of rows, toggling several panels, or
// typing into a preset name can all fire this repeatedly in quick
// succession, and there's no need to push a request for every single one
// of those when only the last matters.
function scheduleCreatorSyncSave() {
  if (!activeCreator) return;
  if (creatorSyncSaveTimer) clearTimeout(creatorSyncSaveTimer);
  creatorSyncSaveTimer = setTimeout(pushCreatorSync, 1200);
}

// Debounced sibling of scheduleCreatorSyncSave, just for presets -- call
// this (not scheduleCreatorSyncSave) after any change to presets
// specifically (add/delete/upload -- see saveCurrentAsPreset,
// deletePreset, uploadPresetFile below). Presets travel to the server
// through pushPresetsDirectly/save-presets exclusively now; see that
// function's comment for why they were split out of the routine autosave.
let presetsSyncTimer = null;
function schedulePresetsSync() {
  if (!activeCreator) return;
  if (presetsSyncTimer) clearTimeout(presetsSyncTimer);
  presetsSyncTimer = setTimeout(() => { pushPresetsDirectly(loadPresetsMap()); }, 1200);
}

async function pushCreatorSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const localMap = loadLocalCustomLists();
    await fetch(ORIGIN + '/api/creator/sync/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        config: collectEntries(),
        // Presets deliberately NOT included here -- they're the one piece
        // of this state that can genuinely grow large (a TV Channel's
        // "url" is its entire episode list) while everything else in this
        // payload changes far more often but stays small. Bundling both
        // together meant every single autosave re-sent and re-processed
        // the full, ever-growing presets payload, which could tip a
        // request over Cloudflare's free-plan 10ms CPU budget. See
        // pushPresetsDirectly/schedulePresetsSync and the dedicated
        // /api/creator/sync/save-presets endpoint, which now handle
        // presets on their own, only when presets actually change.
        collapsedPanels: collectCollapsedPanelsState(),
        likedLists: [...getLikedListsSet()],
        // Always the full current list, same overwrite-the-blob approach
        // as everything else synced here -- see loadCreatorSync's comment
        // for why signing in replaces local state wholesale rather than
        // merging.
        watchHistory: (localMap['watch-history'] && localMap['watch-history'].items) || [],
        continueWatching: (localMap['continue-watching'] && localMap['continue-watching'].items) || [],
        trackPlayback: localStorage.getItem('myListAddon:trackPlayback') === '1',
        // Feeds the server-side Continue Watching cron (checkForNewEpisodes
        // in 26_api-creator-and-admin-routes.js) -- see the blob comment
        // there for why both of these need to travel alongside Watch
        // History/Continue Watching rather than being derived server-side.
        fullyWatchedShowIds: [...(window._fullyWatchedShowIds || [])],
        dismissedContinueWatching: window._dismissedContinueWatching || {},
      }),
    });
  } catch (e) {
    // silently fail, it's a background sync
  }
}

// Called right after sign-in (fresh restore, auto-restore, or a brand new
// profile). A null 'data' means this account has never synced from any
// device before, so rather than wiping out whatever's already on this
// browser, that current state is adopted as-is and pushed up as the
// account's first save. A real 'data' means the opposite: signing in
// replaces this browser's local state with the account's, the same way
// signing into any other synced account would.
async function loadCreatorSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const res = await fetch(ORIGIN + '/api/creator/sync/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok) return;
    if (!data.data) {
      pushCreatorSync();
      const localPresets = loadPresetsMap();
      if (localPresets && Object.keys(localPresets).length) pushPresetsDirectly(localPresets);
      return;
    }
    const synced = data.data;
    suppressSave = true;
    document.getElementById('lists').innerHTML = '';
    if (Array.isArray(synced.config)) {
      synced.config.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
    }
    renumber();
    suppressSave = false;
    renderChannelMergeList();
    
    if (synced.presetsB64) {
      decompressBase64ToJson(synced.presetsB64).then(parsedPresets => {
        if (parsedPresets) {
          savePresetsMap(parsedPresets);
          renderPresetsList();
        }
      });
    } else if (synced.presets && typeof synced.presets === 'object') {
      savePresetsMap(synced.presets);
      renderPresetsList();
    }
    
    applyCollapsedPanelsState(synced.collapsedPanels);
    if (typeof synced.trackPlayback === 'boolean') {
      try { localStorage.setItem('myListAddon:trackPlayback', synced.trackPlayback ? '1' : '0'); } catch (e) {}
      if (typeof renderTrackPlaybackSection === 'function') renderTrackPlaybackSection();
    }
    if (Array.isArray(synced.likedLists)) {
      try {
        localStorage.setItem('myListAddon:likedLists', JSON.stringify(synced.likedLists));
      } catch (e) {
        // non-critical, see rememberLikedList's own comment
      }
    }

    // Watch History / Continue Watching -- same wholesale-replace as
    // everything else in this blob (see this function's own comment).
    // getOrCreateWatchHistoryList/getOrCreateContinueWatchingList are used
    // just to get a properly-shaped, slugged entry to overwrite the items
    // on, rather than hand-building one here and risking it drifting out
    // of sync with that shape later.
    let touchedTracking = false;
    if (Array.isArray(synced.watchHistory)) {
      const wh = getOrCreateWatchHistoryList();
      wh.items = synced.watchHistory;
      wh.updatedAt = Date.now();
      const map = loadLocalCustomLists();
      map['watch-history'] = wh;
      saveLocalCustomListsMap(map);
      window._watchedItemIds = new Set(synced.watchHistory.map((it) => String(it.id)));
      touchedTracking = true;
    }
    if (Array.isArray(synced.continueWatching)) {
      const cw = getOrCreateContinueWatchingList();
      cw.items = synced.continueWatching;
      cw.updatedAt = Date.now();
      const map = loadLocalCustomLists();
      map['continue-watching'] = cw;
      saveLocalCustomListsMap(map);
      window._inProgressShowIds = new Set(synced.continueWatching.map((it) => String(it.showId)).filter(Boolean));
      touchedTracking = true;
    }
    // Both feed the server-side Continue Watching cron and, once adopted
    // here, the exact same badge/dismissal logic Watch History and
    // Continue Watching already use client-side (see updateContinueWatching
    // and setShowFullyWatched in 21_client-custom-list-builder.js) --
    // without adopting these too, a show newly re-flagged fully-watched by
    // the cron wouldn't show its badge here until this browser happened to
    // recompute it independently, and a dismissal made on another device
    // wouldn't be respected on this one.
    if (Array.isArray(synced.fullyWatchedShowIds)) {
      window._fullyWatchedShowIds = new Set(synced.fullyWatchedShowIds.map(String));
      try {
        localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify(synced.fullyWatchedShowIds));
      } catch (e) {
        // non-critical
      }
    }
    if (synced.dismissedContinueWatching && typeof synced.dismissedContinueWatching === 'object') {
      window._dismissedContinueWatching = synced.dismissedContinueWatching;
      try {
        localStorage.setItem('myListAddon:dismissedContinueWatching', JSON.stringify(synced.dismissedContinueWatching));
      } catch (e) {
        // non-critical
      }
    }
    // The dashboard may have already rendered (from before this fetch
    // resolved) with whatever was on this browser beforehand -- refresh it
    // now that the synced watch data has landed, or a device signing in
    // for the first time would show a stale/empty Watch History card
    // until something else happened to trigger a re-render.
    if (touchedTracking && typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

    saveState();
  } catch (e) {
    // Network hiccup -- stay with whatever's already on this browser
    // rather than blocking on a retry.
  }
}

// Shared entry point into the save flow -- used both by the row-level
// "Save List" button (startSaveListFlow below) and directly by Save as a
// List, so a freshly-built list goes straight into saving instead of
// needing a separate trip down to the row below and a second click.
// Signed in -> asks Public/Private, then saves to the Creator Profile.
// Not signed in -> saves straight to this browser's local Custom Lists
// store, no modal at all (see saveLocalCustomList's own comment for why
// there's no equivalent Public/Private step for a local save).
function beginSaveListFlow(sourceRow, urlInput, name) {
  const payload = parseCustomListPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this list.');
    return;
  }
  if (activeCreator) {
    pendingSaveListContext = { sourceRow, urlInput, payload, name };
    openVisibilityModal();
  } else {
    saveLocalCustomList(sourceRow, urlInput, payload, name);
  }
}

// Entry point for the row-level "Save List" button (still here for lists
// that already exist as a row but haven't been through the save flow yet
// -- e.g. one loaded from a shared/backed-up config).
function startSaveListFlow(btn) {
  const sourceRow = btn.closest('.source-row');
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this list.');
    return;
  }
  const rowDiv = urlInput.closest('.entry');
  const name = rowDiv && rowDiv.querySelector('.name') ? rowDiv.querySelector('.name').value.trim() : '';
  if (!name) {
    alert('Name this list first (in the row above), then try again.');
    return;
  }
  beginSaveListFlow(sourceRow, urlInput, name);
}

function openCreateProfileModal() {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>Create a Free Account</h2>' +
    '<p class="modal-sub">Save and sync your custom lists, presets, and channels from any device.<br>No email. No password. Just a username and key.</p>' +
    '<div class="row"><input type="text" id="createProfileNameInput" placeholder="Choose a Username"></div>' +
    '<div id="createProfileError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitCreateProfile()">Create Account</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openRestoreModal();">Already have one? Restore</button>' +
    '</div>'
  );
}

async function submitCreateProfile() {
  const name = document.getElementById('createProfileNameInput').value.trim();
  const errBox = document.getElementById('createProfileError');
  if (!name) {
    errBox.innerHTML = '<p class="testresult err">Enter a username.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' +
        escapeHtml(data.error === 'no-kv' ? 'This Worker has no CONFIGS KV namespace bound.' : (data.error || 'Could not create profile.')) + '</p>';
      return;
    }
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', data.creatorKey);
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderTrackPlaybackSection();
    showKeyRevealModal(data.displayName, data.creatorKey);
    loadCreatorSync();
    migrateLocalCustomListsToAccount();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}

// The Key is shown here in full the moment it's created -- it was never
// stored anywhere server-side (only its hash was), so this is the only
// time it's ever handed back in full without the person having to reveal
// it themselves. It can still be viewed again later from Settings (see
// renderKeyRevealSettingsSection), just hidden behind a click there rather
// than shown outright, so this isn't the one and only chance at it the
// way it used to be. Whether or not there's a list still waiting to be
// saved (pendingSaveListContext), "Continue" leads into the same
// visibility step next.
function showKeyRevealModal(displayName, creatorKey) {
  showModal(
    '<h2>Creator Profile Created</h2>' +
    '<p class="modal-sub" style="margin-bottom:4px;">Username</p>' +
    '<p style="margin:0 0 14px; font-weight:600;">' + escapeHtml(displayName) + '</p>' +
    '<p class="modal-sub" style="margin-bottom:4px;">Key</p>' +
    '<div class="creator-key-display" id="revealedCreatorKey">' + escapeHtml(creatorKey) + '</div>' +
    '<p class="modal-sub">Save this key somewhere safe. You\\'ll need it to edit your lists from another browser. You can view it again later from Settings.</p>' +
    '<div class="actions">' +
    '<button type="button" class="secondary" onclick="copyRevealedCreatorKey()">Copy Key</button>' +
    '<button type="button" onclick="continueAfterKeyReveal()">Continue</button>' +
    '</div>'
  );
}

function copyRevealedCreatorKey() {
  const text = document.getElementById('revealedCreatorKey').textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => alert('Copied.')).catch(() => prompt('Copy this key:', text));
  } else {
    prompt('Copy this key:', text);
  }
}

function continueAfterKeyReveal() {
  closeModal();
  if (pendingSaveListContext) {
    openVisibilityModal();
  } else {
    renderCreatorDashboard();
  }
}

function openVisibilityModal() {
  const ctx = pendingSaveListContext;
  if (!ctx) return;
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2 style="margin-top:0; color:#001f3f;">Visibility</h2>' +
    '<div class="visibility-choice" style="display:flex; flex-direction:column; gap:16px; margin: 20px 0;">' +
    '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; color:#001f3f;">' +
      '<input type="radio" name="listVisibility" value="public" checked style="margin-top:4px; accent-color:#003366;">' +
      '<span style="flex:1;"><strong>Public</strong><br><small style="color:#555;">Anyone with the link can view and use this list.</small></span>' +
    '</label>' +
    '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; color:#001f3f;">' +
      '<input type="radio" name="listVisibility" value="private" style="margin-top:4px; accent-color:#003366;">' +
      '<span style="flex:1;"><strong>Private</strong><br><small style="color:#555;">Only you can view and edit this list after restoring your Creator Profile.</small></span>' +
    '</label>' +
    '</div>' +
    '<div style="display:flex; justify-content:flex-end;">' +
      '<button type="button" onclick="confirmSaveAsCreator()" style="background: transparent; color: #003366; font-weight: 600; border: none; padding: 8px 16px; font-size: 1rem; cursor: pointer;">Save List</button>' +
    '</div>'
  );
}

async function confirmSaveAsCreator() {
  const ctx = pendingSaveListContext;
  if (!ctx || !activeCreator) return;
  const checked = document.querySelector('input[name="listVisibility"]:checked');
  const visibility = checked ? checked.value : 'public';
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  closeModal();
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        slug: ctx.payload.creatorSlug || undefined,
        name: ctx.name,
        type: ctx.payload.type,
        items: ctx.payload.items,
        visibility: visibility,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not save this list: ' + (data.error || 'unknown error'));
      return;
    }
    const updatedPayload = Object.assign({}, ctx.payload, {
      listName: ctx.name,
      publishedUrl: visibility === 'public' ? data.url : undefined,
      creatorSlug: data.slug,
      creatorOwner: activeCreator.creatorName,
      visibility: visibility,
    });
    ctx.sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
    saveState();
    alert(
      visibility === 'private'
        ? 'Saved to your Creator Profile as a private list.'
        : 'Saved to your Creator Profile. Link:\\n' + data.url
    );
    renderCreatorDashboard();
  } catch (e) {
    alert('Network error while saving.');
  } finally {
    pendingSaveListContext = null;
  }
}

// --- Creator Dashboard ---------------------------------------------------------

async function renderCreatorDashboard() {
  const box = document.getElementById('creatorDashboard');
  if (!box) return;
  if (!activeCreator) {
    renderLocalCustomListsDashboard(box);
    return;
  }
  box.innerHTML = '<p><small>Loading your lists\u2026</small></p>';
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your lists.') + '</p>';
      return;
    }
    lastCreatorListsData = data.lists;
    
    // Prune any config rows that reference a creatorSlug no longer on the server
    // (these are ghost rows left behind by previously deleted lists)
    {
      const validSlugs = new Set((data.lists || []).map(l => l.slug));
      let pruned = false;
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && rowPayload.creatorSlug && !validSlugs.has(rowPayload.creatorSlug)) {
          const entry = urlInput.closest('.entry');
          if (entry) { entry.remove(); pruned = true; }
        }
      });
      if (pruned && typeof saveState === 'function') saveState();
    }
    
    const rowsHtml = data.lists.length
      ? data.lists.map((l) => {
          const shareBtn = l.visibility === 'private'
            ? ''
            : '<button type="button" class="lc-btn secondary creatorListShareBtn" data-url="' + escapeAttr(l.url) + '">Share</button>';
          const allPosters = (l.items || []).slice(0, 9).filter((it) => it.poster);
          const totalCount = l.itemCount || allPosters.length;
          const posterThumbs = allPosters.map((it, i) => {
            const isMobileEnd = (i === 2 && allPosters.length > 3);
            const isDesktopEnd = (i === allPosters.length - 1 && allPosters.length >= 4);
            let overlays = '';
            if (isMobileEnd) {
              overlays += '<div class="list-card-count-overlay mobile-only creatorListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
            }
            if (isDesktopEnd) {
              overlays += '<div class="list-card-count-overlay desktop-only creatorListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
            }
            return '<div class="list-card-mini-poster-tile">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.imdbId || it.id) + '" data-type="' + escapeAttr(l.type || 'movie') + '" alt="" loading="lazy">' +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
            '</div>';
          }).join('');
          return '<div class="creator-list-row list-card" data-slug="' + escapeAttr(l.slug) + '" data-list-type="' + escapeAttr(l.type || 'movie') + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-icon src-mylist">ML</div>' +
              '<div class="list-card-body">' +
                '<div class="list-card-title">' +
                  '<span class="drag-handle" draggable="true" style="cursor:grab; padding:0 6px 0 0;">\u2630</span>' +
                  escapeHtml(l.name) +
                '</div>' +
                '<div class="list-card-meta">' +
                  '<span>' + (l.visibility === 'private' ? 'Private' : 'Public') + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + (l.type === 'series' ? 'Shows' : 'Movies') + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + l.itemCount + ' items</span>' +
                  ((l.likes || 0) > 0 ? '<span class="list-card-meta-sep">&middot;</span><span>\u2665 ' + l.likes + '</span>' : '') +
                '</div>' +
              '</div>' +
              '<div class="list-card-actions">' +
                '<button type="button" class="lc-btn secondary creatorListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
                '<button type="button" class="lc-btn secondary creatorListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>' +
                shareBtn +
                '<button type="button" class="lc-btn primary creatorListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
              '</div>' +
            '</div>' +
            (posterThumbs ? '<div class="list-card-posters poster-preview-static creatorListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
          '</div>';
        }).join('')
      : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';

    // Watch History / Continue Watching never live on the server (see
    // renderAutoTrackedListsHtml) -- append them from localStorage so
    // they don't vanish just because someone's signed in. lastLocalCustomListsData
    // gets pointed at just these two so the click-delegation handlers below
    // (Edit/Delete/+Add/View) can still resolve a click on either of them
    // while lastCreatorListsData covers the server rows above.
    const autoTracked = renderAutoTrackedListsHtml();
    lastLocalCustomListsData = autoTracked.lists;

    box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + autoTracked.html + '</div>';
    document.querySelectorAll('#creatorListRows .drag-handle').forEach((h) => initCreatorListTouchDrag(h));
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your lists.</p>';
  }
}

// Local equivalent of the dashboard above -- same row layout (minus
// Share, which needs a server-hosted URL to share, and minus drag-to-
// reorder, which would need a local reordering scheme of its own; sorted
// by most-recently-updated instead). Synchronous, no fetch, since it's
// just reading localStorage.
// Builds one list-card's HTML for a local (browser-only) list -- shared by
// renderLocalCustomListsDashboard (signed out: every local list) and
// renderAutoTrackedListsHtml (signed in: just Watch History/Continue
// Watching, since those two never get migrated to a Creator Profile).
// Builds a "Show Name S03E07 Episode Name" label for a Watch History /
// Continue Watching episode entry -- both store showTitle/seasonNum/
// episodeNum alongside the raw episode name (see toggleWatchStatus,
// toggleBatchWatchStatus, and updateContinueWatching), so the season and
// episode number can always be reconstructed here instead of just showing
// the bare episode title, which on its own doesn't say which show or
// which episode it even is. Falls back to whatever name/title it has for
// movies (no season/episode) or older entries saved before this existed.
// Splits a Watch History / Continue Watching episode entry into a
// "Show Name S03E07" line and an "Episode Name" line -- both items store
// showTitle/seasonNum/episodeNum alongside the raw episode name (see
// toggleWatchStatus, toggleBatchWatchStatus, and updateContinueWatching),
// so this can always reconstruct which show/season/episode it is instead
// of just showing the bare episode title, which on its own says neither.
// Movies (no season/episode) and older entries saved before this existed
// just get a single line back, with subtitle empty.
function formatWatchItemLabel(it) {
  if (!it) return { title: '', subtitle: '' };
  if (it.showTitle && it.seasonNum != null && it.episodeNum != null) {
    const s = String(it.seasonNum).padStart(2, '0');
    const e = String(it.episodeNum).padStart(2, '0');
    return { title: it.showTitle + ' S' + s + 'E' + e, subtitle: it.name || it.title || '' };
  }
  return { title: it.title || it.name || '', subtitle: '' };
}

function buildLocalListCardHtml(l) {
  const isAutoTracked = l.slug === 'watch-history' || l.slug === 'continue-watching';
  const itemCount = (l.items || []).length;
  const allPosters = (l.items || []).slice(0, 9).filter((it) => (l.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster)));
  const totalCount = itemCount || allPosters.length;
  const posterThumbs = allPosters.map((it, i) => {
    const isMobileEnd = (i === 2 && allPosters.length > 3);
    const isDesktopEnd = (i === allPosters.length - 1 && allPosters.length >= 4);
    let overlays = '';
    if (isMobileEnd) {
      overlays += '<div class="list-card-count-overlay mobile-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    if (isDesktopEnd) {
      overlays += '<div class="list-card-count-overlay desktop-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    // Watch History / Continue Watching items are keyed by episode/
    // movie id (it.id), not the imdbId/title shape a hand-built
    // Custom List item has -- fall back through both schemas, and
    // for a Continue Watching entry specifically, link the poster to
    // the show itself (it.showId) rather than the episode's own id,
    // since there's no per-episode details view to send it to.
    const posterId = it.showId || it.imdbId || it.id;
    const posterType = it.showId ? 'series' : (l.type || 'movie');
    const label = formatWatchItemLabel(it);
    // Only Continue Watching gets a remove button -- Watch History and
    // regular Custom Lists don't have a "dismiss until something changes"
    // concept the way Continue Watching's "what's next" suggestion does.
    const removeBtn = (l.slug === 'continue-watching' && it.showId)
      ? '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); dismissContinueWatchingShow(&quot;' + escapeAttr(it.showId) + '&quot;)" title="Remove from Continue Watching">&times;</button>'
      : '';
    const itemPoster = l.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster);
    return '<div class="list-card-mini-poster-tile">' +
      '<div class="list-card-mini-poster-img-wrap">' +
        '<img src="' + escapeAttr(itemPoster) + '" class="clickable-poster" data-id="' + escapeAttr(posterId) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
        removeBtn +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
      (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
    '</div>';
  }).join('');
  const typeLabel = l.type === 'series' ? 'Shows' : l.type === 'movie' ? 'Movies' : 'Mixed';
  // Watch History's own card: every poster shown here is watched by
  // definition, so the blue checkmark badge is redundant -- same
  // suppression the Live Preview shelf and "see all" modal already apply
  // via this class (see the .is-watch-history-shelf CSS rule), just not
  // previously wired up to this specific card's markup.
  const cardClass = 'list-card' + (l.slug === 'watch-history' ? ' is-watch-history-shelf' : '');
  return '<div class="' + cardClass + '" data-slug="' + escapeAttr(l.slug) + '" data-list-type="' + escapeAttr(l.type || 'movie') + '">' +
    '<div class="list-card-header">' +
      '<div class="list-card-icon src-mylist">ML</div>' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
        '<div class="list-card-meta">' +
          '<span>' + typeLabel + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + '</span>' +
        '</div>' +
      '</div>' +
      // Watch History and Continue Watching are auto-generated from what
      // you actually watch, not something to hand-edit or delete -- Edit
      // would desync it from _watchedItemIds (nothing would tell the
      // "watched" badge system an item was removed), and Delete doesn't
      // just clear this browser: the next background account sync push
      // (a full overwrite, not a merge) would wipe it from every
      // signed-in device too. Both stay view-only; the poster grid below
      // still works normally.
      (isAutoTracked
        ? '<div class="list-card-actions">' +
            '<span style="font-size:0.78rem; color:var(--muted); white-space:nowrap; margin-right:8px;">Auto-tracked</span>' +
            '<button type="button" class="lc-btn primary localListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
          '</div>'
        : '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn secondary localListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
            '<button type="button" class="lc-btn secondary localListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>' +
            '<button type="button" class="lc-btn primary localListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
          '</div>') +
    '</div>' +
    (posterThumbs ? '<div class="list-card-posters poster-preview-static localListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
  '</div>';
}

// Backfills a slug onto Watch History / Continue Watching entries saved by
// an older version of this addon before they carried one -- without it,
// the dashboard's View/Edit/Delete/+Add buttons can't match a click back
// to the right entry. Same patch getOrCreateWatchHistoryList /
// getOrCreateContinueWatchingList apply on write; this covers the
// read-only path where someone opens this tab without touching either
// list first.
function backfillAutoTrackedListSlugs(map) {
  let patched = false;
  ['watch-history', 'continue-watching'].forEach((key) => {
    if (map[key] && !map[key].slug) {
      map[key].slug = key;
      patched = true;
    }
  });
  if (patched) saveLocalCustomListsMap(map);
}

// Watch History and Continue Watching are always local -- generated by
// this browser as you watch things, and deliberately never uploaded to a
// Creator Profile the way an ordinary saved Custom List is (turning your
// private watch history into a public server list on sign-up would be a
// bad surprise). That means the signed-in dashboard below, which replaces
// this panel with server data, would otherwise make them disappear the
// moment someone signs in -- this renders them from localStorage
// regardless of sign-in state so they can be appended alongside whatever
// else the panel is showing.
function renderAutoTrackedListsHtml() {
  const map = loadLocalCustomLists();
  backfillAutoTrackedListSlugs(map);
  const lists = ['watch-history', 'continue-watching'].map((key) => map[key]).filter(Boolean);
  return { html: lists.map(buildLocalListCardHtml).join(''), lists: lists };
}

function renderLocalCustomListsDashboard(box) {
  const map = loadLocalCustomLists();
  backfillAutoTrackedListSlugs(map);

  const lists = Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  lastLocalCustomListsData = lists;
  const rowsHtml = lists.length
    ? lists.map(buildLocalListCardHtml).join('')
    : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';
  box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
}


const _creatorDashEl = document.getElementById('creatorDashboard');
if (_creatorDashEl) {
  _creatorDashEl.addEventListener('click', async (e) => {
    if (e.target.closest('.clickable-poster')) return;
    const viewBtn = e.target.closest('.creatorListViewBtn, .localListViewBtn, .creatorListViewTrigger, .localListViewTrigger');
  if (viewBtn) {
    const slug = viewBtn.dataset.slug;
    const pool = (viewBtn.classList.contains('localListViewBtn') || viewBtn.classList.contains('localListViewTrigger')) ? lastLocalCustomListsData : lastCreatorListsData;
    const list = (pool || []).filter((l) => l.slug === slug)[0];
    const sample = list ? (list.items || []).map((it) => {
      const label = formatWatchItemLabel(it);
      return {
        // Watch History / Continue Watching items store the episode's own
        // id, not the show's -- there's no per-episode details view, so
        // point the poster at the show instead (same fallback used for the
        // dashboard's own mini-poster thumbnails above).
        id: it.showId || it.imdbId || it.id,
        type: it.showId ? 'series' : (list.type || 'movie'),
        name: label.title,
        subtitle: label.subtitle,
        poster: list.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster),
        year: it.year,
        // Only Continue Watching's own grid gets a remove button -- see
        // buildLocalListCardHtml's matching comment for why.
        removeShowId: (list.slug === 'continue-watching' && it.showId) ? it.showId : null,
      };
    }) : [];
    openListPreviewModal(viewBtn.dataset.name, viewBtn.dataset.type, '', { sample: sample, maybeMore: false });
    return;
  }
  const shareBtn = e.target.closest('.creatorListShareBtn');
  if (shareBtn) {
    const listUrl = shareBtn.dataset.url;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(listUrl).then(() => alert("Link copied: " + listUrl)).catch(() => prompt("Share this link:", listUrl));
    } else {
      prompt("Share this link:", listUrl);
    }
    return;
  }
  const deleteBtn = e.target.closest('.creatorListDeleteBtn');
  if (deleteBtn) {
    const slug = deleteBtn.dataset.slug;
    if (!confirm("Delete this list? This cannot be undone.")) return;
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, slug: slug }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not delete: ' + (data.error || 'unknown error'));
        return;
      }
      
      // Remove from main lists config if present
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && (rowPayload.creatorSlug === slug || rowPayload.slug === slug)) {
          const entry = urlInput.closest('.entry');
          if (entry) {
            entry.remove();
            if (typeof saveState === 'function') saveState();
          }
        }
      });
      
      renderCreatorDashboard();
    } catch (err) {
      alert('Network error while deleting.');
    }
    return;
  }
  const editBtn = e.target.closest('.creatorListEditBtn');
  if (editBtn) {
    editCreatorList(editBtn.dataset.slug);
    return;
  }
  const addToConfigBtn = e.target.closest('.creatorListAddToConfigBtn');
  if (addToConfigBtn) {
    const slug = addToConfigBtn.dataset.slug;
    const listMeta = (lastCreatorListsData || []).find((l) => l.slug === slug);
    if (!listMeta) {
      alert('Could not find that list -- try refreshing.');
      return;
    }
    const payload = { listId: generateChannelId(), type: listMeta.type, items: listMeta.items || [], shuffle: false };
    addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'Custom Lists');
    addToConfigBtn.disabled = true;
    addToConfigBtn.textContent = 'Added \u2713';
    return;
  }
  const localEditBtn = e.target.closest('.localListEditBtn');
  if (localEditBtn) {
    const editSlug = localEditBtn.dataset.slug;
    // Defense in depth -- these buttons no longer render for Watch
    // History/Continue Watching (see buildLocalListCardHtml), but guard
    // here too in case anything else ever calls this. Editing one by hand
    // would desync it from _watchedItemIds, since nothing would tell the
    // "watched" badge system an item was removed.
    if (editSlug === 'watch-history' || editSlug === 'continue-watching') return;
    editLocalCustomList(editSlug);
    return;
  }
  const localDeleteBtn = e.target.closest('.localListDeleteBtn');
  if (localDeleteBtn) {
    const slug = localDeleteBtn.dataset.slug;
    // Same as above -- deleting either of these doesn't just clear this
    // browser, it also wipes them from every signed-in device on the next
    // background account sync (a full overwrite, not a merge).
    if (slug === 'watch-history' || slug === 'continue-watching') return;
    if (!confirm("Delete this list? This cannot be undone.")) return;
    const map = loadLocalCustomLists();
    delete map[slug];
    saveLocalCustomListsMap(map);
    
    // Remove from main lists config if present
    document.querySelectorAll('#lists .url').forEach((urlInput) => {
      const rowPayload = parseCustomListPayloadClient(urlInput.value);
      if (rowPayload && rowPayload.localSlug === slug) {
        const entry = urlInput.closest('.entry');
        if (entry) entry.remove();
      }
    });
    if (typeof saveState === 'function') saveState();
    
    renderCreatorDashboard();
    return;
  }
  const localAddToConfigBtn = e.target.closest('.localListAddToConfigBtn');
  if (localAddToConfigBtn) {
    const slug = localAddToConfigBtn.dataset.slug;
    const listMeta = (lastLocalCustomListsData || []).find((l) => l.slug === slug);
    if (!listMeta) {
      alert('Could not find that list -- try refreshing.');
      return;
    }
    
    const items = listMeta.items || [];
    
    if (listMeta.type === 'mixed' || slug === 'watch-history' || slug === 'continue-watching') {
      const movies = [];
      const series = [];
      
      items.forEach(it => {
        const isMovie = it.kind === 'movie' || it.type === 'movie';
        const mapped = {
          imdbId: isMovie ? (it.imdbId || it.id) : (it.showId || it.imdbId || it.id),
          title: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
          poster: isMovie ? it.poster : (it.showPoster || it.poster),
          year: it.year
        };
        
        if (isMovie) {
          movies.push(mapped);
        } else {
          // Keep only one entry per show in the catalog
          if (!series.some(s => s.imdbId === mapped.imdbId)) {
            series.push(mapped);
          }
        }
      });
      
      if (movies.length > 0) {
        const url = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
          ? 'autotrack:' + slug + ':movie:' + activeCreator.normalized
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'movie', items: movies, shuffle: false });
        addRow(listMeta.name + (series.length > 0 ? ' (Movies)' : ''), url, 'movie', true, 'My Lists');
      }
      if (series.length > 0 || movies.length === 0) {
        const url = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
          ? 'autotrack:' + slug + ':series:' + activeCreator.normalized
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'series', items: series, shuffle: false });
        addRow(listMeta.name + (movies.length > 0 ? ' (Shows)' : ''), url, 'series', true, 'My Lists');
      }
    } else {
      const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type, items: items, shuffle: false };
      addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'My Lists');
    }
    
    localAddToConfigBtn.disabled = true;
    localAddToConfigBtn.textContent = 'Added \u2713';
  }
});
}

function editCreatorList(slug) {
  const listMeta = (lastCreatorListsData || []).find((l) => l.slug === slug);
  if (!listMeta) {
    alert('Could not find that list -- try refreshing.');
    return;
  }
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = listMeta.type;
  editingCreatorListSlug = slug;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = listMeta.type === 'series' ? 'tv' : 'movie';
  const visSelect = document.getElementById('customListVisibilitySelect');
  if (visSelect) visSelect.value = listMeta.visibility === 'private' ? 'private' : 'public';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  switchTab('lists');
  // Create List has no pill of its own in #listsSubnavBar (it's only ever
  // reached via a list's Edit button, not a tab click), so there's no
  // correct button to highlight here -- passing none leaves every pill
  // unhighlighted instead of the wrong one lighting up. Previously this
  // grabbed whichever pill happened to be 5th, which meant "Find Lists"
  // would light up while looking at the Create List panel instead of Find
  // Lists as soon as anything else got added to the pill bar and shifted
  // that position.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Local equivalent of editCreatorList above.
function editLocalCustomList(slug) {
  const map = loadLocalCustomLists();
  const listMeta = map[slug];
  if (!listMeta) {
    alert('Could not find that list -- try refreshing.');
    return;
  }
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = listMeta.type;
  editingLocalCustomListSlug = slug;
  editingCreatorListSlug = null;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = listMeta.type === 'series' ? 'tv' : 'movie';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  switchTab('lists');
  // Same reasoning as editCreatorList above -- Create List has no pill of
  // its own to correctly highlight.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Drag-to-reorder for the Dashboard's own list of lists -- same live-DOM-
// reorder-then-persist technique used for the picks draft above, just
// keyed by data-slug instead of a data-idx into a local array, since the
// "array" here is the server's own persisted order.
let creatorListDragRow = null;

function getCreatorListDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.creator-list-row:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

async function persistCreatorListOrderFromDom() {
  const container = document.getElementById('creatorListRows');
  if (!container) return;
  const order = [...container.querySelectorAll('.creator-list-row')].map((row) => row.dataset.slug);
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    await fetch(ORIGIN + '/api/creator/lists/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, order: order }),
    });
  } catch (e) {
    // A failed reorder save just means it reverts to server order next
    // load -- not worth interrupting with an error for a drag-and-drop.
  }
}

function initCreatorListTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('dragstart', (e) => {
    creatorListDragRow = handle.closest('.creator-list-row');
    creatorListDragRow.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!creatorListDragRow) return;
    const container = document.getElementById('creatorListRows');
    if (!container) return;
    e.preventDefault();
    const afterEl = getCreatorListDragAfterElement(container, e.clientY);
    if (afterEl == null) container.appendChild(creatorListDragRow);
    else if (afterEl !== creatorListDragRow) container.insertBefore(creatorListDragRow, afterEl);
  });
  handle.addEventListener('dragend', () => {
    if (creatorListDragRow) creatorListDragRow.classList.remove('dragging');
    creatorListDragRow = null;
    persistCreatorListOrderFromDom();
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    creatorListDragRow = handle.closest('.creator-list-row');
    creatorListDragRow.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    const move = (ev) => {
      const container = document.getElementById('creatorListRows');
      if (!container || !creatorListDragRow) return;
      const afterEl = getCreatorListDragAfterElement(container, ev.clientY);
      if (afterEl == null) container.appendChild(creatorListDragRow);
      else if (afterEl !== creatorListDragRow) container.insertBefore(creatorListDragRow, afterEl);
    };
    const end = () => {
      document.removeEventListener('pointermove', move);
      if (creatorListDragRow) creatorListDragRow.classList.remove('dragging');
      creatorListDragRow = null;
      persistCreatorListOrderFromDom();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end, { once: true });
    document.addEventListener('pointercancel', end, { once: true });
  });
}

// Editing a row's name/url/type or toggling its checkbox doesn't go through
// addRow/renumber, so save on those too via delegation instead of wiring up
// a listener on every individual field.
document.getElementById('lists').addEventListener('input', saveState);
document.getElementById('lists').addEventListener('change', saveState);

function openCreateListModal() {
  document.getElementById('createListModalName').value = '';
  document.getElementById('createListModalPublic').checked = true;
  document.getElementById('createListModalBtn').disabled = true;
  document.getElementById('createListModalBtn').style.opacity = '0.5';
  document.getElementById('createListModal').style.display = 'flex';
}

async function submitCreateListModal() {
  const name = document.getElementById('createListModalName').value.trim();
  if (!name) return;
  const isPublic = document.getElementById('createListModalPublic').checked;
  const visibility = isPublic ? 'public' : 'private';
  
  const payload = { listId: generateChannelId(), type: 'movie', items: [], shuffle: false };
  const newUrl = 'customlist:v1:' + JSON.stringify(payload);
  
  const btn = document.getElementById('createListModalBtn');
  btn.innerText = 'Saving...';
  btn.disabled = true;
  
  try {
    if (activeCreator) {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: 'movie',
          items: [],
          visibility: visibility
        })
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not save this list: ' + (data.error || 'unknown error'));
        btn.innerText = 'Create';
        btn.disabled = false;
        return;
      }
      
      const updatedPayload = Object.assign({}, payload, {
        listName: name,
        publishedUrl: visibility === 'public' ? data.url : undefined,
        creatorSlug: data.slug,
        creatorOwner: activeCreator.creatorName,
        visibility: visibility
      });
      addRow(name, 'customlist:v1:' + JSON.stringify(updatedPayload), 'movie', true, 'Custom Lists');
    } else {
      // Local list
      const slug = payload.listId;
      payload.localSlug = slug;
      
      const map = loadLocalCustomLists();
      map[slug] = {
        name: name,
        type: 'movie',
        items: [],
        updatedAt: Date.now()
      };
      saveLocalCustomListsMap(map);
      
      addRow(name, 'customlist:v1:' + JSON.stringify(payload), 'movie', true, 'Custom Lists');
    }
    
    saveState();
    document.getElementById('createListModal').style.display = 'none';
    switchTab('lists');
    switchListsSubmenu('my-lists', document.querySelector('#listsSubnavBar button:nth-child(1)'));
    renderCreatorDashboard();
  } catch (e) {
    alert('Network error while saving.');
  } finally {
    btn.innerText = 'Create';
    btn.disabled = false;
  }
}

// Reordering & position management
function moveRow(btn, dir) {
  const entry = btn.closest('.entry');
  const container = document.getElementById('lists');
  // Works off the ordered array of .entry elements (not raw DOM siblings)
  // so this stays correct regardless of what else the container holds.
  const entries = [...container.querySelectorAll('.entry')];
  const idx = entries.indexOf(entry);
  if (dir < 0 && idx > 0) {
    container.insertBefore(entry, entries[idx - 1]);
  } else if (dir > 0 && idx < entries.length - 1) {
    container.insertBefore(entries[idx + 1], entry);
  }
  renumber();
}

function renumber() {
  const entries = [...document.querySelectorAll('#lists .entry')];
  entries.forEach((div, i) => {
    const posInput = div.querySelector('.pos');
    if (posInput) {
      posInput.value = i + 1;
      posInput.max = entries.length;
    }
    const ups = div.querySelectorAll('.movebtn');
    if (ups && ups.length >= 2) {
      ups[0].disabled = (i === 0);
      ups[1].disabled = (i === entries.length - 1);
    }
  });
  updateListGroupFilterOptions();
  filterLists();
  saveState();
}

// Lets someone type a new position directly into a row's number box (e.g.
// "60" -> "2") instead of clicking the up arrow 58 times -- the row is
// pulled out and reinserted at that spot, and everything in between shifts
// down (or up) by one to make room, same as dragging it there would.
function movePosTo(input) {
  const container = document.getElementById('lists');
  const entries = [...container.querySelectorAll('.entry')];
  const entry = input.closest('.entry');
  const from = entries.indexOf(entry);
  const typed = parseInt(input.value, 10);
  if (!typed || isNaN(typed)) {
    renumber(); // invalid/empty input -- just restore the correct number
    return;
  }
  const to = Math.min(Math.max(typed, 1), entries.length) - 1;
  if (to === from) {
    renumber();
    return;
  }
  entries.splice(from, 1);
  entries.splice(to, 0, entry);
  entries.forEach((e) => container.appendChild(e));
  renumber();
}

// Drag-to-reorder, as an addition to (not a replacement for) the \u2191/\u2193
// buttons above -- those still work and are the only option on touch
// devices, where native HTML5 drag-and-drop generally isn't supported.
let dragSrcEntry = null;

document.getElementById('lists').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) { e.preventDefault(); return; }
  dragSrcEntry = handle.closest('.entry');
  dragSrcEntry.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('lists').addEventListener('dragend', () => {
  if (dragSrcEntry) dragSrcEntry.classList.remove('dragging');
  dragSrcEntry = null;
  renumber();
});

document.getElementById('lists').addEventListener('dragover', (e) => {
  if (!dragSrcEntry) return;
  e.preventDefault();
  const container = document.getElementById('lists');
  const afterEl = getDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(dragSrcEntry);
  } else if (afterEl !== dragSrcEntry) {
    container.insertBefore(dragSrcEntry, afterEl);
  }
});

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.entry:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    }
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

// Touch/pen drag-to-reorder -- native HTML5 drag-and-drop (above) generally
// doesn't fire on touch devices at all, which left dragging a list of 60
// rows into place a real chore on mobile (the \u2191/\u2193 buttons and the
// editable position number both still work there, but neither is as fast
// as a drag). Pointer Events cover touch/pen here without disturbing the
// existing mouse path -- gated to pointerType so a mouse drag still goes
// through the HTML5 dragstart/dragover listeners above untouched. Called
// once per row (from addRow) since each row gets its own handle.
let touchDragEntry = null;

function initTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    touchDragEntry = handle.closest('.entry');
    touchDragEntry.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onTouchDragMove);
    document.addEventListener('pointerup', onTouchDragEnd, { once: true });
    document.addEventListener('pointercancel', onTouchDragEnd, { once: true });
  });
}

function onTouchDragMove(e) {
  if (!touchDragEntry) return;
  const container = document.getElementById('lists');
  const afterEl = getDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(touchDragEntry);
  } else if (afterEl !== touchDragEntry) {
    container.insertBefore(touchDragEntry, afterEl);
  }
}

function onTouchDragEnd() {
  document.removeEventListener('pointermove', onTouchDragMove);
  if (touchDragEntry) touchDragEntry.classList.remove('dragging');
  touchDragEntry = null;
  renumber();
}

// --- undo toast -------------------------------------------------------------
//
// A brief window to reverse Remove All or a single row's Remove button,
// Gmail-style, instead of a confirm() dialog every time. Only remembers the
// single most recent destructive action (not a full history) -- good enough
// for "oops, changed my mind" without the complexity of a real undo stack.
let undoSnapshot = null;
let undoTimer = null;

function captureUndoSnapshot() {
  undoSnapshot = { entries: collectEntries() };
}

function showUndoToast(message) {
  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastMsg').textContent = message;
  toast.style.display = 'flex';
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 8000);
}

function hideUndoToast() {
  document.getElementById('undoToast').style.display = 'none';
  clearTimeout(undoTimer);
}

function performUndo() {
  if (!undoSnapshot) { hideUndoToast(); return; }
  document.getElementById('lists').innerHTML = '';
  undoSnapshot.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  hideUndoToast();
  undoSnapshot = null;
  renderChannelMergeList();
}

// Removes a single row, with the same brief-undo safety net as Remove All
// below -- wired up from each row's own Remove button in addRow().
function removeEntryWithUndo(btn) {
  const entry = btn.closest('.entry');
  const nameEl = entry.querySelector('.name');
  const name = (nameEl && nameEl.value.trim()) || 'Untitled list';
  captureUndoSnapshot();
  entry.remove();
  renumber();
  checkAllDuplicateUrls();
  renderChannelMergeList();
  showUndoToast('Removed "' + name + '".');
}

// Clears the whole builder in one go, for when someone's added a bunch of
// lists and changed their mind rather than removing them one at a time.
// No confirm() dialog -- the undo toast above is the safety net instead, so
// this is a single click like the rest of the bulk actions next to it.
function removeAllLists() {
  const entries = document.querySelectorAll('#lists .entry');
  if (!entries.length) return;
  captureUndoSnapshot();
  document.getElementById('lists').innerHTML = '';
  renumber();
  saveState();
  renderChannelMergeList();
  showUndoToast('Removed ' + entries.length + ' list(s).');
}

// --- search/filter box -------------------------------------------------------
//
// Purely a view filter -- hides non-matching rows without touching the
// underlying data, so it's safe to type into even mid-edit. Re-applied at
// the end of renumber() so it survives adds/removes/reorders/imports.
// Rebuilds the group filter's options from whatever groups actually exist
// right now (rather than a fixed hardcoded list, which would drift out of
// sync with whatever Quick Add panels/group names exist) -- called from
// renumber() below, which already runs after every add/remove/reorder.
// Preserves the current selection across a rebuild so re-filtering after
// an edit doesn't silently reset back to "All groups".
function updateListGroupFilterOptions() {
  const select = document.getElementById('listGroupFilterSelect');
  if (!select) return;
  const currentValue = select.value;
  const groups = new Set();
  document.querySelectorAll('#lists .entry').forEach((div) => {
    groups.add(div.dataset.group || 'Custom');
  });
  const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All groups</option>' +
    sortedGroups.map((g) => '<option value="' + escapeAttr(g) + '">' + escapeHtml(g) + '</option>').join('');
  if (sortedGroups.includes(currentValue)) select.value = currentValue;
}

function filterLists() {
  const input = document.getElementById('listFilterInput');
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  const groupSelect = document.getElementById('listGroupFilterSelect');
  const groupFilter = groupSelect ? groupSelect.value : '';
  document.querySelectorAll('#lists .entry').forEach((div) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl ? nameEl.value : '').toLowerCase();
    const matchesName = !q || name.indexOf(q) !== -1;
    const matchesGroup = !groupFilter || (div.dataset.group || 'Custom') === groupFilter;
    div.style.display = (matchesName && matchesGroup) ? '' : 'none';
  });
}

// --- compact view -------------------------------------------------------------
//
// Toggles a single class on the container; the actual hiding is pure CSS
// (see #lists.compact rules) so this stays a one-line flip regardless of
// how many rows are on screen.
let isLivePreviewEditMode = false;

function toggleLivePreviewEdit() {
  isLivePreviewEditMode = !isLivePreviewEditMode;
  const listsContainer = document.getElementById('lists');
  const btn = document.getElementById('livePreviewEditBtn');
  if (isLivePreviewEditMode) {
    listsContainer.classList.add('live-preview-edit-mode');
    if (btn) {
      btn.textContent = 'Done Editing';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
  } else {
    listsContainer.classList.remove('live-preview-edit-mode');
    if (btn) {
      btn.textContent = 'Edit';
      btn.classList.remove('primary');
      btn.classList.add('secondary');
    }
  }
}

function toggleCompactView(btn) {
  const container = document.getElementById('lists');
  const isCompact = container.classList.toggle('compact');
  btn.textContent = isCompact ? 'Full view' : 'Compact view';
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,60);
}

async function testSourceRow(btn) {
  const sourceRow = btn.closest('.source-row');
  const entry = btn.closest('.entry');
  const url = sourceRow.querySelector('.url').value.trim();
  const type = entry.querySelector('.type').value;
  const resultEl = sourceRow.querySelector('.testresult');

  if (!url) { resultEl.className = 'testresult err'; resultEl.textContent = 'Paste a URL first.'; return; }

  btn.disabled = true;
  resultEl.className = 'testresult pending';
  resultEl.textContent = 'Testing\u2026';

  try {
    const body = { url, type };
    const mdblistKey = document.getElementById('mdblistKeyInput').value.trim();
    if (mdblistKey) body.mdblistKey = mdblistKey;
    const traktKey = document.getElementById('traktKeyInput').value.trim();
    if (traktKey) body.traktKey = traktKey;
    if (traktAccessToken) body.traktAccessToken = traktAccessToken;
    const res = await fetch(\`\${ORIGIN}/api/preview\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (data.ok) {
      const more = data.maybeMore ? '+' : '';
      resultEl.className = 'testresult ok';
      const thumbs = (data.sample || []).filter((s) => s.poster).slice(0, 5).map((s) =>
        '<img class="preview-thumb" src="' + escapeAttr(s.poster) + '" alt="' + escapeAttr(s.name) + '" title="' + escapeAttr(s.name) + '" loading="lazy">'
      ).join('');
      const label = data.count === 0
        ? '\u2713 Reachable, but 0 items matched (check the movie/series toggle).'
        : \`\u2713 \${data.count}\${more} items found\`;
      resultEl.innerHTML = '<div>' + label + '</div>' + (thumbs ? '<div class="preview-thumbs">' + thumbs + '</div>' : '');
    } else {
      resultEl.className = 'testresult err';
      resultEl.textContent = '\u2717 ' + data.error;
    }
  } catch (e) {
    resultEl.className = 'testresult err';
    resultEl.textContent = '\u2717 Network error testing this list.';
  } finally {
    btn.disabled = false;
  }
}

// Runs every row's Test one panel at a time (well, CONCURRENCY at a time)
// by just calling the exact same testSourceRow used for a single row --
// same inline per-row result, same everything, just walking the whole
// list instead of one button click. A summary alert at the end since
// there's no single place on a long list where all the individual
// testresult divs would be visible at once.
async function testAllSources() {
  const buttons = Array.from(document.querySelectorAll('#lists .btn-test'));
  if (!buttons.length) {
    alert('No lists to test yet -- add some above first.');
    return;
  }
  const testAllBtn = document.getElementById('testAllBtn');
  if (testAllBtn) {
    testAllBtn.disabled = true;
    testAllBtn.textContent = 'Testing all\u2026';
  }

  let idx = 0;
  const CONCURRENCY = 4;
  async function worker() {
    while (idx < buttons.length) {
      const i = idx++;
      if (testAllBtn) testAllBtn.textContent = 'Testing all\u2026 (' + (i + 1) + '/' + buttons.length + ')';
      await testSourceRow(buttons[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, buttons.length) }, () => worker()));

  let okCount = 0;
  let errCount = 0;
  document.querySelectorAll('#lists .testresult').forEach((el) => {
    if (el.classList.contains('ok')) okCount++;
    else if (el.classList.contains('err')) errCount++;
  });

  if (testAllBtn) {
    testAllBtn.disabled = false;
    testAllBtn.textContent = 'Test all';
  }
  alert('Tested ' + buttons.length + ' source' + (buttons.length === 1 ? '' : 's') + ' \u2014 ' + okCount + ' ok, ' + errCount + ' failed.');
}

function buildConfig(entries, keys) {
  const payload = { entries };
  if (keys && keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys && keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys && keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys && keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys && keys.track) {
    payload.track = true;
    payload.trackCreatorName = keys.trackCreatorName;
    payload.trackCreatorKey = keys.trackCreatorKey;
  }
  const jsonStr = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(jsonStr);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+\$/,'');
}

function collectEntries() {
  // Catalog IDs must be unique per (type, id) pair for wako/Stremio to tell
  // catalogs apart. Several quick-add sections deliberately reuse short
  // display names like "Movies" or "Shows" (e.g. Trending, Popular Today,
  // Popular This Year, Latest Releases all have a "Movies" row) — if the id
  // were derived from that name, all of them would collide onto the same
  // catalog id and only one (or none, depending on the client) would show
  // up after install. Deriving the id from the URL instead keeps it unique
  // per underlying list; the seen-count fallback below still protects
  // against two rows that genuinely share the same URL + type.
  const seen = {};
  return [...document.querySelectorAll('#lists .entry')].map(div => {
    const name = div.querySelector('.name').value.trim();
    // A merged entry has multiple .url inputs (one per source); join them
    // newline-separated into the single stored "url" field -- fetchCatalog
    // server-side splits on the same delimiter to fan out to each source.
    const urls = [...div.querySelectorAll('.url')].map(el => el.value.trim()).filter(Boolean);
    const url = urls.join('\\n');
    const type = div.querySelector('.type').value;
    // The per-list enable/disable checkbox was removed -- every added list
    // is simply included now (remove the row entirely to leave it out).
    const enabled = true;
    // A Channel's "url" is its whole JSON payload, not a real list URL --
    // slugifying that (like every other source below) would just truncate
    // to the poster URL's prefix, producing a meaningless, collision-prone
    // id. Channels get their own stable id instead (see generateChannelId).
    const isChannelRow = url.startsWith('channel:v1:');
    let id = isChannelRow
      ? (div.dataset.channelId || generateChannelId())
      : (slugify(urls[0] || '') || slugify(name) || 'list');
    const key = type + ':' + id;
    if (seen[key] === undefined) {
      seen[key] = 1;
    } else {
      seen[key] += 1;
      id = id + '-' + seen[key];
    }
    return { id, name, type, url, enabled, group: div.dataset.group || 'Custom' };
  }).filter(e => e.name && e.url);
}

function collectKeys() {
  // trackPlayback only actually applies once signed into a Creator
  // Profile (see renderTrackPlaybackSection's comment for why) -- the
  // checkbox state can outlive a sign-out in localStorage, so this only
  // includes it when there's actually an account to attach it to.
  let track = false;
  try { track = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}
  const keys = {
    mdblistKey: document.getElementById('mdblistKeyInput').value.trim(),
    traktKey: document.getElementById('traktKeyInput').value.trim(),
    traktUsername: document.getElementById('traktUsernameInput').value.trim(),
    traktAccessToken: traktAccessToken,
  };
  if (track && typeof activeCreator !== 'undefined' && activeCreator) {
    keys.track = true;
    keys.trackCreatorName = activeCreator.creatorName;
    keys.trackCreatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  }
  return keys;
}

// --- Live Preview -----------------------------------------------------------
//
// Renders every currently-enabled row as an actual shelf -- name + a strip
// of real posters -- the same way it'll show up on the wako/Stremio home
// screen once installed, in the same top-to-bottom order. Reuses
// collectEntries() (so a merged/multi-source row, a Channel, a Custom
// List, an official chart shortcut, the Watchlist, all resolve exactly the
// same way they would for a real install) and the existing /api/preview
// endpoint (already used by the per-row "Test" button) rather than any new
// server-side machinery -- fetchCatalog already handles every entry.url
// shape uniformly, so this is just that same endpoint called once per row.
// Manual "Refresh" button rather than auto-refreshing on every edit, since
// that would mean firing a burst of live requests on every keystroke.
//
// Each shelf's full fetched sample (up to 100 -- PAGE_SIZE, i.e. exactly
// what the real catalog's first page would contain) is kept in
// livePreviewShelfData is declared globally at script start


async function renderLivePreview() {
  const container = document.getElementById('lists');
  if (!container) return;
  
  // Important: We only collect shelves that are ENABLED, but our DOM contains all .entry rows.
  // So we must iterate all entries and map them to collectEntries().
  const entries = [...container.querySelectorAll('.entry')];
  const allShelves = collectEntries(); // returns one for every entry
  
  // livePreviewShelfData needs to match enabled shelves if openLivePreviewSeeAll expects an array of enabled.
  // Wait, collectEntries() returns all shelves. The previous code did:
  // const shelves = collectEntries().filter(e => e.enabled);
  // So livePreviewShelfData maps 1:1 with ENABLED shelves.
  const shelves = allShelves.filter((e) => e.enabled);
  livePreviewShelfData = shelves.map(() => null);
  
  if (!shelves.length) {
    // If no enabled shelves, do nothing (posters just stay hidden)
    return;
  }
  
  const keys = collectKeys();
  const CONCURRENCY = 4;
  let nextIdx = 0;
  
  // We need to map the enabled shelf index (0 to shelves.length-1) to the actual DOM entry.
  // We can do this by keeping a parallel array of DOM elements for enabled shelves.
  const enabledEntries = entries.filter((_, i) => allShelves[i].enabled);
  
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= shelves.length) return;
      const s = shelves[i];
      const entryDOM = enabledEntries[i];
      if (!entryDOM) continue;
      
      const postersContainer = entryDOM.querySelector('.live-preview-posters');
      if (!postersContainer) continue;
      
      if (s.name && s.name.toLowerCase().includes('watch history')) {
        postersContainer.classList.add('is-watch-history-shelf');
      } else {
        postersContainer.classList.remove('is-watch-history-shelf');
      }
      
      // Determine how many posters we can visibly show (using the old logic)
      const visibleCount = (window.innerWidth < 600) ? 3 : (window.innerWidth < 1000) ? 6 : 9;
      const seeAllBtn = entryDOM.querySelector('.live-preview-shelf-title button');
      if (seeAllBtn) {
        seeAllBtn.onclick = (e) => {
          e.stopPropagation();
          openLivePreviewSeeAll(i);
        };
      }
      
      try {
        const body = { url: s.url, type: s.type, sample: 100 };
        if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
        if (keys.traktKey) body.traktKey = keys.traktKey;
        if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const data = await res.json();
        if (!data.ok) {
          postersContainer.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Could not load this shelf.') + '</p>';
          continue;
        }
        if (!data.sample || !data.sample.length) {
          postersContainer.innerHTML = '<p><small>No items found.</small></p>';
          continue;
        }
        livePreviewShelfData[i] = { name: s.name, type: s.type, url: s.url, sample: data.sample, maybeMore: data.maybeMore };
        postersContainer.innerHTML = data.sample.slice(0, visibleCount).map(livePreviewPosterHtml).join('');
        if (seeAllBtn && data.sample.length > visibleCount) seeAllBtn.disabled = false;
      } catch (e) {
        postersContainer.innerHTML = '<p class="testresult err">✗ Network error loading this shelf.</p>';
      }
    }
  }

  const workers = Array(Math.min(CONCURRENCY, shelves.length)).fill(0).map(worker);
  await Promise.all(workers);
}

function livePreviewPosterHtml(m) {
  const landscape = m.posterShape === 'landscape';
  const posterClass = 'live-preview-poster' + (landscape ? ' landscape' : '');
  const posterEl = m.poster
    ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy">'
    : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
  const removeBtn = m.removeShowId
    ? '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); dismissContinueWatchingShow(&quot;' + escapeAttr(m.removeShowId) + '&quot;)" title="Remove from Continue Watching">&times;</button>'
    : '';
  return '<div class="live-preview-poster-card clickable-poster" data-id="' + escapeAttr(m.id || '') + '" data-type="' + escapeAttr(m.type || '') + '" data-title="' + escapeAttr(m.name || '') + '" data-poster="' + escapeAttr(m.poster || '') + '">' +
    '<div style="position:relative; width:100%;">' +
      posterEl +
      removeBtn +
    '</div>' +
    '<div class="live-preview-poster-name">' + escapeHtml(m.name || '') + '</div>' +
    (m.subtitle ? '<div class="live-preview-poster-subtitle">' + escapeHtml(m.subtitle) + '</div>' : '') +
  '</div>';
}

async function openListPreviewModal(name, type, listUrl, preloaded) {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>' + escapeHtml(name) + '</h2>' +
    '<div class="live-preview-modal-grid" id="listPreviewGrid"></div>' +
    '<p id="listPreviewStatus"><small>Loading\u2026</small></p>',
    'modal-card-wide'
  );
  const modalCard = document.querySelector('#activeModalOverlay .modal-card');
  const gridEl = document.getElementById('listPreviewGrid');
  if (name && name.toLowerCase().includes('watch history')) {
    gridEl.classList.add('is-watch-history-shelf');
  }
  const statusEl = document.getElementById('listPreviewStatus');
  const keys = collectKeys();
  let skip = 0;
  let loading = false;
  let done = false;
  let loadedCount = 0;
  let pagesLoaded = 0;
  const MAX_PAGES = 20;

  function appendItems(items) {
    gridEl.insertAdjacentHTML('beforeend', items.map(livePreviewPosterHtml).join(''));
    loadedCount += items.length;
  }
  function updateStatusAfterPage(maybeMore, itemsThisPage) {
    if (!maybeMore || itemsThisPage === 0 || pagesLoaded >= MAX_PAGES) {
      done = true;
      statusEl.innerHTML = loadedCount
        ? '<small>' + loadedCount + ' item' + (loadedCount === 1 ? '' : 's') + '</small>'
        : '<small>No items found.</small>';
    } else {
      statusEl.innerHTML = '<small>' + loadedCount + '+ items \u2014 scroll for more\u2026</small>';
    }
  }

  async function loadNextPage() {
    if (loading || done) return;
    if (!listUrl) {
      done = true;
      statusEl.innerHTML = loadedCount
        ? '<small>' + loadedCount + ' item' + (loadedCount === 1 ? '' : 's') + '</small>'
        : '<small>No items found.</small>';
      return;
    }
    loading = true;
    statusEl.innerHTML = '<small>Loading\u2026</small>';
    try {
      const body = { url: listUrl, type: type, skip: skip, sample: 100 };
      if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
      if (keys.traktKey) body.traktKey = keys.traktKey;
      if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
      const res = await fetch(ORIGIN + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load this list.') + '</p>';
        done = true;
        return;
      }
      const items = data.sample || [];
      appendItems(items);
      skip += items.length;
      pagesLoaded++;
      updateStatusAfterPage(data.maybeMore, items.length);
    } catch (e) {
      statusEl.innerHTML = '<p class="testresult err">\u2717 Network error loading this list.</p>';
      done = true;
    } finally {
      loading = false;
    }
  }

  if (modalCard) {
    modalCard.addEventListener('scroll', () => {
      if (modalCard.scrollTop + modalCard.clientHeight >= modalCard.scrollHeight - 300) loadNextPage();
    });
  }

  if (preloaded && preloaded.sample && preloaded.sample.length) {
    appendItems(preloaded.sample);
    skip = preloaded.sample.length;
    pagesLoaded = 1;
    updateStatusAfterPage(preloaded.maybeMore, preloaded.sample.length);
  } else {
    await loadNextPage();
  }
}

// Reuses the page-0 sample renderLivePreview already fetched for this
// shelf (see livePreviewShelfData) so opening See All doesn't cost a
// redundant request -- openListPreviewModal picks up pagination from
// there for anything beyond it.
function openLivePreviewSeeAll(i) {
  const shelf = livePreviewShelfData[i];
  if (!shelf) return;
  openListPreviewModal(shelf.name, shelf.type, shelf.url, { sample: shelf.sample, maybeMore: shelf.maybeMore });
}





// --- config JSON export/import (backup / restore) --------------------------
//
// A plain-text alternative to the install link: the same { entries,
// mdblistKey } shape buildConfig() encodes into a base64 URL, but here it's
// left as readable JSON in a textarea -- something to copy into a notes app
// or another device, and paste back in later, without touching the actual
// install link.
function exportConfigJson() {
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  document.getElementById('configJsonBox').value = JSON.stringify(payload, null, 2);
}

function importConfigJson() {
  const raw = document.getElementById('configJsonBox').value.trim();
  if (!raw) {
    alert('Paste a config JSON blob into the box first.');
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    alert('That is not valid JSON.');
    return;
  }
  applyImportedConfig(data);
}

// Shared by importConfigJson (textarea) and uploadConfigFile (file upload) --
// same validation and row-rebuilding either way, just a different source
// for the raw JSON.
function applyImportedConfig(data) {
  if (!data || !Array.isArray(data.entries)) {
    alert('That JSON does not look like a My Lists config -- expected an "entries" array.');
    return;
  }
  document.getElementById('lists').innerHTML = '';
  data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  if (data.mdblistKey) document.getElementById('mdblistKeyInput').value = data.mdblistKey;
  if (data.traktKey) document.getElementById('traktKeyInput').value = data.traktKey;
  if (data.traktUsername) document.getElementById('traktUsernameInput').value = data.traktUsername;
  if (data.traktAccessToken) {
    traktAccessToken = data.traktAccessToken;
    renderTraktConnectStatus();
  }
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
  scheduleMyMdblistListsRefresh();
  scheduleMyTraktListsRefresh();
  alert('Imported ' + data.entries.length + ' list(s).');
}

// --- import from an existing link -------------------------------------------
//
// Reads this add-on's own install link / configure link / stremio:// /
// wako:// link back into rows, via the server's /api/resolve (same
// resolveConfig() the manifest/configure routes use, so it works whether
// the link is a short KV id or a legacy self-contained base64 blob). This
// can only work for THIS add-on's own links -- a manifest from a different
// Stremio add-on, or a screenshot of one, doesn't carry the original list
// URLs anywhere recoverable, so there's no reliable way to reconstruct rows
// from either of those; Bulk Add below is the practical fallback there.
async function importFromLink() {
  const raw = document.getElementById('importLinkInput').value.trim();
  if (!raw) {
    alert('Paste an install link, configure link, or stremio://\\/wako:// link first.');
    return;
  }
  const cleaned = raw.replace(/^stremio:\\/\\//, 'https://').replace(/^wako:\\/\\//, 'https://');
  const m = cleaned.match(/\\/([^/]+)\\/(?:manifest\\.json|configure)(?:[/?#]|$)/);
  let config = null;
  if (m) {
    config = m[1];
  } else if (/^[A-Za-z0-9_-]{6,}$/.test(cleaned)) {
    config = cleaned; // looks like a bare config id/token, pasted on its own
  }
  if (!config) {
    alert('Could not find a config in that link -- paste the full install link (ending in /manifest.json) or a configure link.');
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/resolve?config=' + encodeURIComponent(config));
    const data = await res.json();
    if (!data.ok) {
      alert('Could not load that link: ' + (data.error || 'unknown error'));
      return;
    }
    data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
    if (data.mdblistKey) document.getElementById('mdblistKeyInput').value = data.mdblistKey;
    if (data.traktKey) document.getElementById('traktKeyInput').value = data.traktKey;
    if (data.traktUsername) document.getElementById('traktUsernameInput').value = data.traktUsername;
    if (data.traktAccessToken) {
      traktAccessToken = data.traktAccessToken;
      renderTraktConnectStatus();
    }
    renumber();
    checkAllDuplicateUrls();
    saveState();
    renderChannelMergeList();
    document.getElementById('importLinkInput').value = '';
    alert('Imported ' + data.entries.length + ' list(s) from that link.');
  } catch (e) {
    alert('Network error while resolving that link.');
  }
}

// --- personal presets --------------------------------------------------------
//
// Named local saves of a row selection, for reuse ("my usual setup") or
// sharing (Share copies the same JSON shape the Backup/Restore export
// uses, so the recipient can paste it into their own Import box). Stored
// separately from the autosave snapshot under its own localStorage key, and
// deliberately never includes the MDBList key -- a preset is meant to be
// safe to hand to someone else without a second thought.
const PRESETS_KEY = 'myListAddon:presets';

// Backs every preset-related function below (they all go through
// loadPresetsMap()), since localStorage alone can't be trusted to hold
// everything once a signed-in account's presets include a large Channel --
// once something's too big to persist there, it would otherwise silently
// vanish from Load/Share/Download/Delete too, not just fail to save.
// localStorage is still used underneath as a best-effort mirror for
// whatever it CAN hold, refreshed from the account by loadCreatorSync
// after every sign-in.
let cachedPresetsMap = null;

function loadPresetsMap() {
  if (cachedPresetsMap) return cachedPresetsMap;
  try {
    cachedPresetsMap = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
  } catch (e) {
    cachedPresetsMap = {};
  }
  return cachedPresetsMap;
}

function savePresetsMap(map) {
  // Always updates the cache first, even if the localStorage write below
  // fails -- this is what actually keeps a too-big-for-local-storage
  // preset visible and usable for the rest of this page session, whether
  // or not it also successfully persists to disk.
  cachedPresetsMap = map;
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // Most likely a quota error -- a TV Channel with hundreds of episodes
    // easily runs well past 100KB on its own, and localStorage's total
    // quota is shared across every preset saved plus everything else this
    // add-on keeps there. This used to fail completely silently, which
    // looked exactly like "doesn't work" with no explanation at all --
    // callers now get a false back and can say something useful instead.
    return false;
  }
}

// Pushes a presets map straight to the account's dedicated presets record
// (see /api/creator/sync/save-presets) -- the ONLY path presets travel to
// the server through now, whether from the normal debounced
// schedulePresetsSync path or, as originally added here, as a fallback
// when the local write just failed (see saveCurrentAsPreset below):
// loadPresetsMap() there would only re-read the same stale, pre-failure
// data from localStorage, silently dropping the new preset even for
// someone who's signed in -- passing the in-memory map directly here is
// what actually gets the just-added preset saved anywhere at all in that
// case. Deliberately sends nothing else (no config/collapsedPanels/
// likedLists) -- see save-presets' own comment for why keeping this
// request small is the actual point of the split.
async function pushPresetsDirectly(presetsMap) {
  if (!activeCreator) return { ok: false, error: null };
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return { ok: false, error: null };
  try {
    const presetsB64 = await compressJsonToBase64(presetsMap);
    const res = await fetch(ORIGIN + '/api/creator/sync/save-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        presets: presetsB64 ? undefined : presetsMap,
        presetsB64: presetsB64,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      // Logged (not just discarded) so a DevTools console check actually
      // shows what went wrong -- an HTTP status with no JSON body at all
      // usually means the request was killed outright (e.g. Cloudflare's
      // free-plan 10ms CPU budget on this Worker) rather than anything
      // this endpoint's own code returned. Should be rare now that this
      // request no longer bundles config/watchHistory/etc alongside a
      // large presets payload the way the old shared endpoint did.
      console.error('pushPresetsDirectly failed:', res.status, data);
      return { ok: false, error: (data && data.error) || null, status: res.status };
    }
    return { ok: true, error: null };
  } catch (e) {
    console.error('pushPresetsDirectly failed:', e);
    return { ok: false, error: null };
  }
}

async function saveCurrentAsPreset() {
  const nameInput = document.getElementById('presetNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this preset first.');
    return;
  }
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const map = loadPresetsMap();
  map[name] = { entries };
  const localOk = savePresetsMap(map);

  if (!localOk) {
    // Local storage is full -- if this account is signed in, push the
    // in-memory map (not a re-read of the stale local copy) straight to
    // the server instead of just failing the same way a local-only setup
    // would. KV values go up to 25MB, comfortably clear of anything a
    // Channel-heavy preset would realistically hit on its own -- though
    // several such presets in the same account can still add up close to
    // that limit (see the size guard on /api/creator/sync/save-presets).
    const pushResult = activeCreator ? await pushPresetsDirectly(map) : { ok: false, error: null };
    if (!pushResult.ok) {
      alert(
        activeCreator
          ? (pushResult.error
              ? 'Could not save this preset to your account: ' + pushResult.error
              : 'Could not save this preset to your account either \u2014 check your connection and try again. If this keeps happening, check the browser console (F12) for more detail.')
          : 'Could not save this preset \u2014 your browser\\'s local storage is full. This usually happens when a TV Channel with a lot of episodes is included, since each preset stores a full copy of everything in it. Try removing a large Channel from this preset, deleting an older preset you no longer need, using Backup/Restore\\'s "Download as file" option instead (which isn\\'t limited the same way), or creating a free account so this can be saved there instead of just this browser.'
      );
      return;
    }
  }

  nameInput.value = '';
  renderPresetsList();
  if (localOk) schedulePresetsSync();
}


function renderPresetsList() {
  const container = document.getElementById('presetsList');
  const badge = document.getElementById('presetsCountBadge');
  const map = loadPresetsMap();
  const names = Object.keys(map).sort();
  if (badge) badge.textContent = names.length ? '(' + names.length + ' saved)' : '';
  if (!names.length) {
    container.innerHTML = '<p><small>No saved presets yet.</small></p>';
    return;
  }
  container.innerHTML = names.map((n) => {
    const count = (map[n].entries || []).length;
    return '<div class="row quick-row" data-preset="' + escapeAttr(n) + '">' +
      '<strong>' + escapeHtml(n) + '</strong> <small style="color:var(--muted);">(' + count + ' list(s))</small>' +
      '<span class="actions" style="gap:6px;">' +
      '<button type="button" class="secondary preset-load-btn">Load</button>' +
      '<button type="button" class="secondary preset-share-btn">Share</button>' +
      '<button type="button" class="secondary preset-download-btn">Download</button>' +
      '<button type="button" class="secondary preset-delete-btn">Delete</button>' +
      '</span></div>';
  }).join('');
}

document.getElementById('presetsList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-preset]');
  if (!row) return;
  const name = row.getAttribute('data-preset');
  if (e.target.classList.contains('preset-load-btn')) loadPreset(name);
  else if (e.target.classList.contains('preset-share-btn')) sharePreset(name);
  else if (e.target.classList.contains('preset-download-btn')) downloadPreset(name);
  else if (e.target.classList.contains('preset-delete-btn')) deletePreset(name);
});

function loadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  document.getElementById('lists').innerHTML = '';
  preset.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
}

function sharePreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const jsonStr = JSON.stringify({ entries: preset.entries }, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    alert('"' + name + '" copied to your clipboard as JSON -- paste it into the Backup/Restore box above (on this device or another) to import it.');
  }).catch(() => {
    prompt('Copy this preset\\'s JSON:', jsonStr);
  });
}

function deletePreset(name) {
  if (!confirm('Delete preset "' + name + '"?')) return;
  const map = loadPresetsMap();
  delete map[name];
  savePresetsMap(map);
  renderPresetsList();
  schedulePresetsSync();
}

// --- file download/upload (Backup/Restore and My Presets) -------------------
//
// Shared by both the whole-setup Backup/Restore panel and individual
// presets -- same underlying JSON shape as exportConfigJson/importConfigJson,
// just written to/read from an actual file instead of a textarea, for
// people who'd rather drag a file into a folder than copy-paste text.
function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reads a chosen file as text and hands it to onParsed(jsonData); shared
// error handling (bad file, invalid JSON) so each upload button only needs
// to say what to do once parsing succeeds. Always clears the file input
// afterward so choosing the same filename again still fires a change event.
function readJsonFile(input, onParsed) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('That file is not valid JSON.');
      input.value = '';
      return;
    }
    onParsed(data, file);
    input.value = '';
  };
  reader.onerror = () => {
    alert('Could not read that file.');
    input.value = '';
  };
  reader.readAsText(file);
}

function downloadConfigJson() {
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  downloadJsonFile('my-lists-config.json', payload);
}

function uploadConfigFile(input) {
  readJsonFile(input, (data) => applyImportedConfig(data));
}

function downloadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  downloadJsonFile((slugify(name) || 'preset') + '.json', { entries: preset.entries });
}

function uploadPresetFile(input) {
  readJsonFile(input, (data, file) => {
    if (!data || !Array.isArray(data.entries)) {
      alert('That file does not look like a preset -- expected an "entries" array.');
      return;
    }
    const suggested = (file.name || 'Preset').replace(/\.json$/i, '');
    const name = (prompt('Save this preset as:', suggested) || '').trim();
    if (!name) return;
    const map = loadPresetsMap();
    map[name] = { entries: data.entries };
    savePresetsMap(map);
    renderPresetsList();
    schedulePresetsSync();
  });
}

// --- browser-storage persistence -------------------------------------------
// Keeps whatever the person has added/removed/toggled so a page refresh
// doesn't lose their in-progress list or entered API keys. The stored state
// is only used in the browser; it is never uploaded anywhere.
const STORAGE_KEY = 'myListAddon:state';

function saveState() {
  if (suppressSave) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: collectEntries(),
      keys: collectKeys(),
    }));
  } catch (e) {
    // localStorage unavailable (private browsing, disabled, etc.) — fine,
    // just means refreshes won't be remembered.
  }
  scheduleCreatorSyncSave();
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
    };
  } catch (e) {
    return null;
  }
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = old, 1500); }
  }).catch(() => alert(url));
}

async function generate() {
  const entries = collectEntries();
  if (!entries.length) { alert('Add at least one list.'); return; }
  const keys = collectKeys();

  const box = document.getElementById('result');
  box.style.display = 'block';
  box.innerHTML = '<p><small>Generating link\u2026</small></p>';

  // Prefer a short, KV-backed id (see /api/save) so the install URL stays a
  // fixed short length no matter how many lists are configured. If this
  // Worker has no CONFIGS KV namespace bound, fall back to the old
  // self-contained base64 link.
  let config = null;
  try {
    const res = await fetch(ORIGIN + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries, mdblistKey: keys.mdblistKey, traktKey: keys.traktKey, traktUsername: keys.traktUsername, traktAccessToken: keys.traktAccessToken,
        track: keys.track, trackCreatorName: keys.trackCreatorName, trackCreatorKey: keys.trackCreatorKey,
      }),
    });
    const data = await res.json();
    if (data.ok) config = data.id;
  } catch (e) {
    // network error — fall through to the client-side link below
  }

  let sizeWarning = '';
  if (!config) {
    config = buildConfig(entries, keys);
    // Row count alone misses this: a single Channel with a few dozen
    // episodes can make the encoded config huge even with just one or two
    // rows total, so this checks the actual encoded length instead.
    if (config.length > 4000) {
      sizeWarning = '<p class="testresult err">\u26a0 This link encodes everything directly into the URL (no server-side storage is set up on this Worker), so it\\'s long and may fail to install in apps with URL-length limits \u2014 including wako. If you\\'re the Worker owner, binding a KV namespace named "CONFIGS" fixes this by giving links a short id instead.</p>';
    }
  }

  const installUrl = ORIGIN + '/' + config + '/manifest.json';
  const stremioUrl = 'stremio://' + installUrl.replace(/^https?:\\/\\//, '');
  const wakoUrl = 'wako://' + installUrl.replace(/^https?:\\/\\//, '');
  // A group breakdown alongside the plain install-count beacon -- each
  // row's own .group ("MDBList Charts", "Custom Lists", "Channels", etc.)
  // is already a meaningful "what kind of source is this" label, no need
  // for a separate classification step. Tied to install-link generation
  // specifically rather than every add/remove click, since "ended up in a
  // real install" is a more meaningful signal than "was clicked once,
  // maybe removed a second later" -- and it means this doesn't need
  // touching dozens of individual Quick Add button handlers.
  const groupCounts = {};
  entries.forEach((e) => {
    const g = e.group || 'Custom';
    groupCounts[g] = (groupCounts[g] || 0) + 1;
  });
  fetch(ORIGIN + '/api/track-install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: groupCounts }),
  }).catch(() => {});

  box.innerHTML = \`
    \${sizeWarning}
    <a class="installlink" href="\${installUrl}" id="manifestLink">\${installUrl}</a>
    <div class="actions">
      <button class="btn-copy secondary" id="copyBtn" onclick="copyLink('\${installUrl}')">Copy link</button>
      <a class="btn-stremio" href="\${stremioUrl}">Open in Stremio</a>
      <a class="btn-wako" href="\${wakoUrl}">Open in wako</a>
    </div>
    <p class="hint"><small>If "Open in wako" doesn't do anything on your device, wako may not register a URL scheme yet &mdash; copy the link instead and paste it into wako &rarr; Settings &gt; Extensions &gt; Install an add-on.</small></p>\`;
  // The mobile sticky CTA bar can be tapped from anywhere on a long page of
  // rows, so bring the result into view rather than leaving it rendered
  // off-screen above the fold the person's currently scrolled past.
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// pre-fill
suppressSave = true;
const serverEntries = (${initialEntriesJson});
if (serverEntries.length) {
  // Opened via a real install/configure link — this is the source of truth.
  serverEntries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
} else {
  // Fresh visit to the plain builder page — restore whatever was left off
  // last time, if anything was saved.
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.entries) && saved.entries.length) {
    saved.entries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  }
  if (saved && saved.keys && saved.keys.mdblistKey) {
    document.getElementById('mdblistKeyInput').value = saved.keys.mdblistKey;
  }
  if (saved && saved.keys && saved.keys.traktKey) {
    document.getElementById('traktKeyInput').value = saved.keys.traktKey;
  }
  if (saved && saved.keys && saved.keys.traktUsername) {
    document.getElementById('traktUsernameInput').value = saved.keys.traktUsername;
  }
  if (saved && saved.keys && saved.keys.traktAccessToken) {
    traktAccessToken = saved.keys.traktAccessToken;
  }
}
suppressSave = false;
renumber();
renderPresetsList();
renderChannelMergeList();
scheduleMyMdblistListsRefresh();
scheduleMyTraktListsRefresh();
renderCreatorProfileBar();
renderAccountKeySection();
renderTrackPlaybackSection();
renderCreatorDashboard();
pickUpTraktTokenFromUrl();
renderTraktConnectStatus();
document.querySelectorAll('details.panel.collapsible').forEach((d) => {
  d.addEventListener('toggle', scheduleCreatorSyncSave);
});
restoreActiveTab();
tryAutoRestoreCreatorProfile();
</script>

</body>
</html>`;
}

// --- router ---------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Populate the env-backed API key globals declared in 00_constants.js
    // for this request. Every helper function elsewhere in this add-on
    // already references these five by name (TMDB_API_KEY, TRAKT_CLIENT_ID,
    // etc.) -- this is the one place, run first, that actually connects
    // them to whatever this Worker owner configured (or left unset, which
    // is fine: every feature gated on one of these degrades to a clear
    // in-app error message rather than a crash -- see each one's usage for
    // that message). `|| ""` guards against `env` not having the property
    // at all, same as a missing Worker secret/var normally reads as
    // undefined rather than an empty string.
    TMDB_API_KEY = env.TMDB_API_KEY || "";
    TRAKT_CLIENT_ID = env.TRAKT_CLIENT_ID || "";
    SIMKL_CLIENT_ID = env.SIMKL_CLIENT_ID || "";
    MDBLIST_API_KEY = env.MDBLIST_API_KEY || "";
    MDBLIST_POPULAR_KEY = env.MDBLIST_POPULAR_KEY || "";

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/" || path === "") {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(renderBuilder(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // add-on icon, served straight from this Worker
    if (path === "/icon.png") {
      const bin = atob(ICON_BASE64 );
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          ...corsHeaders(),
        },
      });
    }

    // Poster-shaped placeholder shown in place of a real catalog when a
    // source fails and there's no stale last-known-good data to fall back
    // on (see the catalog route below). Generated on the fly rather than
    // stored as an asset -- it's just text on a flat background.
    if (path === "/unavailable-poster.svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
        <rect width="300" height="450" fill="#161a2e"/>
        <rect x="0.5" y="0.5" width="299" height="449" fill="none" stroke="#2a2f4a"/>
        <text x="150" y="205" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#5865a8">\u26a0</text>
        <text x="150" y="250" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">Temporarily</text>
        <text x="150" y="274" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">unavailable</text>
      </svg>`;
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
          ...corsHeaders(),
        },
      });
    }

    // /:config/configure  -> opened by wako itself when the user taps
    // "Configure" on the already-installed add-on
    let m = path.match(/^\/([^/]+)\/configure$/);
    if (m) {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      const { entries, tmdbKey, mdblistKey, traktKey, traktUsername, traktAccessToken } = await resolveConfig(m[1], env);
      return new Response(
        renderBuilder(url.origin, {
          initialEntries: entries,
          initialKeys: { tmdbKey, mdblistKey, traktKey, traktUsername, traktAccessToken },
          isConfigureMode: true,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // bare /configure (no config yet) -> same builder, empty/default state
    if (path === "/configure") {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, { isConfigureMode: true }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // /:config/manifest.json
    m = path.match(/^\/([^/]+)\/manifest\.json$/);
    if (m) {
      // If this looks like a browser page-load (e.g. wako sent you here for
      // "Configure") rather than a JSON fetch by the app, send the user to
      // the actual editable configure page instead of showing raw JSON.
      if (isBrowserNavigation(request)) {
        return Response.redirect(`${url.origin}/${m[1]}/configure`, 302);
      }
      const { entries, track } = await resolveConfig(m[1], env);
      return json(buildManifest(entries, url.origin, track));
    }

    // bare manifest.json with no config
    if (path === "/manifest.json") {
      if (isBrowserNavigation(request)) {
        return Response.redirect(`${url.origin}/configure`, 302);
      }
      return json(buildManifest([], url.origin));
    }

    // /:config/subtitles/:type/:id.json -- see buildManifest's comment
    // above on why wako/Stremio calls this even though the addon has no
    // real subtitles to offer. type is "movie" or "series"; id is a plain
    // "tt1234567" for a movie, or "tt1234567:5:10" (imdbId:season:episode)
    // for an episode -- Stremio's own id convention for TV, nothing
    // specific to this addon. The trailing (?:\/[^/]+)? tolerates the extra
    // videoHash=...&videoSize=...&filename=... path segment real Stremio
    // (as opposed to hand-built test requests) appends before .json when a
    // stream actually has that metadata -- without it, every genuine
    // Stremio playback ping 404'd here and never reached
    // handleSubtitlesTrack below, so Auto-track Playback looked broken
    // specifically on Stremio even though it worked fine against a bare
    // .../subtitles/movie/tt1234567.json test call.
    m = path.match(/^\/([^/]+)\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
    if (m) {
      const [, configParam, stremioType, rawId] = m;
      // Answer immediately with an empty subtitle list regardless of what
      // happens below -- there's nothing to show wako/Stremio either way,
      // and the actual tracking write (a TMDB lookup plus a KV read/write)
      // shouldn't hold up how fast this responds. ctx.waitUntil lets it
      // keep running after the response is already on its way.
      ctx.waitUntil(handleSubtitlesTrack(configParam, stremioType, decodeURIComponent(rawId), env));
      return json({ subtitles: [] });
    }

    if (path === "/app.webmanifest") {
      const manifest = {
        name: "My Lists",
        short_name: "My Lists",
        start_url: "/",
        display: "standalone",
        background_color: "#1C1C1E",
        theme_color: "#007AFF",
        icons: [
          { src: "/icon.png", sizes: "192x192", type: "image/png" },
          { src: "/icon.png", sizes: "512x512", type: "image/png" }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/manifest+json; charset=utf-8" }
      });
    }

    if (path === "/sw.js") {
      const sw = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  // simple pass-through cache, nothing fancy
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
      `;
      return new Response(sw.trim(), {
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" }
      });
    }

    // /:config/catalog/:type/:id.json  (optionally /:config/catalog/:type/:id/skip=N.json)
    m = path.match(/^\/([^/]+)\/catalog\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const [, config, type, idWithExtra] = m;
      const [id, extraStr] = idWithExtra.split("/");
      const extra = Object.fromEntries(new URLSearchParams(extraStr || ""));
      const skip = parseInt(extra.skip, 10) || 0;

      const { entries, tmdbKey, mdblistKey, traktKey, traktAccessToken } = await resolveConfig(config, env);
      const entry = entries.find((e) => e.id === id && e.type === type);
      if (!entry || entry.enabled === false) return json({ metas: [] });

      // Graceful degradation only applies to the first page (skip === 0):
      // that's the case that makes a whole shelf silently vanish from the
      // home screen, whereas a failure deeper into pagination (scrolling
      // for "load more") is far less disruptive to just show as empty, like
      // before. Only active when a CONFIGS KV namespace is bound (optional,
      // same as the short-link feature) -- without one this behaves exactly
      // as it did previously.
      const staleKey = env && env.CONFIGS ? `lastgood:${config}:${type}:${id}` : null;

      try {
        const metas = await fetchCatalog(entry, skip, { tmdbKey, mdblistKey, traktKey, traktAccessToken, env });
        if (staleKey && skip === 0 && metas.length > 0) {
          // Fire-and-forget -- the response doesn't wait on this write.
          ctx.waitUntil(
            env.CONFIGS.put(staleKey, JSON.stringify(metas), { expirationTtl: 2592000 })
          );
        }
        return json({ metas });
      } catch (err) {
        const errMsg = String(err.message || err);

        if (skip === 0 && staleKey) {
          try {
            const stale = await env.CONFIGS.get(staleKey);
            if (stale) {
              // Genuine last-known-good data -- real "tt" ids, renders
              // exactly like a normal successful load. `stale` is
              // informational only (visible when debugging via curl), not
              // read by wako/Stremio itself.
              return json({ metas: JSON.parse(stale), stale: true, error: errMsg });
            }
          } catch {
            // KV read/parse failed -- fall through to the placeholder below.
          }
          // No last-known-good data to fall back on (this list has never
          // successfully loaded, or KV isn't bound) -- show one placeholder
          // tile so the row still appears instead of silently disappearing.
          // Uses a dummy "tt"-prefixed id since the manifest declares
          // idPrefixes: ["tt", ...] and some clients filter out anything else.
          return json({
            metas: [
              {
                id: "tt0000000",
                type: entry.type,
                name: (entry.name || "This list") + " \u2014 temporarily unavailable",
                poster: `${url.origin}/unavailable-poster.svg`,
              },
            ],
            error: errMsg,
          });
        }

        // Metas stays empty so wako/Stremio just shows an empty row instead
        // of erroring out, but the reason is still visible if you curl this
        // URL directly while debugging.
        return json({ metas: [], error: errMsg }, 200);
      }
    }

    // /api/track-install  (POST)  { groups?: { [groupName]: count } } -> { ok: true }
    // Fire-and-forget beacon the builder page calls right when "Generate
    // install link"/"Update" produces a link -- that action is otherwise
    // entirely client-side (it's just base64-encoding the current config
    // into a URL, no server round trip), so this is the one place a count
    // of "an install link was generated" can be recorded at all. No
    // identifying info sent or stored, just a counter bump for the
    // admin-only dashboard below. The optional groups breakdown feeds the
    // same dashboard's "sources people actually use" table -- see
    // bumpStatBy/sanitizeStatGroupName above.
    if (path === "/api/track-install" && request.method === "POST") {
      ctx.waitUntil(bumpStat(env, "installs"));
      try {
        const body = await request.json();
        if (body && body.groups && typeof body.groups === "object") {
          const entries = Object.entries(body.groups).slice(0, 30);
          for (const [rawGroup, rawCount] of entries) {
            const group = sanitizeStatGroupName(rawGroup);
            const count = Math.max(0, Math.min(1000, parseInt(rawCount, 10) || 0));
            if (group && count) ctx.waitUntil(bumpStatBy(env, `sourcegroup:${group}`, count));
          }
        }
      } catch {
        // no body, or not JSON -- the plain install counter above still
        // recorded either way, this part is just best-effort extra detail
      }
      return json({ ok: true });
    }

    // /api/preview -> GET with ?url=...&type=movie|series[&tmdbKey=...&mdblistKey=...&sample=N&skip=N],
    // or POST with the same fields as a JSON body. Used by the "Test"
    // button in the builder page to check a list (or the watchlist quick-
    // add), by Live Preview to render a row's actual shelf and its "See
    // All" infinite-scroll view, and by the search results' "View list"
    // button. Always uncached (unlike the shared json() helper's default
    // hour-long cache) since all of those should reflect the current live
    // state, not a stale result from before some earlier fix. sample
    // defaults to 5 (the original/Test-button size); Live Preview and View
    // List ask for more (100, a full catalog page) and page through with
    // skip for infinite scroll -- the same skip fetchCatalog already
    // supports for the real /:config/catalog/:type/:id/skip=N.json route
    // below, reused as-is.
    //
    // POST exists because a Channel's own url can be enormous (hundreds of
    // episodes' worth of embedded JSON) -- passed as a GET query string
    // that routinely exceeded URL length limits and failed outright before
    // ever reaching this handler, which is exactly what surfaced as "no
    // streams"-style network errors previewing a Channel. GET is kept for
    // callers with a normal-sized url (a plain mdblist/trakt/tmdb list
    // link is never going to hit that limit).
    if (path === "/api/preview") {
      let testUrl, type, tmdbKey, mdblistKey, traktKey, traktAccessToken, sampleSize, skip;
      if (request.method === "POST") {
        let reqBody;
        try {
          reqBody = await request.json();
        } catch {
          reqBody = {};
        }
        testUrl = reqBody.url || "";
        type = reqBody.type === "series" ? "series" : "movie";
        tmdbKey = reqBody.tmdbKey || "";
        mdblistKey = reqBody.mdblistKey || "";
        traktKey = reqBody.traktKey || "";
        traktAccessToken = reqBody.traktAccessToken || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(reqBody.sample, 10) || 5));
        skip = Math.max(0, parseInt(reqBody.skip, 10) || 0);
      } else {
        testUrl = url.searchParams.get("url") || "";
        type = url.searchParams.get("type") === "series" ? "series" : "movie";
        tmdbKey = url.searchParams.get("tmdbKey") || "";
        mdblistKey = url.searchParams.get("mdblistKey") || "";
        traktKey = url.searchParams.get("traktKey") || "";
        traktAccessToken = url.searchParams.get("traktAccessToken") || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(url.searchParams.get("sample"), 10) || 5));
        skip = Math.max(0, parseInt(url.searchParams.get("skip"), 10) || 0);
      }
      let body;
      try {
        const metas = await fetchCatalog({ url: testUrl, type }, skip, { tmdbKey, mdblistKey, traktKey, traktAccessToken, env });
        body = {
          ok: true,
          count: metas.length,
          maybeMore: metas.length >= PAGE_SIZE,
          // id+poster (not just name) so the builder can show small poster
          // thumbnails as a more satisfying "yes, this is the right list"
          // confirmation than a plain name list. posterShape carries a
          // Channel's "landscape" hint through too -- without it, Live
          // Preview/View List had no way to know a logo shouldn't be forced
          // into the same portrait 2:3 box every other poster uses, and
          // cropped it down to almost nothing. season/episode (only ever
          // present on Trakt history's per-episode rows -- see
          // mapTraktHistoryItems) let "Mark as Watched" on the live Trakt
          // Connect panel look up each episode's real TMDB id without
          // parsing them back out of the folded "Show S1E5" display name.
          sample: metas.slice(0, sampleSize).map((m) => ({ id: m.id, type: type, name: m.name, poster: m.poster, year: m.releaseInfo, showTitle: m.showTitle, posterShape: m.posterShape, season: m.season, episode: m.episode })),
        };
      } catch (err) {
        body = { ok: false, error: String(err.message || err) };
      }
      return new Response(JSON.stringify(body), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    }

    // /:config/meta/:type/:id.json
    // -> synthetic meta for Channel entries (id "channel_<channelId>") --
    // the full hand-picked episode list, assembled into one series-shaped
    // response. Nothing else on this add-on needs a "meta" resource (every
    // other catalog item is resolved by whatever meta add-on -- usually
    // Cinemeta -- the person already has installed); the manifest scopes
    // this resource with idPrefixes so wako/Stremio only ever asks us for
    // our own synthetic ids, never a normal "tt..." one.
    m = path.match(/^\/([^/]+)\/meta\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const [, config, metaType, idRaw] = m;
      const id = decodeURIComponent(idRaw);
      if (metaType !== "series" || !id.startsWith("channel_")) {
        return json({ meta: null });
      }
      const wantedChannelId = id.slice("channel_".length);
      try {
        const { entries } = await resolveConfig(config, env);
        // A row can merge several channels into one shelf (newline-joined
        // urls, same mechanism as merging any other source) -- each
        // sub-payload carries its own channelId, so every entry needs its
        // url split and checked individually rather than matching on the
        // *row's* own id, which only ever identifies the row as a whole.
        let matchedEntry = null;
        for (const e of entries) {
          if (e.enabled === false) continue;
          const subUrls = String(e.url || "").split("\n").map((s) => s.trim()).filter(Boolean);
          for (const subUrl of subUrls) {
            const payload = parseChannelPayload(subUrl);
            if (!payload) continue;
            if ((payload.channelId || e.id) === wantedChannelId) {
              matchedEntry = { ...e, url: subUrl };
              break;
            }
          }
          if (matchedEntry) break;
        }
        if (!matchedEntry) return json({ meta: null });
        const meta = buildChannelMeta(matchedEntry, url.origin);
        return json({ meta: meta || null });
      } catch (err) {
        return json({ meta: null, error: String(err.message || err) });
      }
    }

    // /api/toplists
    // -> powers the "Popular Lists" browser in the builder page. Proxies
    // mdblist.com's own top-lists endpoint so people can add lists from
    // https://mdblist.com/toplists/ with a click instead of copy-pasting URLs.
    // Uses the fixed MDBLIST_POPULAR_KEY (see top of file) — no per-user key
    // needed for this, since it's the same public data for everyone.
    if (path === "/api/toplists") {
      try {
        const lists = await fetchTopLists(MDBLIST_POPULAR_KEY);
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

      // /api/season (GET) -> { ok: true, season: { episodes: [...] } }
      if (path === "/api/season") {
        const q = url.searchParams;
        const imdbId = q.get("imdbId");
        const seasonNum = q.get("seasonNum");
        const tmdbKey = q.get("tmdbKey") || TMDB_API_KEY;
        
        if (!imdbId || !seasonNum) return json({ ok: false, error: "Missing imdbId or seasonNum" }, 400);
        
        const seasonData = await fetchTmdbSeasonDetails(imdbId, seasonNum, tmdbKey);
        if (!seasonData) return json({ ok: false, error: "Not found or TMDB error" }, 404);
        
        return json({ ok: true, season: seasonData });
      }

    // /api/title-search?q=...&type=movie|tv
    // -> powers the "Search a show/movie" box in the Channel builder.
    // Straight TMDB title search, trimmed to what the picker UI needs.
    if (path === "/api/title-search") {
      const q = (url.searchParams.get("q") || "").trim();
      const kind = url.searchParams.get("type") === "movie" ? "movie" : "tv";
      if (!q) return json({ ok: false, error: "Missing search query." }, 400);
      try {
        const src = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
          TMDB_API_KEY
        )}&query=${encodeURIComponent(q)}&include_adult=false`;
        const res = await fetch(src, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) return json({ ok: false, error: `TMDB search failed (HTTP ${res.status}).` });
        const data = await res.json();
        const results = (data.results || []).slice(0, 20).map((it) => ({
          tmdbId: it.id,
          title: it.title || it.name,
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w200${it.poster_path}` : null,
          type: kind,
        }));
        return json({ ok: true, results });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/show-seasons?tmdbId=...
    // -> once a show is picked in the Channel builder, lists its seasons so
    // the person can drill into one. Also resolves the show's IMDB id up
    // front (reusing fetchTmdbDetails -- same combined external_ids+videos
    // call every other TMDB path here already makes) since every episode
    // picked from this show will need it to build a resolvable stream id.
    if (path === "/api/show-seasons") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        const [details, showRes] = await Promise.all([
          fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY),
          fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}`, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 3600, cacheEverything: true },
          }),
        ]);
        if (!details.imdbId) {
          return json({ ok: false, error: "Couldn't resolve an IMDB id for this show, so streams likely won't work for any episode picked from it." });
        }
        if (!showRes.ok) return json({ ok: false, error: `TMDB show lookup failed (HTTP ${showRes.status}).` });
        const data = await showRes.json();
        const seasons = (data.seasons || [])
          .filter((s) => s.season_number > 0) // skip "Specials" (season 0)
          .map((s) => ({ season: s.season_number, name: s.name, episodeCount: s.episode_count }));
        return json({
          ok: true,
          imdbId: details.imdbId,
          name: data.name,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w300${data.poster_path}` : null,
          seasons,
        });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/show-episodes?tmdbId=...&season=...
    // -> the actual episode checklist for one season, once picked in the
    // Channel builder.
    if (path === "/api/show-episodes") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      const season = url.searchParams.get("season") || "";
      if (!tmdbId || !season) return json({ ok: false, error: "Missing tmdbId or season." }, 400);
      try {
        const src = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${encodeURIComponent(
          season
        )}?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
        const res = await fetch(src, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) return json({ ok: false, error: `TMDB season lookup failed (HTTP ${res.status}).` });
        const data = await res.json();
        const episodes = (data.episodes || []).map((e) => ({
          episode: e.episode_number,
          name: e.name,
          released: e.air_date || null,
          thumbnail: e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : null,
        }));
        return json({ ok: true, episodes });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/quick-channel-shows?url=<any supported list url>  OR  ?networkId=<TMDB network id>
    // -> powers the Channels panel's "Quick Add Channel" buttons (CBS, NBC,
    // ABC, FOX, The CW, HBO, etc.) and "Import from link": resolves a source
    // of shows to TMDB ids, so the client can then loop them through the
    // same /api/show-seasons + /api/show-episodes endpoints the manual
    // picker already uses. Deliberately split from that per-show/per-season
    // fetching (rather than one giant server-side request that builds the
    // whole channel) -- a full network lineup could mean dozens of shows
    // and hundreds of TMDB calls, comfortably over what a single Worker
    // request should be doing; spreading that across many small
    // client-driven requests keeps each one fast and avoids leaning on
    // Cloudflare's per-request subrequest ceiling.
    //
    // Three sources feed this: any mdblist.com/trakt.tv/themoviedb.org list
    // link (someone else's hand-picked lineup, or "Import from link"'s own
    // pasted URL), a TMDB network id directly (TMDB's own current/popular
    // shows for that network, e.g. FOX/The CW/HBO -- doesn't depend on any
    // third party's list existing or staying maintained), or -- implicitly,
    // via the url branch -- a mixed movies+shows list, since requesting
    // type "series" from the generic catalog fetch below silently drops any
    // movies rather than erroring out (Channels are shows-only).
    if (path === "/api/quick-channel-shows") {
      const listUrl = url.searchParams.get("url") || "";
      const networkId = url.searchParams.get("networkId") || "";
      const mdblistKey = url.searchParams.get("mdblistKey") || "";
      const traktKey = url.searchParams.get("traktKey") || "";
      const traktAccessToken = url.searchParams.get("traktAccessToken") || "";
      if (!listUrl && !networkId) return json({ ok: false, error: "Missing url or networkId." }, 400);
      try {
        let showRefs; // [{ id: <imdb id>, name, poster }]
        if (networkId) {
          const discoverResults = [];
          // Up to 10 pages (200 shows) -- a much bigger candidate pool to
          // shuffle from than before, but safe to raise: CHANNEL_MAX_TOTAL_ITEMS
          // below already bounds how much actually gets processed regardless
          // of pool size, and this loop still stops early via total_pages
          // for any network with genuinely fewer than 10 pages of results.
          for (let page = 1; page <= 10; page++) {
            const discoverRes = await fetch(
              `https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
                `&with_networks=${encodeURIComponent(networkId)}&sort_by=popularity.desc&page=${page}&include_adult=false`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 3600, cacheEverything: true } }
            );
            if (!discoverRes.ok) break;
            const discoverData = await discoverRes.json();
            discoverResults.push(...(discoverData.results || []));
            if (page >= (discoverData.total_pages || 1)) break;
          }
          if (!discoverResults.length) return json({ ok: false, error: "No shows found for that network." });
          // The network's own logo (e.g. the CBS eye) -- a much more
          // fitting default poster for a channel built to represent that
          // whole network than an arbitrary single show's poster, which is
          // what this fell back to before. Best-effort: if TMDB doesn't
          // have a logo for this network id, the client already has its
          // own fallback (the first show's poster) for that case.
          let networkLogo = null;
          try {
            const networkRes = await fetch(
              `https://api.themoviedb.org/3/network/${encodeURIComponent(networkId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
            );
            if (networkRes.ok) {
              const networkData = await networkRes.json();
              // A specific size (not "original") is required here --
              // TMDB serves the network's raw uploaded logo file at
              // "original", which for many networks is an .svg, and
              // Stremio/wako can't render an SVG as a poster (this was the
              // actual cause of the logo silently never showing and
              // falling back to a show's poster instead). Any fixed pixel
              // size forces TMDB to rasterize it to PNG first.
              if (networkData.logo_path) networkLogo = `https://image.tmdb.org/t/p/w500${networkData.logo_path}`;
            }
          } catch {
            // best-effort -- fall through with networkLogo left null
          }
          const shows = await mapWithConcurrency(discoverResults, 8, async (show) => {
            const details = await fetchTmdbDetails(show.id, "tv", TMDB_API_KEY);
            if (!details.imdbId) return null;
            return {
              imdbId: details.imdbId,
              tmdbId: show.id,
              name: show.name,
              poster: show.poster_path ? `https://image.tmdb.org/t/p/w300${show.poster_path}` : null,
            };
          });
          const resolved = shows.filter(Boolean);
          if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows for that network to IMDB." });
          return json({ ok: true, shows: resolved, networkLogo });
        }

        // A pasted list link can be any of this add-on's supported sources
        // (mdblist/trakt/tmdb) and can be mixed movies+shows -- requesting
        // type "series" specifically both narrows to just the shows
        // (silently dropping any movies in the same list) and reuses the
        // exact same fetchCatalog dispatch every other list source already
        // goes through, instead of this route only ever understanding
        // mdblist's own JSON shape like it used to.
        let metas;
        try {
          metas = await fetchCatalog({ url: listUrl, type: "series" }, 0, { mdblistKey, traktKey, traktAccessToken, env });
        } catch (err) {
          return json({ ok: false, error: `Could not read that list: ${err.message || err}` });
        }
        if (!metas.length) {
          return json({ ok: false, error: "That list has no shows in it (Channels are shows-only -- any movies are skipped)." });
        }

        const shows = await mapWithConcurrency(metas, 8, async (m) => {
          try {
            const findRes = await fetch(
              `https://api.themoviedb.org/3/find/${m.id}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
            );
            if (!findRes.ok) return null;
            const findData = await findRes.json();
            const match = (findData.tv_results || [])[0];
            if (!match) return null;
            return { imdbId: m.id, tmdbId: match.id, name: m.name, poster: m.poster };
          } catch {
            return null;
          }
        });
        const resolved = shows.filter(Boolean);
        if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows in that list to TMDB." });
        return json({ ok: true, shows: resolved });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve-movie?tmdbId=...
    // -> resolves a movie's IMDB id when it's added to a Custom List.
    if (path === "/api/resolve-movie") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        const details = await fetchTmdbDetails(tmdbId, "movie", TMDB_API_KEY);
        if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this movie." });
        return json({ ok: true, imdbId: details.imdbId });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve-show?tmdbId=...
    // -> resolves a show's IMDB id when it's added to a Custom List (a
    // whole-show pick, not per-episode -- that's the Channels panel).
    if (path === "/api/resolve-show") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        const details = await fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY);
        if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this show." });
        return json({ ok: true, imdbId: details.imdbId });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/trakt-search?q=...
    // -> powers the "Search Trakt Lists" box in the builder page. Proxies
    // trakt.tv's public list-search endpoint so people can find and add
    // public trakt.tv lists with a click instead of copy-pasting URLs.
    if (path === "/api/trakt-search") {
      const q = url.searchParams.get("q") || "";
      const traktKey = url.searchParams.get("traktKey") || "";
      try {
        const lists = await searchTraktLists(q, traktKey);
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/trakt-my-lists?username=...&traktKey=...
    // -> powers the "Your Trakt Lists" section in the builder: once someone
    // fills in a Trakt username, this lists everything they've made public
    // at trakt.tv/users/:username/lists (public data -- no OAuth/user-level
    // token needed, just the usual app-level Trakt-Api-Key, same as every
    // other Trakt call here). traktKey overrides the shared TRAKT_CLIENT_ID
    // the same way it does everywhere else.
    if (path === "/api/trakt-my-lists") {
      const username = (url.searchParams.get("username") || "").trim();
      const traktKeyParam = url.searchParams.get("traktKey") || "";
      if (!username) return json({ ok: false, error: "Missing username." }, 400);
      const traktKey = traktKeyParam || TRAKT_CLIENT_ID;
      if (!traktKey) {
        return json({ ok: false, error: "Trakt lists aren't configured on this add-on yet — enter a Trakt Client ID above, or ask the Worker owner to set TRAKT_CLIENT_ID." });
      }
      try {
        const src = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists`;
        const res = await fetch(src, {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": traktKey,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) {
          if (res.status === 404) {
            return json({ ok: false, error: `No Trakt user found with the username "${username}".` });
          }
          if (res.status === 403) {
            return json({
              ok: false,
              error: traktKeyParam
                ? "Trakt rejected the Client ID you entered (HTTP 403 = invalid or unapproved app). Double check it against https://trakt.tv/oauth/applications."
                : "Trakt rejected this add-on's API key (HTTP 403 = invalid or unapproved app). Enter your own Trakt Client ID above to bypass this, or ask the Worker owner to fix TRAKT_CLIENT_ID.",
            });
          }
          return json({ ok: false, error: `Trakt request failed (HTTP ${res.status}).` });
        }
        const data = await res.json();
        const lists = (Array.isArray(data) ? data : [])
          .filter((l) => l && l.ids && l.ids.slug)
          .map((l) => ({
            name: l.name,
            slug: l.ids.slug,
            items: l.item_count || 0,
            likes: l.likes || 0,
            url: `https://trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(l.ids.slug)}`,
          }));
        const classified = await mapWithConcurrency(lists, 8, async (l) => ({
          ...l,
          contentType: await classifyTraktListContentType(username, l.slug, traktKey),
        }));
        return json({ ok: true, lists: classified });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // --- Trakt OAuth (private lists) ----------------------------------------
    //
    // Everything above this point only ever needed TRAKT_CLIENT_ID (an
    // app-level key, same for every visitor) since it's all public data.
    // A private list is only visible to its own owner, which Trakt only
    // recognizes via a real user-level OAuth token -- this is that flow.
    // TRAKT_CLIENT_SECRET is a genuine secret (unlike TRAKT_CLIENT_ID,
    // which is already public-facing in every request this Worker makes)
    // and must be set via `wrangler secret put TRAKT_CLIENT_SECRET`, never
    // hardcoded here.
    //
    // No server-side token storage: the resulting access token is handed
    // straight back to the browser and saved into the person's own config,
    // the same way their MDBList key or Trakt Client ID already are (see
    // traktAccessToken throughout). That keeps this consistent with how
    // every other credential in this add-on works -- nothing here is tied
    // to an account on this Worker -- at the cost of no silent background
    // refresh: Trakt access tokens last about 3 months, and reconnecting
    // after that is a deliberate manual step, not automatic.

    // /api/trakt/oauth/start -> redirects to Trakt's own login/approve page.
    // A short-lived, HttpOnly state cookie (scoped to just this OAuth path)
    // guards against CSRF -- the callback below refuses to proceed unless
    // the state Trakt hands back matches what was stored here.
    if (path === "/api/trakt/oauth/start") {
      if (!TRAKT_CLIENT_ID) {
        return new Response("Trakt isn't configured on this Worker (missing TRAKT_CLIENT_ID).", { status: 500 });
      }
      const state = generateShortId();
      const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
      const authorizeUrl =
        `https://trakt.tv/oauth/authorize?response_type=code&client_id=${encodeURIComponent(TRAKT_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
      // ?debug=1 -> shows the exact values as plain text instead of
      // redirecting, so a redirect_uri mismatch against what's registered
      // at trakt.tv/oauth/applications can be spotted directly (copy/paste
      // comparison) instead of needing to catch a fleeting 302 in devtools.
      // Not a security concern to expose -- everything shown here (origin,
      // Client ID, computed callback URL) is either already public or
      // derived from the request itself; no secret ever appears.
      if (url.searchParams.get("debug") === "1") {
        return new Response(
          `Worker sees this request's origin as:\n  ${url.origin}\n\n` +
            `It will send Trakt exactly this redirect_uri:\n  ${redirectUri}\n\n` +
            `That needs to appear byte-for-byte in your Trakt app's Redirect URI list at\n  https://trakt.tv/oauth/applications\n\n` +
            `Full authorize URL it would redirect to:\n  ${authorizeUrl}\n`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl,
          // SameSite=Lax (not Strict) -- this cookie has to survive the
          // top-level cross-site redirect Trakt sends the browser back
          // through to reach the callback below; Strict cookies aren't
          // sent on that kind of navigation.
          "Set-Cookie": `mla_trakt_state=${state}; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // /api/trakt/oauth/callback -> exchanges the code Trakt sends back for
    // an access token, then redirects to the builder page with that token
    // in a URL *fragment* (#trakt_token=...) rather than a query string --
    // fragments are never sent to any server on subsequent requests or
    // typically written to server access logs, unlike a query param would
    // be. The builder page's own init script reads it from
    // location.hash, saves it, and strips it from the address bar
    // immediately (see the client-side pickUpTraktTokenFromUrl below).
    if (path === "/api/trakt/oauth/callback") {
      const cookies = parseCookies(request);
      const expectedState = cookies.mla_trakt_state || "";
      const clearStateCookie = "mla_trakt_state=; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
      const failWith = (reason, detail) => {
        const params = new URLSearchParams({ trakt_error: reason });
        if (detail) params.set("trakt_error_detail", detail);
        return new Response(null, {
          status: 302,
          headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearStateCookie },
        });
      };

      if (url.searchParams.get("error")) return failWith(url.searchParams.get("error"));
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      if (!code || !state || !expectedState || !timingSafeEqualHex(state, expectedState)) {
        return failWith("state_mismatch");
      }
      if (!env || !env.TRAKT_CLIENT_SECRET) return failWith("not_configured");

      try {
        const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
        const tokenRes = await fetch("https://api.trakt.tv/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({
            code,
            client_id: TRAKT_CLIENT_ID,
            client_secret: env.TRAKT_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });
        if (!tokenRes.ok) {
          // Trakt's token endpoint returns a standard OAuth2-shaped error
          // body ({error, error_description}) on failure -- surface that
          // verbatim rather than a generic message, since the actual cause
          // (bad client_secret, expired/already-used code, redirect_uri
          // mismatch specifically on this step, etc.) is otherwise
          // invisible and turns every failure into a guessing game.
          let detail = `HTTP ${tokenRes.status}`;
          try {
            const text = await tokenRes.text();
            try {
              const errBody = JSON.parse(text);
              if (errBody && (errBody.error || errBody.error_description)) {
                detail = [errBody.error, errBody.error_description].filter(Boolean).join(": ");
              } else if (text) {
                detail = text.slice(0, 200);
              }
            } catch {
              if (text) detail = text.slice(0, 200);
            }
          } catch {
            // keep the HTTP-status-only detail
          }
          return failWith("exchange_failed", detail);
        }
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return failWith("no_token");
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#trakt_token=${encodeURIComponent(tokenData.access_token)}`,
            "Set-Cookie": clearStateCookie,
          },
        });
      } catch {
        return failWith("network");
      }
    }

    // /api/trakt-my-private-lists  (POST)  { accessToken } -> { ok, lists }
    // Same shape as /api/trakt-my-lists above, but hits /users/me/lists
    // with the OAuth token as a Bearer header instead of a plain username
    // lookup -- "me" resolves to whichever account approved the
    // connection, and includes their private lists (which the public,
    // username-based endpoint above can never see). POST, not GET, so the
    // token travels in the body rather than sitting in a URL/query string
    // that could end up in logs.
    if (path === "/api/trakt-my-private-lists" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const accessToken = String(body.accessToken || "").trim();
      if (!accessToken) return json({ ok: false, error: "Not connected to Trakt." }, 400);
      try {
        const res = await fetch("https://api.trakt.tv/users/me/lists", {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": TRAKT_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          // Never cache an authenticated, per-person response -- see the
          // same caching note on fetchTrakt above.
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (res.status === 401) {
          return json({ ok: false, error: "Your Trakt connection has expired or was revoked -- reconnect in Settings." });
        }
        if (!res.ok) return json({ ok: false, error: `Trakt request failed (HTTP ${res.status}).` });
        const data = await res.json();
        const meRes = await fetch("https://api.trakt.tv/users/me", {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": TRAKT_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const me = meRes.ok ? await meRes.json() : null;
        const meSlug = me && me.ids && me.ids.slug ? me.ids.slug : "me";
        const lists = (Array.isArray(data) ? data : [])
          .filter((l) => l && l.ids && l.ids.slug)
          .map((l) => ({
            name: l.name,
            slug: l.ids.slug,
            items: l.item_count || 0,
            likes: l.likes || 0,
            private: l.privacy !== "public",
            url: `https://trakt.tv/users/${encodeURIComponent(meSlug)}/lists/${encodeURIComponent(l.ids.slug)}`,
          }));
        const classified = await mapWithConcurrency(lists, 8, async (l) => ({
          ...l,
          contentType: await classifyTraktListContentType(meSlug, l.slug, TRAKT_CLIENT_ID, accessToken),
        }));

        // The watchlist is a genuinely different endpoint from a list --
        // Trakt never includes it in /users/me/lists above, so it has to
        // be fetched and prepended separately to actually show up here at
        // all. A cheap limit=1 request is enough to read the true total
        // count off Trakt's own pagination header without pulling any
        // real item data. contentType is left as "unknown" deliberately
        // (rather than trying to classify it): a watchlist is almost
        // always a mix of movies and shows for most people, and "unknown"
        // is exactly the signal the client already uses to offer both
        // +Movies/+Shows buttons and to auto-split into two Custom Lists
        // when copying.
        let watchlistCount = 0;
        try {
          const watchlistRes = await fetch("https://api.trakt.tv/users/me/watchlist?limit=1&page=1", {
            headers: {
              "Content-Type": "application/json",
              "trakt-api-version": "2",
              "trakt-api-key": TRAKT_CLIENT_ID,
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (watchlistRes.ok) {
            watchlistCount = parseInt(watchlistRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {
          // best-effort -- the watchlist entry still shows below, just
          // without a count, rather than failing the whole request over it
        }
        const watchlistEntry = {
          name: "Watchlist",
          slug: "watchlist",
          items: watchlistCount,
          likes: 0,
          private: true,
          url: "trakt:watchlist",
          contentType: "unknown",
        };

        // Same idea as the watchlist above -- History is yet another
        // endpoint Trakt keeps separate from /users/me/lists, so it's
        // fetched and prepended the same way. contentType stays "unknown"
        // since a watch history is basically always a mix of movies and
        // shows, same reasoning as the watchlist.
        let historyCount = 0;
        try {
          const historyRes = await fetch("https://api.trakt.tv/users/me/history?limit=1&page=1", {
            headers: {
              "Content-Type": "application/json",
              "trakt-api-version": "2",
              "trakt-api-key": TRAKT_CLIENT_ID,
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (historyRes.ok) {
            historyCount = parseInt(historyRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {
          // best-effort -- the history entry still shows below, just
          // without a count, rather than failing the whole request over it
        }
        const historyEntry = {
          name: "Watch History",
          slug: "history",
          items: historyCount,
          likes: 0,
          private: true,
          url: "trakt:history",
          contentType: "unknown",
        };

        return json({ ok: true, lists: [watchlistEntry, historyEntry, ...classified] });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/mdblist-my-lists?apikey=...
    // -> powers the "Your MDBList Lists" section in the builder: every list
    // the API key's own account has created (not just the built-in
    // watchlist mdblist:watchlist already covers). Same simple ?apikey=
    // auth every other mdblist call here already uses.
    if (path === "/api/mdblist-my-lists") {
      const apikey = (url.searchParams.get("apikey") || "").trim();
      if (!apikey) return json({ ok: false, error: "Missing apikey." }, 400);
      try {
        const res = await fetch(`https://api.mdblist.com/lists/user?apikey=${encodeURIComponent(apikey)}`, {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 60, cacheEverything: false },
        });
        if (!res.ok) {
          return json({ ok: false, error: `MDBList request failed (HTTP ${res.status}). Double check the API key.` });
        }
        const data = await res.json();
        const rawLists = Array.isArray(data) ? data : Array.isArray(data.lists) ? data.lists : [];
        const lists = rawLists
          .filter((l) => l && l.slug && l.user_name)
          .map((l) => ({
            name: l.name || l.slug,
            slug: l.slug,
            mediatype: l.mediatype || "",
            items: l.items || 0,
            url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
          }));
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve?config=...
    // -> powers "Import from a link" in the builder page. Reuses the same
    // resolveConfig() the manifest/configure routes already use (handles
    // both a short KV id and a legacy self-contained base64 blob), just
    // returned as plain JSON instead of a manifest or an HTML page -- so
    // pasting an existing install/configure link can rebuild the same rows
    // client-side via addRow(), the same way importing a config JSON blob
    // does.
    if (path === "/api/resolve") {
      const config = url.searchParams.get("config") || "";
      if (!config) return json({ ok: false, error: "Missing config." }, 400);
      try {
        const { entries, mdblistKey, traktKey, traktUsername, traktAccessToken } = await resolveConfig(config, env);
        if (!entries.length) return json({ ok: false, error: "That link has no lists in it." });
        return json({ ok: true, entries, mdblistKey, traktKey, traktUsername, traktAccessToken });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // POST /api/save  { entries, mdblistKey, traktKey, traktUsername } -> { ok, id }
    // Stores the config server-side (when a CONFIGS KV namespace is bound)
    // and returns a short id to use in the install URL instead of a long
    // base64 blob. Returns { ok: false, error: "no-kv" } when no KV
    // namespace is bound, so the builder page can fall back to the old
    // client-side base64 link instead.
    if (path === "/api/save" && request.method === "POST") {
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "no-kv" });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (!entries.length) {
        return json({ ok: false, error: "No lists provided." }, 400);
      }
      const payload = { entries };
      if (body.mdblistKey) payload.mdblistKey = body.mdblistKey;
      if (body.traktKey) payload.traktKey = body.traktKey;
      if (body.traktUsername) payload.traktUsername = body.traktUsername;
      if (body.traktAccessToken) payload.traktAccessToken = body.traktAccessToken;
      if (body.track) {
        payload.track = true;
        payload.trackCreatorName = body.trackCreatorName || "";
        payload.trackCreatorKey = body.trackCreatorKey || "";
      }

      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        id = generateShortId();
        const existing = await env.CONFIGS.get(id);
        if (!existing) break;
      }
      await env.CONFIGS.put(id, JSON.stringify(payload));
      return json({ ok: true, id });
    }

    if (path === "/api/publish-list" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let plBody;
      try { plBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const baseSlug = slugifyServer(plBody.name || "");
      const plType = plBody.type === "series" ? "series" : plBody.type === "movie" ? "movie" : null;
      const plItems = Array.isArray(plBody.items) ? plBody.items : [];
      if (!baseSlug) return json({ ok: false, error: "Missing a list name." }, 400);
      if (!plType) return json({ ok: false, error: "Missing or invalid list type." }, 400);
      let listSlug = baseSlug;
      let plKey = "publishedlist:user:" + listSlug;
      for (let attempt = 2; attempt <= 500; attempt++) {
        const existing = await env.CONFIGS.get(plKey);
        if (!existing) break;
        listSlug = baseSlug + "-" + attempt;
        plKey = "publishedlist:user:" + listSlug;
      }
      const plVisibility = plBody.visibility === "private" ? "private" : "public";
      await env.CONFIGS.put(plKey, JSON.stringify({ name: plBody.name || baseSlug, type: plType, items: plItems, visibility: plVisibility, likes: 0, publishedAt: Date.now() }));
      return json({ ok: true, listName: listSlug, url: url.origin + "/lists/user/" + listSlug });
    }

    if (path === "/api/lists/like" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let likeBody;
      try { likeBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const likeUser = String(likeBody.username || "").toLowerCase().trim();
      const likeSlug = String(likeBody.slug || "").toLowerCase().trim();
      const likeUnlike = likeBody.action === "unlike";
      if (!likeUser || !likeSlug) return json({ ok: false, error: "Missing list reference." }, 400);
      const likeCreatorKey = "creatorlist:" + likeUser + ":" + likeSlug;
      const likeAnonKey = "publishedlist:" + likeUser + ":" + likeSlug;
      let likeKey = null;
      let likeRaw = await env.CONFIGS.get(likeCreatorKey);
      if (likeRaw) { likeKey = likeCreatorKey; } else { likeRaw = await env.CONFIGS.get(likeAnonKey); if (likeRaw) likeKey = likeAnonKey; }
      if (!likeKey) return json({ ok: false, error: "List not found." }, 404);
      let likeData;
      try { likeData = JSON.parse(likeRaw); } catch { return json({ ok: false, error: "Corrupted." }, 500); }
      likeData.likes = Math.max(0, (likeData.likes || 0) + (likeUnlike ? -1 : 1));
      await env.CONFIGS.put(likeKey, JSON.stringify(likeData));
      return json({ ok: true, likes: likeData.likes });
    }

    if (path === "/api/lists/like-external" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const rawUrl = String(body.url || "").trim();
      if (!rawUrl) return json({ ok: false, error: "Missing list URL." }, 400);
      const unlike = body.action === "unlike";
      const hash = await hashStringForKey(rawUrl.toLowerCase());
      const key = `externallike:${hash}`;
      const raw = await env.CONFIGS.get(key);
      let data = { url: rawUrl, likes: 0 };
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { url: rawUrl, likes: 0 };
        }
      }
      data.likes = Math.max(0, (data.likes || 0) + (unlike ? -1 : 1));
      data.url = rawUrl;
      data.updatedAt = Date.now();
      await env.CONFIGS.put(key, JSON.stringify(data));
      return json({ ok: true, likes: data.likes });
    }


    // /api/details (GET or POST) -> { ok: true, details: { title, overview, rating, releaseYear, poster, background } }
    if (path === "/api/details") {
      let reqBody;
      if (request.method === "POST") {
        try {
          reqBody = await request.json();
        } catch {
          reqBody = {};
        }
      } else {
        const q = url.searchParams;
        reqBody = { imdbId: q.get("imdbId") || "", tmdbKey: q.get("tmdbKey") || "", type: q.get("type") || "" };
      }
      
      const imdbId = reqBody.imdbId;
      const tmdbKey = reqBody.tmdbKey || TMDB_API_KEY;
      if (!imdbId) return json({ ok: false, error: "Missing imdbId" }, 400);
      
      const details = await fetchTmdbItemDetails(imdbId, tmdbKey, reqBody.type);
      if (!details) return json({ ok: false, error: "Not found or TMDB error" }, 404);
      
      return json({ ok: true, details });
    }

    // --- Creator Profile system --------------------------------------------
    //
    // No accounts, no email, no passwords -- a Creator Profile is just a
    // chosen name plus a randomly generated Creator Key (see
    // generateCreatorKey), with only a salted hash of that key ever stored
    // (see hashCreatorKey/verifyCreatorKey above). There's no session or
    // token issued on "login" either: every authenticated request below
    // re-sends the creatorName + creatorKey and gets re-verified against
    // the stored hash each time, which is what "no authentication system"
    // means here in practice -- simple, stateless, and nothing to expire
    // or revoke separately from the key itself.
    async function authenticateCreator(creatorNameRaw, creatorKey) {
      if (!env || !env.CONFIGS) return { ok: false, error: "no-kv" };
      const v = validateCreatorUsername(creatorNameRaw);
      if (!v.ok) return { ok: false, error: "Username or Key is incorrect." };
      const raw = await env.CONFIGS.get(`creator:${v.normalized}`);
      if (!raw) return { ok: false, error: "Username or Key is incorrect." };
      let profile;
      try {
        profile = JSON.parse(raw);
      } catch {
        return { ok: false, error: "Username or Key is incorrect." };
      }
      const valid = await verifyCreatorKey(creatorKey || "", profile.keyHash);
      if (!valid) return { ok: false, error: "Username or Key is incorrect." };
      return { ok: true, username: v.normalized, displayName: profile.displayName };
    }

    // Every failure path above returns the exact same generic message
    // deliberately -- "that name doesn't exist" vs "that key is wrong"
    // would let someone enumerate which creator names are already taken
    // just by trying to restore them.

    // Handles a single "this just started playing" ping from the
    // /:config/subtitles/... route (25_api-catalog-routes.js) -- see
    // buildManifest's comment for the full mechanism. Never throws back
    // to the caller (that route already responded before this runs, via
    // ctx.waitUntil), so every failure path below just records a
    // diagnostic and returns quietly instead.
    //
    // An episode gets marked watched outright: if you're playing it,
    // you're caught up to it -- a discrete, already-aired unit with
    // nothing ambiguous about it. A movie ping gets treated the same way
    // here, marked watched immediately, which is a deliberate
    // simplification versus where this idea started (a similar reference
    // implementation treats a movie ping as merely "in progress," since
    // one ping at the start doesn't prove you finished a 2-hour movie the
    // way starting an episode implies you're caught up to that episode).
    // This addon's Watch History has no in-progress state to put a movie
    // into, only watched/not-watched, so there isn't a cleanly analogous
    // middle ground to preserve that distinction with.
    async function handleSubtitlesTrack(configParam, stremioType, id, env) {
      if (!env || !env.CONFIGS) return;

      let track, trackCreatorName, trackCreatorKey, tmdbKey;
      try {
        ({ track, trackCreatorName, trackCreatorKey, tmdbKey } = await resolveConfig(configParam, env));
      } catch {
        return;
      }
      if (!track || !trackCreatorName || !trackCreatorKey) return;

      const auth = await authenticateCreator(trackCreatorName, trackCreatorKey);
      const diagnosticsKey = `creatortrack:${auth.ok ? auth.username : String(trackCreatorName).toLowerCase()}`;
      const pingId = `${stremioType}:${id}`;

      if (!auth.ok) {
        await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
          lastPingAt: Date.now(),
          lastPingId: pingId,
          matched: "error: this install's Creator Profile credentials no longer authenticate -- re-generate the install link from Settings.",
        }));
        return;
      }

      const effectiveTmdbKey = tmdbKey || TMDB_API_KEY;
      const parts = id.split(":");
      const imdbId = parts[0];
      let matched = "no";

      try {
        const syncKey = `creatorsync:${auth.username}`;
        const raw = await env.CONFIGS.get(syncKey);
        let blob = null;
        if (raw) {
          try {
            blob = JSON.parse(raw);
          } catch {
            blob = null;
          }
        }
        if (!blob || typeof blob !== "object") {
          blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
        }
        blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
        blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
        blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
        blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};

        if (stremioType === "series" && parts.length >= 3) {
          const season = Number(parts[1]);
          const episode = Number(parts[2]);
          if (!Number.isFinite(season) || !Number.isFinite(episode)) {
            matched = "no (unrecognized episode id format)";
          } else {
            const seasonData = await fetchTmdbSeasonDetails(imdbId, season, effectiveTmdbKey);
            const ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episode) : null;
            if (!ep) {
              matched = "no (could not look up this episode on TMDB)";
            } else {
              const showDetails = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "series").catch(() => null);
              const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === String(ep.id));
              if (!alreadyWatched) {
                blob.watchHistory.unshift({
                  id: String(ep.id),
                  type: "episode",
                  name: ep.name,
                  poster: ep.still_path || (showDetails && showDetails.poster) || "",
                  showId: imdbId,
                  showTitle: (showDetails && showDetails.title) || "",
                  showPoster: (showDetails && showDetails.poster) || "",
                  seasonNum: season,
                  episodeNum: episode,
                });
              }
              // Recompute this show's Continue Watching the same way the
              // cron does (checkForNewEpisodes, 07_source-fetchers-tmdb-
              // simkl.js) -- if this ping's episode happens to be the
              // latest watched one, this naturally finds and queues
              // whatever airs next.
              blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== imdbId);
              const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && it.showId === imdbId && it.seasonNum != null && it.episodeNum != null);
              if (watchedEps.length) {
                const latest = watchedEps.reduce((best, e) => {
                  if (e.seasonNum > best.seasonNum) return e;
                  if (e.seasonNum === best.seasonNum && e.episodeNum > best.episodeNum) return e;
                  return best;
                }, watchedEps[0]);
                const dismissed = blob.dismissedContinueWatching[imdbId];
                const stillDismissed = !!(dismissed && dismissed.seasonNum === latest.seasonNum && dismissed.episodeNum === latest.episodeNum);
                if (!stillDismissed) {
                  const next = await findNextAiredEpisodeForShow(imdbId, latest.seasonNum, latest.episodeNum, effectiveTmdbKey).catch(() => null);
                  if (next) {
                    blob.continueWatching.unshift({
                      id: String(next.episode.id),
                      type: "episode",
                      name: next.episode.name,
                      // Show poster, not episode still -- see the matching
                      // comment on the cron's own continueWatching.unshift.
                      poster: latest.showPoster || "",
                      showId: imdbId,
                      showTitle: latest.showTitle || "",
                      showPoster: latest.showPoster || "",
                      seasonNum: next.seasonNum,
                      episodeNum: next.episode.episode_number,
                    });
                    blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== imdbId);
                  } else if (!blob.fullyWatchedShowIds.includes(imdbId)) {
                    blob.fullyWatchedShowIds.push(imdbId);
                  }
                }
              }
              matched = alreadyWatched ? "yes (already watched)" : "yes";
            }
          }
        } else if (stremioType === "movie") {
          const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === imdbId);
          if (!alreadyWatched) {
            const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie").catch(() => null);
            blob.watchHistory.unshift({
              id: imdbId,
              type: "movie",
              name: (details && details.title) || imdbId,
              poster: (details && details.poster) || "",
            });
          }
          matched = alreadyWatched ? "yes (already watched)" : "yes";
        } else {
          matched = "no (unrecognized id format)";
        }

        blob.updatedAt = Date.now();
        await env.CONFIGS.put(syncKey, JSON.stringify(blob));
      } catch (err) {
        matched = "error: " + (err && err.message ? err.message : String(err));
      }

      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({ lastPingAt: Date.now(), lastPingId: pingId, matched }));
    }

    // /api/creator/track-status  (POST)  { creatorName, creatorKey } ->
    // { ok, lastPingAt, lastPingId, matched } -- powers the "last ping"
    // status line on the Settings page's Auto-track playback panel, same
    // idea as the reference implementation's ping diagnostics. Kept in its
    // own creatortrack:{username} KV key rather than folded into the
    // creatorsync:{username} blob, since that blob gets wholesale-
    // overwritten by the browser's own background sync (pushCreatorSync)
    // on a timer -- storing this there would mean it kept getting quietly
    // wiped out by the very next sync from any signed-in device.
    if (path === "/api/creator/track-status" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const raw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
      let status = { lastPingAt: null, lastPingId: null, matched: null };
      if (raw) {
        try {
          status = JSON.parse(raw);
        } catch {
          // leave status as the empty default
        }
      }
      return json({ ok: true, ...status });
    }

    // /api/creator/create  (POST)  { creatorName } -> { ok, creatorName, displayName, creatorKey }
    // Rate limited to one new profile per minute per IP, tracked via a
    // short-lived KV key rather than anything more elaborate -- this add-on
    // has no user-identity system to rate-limit against besides the
    // requester's own IP.
    if (path === "/api/creator/create" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `ratelimit:creatorcreate:${ip}`;
      if (await env.CONFIGS.get(rateLimitKey)) {
        return json({ ok: false, error: "Please wait a moment before creating another Creator Profile." }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const v = validateCreatorUsername(body.creatorName);
      if (!v.ok) return json({ ok: false, error: v.error });
      const displayName = String(body.creatorName || "").trim();
      // Reserve the rate-limit slot before the uniqueness check, not after
      // -- otherwise two requests landing at nearly the same instant could
      // both pass the "is it taken" check before either has written
      // anything, and both succeed.
      await env.CONFIGS.put(rateLimitKey, "1", { expirationTtl: 60 });
      const existing = await env.CONFIGS.get(`creator:${v.normalized}`);
      if (existing) {
        return json({ ok: false, error: "That username is already taken." });
      }
      const creatorKey = generateCreatorKey();
      const keyHash = await hashCreatorKey(creatorKey);
      await env.CONFIGS.put(
        `creator:${v.normalized}`,
        JSON.stringify({ displayName, keyHash, createdAt: Date.now() })
      );
      // The Creator Key is returned exactly once, right here -- it's never
      // stored anywhere (only its hash is), so this is the only moment it
      // will ever exist outside whoever's holding onto it themselves.
      return json({ ok: true, creatorName: v.normalized, displayName, creatorKey });
    }

    // /api/creator/restore  (POST)  { creatorName, creatorKey } -> { ok, creatorName, displayName }
    if (path === "/api/creator/restore" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `ratelimit:creatorrestore:${ip}`;
      const attempts = parseInt((await env.CONFIGS.get(rateLimitKey)) || "0", 10);
      // More generous than profile creation (this is a normal, repeatable
      // action -- someone restoring on a new device isn't abuse), but still
      // capped well below what's useful for guessing a ~60-bit key.
      if (attempts >= 20) {
        return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
      }
      await env.CONFIGS.put(rateLimitKey, String(attempts + 1), { expirationTtl: 60 });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      return json({ ok: true, creatorName: auth.username, displayName: auth.displayName });
    }

    // /api/creator/lists  (POST)  { creatorName, creatorKey } -> { ok, displayName, lists }
    // The Dashboard's data source -- every list this creator owns (public
    // AND private, since this is an authenticated request only the owner
    // can make), in their own persisted order.
    if (path === "/api/creator/lists" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }
      const lists = (
        await Promise.all(
          order.map(async (slug) => {
            const raw = await env.CONFIGS.get(`creatorlist:${auth.username}:${slug}`);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              return {
                slug,
                name: data.name,
                type: data.type,
                items: data.items || [],
                itemCount: (data.items || []).length,
                likes: data.likes || 0,
                visibility: data.visibility === "private" ? "private" : "public",
                url: `${url.origin}/lists/${auth.username}/${slug}`,
              };
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);
      return json({ ok: true, displayName: auth.displayName, lists });
    }

    // /api/creator/lists/save  (POST)
    // { creatorName, creatorKey, slug (optional -- present means "update
    //   this existing list", absent means "create a new one"), name, type,
    //   items, visibility } -> { ok, slug, url }
    if (path === "/api/creator/lists/save" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });

      const type = body.type === "series" ? "series" : body.type === "movie" ? "movie" : null;
      const items = Array.isArray(body.items) ? body.items : [];
      const visibility = body.visibility === "private" ? "private" : "public";
      const name = String(body.name || "").trim();
      if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
      if (!type) return json({ ok: false, error: "Missing or invalid list type." }, 400);

      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }

      const editingSlug = body.slug && order.includes(body.slug) ? body.slug : null;
      let slug;
      if (editingSlug) {
        // Editing keeps its existing URL even if the name changed --
        // re-slugging on every rename would break links people already
        // have to it.
        slug = editingSlug;
      } else {
        // New list -- slug uniqueness only needs to hold within this
        // creator's own namespace (see the spec: jack/top-10 and
        // someone-else/top-10 are unrelated), so the collision check and
        // auto-increment only look at this creator's own list keys.
        const baseSlug = slugifyServer(name) || "list";
        slug = baseSlug;
        for (let attempt = 2; attempt <= 500; attempt++) {
          if (!order.includes(slug)) break;
          slug = `${baseSlug}-${attempt}`;
        }
      }

      const now = Date.now();
      const existingRaw = editingSlug ? await env.CONFIGS.get(`creatorlist:${auth.username}:${slug}`) : null;
      let createdAt = now;
      let likes = 0;
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          createdAt = existing.createdAt || now;
          likes = existing.likes || 0;
        } catch {
          createdAt = now;
        }
      }
      await env.CONFIGS.put(
        `creatorlist:${auth.username}:${slug}`,
        JSON.stringify({ name, slug, type, items, visibility, likes, createdAt, updatedAt: now })
      );
      if (!order.includes(slug)) {
        order.push(slug);
        await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
      }
      return json({ ok: true, slug, url: `${url.origin}/lists/${auth.username}/${slug}` });
    }

    // /api/creator/lists/delete  (POST)  { creatorName, creatorKey, slug }
    if (path === "/api/creator/lists/delete" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const slug = String(body.slug || "");
      if (!slug) return json({ ok: false, error: "Missing slug." }, 400);
      await env.CONFIGS.delete(`creatorlist:${auth.username}:${slug}`);
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }
      order = order.filter((s) => s !== slug);
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
      return json({ ok: true });
    }

    // /api/creator/lists/reorder  (POST)  { creatorName, creatorKey, order: [slug, ...] }
    if (path === "/api/creator/lists/reorder" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const newOrder = Array.isArray(body.order) ? body.order.map(String) : [];
      // Only accept slugs that already belong to this creator -- silently
      // dropping anything else rather than trusting the client's list
      // wholesale (never trust client-side validation).
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let currentOrder = [];
      try {
        currentOrder = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        currentOrder = [];
      }
      const currentSet = new Set(currentOrder);
      const filteredNewOrder = newOrder.filter((s) => currentSet.has(s));
      // Anything the creator owns that somehow didn't appear in the
      // submitted order (shouldn't normally happen) is appended at the end
      // rather than silently dropped.
      currentOrder.forEach((s) => {
        if (!filteredNewOrder.includes(s)) filteredNewOrder.push(s);
      });
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order: filteredNewOrder }));
      return json({ ok: true, order: filteredNewOrder });
    }

    // --- Site-wide account sync ---------------------------------------------
    //
    // A Creator Profile started out scoped to just publishing/managing
    // Custom Lists (the block above). This extends the same account to the
    // rest of the builder page too: the person's full list of source rows
    // and their order, their saved presets, which panels they'd left
    // collapsed, and which lists they'd liked -- so signing in on another
    // device or browser picks up where they left off instead of starting
    // from a blank page. Still no email/password: the same Creator Name +
    // Creator Key from above is all that's needed.
    //
    // Deliberately a single wholesale blob rather than four separate
    // endpoints -- the client always has the complete current picture of
    // all four in memory already (collectEntries(), the presets map, the
    // collapsed-panel state, and the liked-lists set), so there's no
    // partial-update case that actually needs a smaller request, and one
    // key is simpler to reason about than keeping four in sync with each
    // other.
    if (path === "/api/creator/sync/save" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });

      // One-time forward migration: presets used to live embedded in this
      // same blob, but as of this endpoint no longer accepts them here at
      // all (see /api/creator/sync/save-presets below) -- an updated client
      // never sends body.presets/presetsB64 anymore. Without this check,
      // the very first autosave after updating would overwrite this blob
      // with no presets embedded, and since nothing would have copied the
      // old embedded presets into the dedicated key yet either, they'd be
      // gone. Only runs once per account: after the dedicated key exists
      // (whether from this migration or a real preset save), this block is
      // skipped on every subsequent save.
      const existingPresetsKey = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
      if (existingPresetsKey === null) {
        const oldRaw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
        if (oldRaw) {
          try {
            const oldBlob = JSON.parse(oldRaw);
            if (oldBlob.presetsB64 || (oldBlob.presets && Object.keys(oldBlob.presets).length)) {
              await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, JSON.stringify({
                presets: (oldBlob.presets && typeof oldBlob.presets === "object") ? oldBlob.presets : {},
                presetsB64: oldBlob.presetsB64 || null,
              }));
            }
          } catch {
            // Old blob was unreadable -- nothing to migrate; whatever's
            // already in the dedicated key (or lack of one) stands as-is.
          }
        }
      }

      const blob = {
        config: Array.isArray(body.config) ? body.config : [],
        collapsedPanels: body.collapsedPanels && typeof body.collapsedPanels === "object" ? body.collapsedPanels : {},
        likedLists: Array.isArray(body.likedLists) ? body.likedLists.map(String) : [],
        // Watch History / Continue Watching -- unlike a named Custom List
        // (see /api/creator/lists/save above), these are per-browser
        // tracking data with mixed movie+episode items, not a single
        // publishable movie-or-series list, so they ride along in this
        // same private per-account blob rather than the creatorlist:*
        // namespace. Always private by nature; there's no visibility
        // toggle for either of these anywhere in the client.
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
        continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
        // Shows fully caught up as of the last check, and shows dismissed
        // from Continue Watching (each mapped to the latest-watched
        // episode at the moment of dismissal) -- both ride along here for
        // the same reason watchHistory/continueWatching do above, and both
        // are read by the Continue Watching cron (checkForNewEpisodes,
        // further down this file): fullyWatchedShowIds tells it which
        // shows are even worth checking TMDB for (no point re-checking a
        // show with a known next episode already waiting to be watched),
        // and dismissedContinueWatching stops it from re-adding a card
        // someone explicitly removed, the same way updateContinueWatching
        // already respects a dismissal client-side.
        fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
        dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
        trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      // Workers KV hard-caps a value at 25MB. Presets/Channels no longer
      // live in this blob at all (see above), so this is now just a
      // defensive backstop rather than the main thing it used to guard
      // against.
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "This account's saved data is too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsync:${auth.username}`, serialized);
      } catch (e) {
        // A real KV failure (rate limit, transient error, etc.) previously
        // surfaced to the client as nothing more than a failed fetch --
        // this at least tells the person something specific went wrong
        // server-side rather than leaving "check your connection" as the
        // only explanation, which is misleading when the connection was
        // never the problem.
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/save-presets  (POST)  { creatorName, creatorKey,
    // presets?, presetsB64? } -> { ok }
    // The dedicated, lightweight sibling of /api/creator/sync/save just for
    // presets -- split out because presets are the one piece of synced
    // state that can genuinely grow large (a TV Channel's "url" is its
    // entire episode list, see collectEntries' comment,
    // 21_client-custom-list-builder.js, and a preset stores a full copy of
    // everything in it), while everything else in the main blob
    // (config/watchHistory/collapsedPanels/etc) changes far more often but
    // stays small. Before this split, EVERY autosave -- not just an
    // explicit "save preset" -- re-sent and re-processed the entire,
    // ever-growing presets payload alongside that small, frequent state,
    // which is what could tip a request over Cloudflare's free-plan 10ms
    // CPU budget (PBKDF2 verification below plus a large JSON parse/
    // stringify) and fail with no useful error. This endpoint only gets
    // called when presets actually change (see schedulePresetsSync,
    // 24_client-backup-restore-presets.js), and does no deep JSON work of
    // its own -- presetsB64 is already gzip-compressed client-side into an
    // opaque string, so storing it here is close to a raw pass-through.
    if (path === "/api/creator/sync/save-presets" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const presetsBlob = {
        presets: body.presets && typeof body.presets === "object" ? body.presets : {},
        presetsB64: body.presetsB64 || null,
      };
      const serialized = JSON.stringify(presetsBlob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your saved presets are too large to store (over the 25MB limit) \u2014 likely from several TV Channels with a lot of episodes. Try removing an older preset or a large Channel." });
      }
      try {
        await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, serialized);
      } catch (e) {
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/load -> { ok, data: blob | null }
    // null specifically (rather than an empty blob) distinguishes "this
    // account has never synced from any device" from "this account synced
    // an empty state" -- the client uses that to decide whether to adopt
    // what's already on this browser and push it up as this account's
    // first save, versus overwriting this browser with what the account
    // already has.
    if (path === "/api/creator/sync/load" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const raw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      }
      // Presets live in their own key now (see save-presets above) -- merge
      // them back in here so the client's loadCreatorSync doesn't need to
      // know or care that this is two KV reads instead of one; it still
      // just reads data.presets/data.presetsB64 exactly like before.
      const presetsRaw = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
      if (presetsRaw) {
        let presetsBlob = null;
        try {
          presetsBlob = JSON.parse(presetsRaw);
        } catch {
          presetsBlob = null;
        }
        if (presetsBlob) {
          if (!data) {
            // Presets exist but nothing else has ever synced for this
            // account -- construct a minimal blob so the client still
            // receives them, rather than treating "no main blob" as "no
            // data at all" and having loadCreatorSync skip straight to
            // pushCreatorSync (which would try to push this browser's
            // state up and never even look at what's already saved).
            data = {
              config: [], collapsedPanels: {}, likedLists: [], watchHistory: [],
              continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {},
              trackPlayback: false, updatedAt: Date.now(),
            };
          }
          data.presets = presetsBlob.presets || {};
          data.presetsB64 = presetsBlob.presetsB64 || null;
        }
      }
      return json({ ok: true, data });
    }

    // /api/creator/sync/like  (POST)  { creatorName, creatorKey, usernameSlug, liked } -> { ok }
    // A narrower sibling of sync/save above, just for the likedLists piece
    // of the blob -- exists because the standalone public list page
    // (/lists/:username/:listname below) has its own tiny like button but
    // no access to the rest of a signed-in creator's state (their current
    // list config, presets, panel layout aren't loaded there, and
    // shouldn't need to be just to record a like). It reads the same
    // Creator Name/Key straight out of localStorage as the builder page
    // does, since both live on the same origin -- if this browser was
    // signed in on the builder, that list page can tell, without any
    // separate login of its own. Read-modify-write against whatever's
    // already saved (or a fresh blob if this account has never synced)
    // rather than requiring the caller to send the full state, unlike
    // sync/save.
    if (path === "/api/creator/sync/like" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const usernameSlug = String(body.usernameSlug || "").trim();
      if (!usernameSlug) return json({ ok: false, error: "Missing list reference." }, 400);
      const key = `creatorsync:${auth.username}`;
      const raw = await env.CONFIGS.get(key);
      let blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
      if (raw) {
        try {
          blob = JSON.parse(raw);
        } catch {
          blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
        }
      }
      const set = new Set(Array.isArray(blob.likedLists) ? blob.likedLists : []);
      if (body.liked) set.add(usernameSlug);
      else set.delete(usernameSlug);
      blob.likedLists = [...set];
      blob.updatedAt = Date.now();
      await env.CONFIGS.put(key, JSON.stringify(blob));
      return json({ ok: true });
    }

    // /api/search-published-lists?q=...
    // -> powers the "Search Lists" panel including this Worker's own
    // published Custom Lists -- both anonymously published ones (see
    // /api/publish-list) and public Creator-owned ones (see
    // /api/creator/lists/save) -- alongside the existing mdblist.com/Trakt
    // results. Private Creator lists are filtered out entirely here, per
    // the spec ("Not appear in search or browse pages"). KV's list() only
    // returns keys, not values, so this fetches each candidate's stored
    // data to filter/display by name -- capped at 50 keys per prefix per
    // search to keep this fast even once a lot of lists have been
    // published.
    if (path === "/api/search-published-lists") {
      if (!env || !env.CONFIGS) return json({ ok: true, lists: [] });
      const q = (url.searchParams.get("q") || "").toLowerCase();
      try {
        const [anonResult, creatorResult] = await Promise.all([
          env.CONFIGS.list({ prefix: "publishedlist:user:", limit: 50 }),
          env.CONFIGS.list({ prefix: "creatorlist:", limit: 50 }),
        ]);
        const anonCandidates = await Promise.all(
          anonResult.keys.map(async (k) => {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              // "Private" on an anonymous list only ever means "hidden from
              // search" (see /api/publish-list) -- there's no owner login to
              // gate direct access by, so unlike a private Creator list this
              // doesn't affect the GET /lists/... route at all, just this
              // listing. (The client-side flow that used to create these no
              // longer exists -- saving a list now always requires a Creator
              // Profile -- but existing anonymous lists saved before that
              // change still need to keep working.)
              if (data.visibility === "private") return null;
              const listSlug = k.name.slice("publishedlist:user:".length);
              return {
                name: data.name,
                type: data.type,
                items: (data.items || []).length,
                likes: data.likes || 0,
                creatorName: "Anonymous",
                url: `${url.origin}/lists/user/${listSlug}`,
              };
            } catch {
              return null;
            }
          })
        );
        const creatorCandidates = await Promise.all(
          creatorResult.keys.map(async (k) => {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              if (data.visibility === "private") return null;
              // key shape is creatorlist:{username}:{slug}
              const rest = k.name.slice("creatorlist:".length);
              const sep = rest.indexOf(":");
              if (sep === -1) return null;
              const username = rest.slice(0, sep);
              const listSlug = rest.slice(sep + 1);
              let creatorName = username;
              try {
                const profileRaw = await env.CONFIGS.get(`creator:${username}`);
                if (profileRaw) creatorName = JSON.parse(profileRaw).displayName || username;
              } catch {
                // fall back to the raw username slug
              }
              return {
                name: data.name,
                type: data.type,
                items: (data.items || []).length,
                likes: data.likes || 0,
                creatorName,
                url: `${url.origin}/lists/${username}/${listSlug}`,
              };
            } catch {
              return null;
            }
          })
        );
        const matches = [...anonCandidates, ...creatorCandidates]
          .filter(Boolean)
          .filter((l) => !q || l.name.toLowerCase().includes(q))
          .slice(0, 30);
        return json({ ok: true, lists: matches });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /lists/:username/:listname[.json]  (GET)
    // -> the public, shareable page/feed for a Custom List -- either
    // published anonymously (/api/publish-list, always under the literal
    // "user" namespace) or owned by a Creator Profile (/api/creator/lists/
    // save, under that creator's own username). A browser gets a small
    // landing page; the .json variant (or anything that isn't a browser
    // navigation -- see isBrowserNavigation) gets the raw list data.
    // Either way this reads straight from KV; it never round-trips through
    // fetchCatalog itself (that's only for *other* configs pointing at
    // this URL as a source -- see fetchPublishedListCatalog, which
    // mirrors this same lookup order and private-list handling).
    m = path.match(/^\/lists\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\.json)?$/i);
    if (m) {
      const username = m[1].toLowerCase();
      const listName = m[2].toLowerCase();
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "This Worker has no CONFIGS KV namespace bound, so nothing is published here." }, 404);
      }
      let listData = null;
      let isCreatorList = false;
      const creatorRaw = await env.CONFIGS.get(`creatorlist:${username}:${listName}`);
      if (creatorRaw) {
        try {
          const parsed = JSON.parse(creatorRaw);
          // A private list returns exactly the same 404 as a list that
          // doesn't exist at all -- anyone probing a guessed/leaked URL
          // for a private list gets no signal either way that they've
          // found something real, per the spec (404, never a distinct
          // "access denied").
          if (parsed.visibility !== "private") {
            listData = parsed;
            isCreatorList = true;
          }
        } catch {
          // fall through to anonymous lookup below
        }
      }
      if (!listData) {
        const anonRaw = await env.CONFIGS.get(`publishedlist:${username}:${listName}`);
        if (anonRaw) {
          try {
            listData = JSON.parse(anonRaw);
          } catch {
            return json({ ok: false, error: "That list's stored data is corrupted." }, 500);
          }
        }
      }
      if (!listData) {
        return json({ ok: false, error: "No list found at that address." }, 404);
      }
      let creatorDisplayName = "Anonymous";
      if (isCreatorList) {
        creatorDisplayName = username;
        try {
          const profileRaw = await env.CONFIGS.get(`creator:${username}`);
          if (profileRaw) creatorDisplayName = JSON.parse(profileRaw).displayName || username;
        } catch {
          // fall back to the raw username slug
        }
      }
      const likes = listData.likes || 0;
      const wantsJson = path.endsWith(".json") || !isBrowserNavigation(request);
      if (wantsJson) {
        return json({ ok: true, name: listData.name, type: listData.type, items: listData.items, creatorName: creatorDisplayName, likes });
      }
      const itemsHtml = listData.items
        .map(
          (it) =>
            `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">` +
            (it.poster ? `<img src="${escapeHtmlServer(it.poster)}" style="width:40px;height:60px;object-fit:cover;border-radius:4px;flex:none;">` : "") +
            `<span>${escapeHtmlServer(it.title || "Untitled")}${it.year ? " (" + escapeHtmlServer(it.year) + ")" : ""}</span></div>`
        )
        .join("");
      const shareUrl = `${url.origin}/lists/${username}/${listName}`;
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlServer(listData.name)} \u2014 My Lists</title>
<style>
  body { background:#060b16; color:#f1f2f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:640px; margin:0 auto; padding:24px 16px; }
  a { color:#4d9fff; }
  .card { background:rgba(255,255,255,0.045); border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:20px; margin-top:16px; }
  code { background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px; word-break:break-all; }
  button { background:rgba(255,255,255,0.08); color:#f1f2f5; border:1px solid rgba(255,255,255,0.15); border-radius:10px; padding:10px 16px; font-size:0.95rem; cursor:pointer; }
  button:disabled { opacity:0.6; cursor:default; }
</style></head>
<body>
  <h1 style="margin-bottom:4px;">${escapeHtmlServer(listData.name)}</h1>
  <p style="color:#8d9099; margin-top:0;">by ${escapeHtmlServer(creatorDisplayName)} \u2022 ${listData.type === "movie" ? "Movies" : "Shows"} \u2022 ${listData.items.length} item${listData.items.length === 1 ? "" : "s"} \u2022 <span id="likeCountDisplay">\u2665 ${likes}</span></p>
  <button type="button" id="likeListBtn" style="margin-top:10px;">\u2661 Like</button>
  <div class="card">
    <p><strong>Add this to your own My Lists Addon:</strong> paste this URL in as a list source --</p>
    <p><code>${shareUrl}</code></p>
    <p><small><a href="${shareUrl}.json">View as JSON</a></small></p>
  </div>
  <div class="card">${itemsHtml}</div>
  <script>
  (function () {
    var USERNAME = ${JSON.stringify(username)};
    var SLUG = ${JSON.stringify(listName)};
    var KEY = USERNAME + '/' + SLUG;
    var btn = document.getElementById('likeListBtn');
    function getLiked() {
      try { return new Set(JSON.parse(localStorage.getItem('myListAddon:likedLists') || '[]')); } catch (e) { return new Set(); }
    }
    function rememberLiked(k) {
      var set = getLiked();
      set.add(k);
      try { localStorage.setItem('myListAddon:likedLists', JSON.stringify(Array.from(set))); } catch (e) {}
    }
    function forgetLiked(k) {
      var set = getLiked();
      set.delete(k);
      try { localStorage.setItem('myListAddon:likedLists', JSON.stringify(Array.from(set))); } catch (e) {}
    }
    var isLiked = getLiked().has(KEY);
    if (isLiked) {
      btn.textContent = '\\u2665 Unlike';
    }
    btn.addEventListener('click', function () {
      btn.disabled = true;
      fetch('/api/lists/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, slug: SLUG, action: isLiked ? 'unlike' : 'like' }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) {
          alert('Could not update this like: ' + (data.error || 'unknown error'));
          return;
        }
        if (isLiked) {
          forgetLiked(KEY);
          isLiked = false;
          btn.textContent = '\\u2661 Like';
        } else {
          rememberLiked(KEY);
          isLiked = true;
          btn.textContent = '\\u2665 Unlike';
        }
        document.getElementById('likeCountDisplay').textContent = '\\u2665 ' + data.likes;
        // If this browser was signed into a Creator Profile on the builder
        // page, persist the like to that account too -- fire-and-forget,
        // same as the rest of this add-on's account sync.
        try {
          var creatorName = localStorage.getItem('myListAddon:creatorName');
          var creatorKey = localStorage.getItem('myListAddon:creatorKey');
          if (creatorName && creatorKey) {
            fetch('/api/creator/sync/like', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ creatorName: creatorName, creatorKey: creatorKey, usernameSlug: KEY, liked: isLiked }),
            }).catch(function () {});
          }
        } catch (e) {}
      }).catch(function () {
        alert('Network error while updating this like.');
      }).finally(function () {
        btn.disabled = false;
      });
    });
  })();
  </script>
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } });
    }

    // --- Admin dashboard (page views / install links generated) -----------
    //
    // Locked behind ADMIN_KEY, a secret set via `wrangler secret put
    // ADMIN_KEY` (or the Cloudflare dashboard) -- never lives in this file.
    // A correct key gets a signed, HttpOnly, Secure, SameSite=Strict cookie
    // scoped to /admin (see makeAdminCookieValue/isValidAdminCookie above),
    // not a bare ?key=... in the URL that would sit around in browser
    // history/logs.
    if (path === "/admin" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) {
        return new Response(renderAdminLoginPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      const html = await renderAdminDashboard(env);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (path === "/admin/login" && request.method === "POST") {
      if (!env || !env.ADMIN_KEY) {
        return new Response(
          renderAdminLoginPage("This Worker has no ADMIN_KEY secret set -- run `wrangler secret put ADMIN_KEY` (or set it in the Cloudflare dashboard) first."),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
        );
      }
      let submittedKey = "";
      try {
        const form = await request.formData();
        submittedKey = String(form.get("key") || "");
      } catch {
        // falls through with an empty key, which will fail the compare below
      }
      if (!timingSafeEqualHex(submittedKey, env.ADMIN_KEY)) {
        return new Response(renderAdminLoginPage("Incorrect key."), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const cookieValue = await makeAdminCookieValue(env);
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${cookieValue}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`,
        },
      });
    }

    if (path === "/admin/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        },
      });
    }

    // /api/bulk-resolve
    // Resolves an array of {title, year} objects to TMDB/IMDB IDs
    // Used by the Letterboxd CSV import
    if (path === "/api/bulk-resolve" && request.method === "POST") {
      try {
        const body = await request.json();
        const items = body.items || [];
        const resolved = [];
        // Process in small batches (e.g., 10 at a time) to stay within subrequest limits
        const BATCH_SIZE = 10;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const promises = batch.map(async (item) => {
            const q = (item.title || "").trim();
            const y = item.year ? parseInt(item.year, 10) : null;
            if (!q) return null;
            
            // Step 1: Search TMDB
            const searchSrc = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false${y ? '&primary_release_year=' + y : ''}`;
            const searchRes = await fetch(searchSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!searchRes.ok) return null;
            const searchData = await searchRes.json();
            const match = (searchData.results || [])[0];
            if (!match) return null;
            
            // Step 2: Get External IDs to find IMDB id
            const extSrc = `https://api.themoviedb.org/3/movie/${match.id}/external_ids?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
            const extRes = await fetch(extSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!extRes.ok) return null;
            const extData = await extRes.json();
            
            if (extData.imdb_id) {
              return {
                title: match.title || match.original_title || item.title,
                year: match.release_date ? match.release_date.substring(0, 4) : item.year,
                imdbId: extData.imdb_id,
              };
            }
            return null;
          });
          
          const results = await Promise.all(promises);
          for (const res of results) {
            if (res) resolved.push(res);
          }
        }
        return json({ ok: true, resolved });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },

  // Runs on whatever schedule this Worker's owner configured under
  // Triggers -> Cron Triggers in the Cloudflare dashboard (recommended:
  // every 6 hours) -- see checkForNewEpisodes (07_source-fetchers-tmdb-
  // simkl.js) for what it actually does and why it's scoped and batched
  // the way it is. ctx.waitUntil keeps the invocation alive until that
  // finishes, the same way a fetch handler would keep a response pending,
  // since a scheduled trigger has no incoming request to hold it open on
  // its own.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEpisodes(env));
  },
};
