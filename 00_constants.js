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

// --- Bounds on the AUTHENTICATED list write ----------------------------------
//
// The two ceilings above bound /api/publish-list and /api/save, which anyone
// at all can call. /api/creator/lists/save had no bound of any kind -- not on
// items, not on the name, not on bytes -- even though a Creator Profile costs
// one unauthenticated POST to create. The reasoning that produced the
// anonymous limits applies here almost unchanged; it simply was not carried
// across. Measured before this existed: one account parked 21.8 MB across
// eight saves, and /api/creator/lists returns every list's FULL items array
// on every dashboard render, so that came straight back down the wire.
//
// The item and name caps are deliberately the same numbers as the anonymous
// ones -- there is no reason a signed-in list should be allowed to be larger
// than a published one, and sharing the constants stops the two drifting.
//
// The byte ceiling is different, and lower, because of a limit the anonymous
// path does not have to care about: D1's maximum string/row size is 2,000,000
// bytes. A creator list is mirrored into creator_lists.items_json, and a
// record over that limit cannot be written -- the failure lands in a catch
// that logs and carries on, so the list simply stops being mirrored, silently,
// which is exactly the state that made a missing D1 row destroy a real like
// count. Rejecting at 1.8 MB keeps the mirror honest with room for the other
// columns. Far above any genuine list: the largest observed in an account
// export was ~1,200 items.
const CREATOR_LIST_BYTES_MAX = 1_800_000;

// --- Bound on /api/bulk-resolve's fan-out ------------------------------------
//
// That endpoint issues up to two TMDB calls per item and always uses the
// Worker owner's shared key. 200 items is ~400 subrequests, comfortably
// inside Cloudflare's 1,000-per-invocation limit with room for the rest of
// the request. Shared with the client so the chunk size it sends and the
// size the server accepts cannot drift apart.
const BULK_RESOLVE_ITEMS_MAX = 200;

// --- Bounds on the KV -> D1 backfill sweep ----------------------------------
//
// /admin/api/migrate-d1 walks five KV prefixes (creator:, creatorlist:,
// publishedlist:user:, stats:sourcegroup:, stats:) and spends a KV read plus
// a D1 write on each key it keeps -- both of which count against
// Cloudflare's 1,000-subrequest-per-invocation limit. It used to do the
// whole sweep in one request with no cap, so on a site big enough to need
// migrating it aborted partway through with "Too many subrequests" and
// backfilled only whatever it had reached.
//
// That failure is worse than it looks: per wrangler.toml, an account present
// in KV but missing from D1 is exactly the case /api/creator/reset-key and
// /admin/api/reset-creator-key handle incorrectly, because a D1 UPDATE
// matching zero rows still reports success. So the endpoint whose job is to
// prevent that state was itself the thing leaving accounts in it.
//
// It now runs in resumable chunks against migrated1:state, the same shape
// /admin/api/migrate-day-counts and the public-index rebuild use. Every
// section of the sweep is idempotent (DO NOTHING, or DO UPDATE to a value
// derived only from KV), so re-processing a key across a chunk boundary is
// harmless -- which is what makes chunking safe here.
const MIGRATE_D1_STATE_KEY = "migrated1:state";
const MIGRATE_D1_PREFIXES = ["creator:", "creatorlist:", "publishedlist:user:", "stats:sourcegroup:", "stats:"];
// This endpoint has its invocation to itself (it is admin-triggered, not
// ridden along on the cron), so it can claim more of the 1,000 than the
// index rebuild does -- but still well short of it, since a chunk that
// throws saves no progress.
const MIGRATE_D1_OPS_PER_RUN = 700;
const MIGRATE_D1_PAGE = 200;
// Errors accumulate across every chunk of a run and are handed back to the
// admin panel, so they need a ceiling of their own.
const MIGRATE_D1_ERROR_CAP = 50;

// --- Bound on the display-order array ----------------------------------------
//
// /api/creator/lists/reorder writes whatever slugs it is handed into one KV
// key, and had no cap on how many. Authenticated, so the blast radius is the
// caller's own key -- hygiene rather than a vulnerability -- but an unbounded
// authenticated write is still an unbounded write. Far above any real
// account: the worst case ever observed on a live one was 129 records, and
// that was the duplicate-list bug.
const CREATOR_LIST_ORDER_MAX = 5000;

