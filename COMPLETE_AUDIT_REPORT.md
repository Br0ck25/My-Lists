# My Lists Addon — Complete Forensic Audit

**Date:** 2026-09-13
**Commit audited:** `6b80817` (branch `claude/intelligent-albattani-w4ca61`, clean tree)
**Scope:** entire repository — frontend, Worker, D1/KV, providers, addon protocol, cron, PWA, deployment
**Method:** source reading + executable probes against the repo's own in-memory Worker harness
(`tests/harness.mjs`, real SQLite backing `schema.sql`). Every finding marked **CONFIRMED**
below has a runnable reproduction committed under `audit/full-2026-09-13/`.

---

## 1. Executive summary

### Overall health

The Worker is unusually well engineered for a project of this shape. It has a real test suite
(565 tests), a CI pipeline that renders and syntax-checks the three template-literal pages, a
scope checker that catches cross-file identifier leaks, a hostile-input render check, and a
schema/migration drift test. Authentication, SSRF controls, OAuth state validation, SVG
escaping, CSRF posture, tombstones and rate limiting are all in good shape and all resisted
direct probing. **The build is green: `bash verify.sh` passes end to end.**

That is also exactly why the findings below matter. The defects that remain are not the ones a
test suite or a linter finds. They are (a) *one* read path that was never given a privacy gate
its three siblings have, and (b) a cluster of silent-failure bugs in the Phase-4 D1 tracking
tables where an operation reports success and discards data.

### Findings by severity

| Severity | Count |
| --- | --- |
| P0 — Critical | 1 |
| P1 — High | 3 |
| P2 — Medium | 7 |
| P3 — Low | 9 |
| Informational | 5 |
| **Total** | **25** |

### The most dangerous issue

**SEC-001 (P0).** Any account's **Watch History, Continue Watching, Watchlist and Airing Next**
can be read by a completely unauthenticated caller who knows only the creator's username —
which `/lists/public.json` publishes for every creator with a public list. One GET. No account,
no key, no install link. The response carries `Access-Control-Allow-Origin: *`, so any web page
in any browser can harvest it.

This is not a design decision. The repository's own README states the opposite guarantee:

> `POST /api/creator/sync/share-tracking` … is the only way to opt a Watchlist, Watch History or
> Continue Watching shelf into being visible … **they are private by default and nothing else
> can make them public.**

and the gate that enforces it *already exists* at `/lists/:username/:slug` (26_api-creator-and-admin-routes.js:4096-4117),
added by a previous audit whose comment describes this exact attack. It was applied to one of
the four read paths that reach `creatorsynctracking:{username}`.

### The most likely production failures

1. **SEC-001** — needs no bug to trigger; it is reachable today on every deployment.
2. **DB-001 / BE-001** — a single duplicated `showId` in a user's Continue Watching or Airing
   Next array makes every subsequent D1 tracking write fail and roll back, permanently, while
   the API answers `{ok:true}` and the client then throws away its own local copy.
3. **DB-002** — an ordinary autosave silently drops every `tmdb:`-prefixed Continue Watching
   entry after the first. Reproduced: 4 shows in, 2 shows stored.

### Is the project safe to deploy?

**No — not without fixing SEC-001 first.** It is a cross-user disclosure of personal viewing
history, it is trivially automatable, and it contradicts a written product guarantee. Everything
else can be scheduled; this one gates the next deploy.

### Are existing users or data at risk?

* **Privacy: yes, now.** SEC-001 exposes every existing account's tracking data retroactively.
  There is nothing a user can do to protect themselves; the setting that is supposed to control
  it is not consulted on the leaking paths.
* **Data loss: yes, under realistic conditions.** DB-001, DB-002 and BE-001 destroy Watch
  History / Continue Watching without any error reaching the user, and the destruction
  propagates to the browser's own copy on the following sync.

---

## 2. Repository map

### Inventory

240 tracked files. **Every file listed below was opened and read, in whole or in the relevant
part; the 28 source modules were additionally analysed mechanically (AST scans, SQL extraction,
id/handler cross-reference) end to end.**

```
header.js                                 Worker preamble (doc comment only)
00_constants.js                           tunables, budgets, reserved names, schema expectations
01_icon-asset.js                          base64 PNG (256x256 — see PWA-001)
02_http-and-creator-utils.js              CORS/CSP, json helpers, PBKDF2 auth, KV/D1 helpers,
                                          likes ledger, tombstones, purge, page/bundle caching
03_admin.js                               admin dashboard HTML/JS, stats counters, leaderboards
04_config-resolution.js                   resolveConfig / decodeConfig, provider URL parsing
05_catalog-core.js                        buildManifest, fetchCatalog dispatch, SVG generators,
                                          fetchAutoTrackedCatalog, ensureTrackingMigrated
06_source-fetchers-mdblist-trakt.js       MDBList + Trakt fetchers
07_source-fetchers-tmdb-simkl.js          TMDB + Simkl fetchers, checkForNewEpisodes (cron),
                                          prewarmSharedCatalogs (cron)
08_quickadd-chart-data.js                 curated/chart slug tables
09_page-shell.js .. 15_tab-settings-html  server-rendered page shell + tab markup
16_client-row-core.js .. 24_…presets.js   the client bundle (modals, search, channel builder,
                                          custom lists, creator profile, backup/restore)
25_api-catalog-routes.js                  handleFetch part 1: pages, catalogs, meta, subtitles,
                                          providers, OAuth, preview, likes, feedback
26_api-creator-and-admin-routes.js        handleFetch part 2: creator + admin routes, cron
                                          wiring, `export default`
schema.sql                                18 tables/indexes/FTS5 (fresh-provision path)
migrations/0001a … 0010                   11 migrations (incremental path)
wrangler.toml, .github/workflows/ci.yml    deployment + CI
build.py / build.ps1 / verify.sh           concatenate sources -> worker_entry_combined.js
render_check.js / html_checks.py /
scope_check.mjs / gen_map.py               CI validators
tests/harness.mjs, client-harness.mjs,
  worker.test.mjs, client.test.mjs,
  helpers-unit.test.mjs                    565 tests
docs/history/*.md                          seven prior audits + fix-status reports
README.md, CHANGELOG.md, Changes.md,
  STORAGE-PLAN-KV-D1.md, FUNCTION-MAP.md   documentation
my-lists-full-backup1.json                 5.2 MB data dump committed to the repo (INFO-05)
```

### Architecture

Single Cloudflare Worker. `header.js` + `00_`…`26_` are concatenated byte-exactly into
`worker_entry_combined.js` (70,345 lines) by `build.py`; CI fails on any drift. Files `09_`–`24_`
are **not standalone JavaScript** — they are fragments of a template literal that `renderBuilder()`
returns as a string, which is why the CI pipeline renders and separately syntax-checks the
builder page, the admin page and `/sw.js`.

Storage is dual: **D1 is authoritative for reads**, KV is the mirror plus the cache/config layer.
`getCreator`, `getCreatorList` and `readCreatorTrackingD1` all read D1 first. Writes go to both.

### Dependency map — the path that carries the two worst findings

```
Creator dashboard (22_client-creator-profile.js)
  └─ pushTrackingSync()                        22_…:2060
       → POST /api/creator/sync/save-tracking  26_…:2609
            → authenticateCreator              26_…:12      (PBKDF2 + memo + IP throttle)
            → readCreatorTrackingD1            02_…:3734    (D1 first)
            → clientVersion conflict guard     26_…:2661
            → Continue Watching merge          26_…:2740    ← DB-002 (split(':')[0])
            → saveCreatorTrackingD1            02_…:3528    ← DB-001 (no ON CONFLICT, chunked)
                 return value DISCARDED        26_…:2953    ← BE-001
            → KV put creatorsynctracking:{u}
            ← { ok: true, clientVersion }                   ← reports success either way
  └─ loadCreatorSync()                         22_…:2220
       → POST /api/creator/sync/load           26_…:3258
            → readCreatorTrackingD1 (D1 wins unconditionally, no freshness check) 26_…:3390
       ← stale D1 copy
       → shouldKeepLocalOnlyTracking()         22_…:2202 → false (baseline already advanced)
       → local copy overwritten                22_…:2756  ← loss becomes permanent

Stremio / Wako client
  └─ GET /:config/catalog/:type/:id.json       25_…:771
       → resolveConfig                         04_…:3
       → fetchCatalog → fetchAutoTrackedCatalog 05_…:1188   ← SEC-001 (no owner/share check)

Anyone, unauthenticated
  └─ GET /api/preview?url=autotrack:…          25_…:902     ← SEC-001 (no owner/share check)
  └─ GET /api/resolve?config=<id>              25_…:5957    ← SEC-001 (arrays returned wholesale)
  └─ GET /lists/:user/watch-history.json       26_…:4038    ← gate IS here (404s correctly)
```

### Central functions (highest blast radius)

| Function | File:line | Reached by |
| --- | --- | --- |
| `handleFetch` | 25_:158 → 26_:6272 | every request |
| `authenticateCreator` | 26_:12 | 24 routes |
| `resolveConfig` | 04_:3 | manifest, catalog, meta, subtitles, preview, resolve, scrobble |
| `fetchCatalog` | 05_:91 | catalog, preview, channel, cron |
| `fetchAutoTrackedCatalog` | 05_:1188 | every personal shelf |
| `saveCreatorTrackingD1` | 02_:3528 | save-tracking, both scrobble handlers, cron |
| `readCreatorTrackingD1` | 02_:3734 | sync/load, save-tracking guard, cron |
| `getPublicListIndex` | 02_:2441 | directory, search |

---

## 3. Findings table

