## [Unreleased]

Everything below the "Earlier unreleased entries" heading predates 2026-09-03. What
follows first is the work since: four audit passes (an independent full-repository
review, two adversarial rounds, and the first frontend round that drove a real
browser) and the fixes that came out of them, plus the multi-device sync and count
bugs reported from real use afterwards. Every finding from all four audits is closed;
the reports now live in `docs/history/`.

### 🔒 Security & privacy
- **Cross-account data destruction (critical).** An account purge built its D1 delete from a SQL `LIKE` pattern containing the username, and `_` is LIKE's single-character wildcard — so deleting the account `a_c-films` also deleted every list belonging to `abc-films`, `axc-films` and so on. Usernames of all underscores are legal, so this needed no credentials to weaponise. Now an indexed equality on the username column.
- **Stored XSS via imported lists (critical).** Ids from an imported list or channel were interpolated into markup unescaped, so opening a shared list could execute script in the victim's page and read their Creator Key out of `localStorage`. Escaped at every sink, with the delivery path closed.
- **One account's data under another account's name.** Signing in as a second account while the first account's sync response was still in flight rendered the first account's lists, liked lists and catalog rows under the second account's name. A load now checks it still belongs to the account that asked for it.
- **Signup published your Watchlist.** Creating a profile migrated local lists to the account — including the Watchlist, as `public`. It migrates privately now, and creating a profile while already signed in no longer moves the previous account's lists into the new one.
- **Support threads were an open mailbox.** Thread ids were `Math.random()` (~31 bits, recoverable state) and granted read access to free-text reports plus the contact address the form asks for; anyone could also append to any thread and choose the sender name shown. Ids are now 72 bits of CSPRNG, appends to an account's thread require that account's key, the sender is proven rather than claimed, and the lookup endpoint is rate-limited.
- **Account takeover by guessing the recovery answer.** The only throttle was per-IP, which rotating IPs defeat. Added a per-account daily failure budget (atomic on D1), a minimum entropy requirement on the answer at creation, and the same budget on the other credential endpoints.
- **A deleted account could still authenticate.** A colo holding a cached pre-deletion record kept accepting the old key. A strongly-consistent D1 tombstone (`creator_tombstones`) now answers that from anywhere on the next request.
- **Private lists were visible to a probe.** `/api/lists/like` answered differently for a private list than for one that does not exist. Both now return the same generic 404.
- **Media-server webhooks stopped carrying your key.** Plex/Nuvio scrobble URLs contained `creator` + `key` in the query string. They now use a scoped, revocable token that authorises exactly one thing — recording playback — and is revoked when the account is deleted. Existing key URLs keep working, because they are sitting inside people's media servers.
- **SSRF and open redirect** closed in the poster-badge endpoint; `/api/preview` URLs allowlisted; CORS `*` dropped from creator and like JSON; the fflate script from jsDelivr integrity-pinned; admin 401s and every other error response made uncacheable; every account-scoped response moved onto a private-by-default helper at the boundary, so a new route cannot forget.
- **Admin key comparison no longer leaks its length** — both sides are digested first, so the comparison runs over the same length whatever was submitted.

### 🔁 Multi-device sync
- **An installed PWA no longer overwrites the account with its stale copy.** A re-launched PWA begins with no idea what version the account is on, and its start-up timers reached the save endpoints before the first load answered — so changes made on the desktop (a removed Watch History item, a dismissed Continue Watching show, a deleted list, an edited catalog row) came back a few minutes later on the phone. Pushes now wait for the first load, the versions each push cites survive a page load, and `save-tracking` refuses a push built on a version another browser has already replaced.
- **A list deleted on one device stays deleted on the others.** The account now records its own deletions, so a browser still holding a local copy drops it instead of helpfully uploading it back.
- **A resumed device no longer re-adds what another device removed** from Watch History, Continue Watching or the Watchlist.
- **A list changed on another device now refreshes on resume** — the resume poll gained a fifth stamp for custom lists, which the four sync-blob stamps could never have carried.
- **Two devices editing one list** no longer silently lose the older edit: the same conflict guard the sync blobs have, extended to the list write, with the version reported back on save.
- **Concurrent list creation stopped dropping list-order entries** (12 creations, 12 records, 9 order entries before; 12 now).

