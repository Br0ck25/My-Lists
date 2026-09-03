# Changes Log

## 2026-09-03b - Airing Next never reached the account when signed in

### Files Changed
`21_client-custom-list-builder.js`, `22_client-creator-profile.js`, `worker_entry_combined.js`, `tests/airing-next-reaches-account.js` (new)

### Root Cause
The earlier fix restored `airingNext` through `sync/load` and stopped an empty push from erasing a stored list, but the account's list was never being written in the first place.

Airing Next is only ever pushed by the refresh that *builds* it - `refreshAiringNext` calls `scheduleTrackingSync()` at the very bottom, and its two early returns did not. That refresh runs from a `setTimeout(..., 600)` on page load, which routinely wins the race against sign-in restoring `activeCreator`. `pushTrackingSync` bails immediately when `activeCreator` is unset, so the push was silently dropped - and the list was now cached locally with a fresh `updatedAt`, so every subsequent load took the freshness short-circuit, recomputed nothing, and pushed nothing. The account stayed empty indefinitely.

This is why the symptom looked so asymmetric: the dashboard card reads localStorage and looked fine, the signed-out Live Preview embeds a `customlist:v1:` snapshot of those same local items and worked, and only the signed-in row - which resolves `autotrack:airing-next:series:<username>` against the server blob - had nothing to serve.

Returning `airingNext` from `sync/load` also introduced a regression that had to be closed at the same time: the field is now always an array (`[]` rather than absent), and `loadCreatorSync`'s restore branch assigned it unconditionally. That would have wiped a list this browser had computed *and* stamped `updatedAt`, making the empty list look fresh so the refresh would skip rebuilding it too.

### What Changed
- **`21`**: the freshness short-circuit in `refreshAiringNext` now calls `scheduleTrackingSync()` before returning. `scheduleTrackingSync`'s own signature guard makes this a no-op when the account already holds this exact list.
- **`22`**: `loadCreatorSync`'s `airingNext` restore now only adopts the account's list when it is non-empty, or when this browser has none. When the account is empty and this browser has a list, it pushes its own up instead. That is also the reliable moment to do it - `activeCreator` is set by definition inside `loadCreatorSync`, so unlike the load-timer path the push cannot be dropped.

### Verification
Full pipeline: byte-consistency 27/27, `node --check`, sandboxed `renderBuilder()`, inner script (7 blocks), CSS balance (460 pairs), 0 backticks in the edited literal files. All 21 behavioural suites pass, including the new `airing-next-reaches-account.js` (5 checks, slicing the real freshness guard and the real restore branch out of the bundle rather than paraphrasing them).

### Note
Existing accounts self-heal on the next page load: `loadCreatorSync` sees an empty account list against a populated local one and pushes it. No manual reset needed.

## 2026-09-03 - Episode stills in Watch History, Discover/catalog recommendation parity, Airing Next in Live Preview

### Files Changed
`00_constants.js`, `05_catalog-core.js`, `18_client-copy-and-trakt-export.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`, `tests/curated-recs-and-derived-lists.js` (new), `tests/episode-stills-and-snapshots.js` (new), `tests/watch-history-grid.js`

### Root Causes

1. **Watch History episodes showing show posters.** A Watch History entry keeps the episode still in `poster` and the series artwork in `showPoster`, and every renderer already reads `poster` first with `showPoster` as fallback. The entries created from TMDB directly (`markShowWatched`, and both scrobble handlers in `26`) fill in the still correctly. The import paths cannot: Trakt's and MDBList's history rows carry no per-episode image, so `mapMdblistItemsToWatchHistory` wrote the show poster into *both* fields. Scrobbled episodes therefore had stills and imported ones never did, which is the "sometimes" in the report. Two of that mapper's three branches additionally wrote `epNum` instead of `episodeNum` and omitted `showPoster` entirely, so those entries had no episode number for any reader to match on.

