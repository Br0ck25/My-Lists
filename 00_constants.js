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