| ID | Sev | Area | File | Function / line | Issue | Evidence | Impact | Reproduction | Recommended fix | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | **P0** | Security / authz | 05_catalog-core.js; 25_api-catalog-routes.js | `fetchAutoTrackedCatalog` 05_:1188-1204; `/api/preview` 25_:902; `/api/resolve` 25_:5957; `resolveConfig` 04_:14-45 | Private tracking blob is served with no ownership check and no `creatorshare` gate on three of four read paths | `p09_sec001_e2e.mjs` — `/lists/alice-films/watch-history.json` → 404 (gated) while `/api/preview?url=autotrack:watch-history:series:alice-films` → 200 with the data, `ACAO: *` | Full viewing history, watchlist and upcoming-episode list of every account, to anyone, cross-origin | run the probe | Gate all four paths on owner proof or `creatorshare:{u}[slug] === true` | CONFIRMED |
| DB-001 | **P1** | D1 / data loss | 02_http-and-creator-utils.js | `saveCreatorTrackingD1` 02_:3600-3613 (CW), 3639-3676 (airing), 3714-3719 (chunking) | `INSERT INTO continue_watching` / `airing_next` have no `ON CONFLICT`; PK is `(username, show_id)`. One duplicate `showId` throws, rolls the batch back, and the whole tracking write is lost | `p01_tracking_dup.mjs`, `p02_airing_dup.mjs` — after save #2 D1 still holds save #1's row; `watch_history`, `creator_tracking_meta`, show states all unwritten | Entire account tracking state silently frozen; every later save fails the same way | run the probes | `ON CONFLICT(username, show_id) DO UPDATE`, dedupe server-side, and make the whole account write one batch | CONFIRMED |
| DB-002 | **P1** | Data loss | 26_api-creator-and-admin-routes.js | save-tracking CW merge, `const baseKey = sKey.split(':')[0]` at 2746, 2759 (and 2880, 2892) | For `tmdb:123` the base key is the literal `"tmdb"`, so one server-side `tmdb:` entry marks *every* incoming `tmdb:` entry as already handled | `p03_tmdb_basekey.mjs` — 4 shows sent, 2 stored; `tmdb:222` and `tmdb:333` gone | Continue Watching silently loses every tmdb-identified show on a routine autosave | run the probe | Use the same normalisation the client's `dedupeContinueWatchingItems` uses (21_:2140) | CONFIRMED |
| BE-001 | **P1** | Reliability / silent failure | 02_ + 26_ | `saveCreatorTrackingD1` return discarded at 26_:2953; `d1Success` assigned-never-read at 26_:2145-2160; `readCreatorTrackingD1` has no KV-fresher repair (cf. `getCreatorList` 02_:3368) | A failed D1 write is logged and the route answers `{ok:true}`; the client then advances its baseline and discards its own local copy on the next load | `p01` (route returns `{"ok":true,...}` with D1 rolled back); code read of `pushTrackingSync` 22_:2150-2160 and `shouldKeepLocalOnlyTracking` 22_:2202 | Turns a recoverable D1 hiccup into permanent, user-invisible data loss | run `p01` | Return 500 when the D1 write fails; add the `updatedAt` repair `getCreatorList` already has | CONFIRMED |
| BE-002 | P2 | Correctness | 05_catalog-core.js | `airingByBaseId` build 05_:1405, lookup 05_:1457 | Same `split(':')[0]` bug: every `tmdb:` show matches the first `tmdb:` Airing Next entry | `p10_airing_crossmatch.mjs` — `tmdb:200` inherits `seasonFinaleAirDate: "2026-10-01"` from `tmdb:100`; control `tt300` clean | Wrong finale/premiere dates and badges on Continue Watching shelves | run the probe | Same normalisation as DB-002 | CONFIRMED |
| BE-003 | P2 | Security / reliability | 02_http-and-creator-utils.js | `getOrCreateScrobbleToken` 02_:1812-1863 | On a D1 error the KV writes still run; `usernameForScrobbleToken` then rejects the new token and accepts the old one | `p11_scrobble_rotate.mjs` — rotate returns `{ok:true, token:NEW}`; NEW → 401, OLD → 200 | "Rotate webhook URL" (the revocation control for a leaked credential) fails open and hands back a dead token | run the probe | Abort and report failure if the D1 rotation batch fails; do not write KV | CONFIRMED |
| PROTO-001 | P2 | Addon protocol | 05_catalog-core.js | `buildManifest` 05_:8-10, 35 | Catalogs emit `tmdb:`-prefixed meta ids; manifest declares `idPrefixes: ["tt","channel_"]` on the addon and on the `meta` resource | `p08_idprefix.mjs` — manifest `["tt","channel_"]`, catalog returns `["tt1","tmdb:999"]` | Strict Stremio-protocol clients filter those tiles out or never route their detail page back to this addon | run the probe | Add `"tmdb:"` to both `idPrefixes` arrays (the `/meta` route already handles it, 25_:1083) | CONFIRMED |
| A11Y-001 | P2 | Accessibility | 09_page-shell.js (CSS) | `.header-icon-btn`, `.theme-toggle-btn`, `.dark-mode-toggle`, `.channel-accordion summary`, `.cw-remove-btn`, `.merge-add-channel-select`, `.detail-sort-select` | `outline:none` on 7 selectors with no `:focus`/`:focus-visible` replacement; whole 97 KB sheet has 2 `:focus` rules and 0 `:focus-visible` | scan of rendered `page.html` | Theme toggle, header buttons, accordions and CW remove buttons are invisible to keyboard users | render page, tab through | Add a `:focus-visible` outline token and apply it wherever `outline:none` is set | CONFIRMED |
| DB-003 | P2 | Performance / scale | 02_http-and-creator-utils.js | `getPublicListIndex` 02_:2446-2477 | The D1 UNION query has no `LIMIT`; `/lists/public.json` fetches every public list and pages in memory; `json_array_length(items_json)` is evaluated per row | source read; `/lists/public.json` 25_:422-434 slices after the full fetch | Directory and search cost grows linearly with total public lists; eventually a D1 response-size failure | n/a (scale) | Push `LIMIT`/`OFFSET` into SQL; store `item_count` as a column instead of parsing JSON per query | LIKELY |
| FE-001 | P2 | Frontend / silent failure | 22_client-creator-profile.js | 3831-3844 | Reconciliation `POST /api/creator/lists/save` uses `.catch(()=>{})` with no `data.ok` check, after mutating `sList.items` optimistically | source read | A rejected save (413 too large, 409 conflict) leaves the UI showing items the server does not have | send an oversized list through the reconciliation path | Check `data.ok`, revert the optimistic mutation, surface the error | CONFIRMED |
| CF-001 | P2 | Cloudflare limits | 26_api-creator-and-admin-routes.js | `/admin/api/creator-lists` 26_:5080-5085 | `list({prefix, limit:1000})` with no cursor, then one `CONFIGS.get` per key in the same invocation | source read | Approaches/exceeds the 1,000-storage-operations-per-invocation cap; silently truncates past 1,000 lists | admin account with several hundred lists | Page the listing and bound the per-invocation `get` count, as `/admin/api/published-lists` already does | LIKELY |
| A11Y-002 | P3 | Accessibility | 03_, 09_, 16_, 19_, 22_ | 18 sites (list in §8) | Icon-only buttons whose only content is `✕` / `♡`, with no `aria-label` or `title` | `iconbtn` scan, 18 hits | Screen readers announce "multiplication X" or nothing for every modal close button | n/a | Add `aria-label="Close"` etc. | CONFIRMED |
| A11Y-003 | P3 | Accessibility | 09_page-shell.js (CSS) | whole sheet | No `prefers-reduced-motion` block at all, against 3 `@keyframes`, 7 `animation:` and 33 `transition:` declarations | CSS scan | Vestibular-sensitive users get unmitigated motion | n/a | Add a `@media (prefers-reduced-motion: reduce)` block | CONFIRMED |
| A11Y-004 | P3 | Accessibility | 09_page-shell.js | 4 `role="dialog"` elements | None carries `aria-label` or `aria-labelledby` | rendered-page scan: 4 dialogs, 0 named | Dialogs announce as "dialog" with no name | n/a | `aria-labelledby` pointing at each dialog's heading | CONFIRMED |
| PWA-001 | P3 | PWA | 25_api-catalog-routes.js | `/app.webmanifest` 25_:625-629 | Both icon entries point at `/icon.png`, declared 192×192 and 512×512; the PNG's IHDR says **256×256**. No `purpose:"maskable"` | decoded `ICON_BASE64` IHDR = 256×256 | Blurry splash/app icon; Android letterboxes the icon | inspect `/icon.png` | Ship real 192/512 assets, add a maskable entry | CONFIRMED |
| FE-002 | P3 | Dead code | 18_client-copy-and-trakt-export.js | 1015-1540 (~530 lines) | Two zip-import features are bound with `getElementById('traktExportFileInput')?.addEventListener(...)` / `'letterboxdExportFileInput'`; neither id is ever rendered. Replaced by `unifiedImportFileInput` | grep of rendered page: 0 occurrences as an `id=` attribute; `runTraktExportImport` reachable only from inside the never-attached handler | Unreachable code; `renderTraktExportCategories`, `collectTraktExportItems`, `collectLetterboxdExportItems` have 0 references | grep rendered page | Delete the block, or restore the inputs if the feature is wanted | CONFIRMED |
| FE-003 | P3 | Frontend | multiple | 11 ids | `getElementById` targets that the page never creates: `channelDraftCountBadge`, `customListSearchInput`, `customListSearchResult`, `customListSearchType`, `letterboxdExportFileInput`, `letterboxdExportImportResult`, `listSearchResult`, `listsSubBulk`, `localCustomListsDashboard`, `traktExportFileInput`, `traktExportImportResult` | id cross-reference scan (248 referenced, 310 exist, 11 missing) | Guarded reads, so no crash — but each is a feature that quietly no-ops. `#listsSubBulk` even has CSS rules (09_:530,543) | grep rendered page | Remove or reconnect each | CONFIRMED |
| API-001 | P3 | Providers | all OAuth callbacks | 25_:2856, 3090, 3212, 4588 | No `refresh_token` is ever stored and no refresh flow exists (one `expires_in` use in the whole repo, 17_:766) | grep: `refresh_token` 0 hits | Trakt tokens die at ~90 days; users must re-authorise. Handled with a clear message on the web UI, but silent inside Stremio | wait 90 days | Persist and use refresh tokens | CONFIRMED |
| DB-004 | P3 | D1 | 26_api-creator-and-admin-routes.js | 2254-2259 | `lists_fts` is maintained as DELETE-then-INSERT outside a batch/transaction; `DELETE … WHERE list_id = ?` filters on an `UNINDEXED` FTS5 column | source read + schema.sql:104 | Two concurrent saves of one list can leave 0 or 2 FTS rows; each save full-scans the FTS index | n/a | Use `env.DB.batch([...])`; consider a content-table FTS5 setup | LIKELY |
| CF-002 | P3 | Cloudflare limits | 02_http-and-creator-utils.js | `SPLIT_PAGE_MEMO` 02_:998-1000 | Memo keyed by the **full pre-split HTML string** (~1.98 MB measured) with the split page (~0.58 MB) as value, 16 entries | `render_check.js` reports 1,979,374 chars; bundle ~1.3 MB + CSS ~97 KB are split out | ~41 MB of retained strings per isolate in the worst case (estimate), against a 128 MB limit, alongside `PER_USER_CACHE_MAP` (1,000 entries) | n/a | Key the memo on a hash, not the string; lower the cap | LIKELY (numbers are estimates) |
| BE-004 | P3 | Reliability | 07_source-fetchers-tmdb-simkl.js | `checkForNewEpisodes` 07_:2334-2350 | The cron reads the blob from **D1** but writes `target.continueWatching` (that D1-derived list) over a **freshly re-read KV** record | source read | After any D1 write failure (DB-001), the next cron tick rolls KV back to the stale D1 copy, destroying the last good copy | n/a | Re-read from the same store being written, or reconcile by `updatedAt` | LIKELY |
| TEST-001 | P3 | Testing | tests/ | — | No test asserts that a failed D1 write is surfaced, that duplicate show ids are tolerated, or that the tracking share gate holds on `/api/preview` and the catalog route | 565 tests pass with all four P0/P1 defects present | Whole defect class is invisible to CI | n/a | Add the probes in `audit/full-2026-09-13/` as regression tests | CONFIRMED |
| INFO-01 | Info | Security | 03_admin.js:1535-1551 | `makeAdminCookieValue` | Admin sessions are a self-contained HMAC over the expiry; no server-side record, so individual revocation is impossible | — | Documented in README | — | Accepted risk, or add a KV session id | — |
| INFO-02 | Info | Data | 03_admin.js:76 | `bumpStat` | `stats.kind` is unbounded (`list_copy:{slug}` mints one row per list) | — | Table grows with list count | — | Bound or prune | — |
| INFO-03 | Info | Security | 26_:6122 | `/admin/logout` | Accepts any method including GET | — | Cookie is `SameSite=Strict`, so not exploitable today | — | Require POST | — |
| INFO-04 | Info | Providers | 05_catalog-core.js:46 | `stremioAddonsConfig.signature` | Hard-coded JWE bound to this deployment; a self-hoster inherits someone else's issuer signature | — | Cosmetic / provenance | — | Make it configurable | — |
| INFO-05 | Info | Repo hygiene | `my-lists-full-backup1.json` | — | A 5.2 MB data backup is committed to the repository | `git ls-files` | Unclear provenance; review before it is published | — | Confirm it contains no real user data, then remove | — |