2. **Discover cards said 40 items, the catalog row served 100.** Two independent code paths built the same list with different caps. `/api/recommendations` (`25`) ended with `.slice(0, 40)`, and that array is what `buildCuratedRecommendationCard` counts. Adding the card writes `custom:curated:recommended-movies`, which `detectSource` routes to `fetchCuratedCatalog` (`05`), which rebuilt recommendations from scratch and sliced with `PAGE_SIZE` (100). They also disagreed on *content*: the card seeds from the browser's full picture (Continue Watching + Watch History + Watchlist + every other custom list, 12 ids), while `fetchCuratedCatalog` could only see server-side tracking (10 ids, and for movies only `watchHistory`).

3. **Airing Next reporting "No items found" in the Live Preview.** Two halves of one data-loss chain. `/api/creator/sync/load` (`26`) merged the tracking blob into its response but never set `data.airingNext`, so `loadCreatorSync`'s own restore branch (`22`, which checks `Array.isArray(synced.airingNext)`) was unreachable and a browser signing in never received the account's list. `pushTrackingSync` always sends the full local array, so that browser's next autosave pushed `airingNext: []`, and `save-tracking` wrote it verbatim - overwriting the real list. The catalog row and the Live Preview then legitimately had nothing to serve, while another browser's dashboard still showed items from its own localStorage. Separately, the generic `localListAddToConfigBtn` handler (`22`) embedded a list's items into a `customlist:v1:` snapshot untouched; `fetchCustomListCatalog` drops any item without an `imdbId`, and Airing Next items are keyed by `showId`, so such a snapshot rendered empty despite containing real data.

### What Changed

**Episode stills (`18`, `21`)**
- New `backfillWatchHistoryEpisodeStills()` in `21`: walks Watch History for episode entries displaying series artwork (no poster, poster identical to `showPoster`, or a metahub poster URL - metahub only ever serves show artwork), groups them by show + season, and fills in the real still from the existing `/api/season` endpoint. One request per show+season rather than per episode, capped at 12 groups per run with concurrency 3, and seasons that resolved are recorded in `myListAddon:episodeStillChecks` so they are not re-fetched for a week. A failed fetch is deliberately *not* recorded, so a network blip does not write a season off. Episodes whose season genuinely has no still on TMDB keep the show poster, which is the intended fallback.
- Kicked at +1400ms on load (after the Airing Next refresh, which is the more urgent of the two) and directly from `addItemsToWatchHistory`, since imports are the only source of affected entries.
- Fixed `epNum` -> `episodeNum` and added the missing `showPoster` in both affected branches of `mapMdblistItemsToWatchHistory` (`18`).

**Recommendation parity (`00`, `05`, `19`, `22`, `25`, `26`)**
- New shared `CURATED_RECOMMENDATION_LIMIT = 40` in `00`, used by both `/api/recommendations` and `fetchCuratedCatalog` so the two cannot drift apart again.
- The Discover tab now persists exactly the list it rendered (`persistCuratedRecommendations`, `22`; called from `19`) and `pushTrackingSync` carries it up with the rest of the tracking data - the same snapshot approach Airing Next already uses, and the only way the catalog row can hold the same items as a card built from browser-side inputs the server cannot see. Writes are signature-gated so re-rendering Discover does not force a push.
- `fetchCuratedCatalog` prefers that snapshot via the new `mapStoredRecommendationToMeta`, resolving each entry's IMDb id so the row carries ids stream add-ons can use. Falls through to live derivation if the snapshot resolves to nothing. The derivation path is now capped at the shared limit rather than `PAGE_SIZE`.
- Side effect worth noting: the snapshot path drops this row's per-request fan-out from roughly 120 subrequests (10 find + 10-20 recommendations + up to 100 external_ids) to about 41, bringing it back under the 50-subrequest free-tier ceiling.
- `/api/recommendations` now returns each item's `tmdbId` so the list can round-trip.