### 📋 Lists, counts and Discover
- **See All shows the list's real size.** A 303-item chart said "100 items" — the first page's length, printed as a total, and pinned there when a Discover card handed the same 100 through as an exact count. Trakt's own item count is now carried through, a total that the loaded items have overtaken is discarded, and a source that cannot report one says "100+" until the last page lands.
- **Runaway duplicate lists.** One account had 129 list records for 22 real lists (44 copies of one of them) because a save that asked for a slug was silently given a different one and the dashboard re-uploaded the "missing" list forever. The save is idempotent now, the dashboard cannot loop, and the orphan sweep recovers records whose order entry was lost.
- **Never allocate a slug that is already taken** — publishing a 501st list called "Movies" used to replace the contents of `movies-500`.
- Channel "See All" gives every episode its own id instead of collapsing a show into one tile; Trakt popular lists are typed correctly and addressed by slug; imported lists keep their name and type when the URL carries a query string; episode and season posters fall back to the show's artwork when the specific image is missing.
- Removing one Watch History item no longer rebuilds the whole grid, and a grouped show tile removes from the list it is actually in.

### ⌨️ Frontend, accessibility and offline
- **The admin dashboard was dead for two days.** A single backslash inside a template literal turned the whole 60 KB inline script into one `SyntaxError`, and nothing in CI rendered that page. It renders and is syntax-checked now, along with the builder page and the service worker.
- **Modals are usable from a keyboard**: Escape closes, focus is trapped and restored, ARIA roles are correct, and the scroll lock actually locks (it never had) and is always released.
- **The PWA opens offline** — the service worker warms the shell on install, serves it when the network fails, and cannot pin a stale build.
- A restored backup can no longer permanently kill the Discover feed; an obsolete search response can no longer overwrite a newer one; a non-array `dashboardListOrder` no longer takes down the dashboard; the "Settings" label is no longer clipped at 320px.
- **A double-clicked signup** no longer creates an account nobody can sign into.
- **Provider writes that were refused are reported as refused**, instead of being shown as success.

### 🛠️ Admin & operations
- **Browse a creator's lists.** The delete tool takes exact slugs and nothing could tell an operator what they were — unworkable against an account carrying dozens of copies of one list under unguessable slugs. The admin panel now lists the stored records (including ones missing from the creator's display order, flagged), filters by name, and selects them all.
- **Anonymously published lists can be removed.** `publishedlist:user:*` had no delete path in any route; there is now a paged browse and a delete that shares the record, ledger and directory sweep with the creator path.
- **A failed delete says what it removed** before it stopped, instead of only "Failed".
- **The Worker can say when it is running ahead of its own database** (`/admin/api/schema-status`), and the KV→D1 migration is resumable and repairs stale rows rather than only inserting missing ones.
- The public list directory is re-derived daily, rebuilt in resumable chunks, and no longer breaks permanently past ~500 lists; making a list private takes it out of the directory immediately, even if the index write fails.

### ⚙️ Performance & reliability
- **An empty reply from a provider can no longer erase a good chart.** A soft-failed upstream answering `200` with nothing counted as a successful refresh and overwrote all three cache tiers at once, exactly when the circuit breaker was needed. Now refused for the caches a provider owns, while a user's own (legitimately empty) list is unaffected.
- Outbound requests are bounded by a timeout; the cron got the same exception boundary the request path has, isolates each account so one failure costs only itself, and advances its cursor over exactly the accounts it processed.
- Two missing database indexes added; the admin counter panels lost a full table scan and a sort.
- The channel image endpoints are bounded and cacheable; the TMDB fan-out endpoints are rate-limited even when the caller supplies their own key.

### 🧪 Testing & CI
- The suite went from 106 tests to **357**, and now covers the client: `tests/client-harness.mjs` evaluates the real builder bundle against a DOM stub, so payload shapes, response handling and state transitions can be tested without a browser.
- The D1 mock was replaced with **real SQLite**, which is what made the whole first adversarial round's findings testable at all — the mock hardcoded one query to return no rows, could never throw, and could not enforce a constraint.
- `verify.sh` and CI now render and validate the builder page, the admin page and the service worker, check that every inline handler resolves, and fail on `FUNCTION-MAP.md` drift.
- Mutation testing is part of the record: every fix was verified twice — the probe that demonstrated the defect passes, and the defect reintroduced by mutation makes the suite fail.