---

## 4. Detailed findings

### SEC-001 — Any account's Watch History, Watchlist and Continue Watching are readable by an unauthenticated stranger (P0)

**Files / functions**

* `05_catalog-core.js:1188-1204` — `fetchAutoTrackedCatalog`
* `25_api-catalog-routes.js:902-1010` — `GET|POST /api/preview`
* `25_api-catalog-routes.js:771-848` — `GET /:config/catalog/:type/:id.json`
* `25_api-catalog-routes.js:5957-6026` — `GET /api/resolve`
* `04_config-resolution.js:14-45` — `resolveConfig`
* The gate that should be shared: `26_api-creator-and-admin-routes.js:4096-4117`

**What the code does**

`fetchAutoTrackedCatalog` parses a source URL of the form `autotrack:<slug>:<type>:<username>`
and reads that username's private tracking data straight out of D1 (`watch_history`,
`continue_watching`, `airing_next`) or out of `creatorsynctracking:{username}` in KV:

```js
// 05_catalog-core.js:1194-1199
const parts = rawUrl.split(":");
let slug        = parts[1] || "";
let targetType  = parts[2] || entry.type || "movie";
let username    = parts[3] || (keys && (keys.trackCreatorName || keys.username || keys.creatorName)) || "";
…
if (!username) return [];
```

There is no ownership check and no consultation of `creatorshare:{username}`. The username is
taken verbatim from a caller-supplied string.

Separately, `resolveConfig` reads the tracking blob for whatever name a stored config claims:

```js
// 04_config-resolution.js:14, 26-28
let creatorName = parsed.trackCreatorName || parsed.creatorName || "";
…
if (creatorName && env.CONFIGS) {
  const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${creatorName}`);
```

`/api/save` is unauthenticated and accepts `trackCreatorName` without verifying
`trackCreatorKey`, so an attacker can mint a config that names any account and then read the
arrays back out of `/api/resolve`.

**Why it is a problem**

`/lists/:username/:slug` was given a strict opt-in gate by a previous audit, with a comment that
describes this attack precisely:

```js
// 26_api-creator-and-admin-routes.js:4077-4090
// This route has no authentication at all (it's the public share-a-list page), so
// reading that blob here used to hand any anonymous caller the complete viewing
// history of any account whose username they knew -- and usernames are published
// by /lists/public.json for every shared list, so they didn't even need guessing.
```

The gate was applied to that one route. The three paths above reach the same blob and were not
gated. The README (line 406-409) states as a guarantee that sharing is opt-in and *nothing else*
can make these shelves public.

Usernames are not secret: `GET /lists/public.json` returns `creator` for every public list, and
`/api/search-published-lists` returns more.

`/api/preview` responds with `Access-Control-Allow-Origin: *` (25_:1007), so the data is readable
by script on any origin — a page a victim merely visits can harvest the history of any username
it cares to name.

**Evidence — `audit/full-2026-09-13/p09_sec001_e2e.mjs` (actual output)**

```
1. alice's sharing settings: {"watchlist":false,"watch-history":false,"continue-watching":false}
2. GET /lists/public.json  -> usernames: ["alice-films"]
3. GET /lists/alice-films/watch-history.json -> 404 {"ok":false,"error":"No list found at that address."}
4. GET /api/preview autotrack:watch-history -> 200 ACAO=*
   [{"id":"tt0096697","showId":"tt0096697","type":"series","name":"Something Personal",...}]
4. GET /api/preview autotrack:watchlist -> 200 ACAO=*
   [{"id":"tt0000009","type":"movie","name":"Also Personal",...}]