// --- Recovery-answer strength and throttle ----------------------------------
//
// A Creator Key is ~60 bits of entropy and infeasible to guess. The optional
// recovery answer that can REPLACE it via /api/creator/reset-key is not: it
// is free text a human picks, usually the answer to an implicit security
// question, and it is lowercased before hashing. That endpoint hands back a
// brand-new working key on a match, so the recovery answer is a second,
// far weaker credential for full account takeover.
//
// It used to be throttled by IP alone (10/day). IPs are cheap and rotate;
// the account being attacked does not. Rotating source IPs took over a test
// account in five guesses. Two things follow from that:
//
//   * the throttle has to count per ACCOUNT, not just per source, so the
//     budget an attacker is spending belongs to the thing being attacked;
//   * the answer needs a floor on its length, because no rate limit rescues
//     a secret with a handful of plausible values.
//
// Only the per-account failure budget defends existing accounts, so it is
// the load-bearing half. The minimum length applies to newly set answers.
const RESET_KEY_ACCOUNT_MAX_FAILURES = 5;
const RECOVERY_ANSWER_MIN_LENGTH = 8;

// --- Bound on /api/channel-logo's inlined image ------------------------------
//
// That endpoint fetches a TMDB image and base64-encodes it into an SVG,
// holding the whole thing in memory twice (a byte array, then a binary
// string) before encoding. It is unauthenticated, so the size of what it
// will buffer needs a ceiling rather than being whatever the upstream
// happens to return. A w500 poster is tens of kilobytes.
const CHANNEL_LOGO_MAX_BYTES = 2 * 1024 * 1024;

// --- Connecting the env-backed API key globals -------------------------------
//
// The `let` globals below are the names every helper in this add-on
// references (TMDB_API_KEY, TRAKT_CLIENT_ID, ...). They start empty and have
// to be pointed at whatever this Worker owner configured. This is the one
// place that does it, so the fetch and scheduled entry points cannot drift.
//
// scheduled() has to call it too, and did not. Nothing is broken today only
// because both cron functions happen to read env.X directly and thread it
// down -- but 36 bare references to these globals exist across 03_, 05_,
// 06_ and 07_, and the first cron-reachable call into any of them would have
// silently used an empty key: no crash, no error, just a provider quietly
// returning nothing. Three lines here retires the whole class.
//
// `|| ""` guards against `env` not carrying the property at all, which is
// how a missing Worker secret or var normally reads.
function applyEnvApiKeys(env) {
  TMDB_API_KEY = (env && env.TMDB_API_KEY) || "";
  TRAKT_CLIENT_ID = (env && env.TRAKT_CLIENT_ID) || "";
  SIMKL_CLIENT_ID = (env && env.SIMKL_CLIENT_ID) || "";
  SIMKL_CLIENT_SECRET = (env && env.SIMKL_CLIENT_SECRET) || "";
  MDBLIST_API_KEY = (env && env.MDBLIST_API_KEY) || "";
  MDBLIST_POPULAR_KEY = (env && env.MDBLIST_POPULAR_KEY) || "";
  MDBLIST_CLIENT_ID = (env && env.MDBLIST_CLIENT_ID) || "";
}

// --- Daily failure budgets on the credential endpoints -----------------------
//
// /admin/login and /api/creator/restore each already carry a 60-second
// per-IP bucket in KV. Those bound a burst, but KV reads are edge-cached and
// KV has no atomic increment, so a determined caller can read a stale count
// and slip past. That is acceptable as burst-shaping and NOT as the only
// thing standing in front of a credential.
//
// So both also carry a per-IP DAILY budget, spent only on failures and
// backed by D1's atomic upsert wherever D1 is bound (see noteAuthFailure,
// 02_http-and-creator-utils.js). Successes never consume it, so a legitimate
// admin or someone restoring on a run of new devices is unaffected; the
// ceilings are set far above any plausible honest failure count and reset
// daily on their own.
//
// The secrets behind these are strong -- ADMIN_KEY is a chosen secret and a
// Creator Key is ~60 bits -- so this is defence in depth, not the load-
// bearing control that RESET_KEY_ACCOUNT_MAX_FAILURES is for the weak one.
// How many of one creator's lists /admin/api/delete-creator-list will remove
// in a single call. Each slug costs a KV read, a KV delete, a ledger delete
// and (with D1 bound) a statement, so this keeps one call well inside
// Cloudflare's per-invocation subrequest limit. The admin panel loops, so a
// larger cleanup still completes -- it just arrives as several bounded calls,
// the same shape the other maintenance tools use.
const ADMIN_LIST_DELETE_MAX = 50;

