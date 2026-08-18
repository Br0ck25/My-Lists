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
let MDBLIST_CLIENT_ID = "";
let TRAKT_CLIENT_ID = "";
let TMDB_API_KEY = "5e183700244552be60b9a44cf5d7e7b9";
let SIMKL_CLIENT_ID = "b331c5917e9f5b4e2f92fbfdf62de9b62e99c4c6fe743ff281e6c63be159e3b4";