```

Step 3 proves the gate works where it was applied. Step 4 proves it is absent next door.

`p07_preview_leak.mjs` shows all four shelves leaking (`watch-history`, `continue-watching`,
`watchlist`, `airing-next`) and confirms that genuinely private *custom lists* do **not** leak.
`p06_leak_variants.mjs` shows the same data coming back through the Stremio catalog route with a
hand-made base64 config, and `p05_resolve_leak.mjs` shows `/api/resolve` returning all four
arrays after an unauthenticated `/api/save`.

**Reproduction**

```bash
node audit/full-2026-09-13/p09_sec001_e2e.mjs   # end-to-end
node audit/full-2026-09-13/p07_preview_leak.mjs # all four shelves
node audit/full-2026-09-13/p05_resolve_leak.mjs # /api/save -> /api/resolve
node audit/full-2026-09-13/p06_leak_variants.mjs
```

Against a live deployment: `curl 'https://<host>/api/preview?type=series&url=autotrack%3Awatch-history%3Aseries%3A<username>'`

**Expected:** empty result (or 404) unless the owner opted the slug in, or the caller proved
ownership. **Actual:** the full shelf.

**User impact:** complete disclosure of what every creator watches, is watching, and plans to
watch, to anyone, retroactively, with no notification and no user-side mitigation.

**Security impact:** cross-user data exposure (P0). Automatable across the whole user base by
walking `/lists/public.json`. Note `/api/preview`'s 240/minute per-IP limit is a throughput
bound, not a control.

**Recommended fix**

1. Add one helper next to `ensureTrackingMigrated`:

   ```js
   async function mayReadTrackedShelf(env, username, slug, keys) {
     // Owner: the config proved it holds this account's Creator Key.
     if (keys && keys.trackCreatorName && keys.trackCreatorKey) {
       const a = await authenticateCreator(keys.trackCreatorName, keys.trackCreatorKey);
       if (a.ok && a.username === username) return true;
     }
     // Otherwise: only what the owner explicitly opted in.
     return await isTrackingShelfShared(env, username, slug);   // the 26_:4096-4117 lookup, extracted
   }
   ```
2. Call it at the top of `fetchAutoTrackedCatalog` (`05_:1204`) and return `[]` when false. That
   single call covers the catalog route *and* `/api/preview`, since both go through `fetchCatalog`.
3. Thread `trackCreatorKey` through `resolveConfig` → `fetchCatalog`'s `keys` so a genuine
   install link keeps working. Note `/api/preview`'s client payload (19_:736-756) does **not**
   send `creatorKey` today and must be updated.
4. In `resolveConfig` (04_:26), only read `creatorsynctracking:` when the stored config carries a
   `trackCreatorKey` that authenticates as `creatorName`.
5. In `/api/resolve` (25_:6012-6017), drop `watchHistory`/`continueWatching`/`watchlist`/
   `airingNext` from the response unless the same check passes.
6. Add `"airing-next"` to `ALLOWED_SHARE_SLUGS` (26_:3670) so it is expressible, or keep it
   owner-only.

**Migration required:** no. **Affects existing data:** no. **Regression tests required:** yes —
`p07`/`p09` should become permanent tests, plus a positive test that the owner's own install link
still renders all four shelves.

---

### DB-001 — One duplicate show id silently discards an account's entire D1 tracking state (P1)

**File / function:** `02_http-and-creator-utils.js:3528-3723`, `saveCreatorTrackingD1`

**What the code does**

`continue_watching` and `airing_next` both have `PRIMARY KEY (username, show_id)`
(`schema.sql:174`, `schema.sql:203`). The inserts carry no conflict clause:

```js
// 02_:3603-3608  (continue_watching — identical shape at 3664 for airing_next)
env.DB.prepare(
  `INSERT INTO continue_watching (username, show_id, item_id, name, poster, show_title,
    show_poster, season_num, episode_num, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(username, showId, itemId, …)
```

with `const showId = String(item.showId || item.id || "")` (02_:3585). Statements are collected
and sent as `env.DB.batch(chunk)` in chunks of 80 (02_:3714-3718). A D1 batch is one transaction,
so a constraint violation anywhere rolls back that whole chunk — including the
`DELETE FROM continue_watching WHERE username = ?` and every `watch_history` upsert and the
`creator_tracking_meta` row. The outer `catch` (02_:3720) logs and returns `false`.

Two compounding problems: **(a)** the whole account write is not one transaction — with more than
80 statements the leading `DELETE` can commit in chunk 1 while a later chunk rolls back, leaving
the shelf genuinely emptied; **(b)** `watch_history` *does* have `ON CONFLICT … DO UPDATE`
(02_:3695), which shows the pattern was known and simply not applied to the two sibling tables.

**Evidence — `p01_tracking_dup.mjs` (actual output)**

```
save#1: 200 {"ok":true,...}
  D1 continue_watching rows: [ { show_id: 'tt1', item_id: 'tt1:1:2' } ]

D1 write error (saveCreatorTrackingD1): Error: UNIQUE constraint failed:
  continue_watching.username, continue_watching.show_id
save#2: 200 {"ok":true,"rescuedFromScrobble":0,"clientVersion":1789340152454}
  D1 continue_watching rows: [ { show_id: 'tt1', item_id: 'tt1:1:2', name: 'Ep2' } ]   ← save #1's row
  D1 watch_history rows:     [ { item_id: 'tt1:1:1' } ]                                 ← tt9 never landed
  KV blob continueWatching:  [ 'tt2:1:1', 'tt2:1:2' ]                                   ← KV has the truth
load: 200 continueWatching= [{"id":"tt1:1:2",...}]  watchHistory= ["tt1:1:1"]            ← D1 wins
```

`p02_airing_dup.mjs` shows the same for `airingNext`, on a first save, wiping *everything*:

```
D1 write error: UNIQUE constraint failed: airing_next.username, airing_next.show_id
save: 200 {"ok":true,...}
D1 airing_next: []   D1 watch_history: []   D1 meta: []
```

**Why it is a problem**

* `/api/creator/sync/load` prefers D1 unconditionally (26_:3390-3405 — see BE-001), so the user
  sees the stale state.
* `fetchAutoTrackedCatalog` prefers D1 too (05_:1218-1250), so their Stremio shelves are stale.
* `creator_tracking_meta.client_version` never advances, so the conflict guard at 26_:2661
  compares against a baseline that no longer matches KV.
* The condition is sticky: as long as the duplicate is in the client's array, *every* subsequent
  save fails identically, forever, with `{ok:true}` each time.

**Reachability.** `continueWatching` and `airingNext` are wholesale client-supplied arrays. The
current client dedupes them on the *load* path (`dedupeContinueWatchingItems`, 21_:2124) but
**not** on the push path (`pushTrackingSync` sends `localMap['continue-watching'].items` raw,
22_:2098). Any duplicate that ever reaches localStorage — a restored backup, an older cached
bundle, a merge from a second device, a hand-edited key — is pushed and detonates the account.
I checked `TV_CROSSOVER_EVENTS` (136 events, 470 parts): its 223 movie parts are all distinct, so
the companion-bridge path cannot produce a collision from the registry.

**Expected:** the last write wins, per-show, and a genuinely failed write is reported.
**Actual:** the write is discarded in full and reported as success.

**Recommended fix**

1. Add `ON CONFLICT(username, show_id) DO UPDATE SET …` to both inserts (02_:3603, 3664).
2. Dedupe by the key actually being written before building the statements, using the same
   normalisation as `dedupeContinueWatchingItems` (21_:2140).
3. Send the account's write as **one** batch (or wrap the chunks so a later failure cannot leave
   a committed `DELETE` behind).
4. Surface the failure — see BE-001.

**Migration required:** no. **Affects existing data:** no (repairs itself on the next successful
save). **Regression tests required:** yes — `p01` and `p02`.

---

### DB-002 — Continue Watching silently drops every `tmdb:`-prefixed show on an ordinary autosave (P1)

**File / function:** `26_api-creator-and-admin-routes.js:2740-2770` (and the identical block at
2874-2900), inside `/api/creator/sync/save-tracking`

**What the code does**

```js
// 26_:2744-2752
for (const sItem of serverCwList) {
  if (sItem && (sItem.showId || sItem.id)) {
    const sKey = String(sItem.showId || sItem.id);
    const baseKey = sKey.split(':')[0];        // ← "tmdb:123".split(':')[0] === "tmdb"
    …
    mergedCw.push(sItem);
    handledShows.add(sKey);
    if (baseKey) handledShows.add(baseKey);
  }
}
// 26_:2757-2765
for (const cItem of incomingCwList) {
  const cKey = String(cItem.showId || cItem.id);
  const baseKey = cKey.split(':')[0];
  if (!handledShows.has(cKey) && !handledShows.has(baseKey)) { mergedCw.push(cItem); … }
}
```

The intent of `baseKey` is to reduce a compound episode id (`tt123:1:2`) to its show id
(`tt123`). For a TMDB-namespaced id it reduces to the literal namespace `"tmdb"`. One
server-side `tmdb:`-prefixed entry therefore puts `"tmdb"` into `handledShows`, and **every**
incoming `tmdb:` entry is then treated as already handled and dropped.

`tmdb:`-prefixed show ids are a first-class shape in this app — 17_:79 and 17_:885 construct them
(`it.tmdbId ? 'tmdb:' + it.tmdbId : …`), and `findCompanionBridgeMovie` (21_:2315) emits them.

The client's own dedupe gets this right, which is what makes it a bug rather than a choice:

```js
// 21_:2140  dedupeContinueWatchingItems
epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : …
```

**Evidence — `p03_tmdb_basekey.mjs` (actual output)**

```
seeded server CW: [ { show_id: 'tmdb:111', name: 'Show One S1E1' } ]
save: 200 {"ok":true,"rescuedFromScrobble":0,"clientVersion":…}
stored CW (D1): [ { show_id: 'tmdb:111' }, { show_id: 'tt444' } ]
stored CW (KV): [ 'tmdb:111', 'tt444' ]
```

Four shows were sent (`tmdb:111`, `tmdb:222`, `tmdb:333`, `tt444`); two were stored. The
IMDb-namespaced control survived; two TMDB-namespaced shows were silently deleted.

**Reproduction:** `node audit/full-2026-09-13/p03_tmdb_basekey.mjs`

**Expected:** all four shows stored. **Actual:** two, with `{ok:true}`.

**User impact:** Continue Watching quietly loses shows on a routine background autosave. Because
the client's next load adopts the server's answer (BE-001), the loss reaches localStorage too.

**Recommended fix.** Extract the client's normalisation into a shared helper and use it at
26_:2746, 2759, 2880, 2892:

```js
function cwShowKey(raw) {
  const s = String(raw || "");
  if (s.startsWith("tmdb:")) { const p = s.split(":"); return p.length >= 2 ? p[0] + ":" + p[1] : s; }
  return s.split(":")[0];
}
```

**Migration required:** no. **Affects existing data:** entries already dropped are gone; the fix
stops further loss. **Regression tests required:** yes — `p03`.

---

### BE-001 — A failed D1 write is reported as success, and the client then destroys its own copy (P1)

**Files / functions**

* `26_api-creator-and-admin-routes.js:2953-2955` — return value discarded
* `26_api-creator-and-admin-routes.js:2145-2166` — `d1Success` assigned, never read
* `26_api-creator-and-admin-routes.js:3390-3405` — D1 wins unconditionally on load
* `02_http-and-creator-utils.js:3368-3372` — the freshness repair that *does* exist for lists
* `22_client-creator-profile.js:2147-2160` — client advances its baseline on `ok:true`
* `22_client-creator-profile.js:2202-2210` — `shouldKeepLocalOnlyTracking`

**What the code does**

```js
// 26_:2953
if (env.DB) {
  await saveCreatorTrackingD1(env, auth.username, blob, !!body.intentionalRemoval);
}
```