const ADMIN_LOGIN_MAX_FAILURES_PER_DAY = 50;
const CREATOR_RESTORE_MAX_FAILURES_PER_DAY = 100;

// How many Creator Key verifications one IP may force per minute.
//
// Every one of them is PBKDF2 at 100,000 iterations -- about 15ms of CPU,
// measured -- and it runs before the caller has proved anything, on any of the
// sixteen routes that take a Creator Key. Only /api/creator/restore was
// throttled, so /api/creator/sync/load or /api/scrobble?creator=&key= would
// serve unbounded PBKDF2 runs to an anonymous caller: a cheap way to burn
// Worker CPU, and a way around restore's own limit for guessing.
//
// Charged only when the per-isolate memo cannot answer (see
// isCreatorAuthMemoized), so this counts real key checks rather than
// requests. A signed-in dashboard polls, autosaves and pings continuously and
// is memoized throughout, so the ceiling is deliberately far above anything a
// person generates -- several people behind one CGNAT address should never
// see it -- while still bounding a flood to something that cannot dominate an
// invocation budget.
const CREATOR_AUTH_VERIFY_PER_MINUTE = 60;

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



// --- D1 schema manifest ------------------------------------------------------
//
// What each file under migrations/ adds, so the Worker can tell an operator
// when it is running ahead of its own database.
//
// This exists because the failure is otherwise silent and measured: deploy the
// Worker without running migration 0004 and account deletion still answers
// ok:true, still writes its KV tombstone, and still refuses the deleted
// account on a normal request -- but the strongly-consistent half of R3 is
// gone, and a colo with a stale KV cache authenticates a deleted account. The
// only trace is one line in the Worker's logs, which nobody reads until after
// something has gone wrong.
//
// `consequence` is the point of the whole structure. "creator_tombstones is
// missing" tells an operator nothing they can act on; "deleted accounts can
// still authenticate from a colo whose KV cache is stale" tells them whether
// it matters this afternoon.
//
// Kept in step with migrations/ by a test, not by discipline: adding a
// migration without adding its objects here fails the suite, the same way
// FUNCTION-MAP.md and the combined Worker are kept honest by a drift check.
const D1_SCHEMA_MANIFEST = [
  {
    migration: "0001a", kind: "column", table: "creator_lists", name: "likes",
    consequence: "Every list save and the whole D1 mirror fail -- creator_lists has no likes column to write.",
  },
  {
    migration: "0001b", kind: "index", name: "idx_creator_lists_likes",
    consequence: "Ordering public lists by likes scans the table instead of using an index. Slower, not broken.",
  },
  {
    migration: "0002", kind: "table", name: "stats",
    consequence: "Counters fall back to the older KV-only path. Admin totals still work; day-by-day history is thinner.",
  },
  {
    migration: "0003", kind: "index", name: "idx_creators_last_active",
    consequence: "The admin creators list sorts by scanning every row. Slower, not broken.",
  },
  {
    migration: "0003", kind: "index", name: "idx_creator_lists_vis_likes",
    consequence: "The public directory query sorts the whole table rather than walking an index. Slower, not broken.",
  },
  {
    migration: "0004", kind: "table", name: "creator_tombstones",
    consequence: "A deleted account can still authenticate from a colo whose KV cache predates the deletion. This is a security property, not a performance one -- apply this one.",
  },
  {
    migration: "0005", kind: "index", name: "idx_stats_day_totals",
    consequence: "The dashboard's counter panels scan and sort the whole stats table on every load. Slower, not broken.",
  },
];