**Airing Next / derived lists (`22`, `26`)**
- `/api/creator/sync/load` now returns `airingNext` and `curatedRecommendations`, making `loadCreatorSync`'s restore branches reachable.
- `save-tracking` no longer lets an empty incoming `airingNext` or `curatedRecommendations` replace a non-empty stored one. Placed inside the existing `!intentionalRemoval` guard, so a deliberate Clear Watch History still commits.
- New `normalizeSnapshotItemsForCatalog` (`22`) fills in a missing `imdbId` from `showId`/`id`/`tmdbId` before a list is embedded in a `customlist:v1:` snapshot, without disturbing items that already have one (`kind`/`type` in particular round-trip untouched, since `fetchCustomListCatalog` reads them to sort items into movie or series rows).

### Verification
Full pipeline run: byte-consistency 27/27, `node --check`, sandboxed `renderBuilder()` execution, inner script check (7 blocks), CSS brace balance (460 pairs), template-literal hazard scan (0 backticks in the edited files 18/19/21/22). All 19 pre-existing behavioural suites pass, plus two new ones: `curated-recs-and-derived-lists.js` (19 checks against mock KV + mock TMDB, covering the caps, snapshot ordering, the empty-push guard, the intentional-clear path, `sync/load`, and both Live Preview endpoints end to end) and `episode-stills-and-snapshots.js` (26 checks). `tests/watch-history-grid.js` had its slice start marker moved, since `trackingSyncSignature` now folds in `curatedRecsSignature` and no longer runs sliced alone.

### Not Changed
- `23_client-list-management.js:1642` also uses an `epNum` field with `poster: it.showPoster || it.poster`, but that is the TV Channel preview's own item shape, where showing series artwork is deliberate. Left alone.
- Content parity for recommendations holds once Discover has been opened on an account. Before that, the row falls back to the server-side derivation, which is capped identically but seeded from tracking data only.

## 2026-09-02 — Fix Continue Watching posters on dashboard and Trakt Watch History movies in See All

### Files Changed
`04_config-resolution.js`, `06_source-fetchers-mdblist-trakt.js`, `22_client-creator-profile.js`, `23_client-list-management.js`, `worker_entry_combined.js`

### Root Causes
1. **Continue Watching dashboard posters missing**: `buildLocalListCardHtml` and `buildServerListCardHtml` filtered preview posters strictly with `it.showPoster || it.poster`. When items in `continue-watching` were saved without an explicit `showPoster` string (carrying only `showId` / `imdbId` / `id`), they were filtered out on the dashboard card, whereas "See All" dynamically generated `https://images.metahub.space/poster/medium/${showId}/img`.
2. **Trakt Watch History movies missing in See All**:
   - `detectSource` did not match full user URL shapes like `https://trakt.tv/users/<username>/history`, causing it to fall through to public list lookups.
   - When switching to the "Movies" pill inside `switchListDetailsType`, `isDualTypeChart` did not treat `trakt:history` as a multi-type provider list, preventing it from requesting `/api/preview` with `type: 'movie'` (which hits `https://api.trakt.tv/users/me/history/movies`).
   - `mapTraktHistoryItems` strictly required `it.movie.ids.imdb`, dropping movies with other ID shapes or top-level movie mappings.

### What Changed
- **Dynamic poster fallback on dashboard cards (`22`)**: Added `resolveItemPoster` to `buildLocalListCardHtml` and `buildServerListCardHtml` to fall back to `https://images.metahub.space/poster/medium/${showId}/img` whenever `showPoster`/`poster` is not explicitly stored on the item.
- **Enhanced Trakt/MDBList history source detection (`04`)**: Added full user URL regex matching for `trakt-watchlist`, `trakt-history`, `mdblist-watchlist`, and `mdblist-history`.
- **Robust Trakt history mapping (`06`)**: Updated `mapTraktHistoryItems` to safely resolve movie, episode, and show IDs across TMDb and IMDb formats.
- **Provider-aware type switching in See All (`23`)**: Added `isExternalProviderList` handling in `switchListDetailsType` and `openListDetailsPage` so switching between `All`, `Movies`, and `Shows` re-fetches provider-specific history streams.