### Earlier unreleased entries
- **Performance:** Fixed account login and navigation lag for accounts with 1000+ items in Watch History by caching parsed tracking payloads in memory (`_memoryCustomListsObj`) and eliminating repetitive main-thread JSON string re-parsing.
- **Fix:** Fixed a runtime crash in `loadCreatorSync` (`ReferenceError: localOnly is not defined`) during tracking sync unpack.
- **Performance:** Restored 0ms instant tab switching and in-memory Discover feeds caching (`_discoverFeedsCache`), matching production smoothness.
- **Fix:** Enhanced `compactCustomListMap` storage compaction to permanently eliminate browser `QuotaExceededError` when saving large accounts.
- **Feature:** Improved list search with external source name search (MDBList, Trakt, TMDB, Simkl, Profile, Streaming), external creator username search, multi-token relevance scoring, and source badges.
- **Fix:** Fixed Mark Season Watched button state resetting on refresh and fixed episode checkmarks lingering after clicking Mark Season Unwatched.
- **UI:** Renamed "Creator Profile" to "Profile" across all user-facing interface text, prompts, alerts, and FAQs.
- **Fix:** Fixed browser refresh on Custom Lists returning user to the "My Lists" tab page or dropping items.
- **Fix:** Fixed Continue Watching "See All" items disappearing upon clicking the browser refresh button.
- **Fix:** Fixed Continue Watching fast queue race condition (adding both watchHistory and continueWatching to creatorscrobblequeue).
- **Fix:** Fixed Plex scrobbles using show poster instead of episode still thumbnail in Watch History.

- **Fix:** Plex & Nuvio Continue Watching progression and Plex watched checkmarks.
  - Resolved Continue Watching progression failure: fixed a server-merge race condition in `/api/creator/sync/save-tracking` where incoming browser tracking syncs were overwriting the server's newly computed next episodes with stale client state.
  - Fixed Plex TMDB resolution: fixed a title search nesting bug in `fetchTmdbItemDetailsUncached` that caused non-IMDb Plex scrobbles to fail metadata lookup.
  - Added Creator TMDB Key resolution for Plex webhook handler (`handleMediaServerScrobble`).
  - Enhanced client-side episode watch status checks (`openEpisodeDetails`, `computeWatchBadgeState`) to support composite and title-based fallback IDs.

- **Fix:** Plex re-watch progression and TMDB API usage caching.
  - Added watch history reduction logic to Plex scrobbling (previously only on Nuvio) to accurately handle re-watching old episodes without accidentally reverting your Continue Watching state backwards.
  - Rewired TMDB requests to utilize Cloudflare's native Edge Cache API (`caches.default`) in addition to KV. External TMDB requests were bypassing edge caching on Cloudflare Free/Pro tiers, leading to intense TMDB rate-limiting (and inflated API usage stats in the admin dashboard) which previously caused Continue Watching updates to silently fail.

- **Fix:** Continue Watching next episode updates for Plex and Nuvio.
  - Fixed a string coercion bug when reducing watch history that caused the system to mistakenly fetch the next episode for the *first* watched episode rather than the *latest* one.
  - Added a fallback safety check: if a show's next episode cannot be fetched from TMDB (due to rate limits, server timeouts, or metadata agent mismatches from Plex), the previous Continue Watching state is now safely restored rather than permanently dropping the show.

# Changelog