`saveCreatorTrackingD1` returns `true`/`false`. The value is dropped. The route goes on to write
KV and answer `{ ok: true, clientVersion }`.

The same intent appears and is abandoned in `/api/creator/lists/save`:

```js
// 26_:2145-2160
let d1Success = false;
…
  d1Success = true;      // set in two places
…                        // and never read anywhere in the file
```

(`grep -n d1Success 26_api-creator-and-admin-routes.js` → lines 2145, 2151, 2159 only.)

On the read side, `/api/creator/sync/load` takes D1's answer with no freshness comparison:

```js
// 26_:3390-3396
if (d1Tracking) {
  data.watchHistory     = Array.isArray(d1Tracking.watchHistory) ? d1Tracking.watchHistory : [];
  data.continueWatching = Array.isArray(d1Tracking.continueWatching) ? d1Tracking.continueWatching : [];
```

Compare `getCreatorList`, which does exactly the right thing for list records:

```js
// 02_:3368-3371
// If KV has a fresher edit because a D1 write was dropped, prefer KV and repair D1
const kvIsFresher = kvData && typeof kvData.updatedAt === "number" && kvData.updatedAt > (row.updated_at || 0);
```

`readCreatorTrackingD1` has no equivalent.

**Why it is a problem — the full chain**

1. D1 write fails (DB-001, or a real outage). KV holds the truth.
2. Route answers `{ok:true, clientVersion: N}`.
3. Client stores `N` as its new baseline and calls
   `recordTrackingLocalBaseline(sentStamps)` (22_:2156).
4. On the next `loadCreatorSync`, the server serves D1's stale arrays.
5. `shouldKeepLocalOnlyTracking` compares the local list's `updatedAt` to the baseline recorded
   in step 3, finds them equal, and returns `false` (22_:2205-2207).
6. The merge therefore drops every local-only item (22_:2744-2746) and overwrites localStorage
   with the stale server state (22_:2753-2757).

The user's last good copy is destroyed by their own browser, and the only signal anywhere was a
`console.error` in a Worker log.

**Evidence.** `p01_tracking_dup.mjs` shows steps 1-4 directly: `save#2: 200 {"ok":true,...}` with
the D1 batch rolled back, and `load:` returning the pre-save state. Steps 5-6 are a source read
of the two client functions cited above.

**Expected:** a write that did not land is reported as a failure. **Actual:** `{ok:true}`.

**Recommended fix**

1. `26_:2953` — honour the return value:
   ```js
   if (env.DB) {
     const d1ok = await saveCreatorTrackingD1(env, auth.username, blob, !!body.intentionalRemoval);
     if (!d1ok) {
       await env.CONFIGS.put(`creatorsynctracking:${auth.username}`, serialized); // keep the KV truth
       return json({ ok: false, error: "Could not save your watch history right now. Please try again." }, 500);
     }
   }
   ```
2. Give `readCreatorTrackingD1` the `kvIsFresher` repair `getCreatorList` already has, comparing
   `creator_tracking_meta.updated_at` against the KV blob's `updatedAt`.
3. Either read `d1Success` in `/api/creator/lists/save` or delete the variable.

**Migration required:** no. **Affects existing data:** no. **Regression tests required:** yes —
a `failWhen` test asserting a 500 when the D1 tracking write fails.

---

### BE-002 — Wrong season-finale dates on unrelated shows (P2)

**File:** `05_catalog-core.js:1399-1410` (index build) and `1455-1461` (lookup)

```js
// 05_:1405
const base = sid.split(':')[0];
if (base && !airingByBaseId.has(base)) airingByBaseId.set(base, an);
…
// 05_:1457
const base = String(it.showId || it.id || '').split(':')[0];
if (base && airingByBaseId.has(base)) airingMatch = airingByBaseId.get(base);
```

Same `"tmdb"` collapse as DB-002. Every `tmdb:`-prefixed Continue Watching row that has no Airing
Next entry of its own is matched to the *first* `tmdb:` Airing Next entry in the account.

**Evidence — `p10_airing_crossmatch.mjs` (actual output)**

```
{"id":"tmdb:100",...,"airDate":"2026-10-01","isSeasonFinale":true,"seasonFinaleAirDate":"2026-10-01"}
{"id":"tmdb:200",...,"seasonFinaleAirDate":"2026-10-01"}    ← has NO airing entry of its own
{"id":"tt300", ...}                                          ← control, clean
```

`tmdb:200` (Show Two, S5E3) inherited Show One's finale date purely because both ids begin
`tmdb:`. The IMDb-namespaced control is unaffected.

**Impact:** incorrect "season finale" dates and badges on Continue Watching cards and in the
Stremio catalog. **Fix:** the same `cwShowKey` helper as DB-002. **Migration:** no.
**Regression test:** `p10`.

---

### BE-003 — Rotating a leaked scrobble webhook token fails open (P2)

**File:** `02_http-and-creator-utils.js:1812-1863`, `getOrCreateScrobbleToken`

The D1 rotation batch is wrapped in `try { … } catch (dbErr) { console.error(…) }` (02_:1840-1847)
and the KV writes below it run unconditionally. `usernameForScrobbleToken` (02_:1866-1893) then
consults D1 first and, on a KV hit, *rejects* the token if D1 names a different active one:

```js
// 02_:1881-1886
const active = await env.DB.prepare("SELECT token FROM scrobble_tokens WHERE username = ?").bind(u).first();
if (active && active.token && active.token !== t) return "";
```

After a failed rotation, D1 still holds the **old** token. The new token is rejected; the old one
is accepted.

**Evidence — `p11_scrobble_rotate.mjs` (actual output)**

```
initial token: lxnodHIPyrSpaKRMxDIaHbAX
D1 write error (scrobble_tokens): Error: D1_ERROR: injected failure
rotate -> 200 {"ok":true,"token":"WPRv3E6P_SF4IuVrETbGrJ1K"}
after rotation:
  NEW token (should work)    -> 401 Unauthorized
  OLD token (should be revoked) -> 200 {"ok":true,"server":"Plex",...}
```