## 2026-09-02 — Fix Trakt / external Watch History opening local dashboard history on See All

### Files Changed
`06_source-fetchers-mdblist-trakt.js`, `23_client-list-management.js`, `worker_entry_combined.js`

### Root Cause
When clicking "See All" on the "Your Trakt Lists" Watch History card, `openListDetailsPage('Watch History', 'mixed', 'trakt:history')` was invoked. Inside `openListDetailsPage`, `isWatchHistory` was evaluated as:
`const isWatchHistory = (name && name.toLowerCase().includes('watch history')) || (listUrl === 'autotrack:watch-history' || listUrl === 'custom:watch-history');`
Because `name` was "Watch History", this condition evaluated to `true` even when `listUrl` was `'trakt:history'`. As a result, the function bypassed fetching from Trakt via `/api/preview`, loaded the local browser/dashboard watch history from `loadLocalCustomLists()['watch-history']`, and called `renderWatchHistoryGrid()`.

### What Changed
- **Disambiguated Local vs External Watch History in `openListDetailsPage` (`23`)**: Explicitly separated external history list URLs (`trakt:history`, `mdblist:history`, `simkl:user:...:history`) from local custom list / autotrack history (`custom:watch-history`, `autotrack:watch-history`, or empty `listUrl`).
- **Guarded `renderWatchHistoryGrid` (`23`)**: Prevented `renderWatchHistoryGrid` from executing if the active list parameters point to an external history URL.
- **Fixed `addBtn.onclick` fallback (`23`)**: Ensured slug resolution only falls back to list name when `!listUrl`.
- **Added mixed-type support to Trakt History fetcher (`06`)**: Updated `fetchTraktHistory` and `mapTraktHistoryItems` to support `mixed` content types (interleaving movies and episodes chronologically).

## 2026-09-02 — Sign-out actually clears the account, and a Reset Account Data button

### Files Changed
`22_client-creator-profile.js`, `24_client-backup-restore-presets.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`

### Root cause of the sign-out bug
`clearLocalAccountData` looked thorough — it wiped every `myListAddon:` key from localStorage, cleared the tokens, and re-rendered. But `saveLocalCustomListsMap` mirrors the custom-lists map into **sessionStorage** as a fast backup, and `loadLocalCustomLists` reads it in this order:

```js
if (_memoryCustomListsObj) return _memoryCustomListsObj;
let str = _memoryCustomListsString;
if (!str) { str = sessionStorage.getItem(LOCAL_CUSTOM_LISTS_KEY); }
if (!str) { str = localStorage.getItem(LOCAL_CUSTOM_LISTS_KEY); }
```

**sessionStorage is read before localStorage, and sign-out never touched it.** So it cleared the slower copy and left the one that actually gets read. The very next render pulled the signed-out account's Watch History, Continue Watching, Watchlist, Airing Next and every Custom List straight back.

Three smaller leaks alongside it:

- `cachedPresetsMap` (`24`) is what `loadPresetsMap` falls back to when storage is empty — precisely the state sign-out creates — so the previous account's presets survived the sign-out that had just deleted every key they came from.
- The watch-badge index (`_watchedItemIds`, `_rawWatchHistoryItems`, `_inProgressShowIds`) was left populated, so the previous account's watched ticks kept appearing on posters.
- `window._dismissedContinueWatching` was reset to `new Set()`, but it is read everywhere else as a plain object (`Object.keys(...)`, lookups by show id). Sign-out was leaving behind a value nothing could use.

