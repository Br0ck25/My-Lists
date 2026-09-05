const ADDON_ID = "app.my-list";
const ADDON_VERSION = "1.5.0";
const ADDON_NAME = "My Lists";

// How many items a "Recommended Movies"/"Recommended Shows" list holds --
// shared deliberately by the two places that build one, because they used
// to disagree. /api/recommendations (25_api-catalog-routes.js) is what the
// Discover tab's card renders and counts; fetchCuratedCatalog
// (05_catalog-core.js) is what the actual catalog row and the Live Preview
// serve. The card said 40 and the shelf said 100 (PAGE_SIZE) purely
// because each hardcoded its own number. One constant so they cannot
// drift apart again.
const CURATED_RECOMMENDATION_LIMIT = 40;

// --- Bounds on the two unauthenticated permanent-KV-write endpoints ---------
//
// /api/publish-list and /api/save both accept a body from anyone at all and
// store it under a KV key that nothing in this Worker ever expires or
// deletes. Neither used to bound what it stored, so a single anonymous
// request could park multiple megabytes in KV permanently, as many times as
// it liked.
//
// These ceilings are set far above real usage on purpose -- the largest
// genuine list observed in an account export was ~1,200 items, and a
// realistic install config is tens of rows, not thousands. Anything over
// these is rejected with a clear error rather than silently truncated:
// quietly storing a shortened list or a shortened install config would
// trade one bug for a worse, invisible one.
const PUBLISHED_LIST_ITEMS_MAX = 10000;
const PUBLISHED_LIST_NAME_MAX = 200;
const PUBLISHED_LIST_BYTES_MAX = 2 * 1024 * 1024;   // 2 MB of serialized JSON
const SAVED_CONFIG_ENTRIES_MAX = 500;
const SAVED_CONFIG_BYTES_MAX = 512 * 1024;          // 512 KB of serialized JSON

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
let TMDB_API_KEY = "";
let MDBLIST_API_KEY = "";
let MDBLIST_POPULAR_KEY = "";
let MDBLIST_CLIENT_ID = "";
let TRAKT_CLIENT_ID = "";
let SIMKL_CLIENT_ID = "";
let SIMKL_CLIENT_SECRET = "";

// Countries for the Settings > External Accounts & API Keys region picker
// (streaming-availability catalogs and content ratings -- see
// 07_source-fetchers-tmdb-simkl.js's tmdbProviderChartPaths/
// fetchTmdbItemDetailsUncached). ISO 3166-1 alpha-2 codes, matching what
// TMDB's own watch_region/certification data expects. Not every country
// TMDB recognizes is listed here -- this covers the markets TMDB actually
// has meaningful watch-provider coverage for, sorted by country name so
// the dropdown reads naturally rather than needing anyone to already know
// their own ISO code.
const REGION_OPTIONS = [
  ["AR", "Argentina"], ["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"],
  ["BO", "Bolivia"], ["BR", "Brazil"], ["CA", "Canada"], ["CL", "Chile"],
  ["CO", "Colombia"], ["CR", "Costa Rica"], ["HR", "Croatia"], ["CZ", "Czech Republic"],
  ["DK", "Denmark"], ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["EG", "Egypt"],
  ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"],
  ["HK", "Hong Kong"], ["HU", "Hungary"], ["IN", "India"], ["ID", "Indonesia"],
  ["IE", "Ireland"], ["IL", "Israel"], ["IT", "Italy"], ["JP", "Japan"],
  ["MY", "Malaysia"], ["MX", "Mexico"], ["NL", "Netherlands"], ["NZ", "New Zealand"],
  ["NO", "Norway"], ["PA", "Panama"], ["PE", "Peru"], ["PH", "Philippines"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SA", "Saudi Arabia"],
  ["SG", "Singapore"], ["ZA", "South Africa"], ["KR", "South Korea"], ["ES", "Spain"],
  ["SE", "Sweden"], ["CH", "Switzerland"], ["TW", "Taiwan"], ["TH", "Thailand"],
  ["TR", "Turkey"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"],
  ["US", "United States"], ["UY", "Uruguay"], ["VE", "Venezuela"], ["VN", "Vietnam"],
];

// Renders REGION_OPTIONS as <option> tags for the Settings region <select>,
// called at render time in 15_tab-settings-html.js with whatever region
// this install's config already carries (or "US" for a fresh one).
function buildRegionOptionsHtml(selectedRegion) {
  const sel = (selectedRegion || "US").toUpperCase().slice(0, 2) || "US";
  return REGION_OPTIONS.map(
    ([code, name]) => `<option value="${code}"${code === sel ? " selected" : ""}>${name}</option>`
  ).join("");
}