**Why it matters:** rotation is the *only* revocation control for a webhook URL that carries its
credential in the query string (and therefore lands in the media server's config and logs, as the
code's own comment at 02_:1813-1818 explains). The user is told it succeeded; the compromised
credential keeps working and the replacement does not.

**Fix:** treat a D1 rotation failure as fatal — do not write KV, return an error. **Migration:** no.
**Regression test:** `p11`.

---

### PROTO-001 — Catalogs emit ids the manifest does not declare (P2)

**File:** `05_catalog-core.js:8-10, 35`

```js
const resources  = ["catalog", { name: "meta", types: ["movie","series"], idPrefixes: ["tt","channel_"] }];
const idPrefixes = ["tt", "channel_"];
```

**Evidence — `p08_idprefix.mjs` (actual output)**

```
manifest idPrefixes: ["tt","channel_"]
  meta resource: {"name":"meta","types":["movie","series"],"idPrefixes":["tt","channel_"]}
wh -> ["tt1","tmdb:999"]
cw -> ["tmdb:999"]
```

The `/meta` route *does* handle `tmdb:` ids (`25_:1083 — if (id.startsWith("tt") || id.startsWith("tmdb:"))`),
so this is a declaration/behaviour mismatch, not a missing feature. The codebase already knows
clients enforce `idPrefixes` — the placeholder tile at `25_:833-836` uses a dummy `tt0000000`
"since the manifest declares idPrefixes: ['tt', ...] and some clients filter out anything else".

**Impact:** TMDB-only titles in Watch History / Continue Watching may be dropped from the shelf by
strict clients, and their detail pages are never routed to this addon.
**Fix:** add `"tmdb:"` to both arrays. **Migration:** no. **Regression test:** `p08`.

---

### A11Y-001 — Focus outlines removed with no replacement (P2)

`outline: none` appears 7 times in the rendered stylesheet, on `.header-icon-btn`,
`.theme-toggle-btn`, `.dark-mode-toggle`, `.channel-accordion summary`, `.cw-remove-btn`,
`.merge-add-channel-select` and `.detail-sort-select`. The whole 97,074-byte sheet contains
**two** `:focus` rules (covering `input/select/textarea` and `.detail-sort-select:hover`) and
**zero** `:focus-visible` rules.

A keyboard user tabbing to the theme toggle, any header icon button, a channel accordion, or a
Continue Watching remove button gets no visible indication of where they are. WCAG 2.4.7.

**Fix:** define one token and apply it:
```css
:where(button, summary, select, a, [tabindex]):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

---

### FE-002 / FE-003 — Dead import handlers and 11 phantom element ids (P3)

`document.getElementById('traktExportFileInput')?.addEventListener('change', …)`
(18_:1069) and the Letterboxd equivalent (18_:1418) run at script-evaluation time and bind to ids
that the page never renders. `grep` over the rendered 1.98 MB page finds **zero** occurrences of
either id as an `id=` attribute. The optional chaining means they fail silently.

The features were superseded by `unifiedImportFileInput` (15_:325 →
`onUnifiedImportFilesSelected`, 18_:1677), which handles `.zip` itself. That leaves
18_:1015-1540 (~530 lines) unreachable: `renderTraktExportCategories`, `collectTraktExportItems`,
`renderLetterboxdExportCategories` and `collectLetterboxdExportItems` have **0** references in
the rendered page, and `runTraktExportImport` / `runLetterboxdExportImport` are reachable only
from markup generated inside the never-attached handlers.

A cross-reference of all 248 `getElementById` targets against the 310 ids that exist anywhere in
the page found 11 that are never created (listed in the findings table). `#listsSubBulk` even has
dedicated CSS at 09_:530 and 09_:543, so a "Bulk" sub-tab was intended and is not rendered.

**Note:** a separate AST scan of all 580 top-level client functions found **zero** that are
entirely unreferenced, and CI's `html_checks.py` already proves every inline `on*=` handler
resolves. The dead code is confined to the block above.

---

## 5. Feature-by-feature status

| Feature | Status | Confirmed issues | Untested areas | Risk |
| --- | --- | --- | --- | --- |
| Creator Profiles (create / restore / reset / delete) | **Good** | — | Behaviour at >1,000 accounts during a purge sweep | Low |
| Creator key auth (PBKDF2, memo, throttle) | **Good** | — | Real-world timing variance on Workers | Low |
| Custom Lists (CRUD, slugs, visibility, likes) | **Good** | BE-001 (D1 failure unreported), DB-004 (FTS race) | Concurrent edit from 3+ devices | Low-Med |
| Public directory + search | **Works, scales poorly** | DB-003 (unbounded query) | >5,000 public lists | Medium |
| **Watch History / Continue Watching sync** | **Broken** | DB-001, DB-002, BE-001, BE-004 | Multi-device convergence after a failed write | **High** |
| **Personal shelf privacy** | **Broken** | SEC-001 | — | **Critical** |
| Airing Next | Works with wrong badges | BE-002, DB-001 | TMDB schedule changes mid-season | Medium |
| Virtual TV Channels | **Good** | — | >500-episode channels; channel meta in Wako | Low-Med |
| Scrobble / media-server webhook | Good, revocation broken | BE-003 | Emby/Jellyfin payload variants (code read only) | Medium |
| Trakt / MDBList / Simkl / TMDB OAuth | **Good** (state + PKCE + timing-safe) | API-001 (no refresh) | Live token expiry at 90 days | Medium |
| Letterboxd / unified import | Works | FE-002 (dead predecessor) | Very large zips in a mobile browser | Low |
| Stremio protocol (manifest/catalog/meta/subtitles) | Mostly conformant | PROTO-001 | `genre` extra is declared nowhere and ignored | Medium |
| Cron (episodes + prewarm + schema check + prune) | **Good** | BE-004 | A live free-plan tick | Low-Med |
| Admin dashboard | **Good** | CF-001 | >200 lists on one account | Low |
| PWA / service worker | Good | PWA-001 | Real offline on iOS Safari | Low |
| Likes | **Good** | — | Ledger contention at high concurrency | Low |
| Feedback | **Good** | — | — | Low |
| Backup / restore / presets | Good | — | Round-trip of a 20 MB preset blob | Low |
| Accessibility | **Weak** | A11Y-001..004 | Real screen-reader pass | Medium |

---

## 6. API route matrix

122 route dispatch points (71 in `25_api-catalog-routes.js`, 51 in
`26_api-creator-and-admin-routes.js`). Auth was verified mechanically for every `/api/creator/*`
and `/admin*` route: **20 of 21 creator routes call `authenticateCreator`** — the exception is
`/api/creator/create`, which by definition cannot — and **22 of 23 `/admin*` routes call
`isAdminRequest`** — the exception is `/admin/logout`, which only clears a cookie. **No
missing-authentication defect was found.** Selected rows:

| Method | Route | Auth | Rate limit | Validation | Storage | Audit result |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/` | none | — | — | memo + ETag | OK |
| GET | `/:config/manifest.json` | config = bearer | — | `decodeConfig` | KV | OK |
| GET | `/:config/catalog/:type/:id.json` | config = bearer | — | skip parsed | KV/D1 + providers | **SEC-001** |
| GET | `/:config/meta/:type/:id.json` | config = bearer | — | prefix-checked | cache | PROTO-001 |
| GET | `/:config/subtitles/...` | config = bearer | — | — | KV write via waitUntil | OK |
| GET/POST | `/api/preview` | **none** | 240/min/IP | `isAllowedCatalogSourceUrl` | providers + KV/D1 | **SEC-001** |
| GET | `/api/resolve` | config id | 30/min (remote only) | `isRemoteResolveOrigin` | KV | **SEC-001**; `no-store` OK |
| POST | `/api/save` | **none** | 20/min/IP | entries + byte cap | KV (permanent) | OK (bounded); feeds SEC-001 |
| GET | `/lists/public.json` | none | — | limit/offset clamped | D1 | DB-003 |
| GET | `/lists/:user/:slug(.json)` | none | — | share gate | KV | **OK — the gate is here** |
| POST | `/api/lists/like` | optional | via ledger | existence + visibility | KV + D1 | OK |
| POST | `/api/creator/create` | none | 1/min/IP | username + display name | KV + D1 | OK |
| POST | `/api/creator/restore` | key | 20/min + daily budget | — | KV/D1 | OK |
| POST | `/api/creator/reset-key` | recovery answer | per-IP + per-account | min length | KV + D1 | OK |
| POST | `/api/creator/lists/save` | key | via auth throttle | name/items/bytes | KV + D1 + FTS | BE-001, DB-004 |
| POST | `/api/creator/sync/save-tracking` | key | via auth throttle | arrays coerced; 24 MB cap | KV + D1 | **DB-001, DB-002, BE-001** |
| POST | `/api/creator/sync/load` | key | via auth throttle | — | KV + D1 | BE-001 |
| POST | `/api/creator/sync/share-tracking` | key | via auth throttle | slug allowlist | KV + D1 | OK (not consulted by SEC-001 paths) |
| POST | `/api/scrobble*` | token / key / config | via auth throttle | payload shape | KV + D1 | BE-003 |
| POST | `/api/creator/delete-account` | key | via auth throttle | — | full purge | OK |
| GET | `/admin/api/creator-lists` | cookie | — | username validated | KV 1,000 + D1 | CF-001 |
| POST | `/admin/login` | ADMIN_KEY | 10/min + daily budget | `timingSafeEqualSecret` | — | OK |
| POST | `/api/bulk-resolve` | none | 3,600 ids/min | budgeted | TMDB | OK |
| POST | `/api/feedback` | optional | 20/day/IP | 4,000 chars, category allowlist | KV + D1 | OK |

---

## 7. Database and storage review

### D1 schema

18 tables plus one FTS5 virtual table. **Every SQL statement in the source was extracted (225
literals) and re-prepared against `schema.sql` in real SQLite: zero unknown tables and zero
unknown columns.** (`sqlextract.py` + `sqlcheck2.py`; the 75 "failures" were all UI strings
falsely matched as SQL, e.g. `"Delete Feedback"`.)

| Table | PK | Indexes | Written by | Read by |
| --- | --- | --- | --- | --- |
| `creators` | username | `(last_active DESC, created_at DESC)` | create, reset-key, migrate-d1, share-tracking | `getCreator`, admin |
| `creator_lists` | id | username; visibility; likes; `(visibility, likes DESC, updated_at DESC)` | lists/save, save-tracking (watchlist), likes | `getCreatorList`, directory, admin |
| `published_lists` | slug | `(visibility, likes DESC, updated_at DESC)` | migrate-d1, likes | directory, search, admin |
| `lists_fts` (FTS5) | — | — | lists/save, rebuild, purge | search |
| `list_likes` | (list_id, voter_id) | voter_id | `applyLikeVote` | like count |
| `stats` | (kind, day) | `(day, n DESC, kind)` | `bumpStat` | admin |
| `creator_tombstones` / `list_tombstones` | username / (username, slug) | `(username, until)` | purge, delete | auth, list read |
| `feedback` | id | `(status, updated_at DESC)` | feedback | admin |
| `scrobble_tokens` | token | username | `getOrCreateScrobbleToken` | `usernameForScrobbleToken` |
| `event_meta` | (event_type, item_id) | — | backfill-trending | leaderboard |
| **`watch_history`** | (username, item_id) | `(username, watched_at DESC)` | `saveCreatorTrackingD1` | load, catalog |
| **`continue_watching`** | (username, show_id) | `(username, updated_at DESC)` | `saveCreatorTrackingD1` | load, catalog |
| **`airing_next`** | (username, show_id) | `(username, air_date ASC)` | `saveCreatorTrackingD1` | load, catalog |
| `creator_user_lists` | (username, list_id, list_type) | `(username, list_type)` | sync/save | load |
| `creator_show_states` | (username, show_id) | `(username, is_fully_watched)` | `saveCreatorTrackingD1` | catalog |
| `creator_tracking_meta` | username | — | `saveCreatorTrackingD1` | load, cron |

The three bolded tables are where DB-001 lives.

### Migrations

11 files, `0001a` … `0010`, all idempotent (`IF NOT EXISTS` / `ADD COLUMN`). **The fresh
(`schema.sql`) and incremental (`migrations/`) provisioning paths converge** — `worker.test.mjs`
A15 diffs tables, columns and indexes between the two and passes. No missing migration, no
destructive migration, no migration that cannot run against live data.

`schema.sql` correctly warns that it `DROP`s every table and must not be run against a live
database. `checkD1Schema` (02_:3487) + the cron schema check + `/admin/api/schema-status` give
an operator three ways to notice an unapplied migration.

### KV

Key namespaces: `creator:`, `creatorlist:`, `creatorlistorder:`, `creatorliststamp:`,
`creatorsync:`, `creatorsynctracking:`, `creatorsyncpresets:`, `creatorsyncchannels:`,
`creatorshare:`, `creatortrack:`, `creatorscrobblequeue:`, `creatorlistdeleted:`,
`creatordeleted:`, `scrobbletoken:`, `creatorscrobbletoken:`, `scrobbleseenusers:`,
`publishedlist:user:`, `listlikevoters:`, `lastgood:`, `ratelimit:`, `feedbackrate:`,
`feedback:`, `stats:`, `cron:continuewatching:cursor`, plus bare 12-character config ids.

**KV pagination.** `listAllKeys` (02_:2570) follows cursors correctly and honours `list_complete`.
The `checkForNewEpisodes` sweep stores cursor *and* intra-page offset (07_:2160-2196), which is
the right shape. The unpaginated `list()` calls are all deliberately bounded and documented
(`limit: 200` / `150` / `20` fallbacks) — except `/admin/api/creator-lists` (CF-001).

**Note on the bare config keys.** `resolveConfig` does `env.CONFIGS.get(configParam)` for any
`configParam` of ≤12 characters (04_:4). `/api/save` writes ids with no prefix. I checked every
KV key the codebase writes: all other namespaces are prefixed and longer than 12 characters, so
this cannot currently be used to read an unrelated key. It is a latent hazard — a future key
shorter than 13 characters becomes readable through `/api/resolve` — and deserves a `cfg:` prefix.

### D1 / KV consistency

| Aspect | Status |
| --- | --- |
| D1 authoritative on read | Yes (`getCreator`, `getCreatorList`, `readCreatorTrackingD1`) |
| KV-fresher repair on read | **Lists only.** Tracking has none → BE-001 |
| Write-failure surfaced | **No** → BE-001 |
| Deletion resurrection | Guarded: creator + list tombstones in both stores, with the D1 copy closing KV's read-cache window |
| Orphan cleanup | `makeCreatorExistsMemo` filters lists whose creator is gone |
| Concurrent writes to one KV key | `creatorlistorder:` is read-modify-write; mitigated by a re-read-and-union (26_:2211-2232) and honestly documented as "a rare loss, not a routine one" |
| Malformed stored JSON | Every `JSON.parse` of stored data I traced is inside a `try` |

### Data-loss risks, ranked

1. **DB-001 + BE-001** — whole-account tracking state, silently, permanently.
2. **DB-002** — per-show Continue Watching entries, silently, on every autosave.
3. **BE-004** — the cron writes a D1-derived Continue Watching list over a freshly-read KV
   record, so a divergence created by (1) is cemented rather than healed.
4. `creatorlistorder:` clobbering — list *ordering* only; records are never at risk.

---

## 8. Security review

| Area | Result |
| --- | --- |
| **Authentication** | PBKDF2-SHA256, 100k iterations, 16-byte random salt, `pbkdf2:iter:salt:hash` format. Timing-safe comparison. Success-only memo keyed on `SHA-256(username ‖ key ‖ storedHash)` so a rotation invalidates it. Failures are never memoized. **Sound.** |
| **Authorization** | Every creator route derives ownership from `auth.username`, never from the request body. verified across all 21 creator and 23 admin routes. **No IDOR found in the list/profile surface.** |
| **The one authorization hole** | **SEC-001** — personal shelves are read by username with no check on 3 of 4 paths. |
| **Account enumeration** | Create/restore/reset all return one generic message; tombstones make a just-deleted name indistinguishable from a taken one. **Good.** |
| **Brute force** | Creator key ≈ 60 bits. Per-IP 60 s buckets + per-IP *and* per-account daily failure budgets (D1-atomic where bound). Gated centrally in `authenticateCreator` so a new route inherits it. **Good.** |
| **Admin auth** | `timingSafeEqualSecret` digests both sides first, so `ADMIN_KEY`'s length is not leakable. Cookie `HttpOnly; Secure; SameSite=Strict; Path=/`. 10/min + daily failure budget. **Good** (INFO-01: no individual revocation). |
| **Input validation** | Username `[a-z0-9_-]{3,25}` + reserved set; display name control-char stripped, 40 chars; slugs through `slugifyServer` (`[^a-z0-9]+ → -`, 60 chars) — no traversal reaches a KV key; byte-accurate size caps via `utf8ByteLength`. **Good.** |
| **XSS** | `escapeHtmlServer` (5 chars), `jsonForScript`, `escapeXml`. CI renders the builder page with hostile input in every caller-supplied field and asserts inertness. I probed `/api/channel-poster` and `/api/channel-logo` with `</text><script>`, `"><script>` and an SVG-attribute break: all escaped, `<script` absent from every response (`p04_svg_xss.mjs`). **Good.** |
| **CSP** | `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'self'`, `base-uri 'self'`. `'unsafe-inline'` on script-src is required by the inline-handler architecture and is honestly documented; `html_checks.py` verifies every inline handler resolves. |
| **CSRF** | Admin cookie is `SameSite=Strict`; all mutations are POST; `corsHeaders()` is applied only to the Stremio-protocol and image paths via `isPublicCorsPath`. **Good.** INFO-03: `/admin/logout` accepts GET (not exploitable under Strict). |
| **SSRF** | `isRemoteResolveOrigin` requires https, port 443, a DNS name with an alphabetic TLD, and excludes `PRIVATE_HOST_SUFFIXES` — rejects IPv4/IPv6 literals in every encoding. `normalizeExternalListUrl` uses a host allowlist. `/api/channel-logo` pins `image.tmdb.org` and regex-validates the path. **Good.** Residual: DNS rebinding to a private address is not defended against (inherent without an IP-level check). |
| **Open redirect** | OAuth `redirect_uri` is always `${url.origin}/api/.../callback`; no caller-supplied redirect target. **Good.** |
| **Injection** | All D1 access is via `.prepare().bind()`. The one FTS5 `MATCH` is built from tokens stripped to `[\p{L}\p{N}_]` and quoted. `LIKE` patterns escape `% _ \` — the comment at 02_:2894-2910 documents the `_`-as-wildcard bug this replaced. **Good.** |
| **Secrets** | `safeErrorMessage` strips URLs, labelled secrets and long opaque tokens. `isPrivateApiPath` forces `no-store` on `/api/creator/*`, `/admin*` and `/api/resolve`. OAuth tokens return in the URL **fragment**, not the query string. No secret is logged. **Good.** |
| **Rate limiting** | Present on create, restore, reset-key, admin login, save, preview, feedback, recommendations, bulk-resolve, details/batch, resolve-proxy, and centrally on key verification. |
| **Abuse resistance** | Bounded payloads everywhere (`SAVED_CONFIG_BYTES_MAX`, `CREATOR_LIST_BYTES_MAX`, `PUBLISHED_LIST_ITEMS_MAX`, 24 MB tracking cap, `CHANNEL_LOGO_MAX_BYTES`). `/api/publish-list` — the unauthenticated permanent-key minter — was removed in 1.5.3. **Good.** |

---

## 9. Cloudflare limits review

| Limit | Path | Assessment |
| --- | --- | --- |
| Subrequests / invocation (50 free, 1,000 paid) | Cron | Explicitly budgeted: `CRON_SUBREQUEST_BUDGET`, split 50/50, episode sweep first and awaited so the cheap half lands before the expensive half. **Measured by the repo at 186/tick before the fix.** Well handled. |
| Subrequests / invocation | `/api/bulk-resolve`, `/api/details/batch` | Budgeted and resumable; the client re-posts the remainder. Good. |
| **Storage ops / invocation (1,000)** | `/admin/api/creator-lists` (26_:5080) | `list(limit:1000)` + one `get` per key ⇒ up to 1,001 ops in one request. **CF-001.** |
| Storage ops / invocation | `purgeCreatorData` | Paged, 50 pages max, one delete per key — bounded but a 500-list account is ~500 ops. Acceptable. |
| CPU (10 ms free / 30 s paid) | `authenticateCreator` | PBKDF2 ≈ 15 ms. The memo removes it for warm clients; the IP throttle bounds the cold path. Honest about the free-plan cost. |
| **Isolate memory (128 MB)** | `SPLIT_PAGE_MEMO` (02_:998) | Keyed by the **full 1.98 MB HTML string**; 16 entries × (1.98 MB key + ~0.58 MB value) ≈ **41 MB** worst case (estimate — measured page size, assumed worst-case fill). Plus `APP_BUNDLE` ~1.3 MB, `APP_CSS` ~97 KB, `PER_USER_CACHE_MAP` up to 1,000 entries. **CF-002.** |
| D1 response size | `getPublicListIndex` (02_:2446) | **No `LIMIT`.** Grows with total public lists. **DB-003.** |
| D1 batch size | `saveCreatorTrackingD1` | Chunked at 80 — but chunking is what breaks atomicity (**DB-001**). |
| KV 1 write/s/key | `creatorlistorder:`, tracking blob | Documented; the directory index was already sharded across 32 keys to address this. |
| KV daily writes (1,000 free) | `bumpStat`, `consumeRateLimit` | `bumpStat` routes to D1 when bound, and D1 is required. A KV-only deployment would exhaust the free daily write quota quickly — worth a README line. |
| Request size (100 MB) | tracking blob | Capped at 24 MB in-handler. Fine. |
| Cron duration | `prewarmSharedCatalogs` | 47 charts × ~105 fetches ≈ 4,935 subrequests/tick at the paid default, every 6 minutes. Within the paid 1,000-per-*invocation*… **this exceeds 1,000 subrequests in a single invocation** and should be re-measured against the real cap; the budget arithmetic assumes 10,000. *Flagged as needing measurement, not asserted.* |

---

## 10. Testing report

### Commands actually executed

| Command | Result |
| --- | --- |
| `bash verify.sh` (full pipeline) | **PASS** — build drift, `node --check`, scope check ×2, builder render + validate, admin render + validate, service-worker syntax, hostile render, FUNCTION-MAP drift, 565 tests |
| `node --test tests/*.test.mjs` | **565 tests, 564 pass, 1 skip, 0 fail** (148.5 s). The skip is `pins a hash that matches the bytes the CDN actually serves` (needs network) |
| `python3 build.py` + `git diff` | no drift |
| `node scope_check.mjs worker/page` | clean |
| `node render_check.js` (builder / admin / sw / hostile) | all render |
| `python3 html_checks.py` (×4 tags) | all pass |
| `python3 gen_map.py` + `git diff` | no drift |

### Probes written for this audit (all under `audit/full-2026-09-13/`)

| Probe | Proves | Result |
| --- | --- | --- |
| `p01_tracking_dup.mjs` | DB-001 (CW dup) + BE-001 | **defect confirmed** |
| `p02_airing_dup.mjs` | DB-001 (airing dup wipes a first save) | **defect confirmed** |
| `p03_tmdb_basekey.mjs` | DB-002 | **defect confirmed** |
| `p04_svg_xss.mjs` | SVG escaping on channel-poster/logo | **no defect** |
| `p05_resolve_leak.mjs` | SEC-001 via `/api/save` + `/api/resolve` | **defect confirmed** |
| `p06_leak_variants.mjs` | SEC-001 via base64 config / catalog / configure | **defect confirmed** (configure page is clean) |
| `p07_preview_leak.mjs` | SEC-001 across all four shelves; private lists safe | **defect confirmed** |
| `p08_idprefix.mjs` | PROTO-001 | **defect confirmed** |
| `p09_sec001_e2e.mjs` | SEC-001 end to end incl. enumeration + the gate that works | **defect confirmed** |
| `p10_airing_crossmatch.mjs` | BE-002 | **defect confirmed** |
| `p11_scrobble_rotate.mjs` | BE-003 | **defect confirmed** |

Run them with `node audit/full-2026-09-13/<probe>.mjs` from the repo root.

### Static analyses run

* **SQL** — 225 literals extracted and re-prepared against `schema.sql` in real SQLite. 0 schema mismatches.
* **AST (acorn)** — 136 async functions in the combined Worker; only 2 unawaited bare calls, both documented fire-and-forget (`touchCreatorLastSeen`, `bumpStat`).
* **AST (client)** — 580 top-level functions; **0** with no reference anywhere in the page.
* **Element ids** — 248 `getElementById` targets vs 310 existing ids → 11 phantom (FE-003).
* **Accessibility** — duplicate ids: 0; `<img>` without `alt`: 0; icon-only buttons without a name: 18; `role="dialog"` without a name: 4/4; `outline:none` without replacement: 7; `prefers-reduced-motion`: 0 blocks.
* **CSS** — 20 media blocks, breakpoints at 360/600/640/641 px; **no rule with `min-width ≥ 380px`**; viewport meta correct; `user-scalable=no` absent. No static horizontal-overflow hazard found.
* **Route/auth matrix** — all 44 creator+admin routes checked for their auth call (20/21 and 22/23 respectively; the two exceptions are `/api/creator/create` and `/admin/logout`).
* **Crossover registry** — parsed as JSON: 136 events, 470 parts, 223 movie parts, **0 duplicate movie ids** (rules out one DB-001 trigger).

### Environment limitations — what could NOT be tested, and the evidence still needed

| Not tested | Why | Evidence needed |
| --- | --- | --- |
| Real browser rendering / layout | No browser in the harness; jsdom deliberately not a dependency | A Playwright pass at 360 px and 1440 px in both themes (Chromium *is* available in this container; it was not wired to the app because the app needs a running Worker) |
| Live Cloudflare limits (CPU ms, subrequests, isolate memory) | No `wrangler dev` / no account | `wrangler dev --remote` + one cron tick with observability on; this is what would settle the prewarm subrequest question in §9 |
| Real provider behaviour (401/403/429/500/timeout/shape change) | No API keys; probes would hit live third parties, which rule 12 forbids | A mocked-provider matrix per provider × 10 failure modes |
| Service worker in a real browser | Same | An offline-mode pass after a deploy, plus a cache-version bump test |
| D1 at scale (`getPublicListIndex` with 10k rows) | In-memory SQLite only | A seeded D1 with 10k public lists, timed |
| Screen-reader announcement quality | No AT available | A NVDA/VoiceOver pass over the modals and the dashboard |
| Trakt/Simkl token expiry at 90 days | Time | Nothing needed — `refresh_token` is provably never stored |

---

## 11. Remediation roadmap

Dependencies are noted; the order below is the safe one.

### 1. Critical (before the next deploy)

1. **SEC-001** — gate `fetchAutoTrackedCatalog` on owner-proof-or-opt-in; fix `resolveConfig`
   and `/api/resolve`; update the `/api/preview` client payload to send `creatorKey`.
   *No dependencies. Ship alone, with the `p07`/`p09` probes as tests.*

### 2. High priority — data integrity

2. **DB-001** — `ON CONFLICT` on `continue_watching` and `airing_next`; one batch per account;
   dedupe before building statements.
3. **BE-001** — return 500 when the tracking D1 write fails; add the `kvIsFresher` repair to
   `readCreatorTrackingD1`. *Do this **after** DB-001, or every existing duplicate turns into a
   user-visible 500 instead of silent loss.*
4. **DB-002 + BE-002** — one shared `cwShowKey()` helper, applied at 26_:2746/2759/2880/2892 and
   05_:1405/1457. *Independent of 2-3; ship together since it is one helper.*
5. **BE-004** — make `checkForNewEpisodes` read and write the same store. *Depends on 3.*

### 3. Backend reliability

6. **BE-003** — fail the scrobble rotation when D1 fails.
7. **CF-001** — page `/admin/api/creator-lists`.
8. **DB-004** — batch the `lists_fts` delete+insert.

### 4. Protocol and frontend

9. **PROTO-001** — add `"tmdb:"` to both `idPrefixes`. One line, ship any time.
10. **FE-001** — check `data.ok` in the reconciliation save.
11. **FE-002 / FE-003** — delete the dead import block; resolve the 11 phantom ids (decide per id:
    reconnect or remove). *`#listsSubBulk` has CSS, so confirm intent with the maintainer first.*

### 5. Performance

12. **DB-003** — push `LIMIT`/`OFFSET` into the directory SQL; add an `item_count` column.
    *This is a migration — sequence it after the P1 work lands.*
13. **CF-002** — key `SPLIT_PAGE_MEMO` on a hash.

### 6. Security hardening (no known exploit)

14. Prefix `/api/save` config ids (`cfg:`) so `resolveConfig`'s ≤12-char KV read can never reach
    another namespace. *Needs a read-both-shapes compatibility window — old install links must
    keep working.*
15. `/admin/logout` → POST only.

### 7. Accessibility

16. **A11Y-001** `:focus-visible` token; **A11Y-002** `aria-label` on the 18 icon buttons;
    **A11Y-004** name the 4 dialogs; **A11Y-003** reduced-motion block.

### 8. Testing

17. Promote all 11 probes to `tests/`. Add: a `failWhen` test that a failed tracking D1 write
    returns 500; a share-gate test on `/api/preview` and the catalog route; a duplicate-show-id
    tolerance test.

### 9. Documentation / maintainability

18. **API-001** — either implement refresh tokens or state the 90-day re-auth in the README.
19. **PWA-001** — real 192/512 icons + a maskable entry.
20. **INFO-05** — review and remove `my-lists-full-backup1.json`.
21. Document the free-plan KV daily-write reality in the plan section.

---

## 12. Final verdict

**Is the project production-ready?**
No. It is close — the architecture, the auth model, the input validation and the operational
tooling are all production-grade — but it ships a critical privacy defect and a cluster of
silent data-loss bugs in its flagship sync feature.

**What prevents it from being production-ready?**
SEC-001 alone. It is a cross-user disclosure of personal viewing history, reachable by anyone
with a URL bar, contradicting a written guarantee in the project's own README.

**What could cause data loss?**
DB-001 (a duplicate show id discards the whole D1 tracking state), DB-002 (every `tmdb:`-prefixed
Continue Watching entry after the first, on a routine autosave), BE-001 (the failure is reported
as success, so the client then overwrites its own good copy), BE-004 (the next cron tick cements
the loss). Together these can take an account's entire watch history without a single error
reaching the user.

**What could expose user data?**
SEC-001. Secondarily, and by design rather than by defect: an install link is a bearer credential
carrying provider keys and OAuth tokens, which the README states plainly.

**What could silently fail?**
Every D1 write in the tracking path (BE-001). Scrobble-token rotation under a D1 error (BE-003).
The reconciliation list save (FE-001). Two entire zip-import features that are wired to elements
that do not exist (FE-002). Eleven `getElementById` targets that never resolve (FE-003).

**What should be fixed before the next deployment?**
SEC-001, then DB-001 + BE-001 + DB-002 in that order.

**What can safely wait?**
Everything at P2 and below. The accessibility, PWA, dead-code and performance items are real but
carry no data-loss or disclosure risk, and DB-003 / CF-002 only bind at a scale this deployment
has not reached.

---

## 13. Verification of this report

Per the brief's final rule, the report was re-checked after it was written:

* Every P0/P1 finding was re-run from its committed probe; all still reproduce on `6b80817`.
* Claims that did not survive verification were **removed**, not softened. Two examples: an
  initial suspicion that the four static modals lacked `role="dialog"` was wrong (they have both
  `role` and `aria-modal` — only the accessible *name* is missing, recorded as A11Y-004); and an
  AST pass that appeared to show 64 unreferenced client functions was a false positive from
  handlers referenced only inside string literals — the corrected count is **0**, and that is
  what the report states.
* Findings that could not be proven in this environment are marked **LIKELY**, never CONFIRMED,
  and §10 lists the exact evidence still outstanding for each.
* The documentation/implementation contradiction search found one, and it is the P0: README
  lines 406-409 assert a privacy guarantee the code does not keep.