### What changed — sign-out
- **sessionStorage is cleared** with the same key filter used for localStorage. This alone fixes the reported bug.
- `resetPresetsCache()` added in `24` and called from `clearLocalAccountData`.
- The watch index, raw history, in-progress set, `_currentItemDetails`, `_episodeDataCache` and `_currentListDetailsAllItems` are all reset, and the poster render caches invalidated.
- `_dismissedContinueWatching` is reset to `{}`, matching how it is read.
- Navigation state (`activeTab` and the submenu keys) is still preserved, as before.

### What changed — Reset Account Data

**New endpoint `POST /api/creator/account/reset`** `{ creatorName, creatorKey, confirm: "RESET" }`. Empties an account back to how it looked when it was created **without deleting it**: the `creator:<u>` record, its key hash and its recovery answer are untouched, so the same Creator Name and Key keep working and the person stays signed in.

- Deletes every `creatorlist:<u>:*` key, **paging through the cursor** rather than assuming one `list()` call covers an account that may have hundreds. Verified against 120 lists.
- Deletes `creatorsync`, `creatorsynctracking`, `creatorsyncpresets`, `creatorsyncchannels`, `creatorlistorder`, `creatorscrobblequeue`, `creatorlistlikes`, `creatorlikes`, plus the legacy `creatortrack` / `creatorpresets` / `creatorchannels` names.
- Clears the matching D1 rows.
- Requires `confirm: "RESET"` in the body on top of key authentication. The key alone authenticates, but this is irreversible with no undo, so it should not be reachable by a stray request.

**Client (`22`)** — a Reset Account Data entry in the Settings danger zone, above Delete Account, with its own confirmation dialog.

**Ordering, which matters:** local state is cleared **first** and the server call made **second**. The reverse leaves a window where the browser still holds the old lists, and any autosave, scrobble ping or background sync landing in that window would push them straight back up to the account that was just wiped. This way the worst case is a browser that has forgotten data the server still holds — recoverable by signing in again — rather than a reset that silently undoes itself.

For the same reason `window._suppressCreatorSync` is set for the duration and is now **honoured by all four push paths** (`pushCreatorSync`, `pushTrackingSync`, `pushChannelsSync`, `pushPresetsDirectly`). Setting a flag nothing reads would have been worse than not setting one.

Since `clearLocalAccountData` signs the person out as a side effect, the handler restores the session afterwards using the same three keys sign-in writes (`creatorName`, `creatorDisplayName`, `creatorKey`) — not an `activeCreator` blob, which nothing reads.

### Noticed while working here, not changed
`/api/creator/delete-account` deletes `creatorprofile:`, `creatortrack:`, `creatorpresets:` and `creatorchannels:` — **old key names this codebase no longer writes.** The live data is under `creator:`, `creatorsynctracking:`, `creatorsyncpresets:` and `creatorsyncchannels:`, so that endpoint currently leaves most of an account's data behind after a "permanent" deletion. The new reset uses the names actually in use plus the legacy ones. Deleting more on the delete-account path is a separate decision (and arguably a privacy issue), so it is flagged rather than quietly changed.

### Verification
Fourteen pipeline checks (one new), plus every earlier phase's suite as regression. All green.

- Split/combined 27/27; `node --check` OK; renderBuilder 1,666,095 chars; 7 script blocks, 460/460 CSS braces, 8 placeholders — unchanged. No backticks introduced.
- **New check 8d** — asserts `clearLocalAccountData` clears sessionStorage and localStorage, resets the watch index and raw history, and calls `resetPresetsCache`; and that all four push functions reference `_suppressCreatorSync`. That is what catches a fifth push path being added later without the guard, or the sessionStorage clear being dropped.
- Rendered HTML diff +134 / -2; both removals reviewed (the danger-zone container that now has a sibling, and the `new Set()` line).

**Account reset suite, 33 assertions.** 120 lists cleared across multiple `list()` pages; all eleven data keys cleared; the profile record, key hash, recovery answer and `createdAt` all unchanged; **the same key still authenticates after the reset**; another account's profile, lists and sync are untouched. Guards: a missing confirmation and a wrong confirmation string are both refused with 400 and **nothing is deleted**; a wrong key is refused with 401 and nothing is deleted; an unknown account is refused. Afterwards the account reads as *empty rather than broken* — `/api/creator/lists` returns ok with zero lists and `sync/load` returns ok with an empty config.