All notable changes to **My Lists Addon** ([mylistsaddon.com](https://mylistsaddon.com)) are documented in this file.

---

## [1.5.3] - 2026-09-08

Closes the last open items from `AUDIT-2026-09-08-ADVERSARIAL-III.md`. Every finding in that report is now
either fixed or a recorded decision; nothing is deferred.

### ⚠️ Action required if you deploy with `wrangler`

`wrangler.toml` now sets three plan-tuning variables (`BULK_RESOLVE_SUBREQUEST_BUDGET`,
`DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`) to their **Workers Paid** values, which keeps the
behaviour you have today. The constants in the code default to the **Free** values instead, because a Worker
pasted into the Cloudflare dashboard has no `wrangler.toml` to read. If you deploy this file to a *free*
Worker, comment that `[vars]` block out. See README's "Which Cloudflare plan do I need?".

### 🗑️ Removed

- **`POST /api/publish-list` is gone.** It was unauthenticated, minted a permanent unowned KV record on every
  call, had no caller anywhere in the shipped app, and was the easiest route to a stored payload. Everything
  that *reads* the records it already wrote is untouched: existing anonymous lists still serve at
  `/lists/user/<slug>`, still appear in the directory and in search, and are still browsable and deletable
  from `/admin`. Publishing a list now goes through the authenticated `/api/creator/lists/save`, which is
  owned and deletable by the person who made it.

### ⚡ Scale & cost

- **The directory index is 32 keys, not one.** Every public save, publish and like did a read-modify-write of
  a single key holding the whole directory — 4.45 MB at the 20,000-entry cap — against KV's limit of one
  write per second to a given key. Entries are now sharded across `index:publiclists:s0`…`s31` on a hash of
  the entry id, so a like touches ~1/32 of the blob and the deployment has 32 keys' worth of write throughput.
  A deployment upgrading in place keeps serving from the old key until its first full publish converts it, so
  the directory never serves a fraction of itself.
- **The daily rebuild actually runs now.** Staleness was read from the index blob's own timestamp, which every
  incremental write bumped — so a deployment busy enough to matter looked freshly built forever and never
  re-derived, which is exactly where stranded entries accumulate. It reads a small marker written only by a
  full build.
- **`/api/creator/lists` no longer ships every list's contents.** It returned each list's full `items` array
  on every dashboard render — after every save, delete and tab switch — measured at 15.08 MB for a 1,200-list
  account. It returns `itemCount` and `updatedAt`; the browser fetches the contents of only the lists whose
  version it does not already hold, from the new `POST /api/creator/lists/items`. After a one-list edit that
  is one list's items instead of all of them.
- **`/api/details/batch` fits an invocation.** 180 outbound fetches at its 60-id cap, against the free plan's
  50. It now spends a budget against *real* upstream calls, so a warm Airing Next refresh is still one
  request on either plan and only cold ids are metered; whatever it could not reach comes back as
  `remainingIds` and the client asks again.
- **The cron tick fits an invocation.** ~186 outbound fetches, so on a free Worker Cloudflare terminated it and
  Continue Watching never picked up a single episode. The episode sweep is now budgeted (two fetches per show,
  exactly) and runs *first*, so its work lands before the expensive optional half starts. Chart pre-warming
  rotates through the chart list from a cursor, and is skipped with one explanatory log line when the budget
  cannot fit even one chart — which is any free-plan budget, since one chart is ~105 fetches.
- Rate limits on `/api/details/batch` are charged in **ids**, not requests, so splitting one refresh across
  invocations does not quietly shrink the real ceiling. Same correction `/api/bulk-resolve` got in 1.5.2.

### 🐛 Fixes

- `/api/external-list/create` returned HTTP 500 and an internal error string when a body field was not a
  string. Fixed there and at the six sibling sites in the same file with the same shape.
- `/api/creator/reset-key` answered HTTP 200 on every failure. Throttles answer 429, credential failures 401 —
  with the message byte-identical across all of them, so the status codes say nothing the body did not.
- Removed `runListSearch()`, the one function in the client bundle with no reference of any kind.

### 📖 Documentation

- README: the three subrequest budgets and what each default costs; that the install link is a bearer
  credential carrying your provider tokens and Creator Key; that an admin session can only be revoked by
  rotating `ADMIN_KEY`; and that `POST /api/creator/sync/share-tracking` is supported but API-only.

### 🧪 Tests

428 pass, 1 skipped (up from 401). Ten mutations — one per behaviour this release introduces — each caught by
the test written for it. Two test helpers were quietly not testing what they claimed: a cron tick was drained
with a single snapshot of `ctx.waitUntil`, so background work registered *by* that work was never awaited, and
the tests only passed because the pre-warm slept long enough between charts.

---

## [1.5.2] - 2026-08-31

### 🛠️ Sync & Live Preview Fixes
- **Watch Tracking Sync Debounce Accumulation**:
  - Fixed a race condition in `scheduleTrackingSync` where concurrent UI events wiped out the `intentionalRemoval` flag, causing unwatched episodes/seasons/shows and removed Continue Watching/Watch History items to revert after <1 second.
  - Ensured `toggleWatchStatus`, `toggleBatchWatchStatus`, and `dismissContinueWatchingShow` pass the intentional removal flag to permanently remove items in server KV.
- **Airing Next Multi-ID Deduplication**:
  - Captures canonical `tmdbId` to prevent the same upcoming episode from showing multiple times when Watch History stores mixed ID formats (`tt...`, `tmdb:...`).
- **Continue Watching Cross-Format Show Deduplication**:
  - Enhanced `dedupeContinueWatchingItems` to deduplicate shows across different ID formats using normalized show titles as a fallback.
- **Live Preview & Catalog Flashing Prevention**:
  - Added configuration payload hashing in `loadCreatorSync` to prevent tearing down the `#lists` DOM when only timestamps change during periodic background syncs.
  - Updated `renderLivePreview` to preserve existing posters during background data refreshes instead of clearing them out with shimmer skeletons.
- **Creator Sync Foreground Resume Crash Fix**:
  - Fixed runtime `ReferenceError: opts is not defined` crash in `loadCreatorSync`.
- **Large Account Performance Optimization**:
  - Removed 15-second forced full-page re-renders and stopped hidden tabs from generating thousands of image DOM nodes.
- **Continue Watching Badges & Parity Rules**:
  - Enforced complete mirroring between **Your Custom Lists > Continue Watching** and **Catalogs / Live Preview**:
    - **Newest Season**: Episode 1 displays `Season Premiere` (if unaired); middle episodes (2 to N-1) display `Finale: [Date]` (e.g. *Lanterns S01E02* `Finale: Oct 4`, *Reacher S04E02* `Finale: Sep 16`); final episode displays `Season Finale`. Unaired episodes display their upcoming air date badge.
    - **Older Seasons** (e.g. *Tracker S03E01*, *FBI S01E03*, *Reacher S03E01*): Displays no badges when the newest season is a later season.
  - Fixed `ReferenceError: today is not defined` in `isEpisodeAired` (`19_client-search-and-likes.js`) and resolved a syntax error in `22_client-creator-profile.js`.
  - Fixed poster card matching in `livePreviewPosterHtml` so Continue Watching badges in Catalogs / Live Preview mirror Your Custom Lists.
  - Enhanced `refreshAiringNext` to auto-fetch when local items are empty, preventing stalled schedule displays on startup.
  - Expanded server-side Airing Next evaluation limit (Trakt/Simkl/MDBList) from 35-40 up to 90 candidate shows, ensuring all upcoming episodes populate in Live Preview & Editor catalogs.
  - Fixed a massive HTTP 429 rate-limit bug when clicking "Mark all as Watched" on Trakt/Simkl/MDBList history, which previously attempted to redundantly sync thousands of items individually back to external providers.
  - Added an in-memory fallback for Custom Lists that completely bypasses the browser's 5MB `localStorage` limit for logged-in users, seamlessly syncing massive imported lists (8,000+ items) directly to/from the cloud. Offline/unauthenticated users now see a proper "Storage Full" error instead of a silent failure.
  - Added automated retry logic for Continue Watching updates during mass imports to prevent TMDB rate limits (110 of 111 shows failing), and fixed the "run this again" button so it actually retries fetching Continue Watching data even if the watch history is already imported.
  - Fixed a "Zombie" item bug where deleting a show from Continue Watching (or Watch History) and immediately refreshing the page would cause the item to re-appear due to Cloudflare KV propagation delays.
  - Fixed a bug where episodes scrobbled from external Media Servers (Plex, Emby, Jellyfin) would appear in Watch History but fail to show the "Marked as Watched" checkmark when browsing the show's seasons in the UI, and added backwards-compatibility so your existing scrobbles now display correctly.
  - Fixed a race condition where massive Trakt imports (8,000+ items) would vanish if the browser was refreshed immediately after importing, due to Cloudflare KV propagation delays overwriting the volatile RAM fallback; massive lists now correctly fallback to `sessionStorage` to safely survive page reloads.

---

## [1.5.1] - 2026-08-30

### 🌟 Features & Rebuilding Tools
- **Rebuild Custom Lists & Channels from Presets & Links**:
  - Automatically reconstructs deleted or missing custom lists and channels from saved presets or install/configure links into local storage and Creator cloud accounts.
  - Added **"Restore Lists"** under Import from Link and **"Rebuild Custom Lists"** on preset cards.
- **Continue Watching Clear History**:
  - Added **Clear History** button to the Continue Watching detail view filter bar and a dedicated **Clear Continue Watching** button in Settings.

### 🛠️ Fixes & Improvements
- **Cross-Origin & Short KV Link Resolution**:
  - `resolveInstallLinkData` automatically detects remote origins and resolves short KV configs across different worker domains.
- **Saved Presets KV Migration**:
  - Added automatic backward-compatible migration from `creatorsync` to dedicated `creatorsyncpresets` KV storage.
- **Creator Dashboard Custom Lists Sync**:
  - Fixed restored custom lists not appearing under "Your Custom Lists" when logged into a Creator Profile and automated cloud syncing.
- **Watch History & Continue Watching Restoration**:
  - Restoring from saved presets or install/configure links now restores Watch History, Continue Watching, and Watchlist items directly into local storage and cloud KV (`pushTrackingSync`).
- **Multi-Device Background Sync & Foreground Resume**:
  - Added lifecycle listeners (`visibilitychange`, `focus`, and `pageshow`) to automatically pull down updates made on other devices (e.g. desktop to mobile PWA) when resuming the app from the background.
- **TMDB API Request Reduction & Global KV Caching**:
  - Eliminated redundant background catalog trailer enrichment calls (/find + /videos), lowering TMDB requests by ~85-95% and significantly accelerating catalog load times.
  - Added 30-day KV caching for TMDB ID and details resolution across all worker nodes.
- **Centered Season Premiere Badge**:
  - Centered the "Season Premiere" badge horizontally at the bottom of poster cards in Airing Next rows and grids.
- **Season Finale Badges on Airing Next Lists**:
  - Automatically identifies when an upcoming episode is the season finale across Trakt, MDBList, Simkl, and custom lists and displays a centered amber "Season Finale" badge.
- **Season Finale Date Badges for Mid-Season Episodes**:
  - Automatically resolves when the season finale will air for mid-season episodes (Episodes 2–9) and displays a centered "Finale: [Date]" badge.
  - Enforced strict suppression of Season Premiere/Finale badges on already-aired episodes (such as past episodes in Continue Watching or Watch History).
- **Poster Badges & Labels Settings Panel**:
  - Added individual on/off toggle controls in Settings for all poster badges (Air Date, Premiere, Finale, Finale Date, Ratings, Providers, Watched), fully synced via Creator Profile.
  - Added "Display Locations" settings to independently enable or disable badges for **Catalogs & Live Preview**, **Dashboard & My Lists**, and **Stremio & Nuvio Catalogs**.
- **Dynamic Badged Posters for Stremio & Nuvio Catalogs**:
  - Implemented `/api/poster-badge` endpoint that embeds Season Premiere, Season Finale, Finale Date, and Upcoming Air Date badges onto catalog poster artwork inside Stremio and Nuvio clients.
- **TMDB Item Details & Badged Poster Click Fix**:
  - Fixed variable scope issue in server-side TMDB details handler that caused `/api/details` to return 404 for series.
  - Enhanced client-side poster click event delegation to ensure clicking anywhere on a badge or poster properly opens show details and cleans compound episode IDs.
- **Continue Watching "See All" Details View & Badge Enrichment**:
  - Fixed Continue Watching "See All" page to ensure it groups by show (displaying one card per in-progress show with the main Show Poster rather than raw episode still thumbnails).
  - Filtered out already-watched episodes from Watch History, corrected header button to "Clear All", and ensured unaired badges display cleanly alongside the red (X) remove button.
  - Enriched Continue Watching items (both dashboard shelf and "See All" page) to automatically display "Season Finale" (e.g. *Silo*) and "Finale: [Date]" (e.g. *Reacher*, *Lanterns*) badges for upcoming unaired episodes.
- **JavaScript Syntax Fix**:
  - Resolved `Uncaught SyntaxError` on client-side template string line breaks.

---

## [1.5.0] - 2026-08-28

### 🌟 Highlights & Major Additions
- **Airing Next Calendars for Trakt, MDBList & Simkl**:
  - Personalized upcoming episode calendar catalogs (`trakt:user:shows:airing-next` and `mdblist:user:shows:airing-next`), complementing existing Simkl Airing Next support.
  - Analyzes watched history and watchlists, dynamically checks upcoming episode air dates via TMDB, and sorts series chronologically ascending.
  - Features real-time schedule badges (*"Airs today"*, *"Airs Friday"*, *"Season Premiere"*).
  - Dedicated interactive schedule modal and Stremio/Nuvio list preview.
- **Modern Light / Dark Mode Toggle**:
  - Replaced legacy toggle with an iOS/Wako-styled animated circular switch.
  - Custom SVG iconography (radiant 8-ray sun in dark mode, fine-stroke crescent moon in light mode).
  - Smooth 360-degree rotational & scale transitions.
  - Dynamic `<meta name="theme-color">` synchronization between `#000000` (dark) and `#F2F2F7` (light) for native mobile status bar adaptation.
- **Automated Multi-Source Poster Fallback Engine**:
  - Automatically recovers missing posters for classic, obscure, or indie titles where TMDB's `poster_path` is empty.
  - Three-tier fallback cascade: TMDB High-Res Backdrops &rarr; IMDb ID via Cinemeta & Metahub &rarr; Cinemeta Title Search.
  - Integrated into `/api/title-search`, client image error handlers, and the catalog rendering pipeline.

### ⚡ Search & Discovery Enhancements
- **Multi-Page Search Results**:
  - Keyword title searches now query and aggregate up to 100 relevant results in parallel instead of capping at 20.
- **Real-Time Search Filter Dropdowns**:
  - Added instant client-side dropdown filters for **Genre** (16 categories), **Release Year** (1980s to 2026), and **Rating** (5.0+ to 8.0+).
  - Added star rating badges (`★ 8.4`) directly onto search result posters.
- **Top 20 Default Category Previews**:
  - Opening the Search tab or switching category chips (**Movies**, **Shows**, **Lists**) immediately displays the current Top 20 trending items or top-rated community lists.
  - Community lists are ranked by Likes descending and Item Count descending; empty lists (0 items) are excluded.

### 🛠️ Watchlist & Catalog Fixes
- **MDBList Watchlist Add & Sync**:
  - Fixed mutation endpoint authentication (`Authorization: Bearer` and `x-api-key`) and payload structure for adding/removing watchlist items.
  - Multi-endpoint probing across `/watchlist`, `/watchlist/items`, `/sync/watchlist`, and custom list IDs.
  - Fixed ID extractor to normalize numeric TMDB IDs, IMDb IDs, and nested media objects so no items are discarded.
- **"See All" Full List Details for Mixed Lists**:
  - Fixed `/api/preview` to preserve `type: "mixed"` and per-item media types, allowing mixed catalogs and watchlists to properly display all movies and TV shows across category tabs.
- **Infinite Pagination Fix**:
  - Fixed recommended movies/shows catalogs in Stremio/Nuvio to return empty arrays once personal recommendations are exhausted, preventing endless 500-page loops into generic charts.
- **Clean Poster Layouts**:
  - Removed duplicate release years under catalog shelves in Live Preview for a cleaner poster presentation.
  - Removed ~170 lines of duplicate code in list management utilities.

---

## [1.4.1] - 2026-08-26

### Improvements & Fixes
- **Simkl Airing Next Simplification**:
  - Streamlined Airing Next candidate resolution into a unified chronological schedule.
  - Fixed `extended=full` query parameter on Simkl sync requests to ensure accurate episode progress tracking.
- **Admin Dashboard Cleanup**:
  - Removed redundant `[Developer]`/`[User]` prefixes when copying feedback threads to the clipboard.
- **MDBList Rate Limit Handling**:
  - Improved HTTP 429 rate limit diagnostics and user-friendly error banners.

---

## [1.4.0] - 2026-08-20

### Major Features
- **Virtual TV Channel Builder**:
  - Create synthetic linear TV channels and scheduled playlists combining hand-picked TV show episodes and movies into a single catalog row.
  - Custom channel poster generation (`/api/channel-poster`) and quick-add channel presets.
- **Letterboxd CSV Import**:
  - Import Letterboxd export CSV files with automated batch resolution of titles and release years into IMDb and TMDB IDs (`/api/bulk-resolve`).
- **Simkl Integration**:
  - Added Simkl trending charts for Movies, TV Shows, and Anime (Daily, Weekly, Monthly) and OAuth account linking.
- **Creator Profiles & Cloud KV Sync**:
  - Passwordless sync across devices using salted SHA-256 Creator Keys (`CRTR-...`).
- **Admin Analytics Dashboard (`/admin`)**:
  - Telemetry console tracking installs, page views, and API usage counters across TMDB, Trakt, MDBList, and Simkl.
- **PWA & Offline Mode**:
  - Service worker caching (`/sw.js`) and Web App Manifest (`/app.webmanifest`) for standalone mobile and desktop installation.