**Sign-out suite, 24 assertions.** With the map seeded into **both** localStorage and the sessionStorage mirror: the mirror is cleared, and `loadLocalCustomLists()` returns `{}` — asserted individually for Watch History, Continue Watching, Watchlist, Airing Next and a custom list, since those are the five the report named. Channels, presets and the creator key are cleared while navigation state survives. In memory: the watch index, raw history, index length, fully-watched and in-progress sets are all emptied; tokens cleared; `_dismissedContinueWatching` is an object and not a Set; the presets cache and poster caches are reset. Signing out twice does not throw.

## 2026-09-02 — Large Watch Histories: removing the per-poster history scan and the whole-document re-badge

### Files Changed
`21_client-custom-list-builder.js`, `worker_entry_combined.js`

### Root cause
Reported as: smooth for new users, laggy and glitchy once a watch history passes ~1,000 items. Two things compounded, and both scale with history length rather than with anything visible.

**1. `computeWatchBadgeState` scanned the entire watch history, per poster.** After its `Set` lookups missed it fell through to:

```js
if (Array.isArray(window._rawWatchHistoryItems)) {
  const isW = window._rawWatchHistoryItems.some((it) => { ... });
```

Most posters on a page are *not* watched, so that fallback ran for nearly all of them. A 1,200-poster page against a 1,200-item history is 1.44 million comparisons in a single pass. Measured: **754ms for 2,000 unwatched posters against a 2,000-item history**, on desktop V8.

**2. A `MutationObserver` on `document.body` re-ran that for every poster on every mutation.** The callback did a whole-document `querySelectorAll('.clickable-poster, .clickable-episode')` — not just what changed — with no debounce, and its own badge insertions were themselves mutations inside the observed subtree, scheduling further passes.

**Phase 1's chunked grid renderer made this materially worse.** `renderPosterGridChunked` appends 60 cards per animation frame; the previous single `innerHTML` assignment was *one* mutation batch, and chunking turned it into ~20, each triggering a full-document pass over a grid that keeps growing. Better first paint, far more total work. The right thing would have been to check what was observing the DOM before changing how it is mutated.

### What changed

1. **`watchedIndexKeysFor(it, details)`** — one place that knows every key a history item can be looked up by. The permutations were previously spelled out separately in three places (the initial index build and both halves of `toggleWatchStatus`), and the linear scan existed as a safety net for whatever they missed.

2. **A genuinely missing permutation, now indexed.** A show is stored sometimes as `tmdb:123` and sometimes as `123`, while the poster on screen may carry either form in `data-show-id`. The scan handled this by comparing against `'tmdb:' + sid`; the set did not. Both directions are now indexed and both are checked, so the new lookup is a **superset** of what the scan matched — verified, not assumed.

3. **The linear scan is gone.** `computeWatchBadgeState` is now set lookups only.

4. **`ensureWatchedIndexFresh()`** — the scan also quietly covered the case where the history array changed without the set being updated alongside it. Still worth guarding, just not once per poster: a length change triggers a rebuild, checked once per frame.

5. **The observer collects mutation records and drains them once per animation frame, walking only `addedNodes`.** Badge insertions still re-enter, but an inserted overlay contains no posters, so that pass finds nothing and costs nothing. Work per frame is proportional to what just appeared.

6. **`_badgeExistingPosters()`, called on every index rebuild.** The old observer's whole-document rescan incidentally covered watch state changing *after* posters were on screen — history arriving from the account mid-session, for instance. Now that the observer only looks at nodes as they are added, that case needed saying out loud rather than relying on a side effect. One pass over what is visible, not one pass per poster per mutation.

### Result
- **Badge lookup: 754ms -> 1.39ms** for 2,000 unwatched posters against a 2,000-item history. **543x.**
- **Observer: ~12,600 element visits -> 1,200** while appending a 1,200-poster grid in 20 batches. Linear in what was added rather than quadratic in page size.

### Verification
Thirteen pipeline checks (one new), plus every earlier phase's suite as regression. All green.

- Split/combined 27/27; `node --check` OK; sandboxed `renderBuilder()` 1,658,098 chars; 7 script blocks, 460/460 CSS brace pairs, 8 unresolved placeholders — unchanged.
- Symbol audit: three new symbols defined once and used. No backticks introduced.
- **New check 8c** — asserts `computeWatchBadgeState` contains no iteration over `_rawWatchHistoryItems`, and that the observer body contains no `document.querySelectorAll`. This is what catches either regression being reintroduced later.
- Rendered HTML diff +173 / -61; all 61 removals reviewed and confirmed to be the linear scan, the two duplicated index builders, and the old observer body.

**Badge index suite, 9 assertions.** The central one runs the **original linear predicate verbatim as an oracle** against 1,500 randomised probes — elements drawn from the same id space, exercising both `tmdb:`-prefixed and bare show ids, matching and non-matching. Result: 300+ agreed matches, **zero cases where something previously badged is now missed**, and every disagreement is the new index matching *more* (the id-spelling case the scan handled but the set did not). Plus: the freshness guard rebuilds on a length change; both `tmdb:` normalisation directions resolve; and the cost comparison above.

**Observer suite, 7 assertions.** Driven against a minimal DOM with a real `MutationObserver` shim: appending 1,200 posters in 20 batches costs 1,200 element visits against ~12,600 for the old whole-document rescan; watched posters get a badge and unwatched ones do not; an inserted overlay costs <= 2 visits; 50 separate mutation callbacks collapse to **one** animation frame; a node detached before the frame runs is skipped.

### On the alternative that was proposed
The suggestion was to load only the last 100 watch-history items on the dashboard, show the true count, and load the rest on scroll in See All. The dashboard half is already in place — `buildLocalListCardHtml` does `.slice(0, 9)` and renders `totalCount` from `itemCount`. The See All half would have reduced the poster count linearly while leaving the per-poster history scan intact, which against quadratic behaviour moves the cliff from ~1,000 items to perhaps ~3,000 rather than removing it.

Windowing See All is still worth doing as a **DOM-size** measure — 1,200 cards is roughly 10,000 nodes and real memory on a mid-range phone — and `renderPosterGridChunked` already appends progressively, so turning it into render-on-scroll is a small change to one function. It is deliberately left until after this lands, so it can be judged on whether the lag is actually still there.

## 2026-09-02 — Recovering Custom Lists a Browser Has Lost (server -> local backfill)

### Files Changed
`22_client-creator-profile.js`, `worker_entry_combined.js`

### The question this answers
After the previous session, a signed-in user whose localStorage write failed had their data saved to the account — but did it ever come back? Checking rather than assuming: **no.** The reconciliation in `renderCreatorDashboard` was:

```js
if (localMapForCreator[slug] && rowPayload.items.length > (localMapForCreator[slug].items || []).length) {
```

Two things about it. It only ever flowed **row -> server** and **row -> local**, never **server -> local**. And it iterates the rows currently in the page, so a list that had disappeared from localStorage entirely was never even considered. The `localMapForCreator[slug] &&` guard meant a vanished list could not be restored even in principle.

So the dashboard would render a list from the server response while the local map — which is what catalog rows, See All and editing all read — stayed empty. The account had the data; the browser never got it back.

### Why a backfill and not server-authoritative mode
The plan's Tier 2 was to make the server authoritative at runtime: read the account first, demote localStorage to a cache. That closes this hole plus a theoretical one, at roughly twenty times the regression surface — a new endpoint, per-list writes, and converting ~15 consumers (several synchronous) across the See All and Edit paths that have produced bugs before.

The gap is narrower than that. The data is already in the response the dashboard just fetched; it costs nothing to put it back. **The condition that would change this call:** reports of signed-in users still losing lists after this, which would mean the cache model itself is diverging in ways a backfill cannot catch. Tier 2 is held as a contingency, not a plan.

### What changed

1. **`backfillCreatorListsIntoLocalMap(serverLists)`** — runs immediately after the existing reconciliation, using `data.lists` the dashboard already has. Deliberately narrow:
   - **Add-only.** It restores a list that is *entirely absent* and never merges items into one that exists, because a local copy may legitimately be ahead of the server (an edit made offline) and picking a winner there is a different problem with a different right answer.
   - **Identity-aware.** `localMapHasList` matches the way the delete paths look a list up — a local entry can be keyed by its map key while carrying the slug under `slug`, `creatorSlug`, `localSlug` or `listSlug`. Without this it would happily create duplicates.
   - **Skips the auto-tracked slugs** (`watchlist`, `watch-history`, `continue-watching`, `airing-next`). Those are generated locally from watch state; writing a server copy over them would fight the tracking code for control of the same slug.

2. **Deletion tombstones** — `recordCreatorListDeletion(slug)` writes to `myListAddon:deletedCreatorLists`, and the backfill skips any slug it finds there.

   This is the whole risk of the feature, and it is a bug this project has had once already (presets/import resurrecting deleted Custom Lists). Of the two delete paths, one waits for the server and bails on failure — safe. **The other removes the list locally and fires the server delete without waiting (`.catch(() => {})`).** If that request never lands, the list survives on the account while being gone locally, which is exactly the shape the backfill reads as "lost". So the tombstone is recorded **at request time, before the server confirms**, at both sites.

3. **Tombstones expire after 24 hours** and are pruned on read. Keeping them forever would mean a list deleted a year ago could never be recovered from the account if the browser cache were later lost for an unrelated reason.

### Verification
Twelve pipeline checks (one new), plus every earlier phase's suite as regression. All green.

- Split/combined 27/27; `node --check` OK; sandboxed `renderBuilder()` 1,653,879 chars; 7 script blocks, 460/460 CSS brace pairs, 8 unresolved placeholders — all unchanged.
- Phase 2 regressions: cache tier 17/17, TMDB callers 18/18.
- Symbol audit: all three new symbols defined once and used.
- **New check 8b** — scans the rendered page for every `/api/creator/lists/delete` call site and asserts a tombstone is recorded before the request. 2/2 guarded. This is the check that would catch a future third delete path being added without the guard.
- **Rendered HTML diff: +120 / -0.** Nothing was removed, which is the right shape for a change that only adds a recovery path.

**Backfill suite, 19 assertions.** The case it exists for: two lists missing locally are restored with items intact, `creatorSlug` set so later lookups match, name and type preserved. Then the negative cases, which matter more:

- **A tombstoned list is NOT restored** — simulating the exact failure the guard is for: delete removes it locally, the server delete never lands, the list is still in `data.lists`. Nothing comes back and the map stays empty.
- A 25-hour-old tombstone no longer blocks recovery, and is pruned.
- An existing local list is never touched: a server copy with 99 items does not overwrite a local one with 2, and **no write happens at all**.
- A list stored under a different map key but carrying `creatorSlug` is recognised, not duplicated.
- `watchlist` / `watch-history` / `continue-watching` / `airing-next` are skipped while a real list alongside them is restored.
- Empty, null and malformed server payloads are no-ops that write nothing.
- Corrupt tombstone JSON does not break the backfill.
- Repeated dashboard renders write once, not every time.

### Not done
- **Server-authoritative mode** — see above. Still available, now with a much weaker case for it.
- **Storage meter in Settings**, so a person can see this coming rather than discover it afterwards.
- **Live row URLs still embed their items** (the install-link size issue) — unchanged, and still needs its own decision about gating on KV availability.
