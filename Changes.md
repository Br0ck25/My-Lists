# Changes Log

## 2026-09-21 - Better Posters (btttr.cc) integration

### Files Changed
`00_constants.js`, `02_http-and-creator-utils.js`, `04_config-resolution.js`, `05_catalog-core.js`,
`09_page-shell.js`, `15_tab-settings-html.js`, `22_client-creator-profile.js`,
`23_client-list-management.js`, `25_api-catalog-routes.js`, `worker_entry_combined.js`,
`tests/better-posters.test.mjs`, `CHANGELOG.md`, `Changes.md`, `README.md`, `FUNCTION-MAP.md`

### The request

Integrate [BetterPosters](https://btttr.cc/) as replacement catalog artwork, behind a setting users can
turn on. `StrayBer/nuvio-better-posters-addon` was flagged as possible code to reuse.

### What was reusable from the reference project, and what was not

That project is a **wrapper add-on**: it takes somebody else's manifest URL, proxies their catalog and
meta responses, and rewrites the posters on the way through. Roughly 1,100 of its ~1,190 lines are that
proxy (`upstreams.js`, `fetch-handler.js`, `config.js`, `server.js`) and none of it applies here -- this
add-on builds its own catalogs, so it can rewrite posters at the point it assembles a meta instead of
re-fetching somebody else's. The genuinely reusable part was `posters.js`, about forty lines, and two of
its choices did not survive review:

1. **The style path was wrong.** It hard-codes `/poster/imdb/poster-default/{id}.jpg`. Checked against the
   live service, the `poster-default` segment is inert -- `poster-nologo`, `poster-textless` and an
   outright nonsense value all return byte-identical bytes. The style actually lives in the **first**
   segment (`poster`, `poster-g`, `poster-r`, `poster-n`, plus `q`/`a` flags), which is what btttr.cc's
   own configurator varies in its "AIOMetadata / Other Addon" mode. Nine bases were confirmed to return
   nine different images. Following the reference would have shipped default artwork with no way to
   change it.
2. **Scraping `meta.poster` for an IMDb id is unsafe here.** Its `findImdbId` falls back to the poster
   URL. Several posters this add-on builds carry the id in a query string
   (`/api/poster-badge?poster=...&id=tt...`), so an already-badged poster would look like a plain IMDb
   title and get sent back through BetterPosters, losing the badge. `betterPostersImdbId` reads the id
   fields only.

### The fix

`applyBetterPostersToMetas` (`05_catalog-core.js`) sits in `fetchCatalog` alongside the existing
`applyBadgedPostersToMetas` / `applyAdultContentFilterToMetas` passes, as the same kind of 1:1 poster-URL
map. Ordering is the load-bearing detail: it runs **before** the badge pass, because a badge wraps
whatever poster URL it finds into `/api/poster-badge?poster=...`. Running it second would throw the
BetterPosters artwork away; running it first means a badged poster is a badge drawn over BetterPosters
art. The adult-content filter still runs after both and still wins, so nothing about poster safety
changes. A mutation test (swapping the two passes) was used to confirm the ordering assertion actually
bites.

The search catalog and the `/meta/` detail route assemble metas without going through `fetchCatalog`, so
both call the same helper directly -- otherwise search results and title pages would be the two surfaces
still serving the old artwork.

`dedupeAcrossListEntries` deliberately does **not** get the flag, matching the existing reasoning in its
own comment: it only needs to know which ids come back, and a poster rewrite never changes that.

### Settings

`betterPosters` plus seven style keys, following the `showBadgesStremio*` pattern end to end (config
resolution in both the KV and base64-in-URL paths, `collectKeys`, `buildConfig`, the settings panel, and
the Creator Profile sync restore). The master switch defaults **off** -- so `getBadgeSetting`, which
treats an absent value as on, is not reused; `getBetterPostersSetting` takes a per-key default instead.
Style keys are only written into the install link when they differ from btttr.cc's default, so a config
with the feature off grows by nothing and a default-style config grows by one key.

Landscape tiles are skipped: BetterPosters only renders 2:3 artwork, and a TV Channel's 16:9 banner would
be squeezed. `tt0000000`, the placeholder id used for a temporarily-unavailable list, is skipped too.

### Second pass: the whole website, not just the add-on's responses

The first pass rewrote posters server-side only, so the website's own surfaces still showed the plain
artwork. Extending it turned out to be small, because the client already funnels every poster through one
function: `resolveClientPoster` (`19_client-search-and-likes.js`). Twelve call sites reach it directly and
the rest arrive via `resolveListCardItemPoster` (17, 8 sites), `resolveItemPoster` (22, 4 sites),
`livePreviewPosterHtml` (23), `renderMediaCard` (16) and `loadPosterSlot` (19). Adding the rewrite inside
it -- after the Adult Content Filter's early return, so the filter still wins exactly as it does
server-side -- covered Live Preview, My Lists, creator profiles and the Discover/Search list-card strips in
one edit.

The client mirror of the URL builder sits next to it. It uses **no regex at all**, on purpose: this file's
text passes through `09_page-shell.js`'s outer template literal, which eats one round of backslash escapes,
so every `\\d` would have to be written doubled (see `parseListSearchIntent`'s own comment). Plain string
scanning sidesteps the trap. The same constraint bit once during this work -- a backtick inside a code
comment terminated the outer template literal and broke the entire bundle; `node --check` on the combined
Worker caught it immediately, which is exactly the blind spot that check exists for.

The remaining sites that did not reach the funnel were routed through it: Discover/curated list-card tiles,
the title details modal's hero poster, search result cards (resolved once so the tile and the `data-poster`
the modal reads back agree), Custom List Builder picks, Channel Builder show/spotlight/credit results,
storyline cards, and the per-row Test button's thumbnail strip. Deliberately left alone: **episode stills**
(a screenshot of that episode, not a poster the show's artwork could stand in for), **season posters** (a
season's own artwork -- BetterPosters has no season concept, so every season would look identical), and
**TV Channel logos/banners**, which the add-on generates itself.

Switching the setting needs no refetch: posters resolve at render time and nothing writes the resolved URL
back onto the item, so the original is always still there when the setting goes off again.
`refreshBetterPostersSurfaces` just re-renders.

### Third pass: the feature never actually reached Stremio or Nuvio

Reported after the fact: Better Posters showed nothing in the apps. The cause was neither the URL builder nor
the catalog wiring, both of which were right -- it was the install link.

`/api/save` (`25_api-catalog-routes.js`) stores the config a short install link points at, and it builds that
payload from an **allowlist** of body fields rather than passing the body through. The POST body `generate()`
(`24_client-backup-restore-presets.js`) sends it is an allowlist too. `betterPosters` was named in neither, so
it never left the browser and was never stored; `resolveConfig` read it back as `false` and served plain
artwork. Because a CONFIGS KV namespace is bound on any normal deployment, that is the path essentially every
install takes -- only the base64 fallback link (no KV, or a failed save) carried the setting, which is why the
website looked correct while every app did not.

The setting's other five legs were all wired correctly (`collectKeys`, `buildConfig`, `decodeConfig`,
`resolveConfig`, `fetchCatalog`), which is exactly what made this easy to miss: the sixth leg is a pair of
allowlists that fail silently and are only exercised by the real round trip.

**Why the tests did not catch it.** Every earlier server-side test seeded KV directly --
`kv.put(cfgId, JSON.stringify({ betterPosters: true, ... }))` -- which writes the config *past* both
allowlists. The new tests POST to `/api/save` and then request the catalog from the id it returns, so the
allowlists are on the path. Both halves are mutation-tested: reverting the server fix fails three of them,
reverting the client fix fails the two client ones.

The save endpoint also now validates `betterPostersLang` / `betterPostersRatingSource` against btttr.cc's
accepted values before storing them. It is unauthenticated and the value ends up interpolated into a URL, so
persisting something the service would reject has no upside.

### Two pre-existing poster bugs this pass exposed

1. **`renderMediaCard` (16) short-circuited past the funnel.** `item.poster || resolveClientPoster(...)`
   only called the funnel when there was no poster to use -- so every card with artwork skipped it, and the
   **Adult Content Filter never applied to any of them** (search result cards, Custom List picks, Channel
   Builder picks). Now always resolved. Mutation-tested: restoring the old expression fails two tests,
   including one specifically for the adult filter.
2. **A filtered adult poster leaked through `data-poster` in the Live Preview.** `livePreviewPosterHtml`
   assigned its resolved poster onto the item (`m.poster = ...`), and the card's `data-poster` -- what the
   poster modal reads back -- picked up the safe URL from that side effect rather than on purpose. De-
   mutating (required so a Better Posters URL cannot stick after the setting is switched off, with no
   original left to restore) surfaced it; the attribute now uses the resolved value explicitly. The
   existing test at `tests/client.test.mjs:3545` caught this the moment the mutation was removed.

### Verification

34 tests (`tests/better-posters.test.mjs`): the nine style bases against the strings btttr.cc's
configurator emits, query-parameter defaults and validation, id resolution (including the episode-id and
poster-scraping cases), and three end-to-end tests through the real Worker proving the stored setting
reaches `fetchCatalog`, that style options reach the URL, and that a badge layers over BetterPosters art.
Generated URLs were also confirmed to return HTTP 200 with distinct artwork from the live service. Full
suite green (1,050 passing), plus `verify.sh` steps 3b/4/4b/4c/4d.

The website half adds eleven tests that run the real client bundle through `tests/client-harness.mjs`:
the setting off and on, the style options producing the same URL the Worker does, episode-id resolution,
the Adult Content Filter still winning, generated add-on artwork left alone, landscape tiles and episode
stills left alone, idempotence when the helper is handed its own URL back, and both shared renderers
(`livePreviewPosterHtml`, `renderMediaCard`) -- including that the item object is not mutated.


## 2026-09-21 - Customize button on Discover and Search lists

### Files Changed
`19_client-search-and-likes.js`, `21_client-custom-list-builder.js`, `worker_entry_combined.js`,
`tests/client.test.mjs`, `CHANGELOG.md`, `Changes.md`

### The request

After seeing the Storylines & Universes grid's own **Customize** button (which loads a saga's items into
the Channel Builder's editable draft before adding it), the ask was to give every list on Discover --
every sub-tab, not just one -- and every list Search turns up the same button.

### The fix

A saga is built episode by episode for a 24/7 channel; a Discover or Search list is just a plain catalog
of movies or shows. So rather than reusing the Channel Builder, **Customize** on these lists loads the
list's items into the **Custom List Builder**'s draft instead (`loadListToCustomListDraft`,
`21_client-custom-list-builder.js`) -- add, remove, reorder, then Save -- which is what these lists
actually are. This is deliberately different from the existing **+ Add** button and the My Lists panel's
"Copy to Custom List" buttons (`copyListToCustomList`, `18_client-copy-and-trakt-export.js`), both of
which copy a list in as-is with no chance to edit first.

Uses the same bounded preview fetch (`fetchPreviewForSlot`, up to ~100 items per type) already filling
each card's own poster strip, not `copyListToCustomList`'s exhaustive full-list fetch -- a hand-edited
draft is for curating a short list, and a shelf like TMDB Trending can run into the thousands of items.

Every Discover sub-tab (All, Movies, Shows, Popular Lists, Hidden Gems, Kids, Holidays, Genres) renders
through one shared function, `render5PosterListsFeed` (`19_client-search-and-likes.js`), so adding the
button there covers all of them at once; Curated (`buildCuratedRecommendationCard`) and the Search tab's
own list search (`renderListSearchResults`) each needed their own copy of the button, since they build
their card markup separately.

### Tests

`tests/client.test.mjs`: new "Customize button on Discover and Search lists" suite -- a Customize button
renders on cards from all three surfaces (`render5PosterListsFeed`, `buildCuratedRecommendationCard`,
`renderListSearchResults`) with the same name/url/type as the card's own Add button, `loadListToCustomListDraft`
correctly populates the draft from a movie-only list, marks the draft "mixed" when a list has both movies
and shows, and never overwrites the identity of a list already being edited (starts a fresh, unsaved draft
every time).

## 2026-09-21 - A saga's "See All" page showed no ratings past its first 9 posters

### Files Changed
`20_client-channel-builder.js`, `worker_entry_combined.js`, `tests/client.test.mjs`, `CHANGELOG.md`,
`Changes.md`

### The bug

The Storylines & Universes grid itself looked correct after the placement fix below, but a saga's own
"See All" page showed no ratings on any poster past the ninth. The grid's card preview only ever resolves
ratings for the first 9 posters it actually shows (`previewPosters = event.episodes.slice(0, 9)`, in
`renderStorylinesUniverseList`) -- a 12-movie saga's remaining 3 items were never asked about at all. The
shared "See All" page (`openStorylineDetails` -> `openListDetailsPage`) has no slot-patching machinery of
its own, unlike the grid and the item details modal -- it only ever renders whatever rating an item
already carries when the page is built, so a gap in the grid's own cache became a gap on this page too.

### The fix

`openStorylineDetails` now awaits every episode's rating before opening the "See All" page: whatever the
grid already resolved comes straight from the shared cache, and whatever it didn't (parts past the
preview window) gets resolved fresh, right there. This meant `resolveStorylineRatings` needed to become
awaitable -- it now returns a Promise that resolves once every id passed in has an answer cached -- and
its in-flight tracking moved from a Set of ids to a Map of id -> the actual fetch Promise resolving it, so
a caller that needs an answer for every id (this one has no fallback render for one that never shows up)
can await an id someone else already started fetching instead of silently skipping it.

### Tests

`tests/client.test.mjs`: new regression test using Marvel's 12-movie Infinity Saga specifically -- browses
the grid first (resolving only parts 1-9, confirmed via the cache), then opens the saga's "See All" page
and confirms parts 10-12 arrive with correct ratings too, resolved fresh before the page opens.

## 2026-09-21 - Storylines & Universes rating badges were in the wrong place

### Files Changed
`19_client-search-and-likes.js`, `20_client-channel-builder.js`, `worker_entry_combined.js`,
`tests/client.test.mjs`, `CHANGELOG.md`, `Changes.md`

### The bug

The previous entry below made the Storylines, Sagas & Universes badges visible, but on the Channel
Builder's own browse grid they came back as a colored badge overlaid on the poster's top-left corner --
not how a rating shows up anywhere else on the site. Discover, list previews, and every other place that
uses this same `list-card-mini-poster-tile` poster markup (`loadPosterSlot`, `19_client-search-and-likes.js`)
shows its rating as a plain star-and-number sitting in the text line below the poster, next to the year --
never a colored overlay on the image itself. The item details modal's own Storylines section already
matched that pattern; only the Channel Builder grid didn't.

### The fix

Moved the grid's rating slot out of the poster image wrapper and into the year line
(`renderStorylinesUniverseList`, `20_client-channel-builder.js`), styled identically to Discover's own
year/rating row. `applyStorylineRatingBadges` no longer branches between a poster-corner badge
(`formatRatingBadgeHtml`) and an inline one (`formatRatingSpanHtml`) -- both Storylines surfaces only
ever want the inline star now, so it always uses that formatter, and the now-unused `data-rating-style`
attribute was dropped from both surfaces' markup.

### Tests

`tests/client.test.mjs`: new test confirms the rating slot renders inside the year line rather than the
poster image wrapper; the existing regression test for the invisible-badge bug was reworded since it no
longer needs to distinguish an "overlay badge" case that doesn't exist anymore, while still pinning down
`formatRatingBadgeHtml`'s id-shape guess as the actual mechanism behind that earlier bug.

## 2026-09-21 - Storylines & Universes rating badges were invisible

### Files Changed
`20_client-channel-builder.js`, `worker_entry_combined.js`, `tests/client.test.mjs`, `CHANGELOG.md`,
`Changes.md`

### The bug

The previous entry below added a rating badge to both Storylines, Sagas & Universes surfaces, and it
shipped and deployed correctly -- but nothing ever became visible on either one. The badges were there in
the DOM the whole time, just permanently invisible.

`applyStorylineRatingBadges` handed each resolved rating to `formatRatingBadgeHtml`/`formatRatingSpanHtml`
as `{ id, rating }`. Both formatters have always supported two input shapes -- a raw `rating` field, or a
`vote_average` field -- and for the `rating` field specifically, `formatRatingBadgeHtml` guesses whether
the number is an IMDb or a TMDB rating from the shape of `id` alone: an id starting with `tt` reads as
IMDb. Every id on these two pages is an imdb-style `tt...` id, even though the value itself always comes
from `/api/details/batch`'s own TMDB `vote_average`. So every badge got labelled `data-rating-type="imdb"`
-- and this site hides IMDb-type badges unconditionally, everywhere, by design (`hide-badge-imdb-rating` is
forced on in `23_client-list-management.js`; only a TMDB-vs-none choice has ever been a real setting here).
Correct data, correct markup, zero visible pixels.

### The fix

Both call sites in `applyStorylineRatingBadges` now pass the value as `vote_average` instead of `rating`,
which both formatters treat as unambiguously TMDB regardless of what the id looks like -- sidestepping the
guess entirely rather than trying to special-case it.

Found by reproducing the report directly against the live site with Playwright rather than re-reading the
diff, since the diff alone looked correct -- the deployed build genuinely did have the feature, it just
had this one mislabeled field.

### Tests

`tests/client.test.mjs`: new regression test in the existing "Storylines, Sagas & Universes rating badges"
suite asserts both formatters label a `tt...` id's badge as `data-rating-type="tmdb"` when given
`vote_average`, and separately confirms `formatRatingBadgeHtml` really does mislabel that same id as
`imdb` when given `rating` instead -- pinning down the exact mechanism, not just the symptom.

## 2026-09-21 - Remove duplicate items across lists

### Files Changed
`02_http-and-creator-utils.js`, `04_config-resolution.js`, `05_catalog-core.js`, `09_page-shell.js`,
`15_tab-settings-html.js`, `22_client-creator-profile.js`, `23_client-list-management.js`,
`24_client-backup-restore-presets.js`, `25_api-catalog-routes.js`, `worker_entry_combined.js`,
`CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/client.test.mjs`, `tests/worker.test.mjs`

### The request

Someone with several overlapping lists (the same handful of popular titles turning up near the top of
list after list) wanted the later lists to stop repeating what an earlier one already showed -- both in
the builder's own Live Preview and in the real catalogs Stremio/Nuvio end up with once the install link
is generated. Their own example: three lists that each start with the same three movies; with the setting
on, the top list keeps everything, and each list after it keeps only what nothing above it already has.

### The fix

New setting, off by default: **Remove duplicate items across lists**. "Order" is whichever order a
person's lists are in, in Catalogs/Live Preview & Editor -- the same order a list is already
drag-to-reordered in today, so changing which list keeps a shared title is just dragging it above the
other one.

Two places apply the identical rule, since a person can look at either one:

- **Live Preview & Editor** -- `renderLivePreview` (`23_client-list-management.js`) already fetches every
  enabled shelf's sample in parallel before this runs; once every shelf has its final answer, a single
  pass walks them in order, removing (per type -- movie vs series never collide anyway) whatever id an
  earlier shelf already showed, then re-renders just the shelves that actually lost something.
- **The real Stremio/Nuvio catalogs** -- new `dedupeAcrossListEntries` (`05_catalog-core.js`), called from
  the `/catalog/:type/:id.json` route (`25_api-catalog-routes.js`) whenever the setting is on. Finds the
  entry being served, re-fetches every enabled earlier same-type entry at the identical `skip`, and
  strips anything already in one of those pages. Deliberately mirrors `fetchMergedCatalog`'s own existing
  tradeoff for a merged row's sources -- same skip/page window only, not the whole earlier list -- since
  getting it exact deeper into pagination would mean holding every earlier list in full, which this
  add-on's stateless, one-request-per-page design was never built for.

Getting the flag itself from a checkbox to both of those meant threading it through every place a
settings flag like this already has to reach: `collectKeys`/`buildConfig` and the client's own `/api/save`
call, the server's field allowlist on `/api/save`, both `resolveConfig` decode paths (the KV short-link
branch and `decodeConfig`'s base64 branch), the `/:config/configure` page's `initialKeys`, JSON backup
export/restore, the config-changed-since-last-save hash, and cross-device Creator Profile sync. Used
`hideNonDigitalReleases` as the template throughout, since it already touches every one of those exact
spots.

### Tests

`tests/worker.test.mjs` ("worker: remove duplicate items across lists", 4 tests, plus a decode/resolve
test alongside the existing `adultContentFilter` one): built from `customlist:v1:` entries specifically,
since that source embeds its items directly in the url and needs no network mock at all. Covers the top
list staying untouched, a later list losing only what an earlier one already has, the setting doing
nothing at all when off, movie/series lists never deduping against each other even with a deliberately
shared id, and a disabled earlier list being skipped while a later enabled one still counts.

`tests/client.test.mjs`: a new "Live Preview removes duplicate items across lists" suite (3 tests) covers
the client-side pass -- the top shelf keeps its items, a later shelf loses what's shared, the setting does
nothing when off, and a shelf that loses every item shows a message instead of going blank. A separate
"dedupeAcrossLists setting round-trips through collectKeys and buildConfig" suite (3 tests) covers the
settings plumbing directly.

## 2026-09-21 - Rating badges on Storylines, Sagas & Universes

### Files Changed
`19_client-search-and-likes.js`, `20_client-channel-builder.js`, `worker_entry_combined.js`,
`CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/client.test.mjs`

### The problem

TV_CROSSOVER_EVENTS (the static saga/universe registry both features below read from) carries a
poster, a title and a year for every entry, but never a rating -- it's hand-curated, not a live catalog
fetch. Two different places show this same registry's posters, and neither one had a rating badge:
the Channel Builder's own **Storylines, Sagas & Universes** browse grid (`renderStorylinesUniverseList`),
and the identically-named section of the item details modal (`renderItemStorylinesWatchOrder`) that shows
a title's saga when you're already looking at one of its parts.

### The fix

Added `resolveStorylineRatings`/`applyStorylineRatingBadges` (`20_client-channel-builder.js`): after a
poster grid renders, it collects the unique imdb/tmdb ids on the page, skips whatever is already cached
or already in flight, and resolves the rest from `/api/details/batch` in chunks of 60 (that route's own
per-request cap), with its existing round-continuation loop for whatever a single invocation's fetch
budget didn't finish. Results land in a module-scoped cache keyed by id, shared by both surfaces, so a
title in more than one saga, or shown on both pages, is only ever looked up once per session.

Each surface renders the badge to fit what's already on its own poster tile. The Channel Builder's grid
tiles are otherwise bare, so they get the standard poster-corner badge (`formatRatingBadgeHtml`, which
had been sitting fully wired -- CSS, settings toggles -- with no caller anywhere in the app until now).
The item details modal's storyline cards are already carrying a part-number badge, a watched checkmark
and (on the current part) a full-width "Current" pill, so a fourth overlay would only collide; those get
a plain inline star-and-number instead (`formatRatingSpanHtml`), next to the subtitle text. The card for
the title already open in that modal is skipped entirely -- its rating is already shown higher up on the
same page, and skipping it also sidesteps the one tile whose "Current" pill spans the full width where an
overlay badge would have gone.

Both call sites hand the resolver a plain list of ids collected while building the HTML, rather than
re-discovering them by querying the rendered DOM afterward: the ids were already in hand from the same
loop that built the poster markup, and it kept the fetch-and-cache logic testable independent of DOM
queries. The item details modal's call is deferred by one microtask (`Promise.resolve().then(...)`),
since `renderItemStorylinesWatchOrder` only returns an html *string* -- its one caller doesn't assign that
into the modal body until after it returns, so resolving synchronously would query a DOM that doesn't
have these slots in it yet.

### Tests

`tests/client.test.mjs`: a new "Storylines, Sagas & Universes rating badges" suite (4) covers the
Channel Builder grid -- a rating slot renders for every poster tile (deduping a show that appears twice
in the same card), `/api/details/batch` is asked for each unique id exactly once, a second render of the
same grid asks for nothing already cached, and a title with no TMDB rating is cached as `null` rather
than retried forever. Two more in the existing "Item Details Storylines, Sagas & Universes watch order"
suite cover the modal-specific behaviour: a rating slot renders for each companion title but not for the
one already open, and `openItemDetailsModal` end to end resolves the companions' ratings once the modal
body is actually updated, never the currently-open title's own id.

## 2026-09-21 - Specials, listed instead of dropped

### Files Changed
`19_client-search-and-likes.js`, `20_client-channel-builder.js`, `25_api-catalog-routes.js`,
`worker_entry_combined.js`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/client.test.mjs`,
`tests/worker.test.mjs`

### The problem

Two places in the add-on quietly threw away a show's Specials (TMDB season 0): `/api/show-seasons`
filtered them out of the season list `browseChannelShow` (Channel Builder) fetches, so there was no way to
add a special to a channel by hand; and the item details modal (`openItemDetailsModal`) skipped season 0
entirely while looping over `d.seasonsData`, so a show's Specials never appeared on its own page at all.

### The fix

`/api/show-seasons` now keeps Specials, appended after the regular seasons -- kept out of the "is this
single season actually several TMDB seasons packed together" unpacking heuristic (which only makes sense
against real seasons), then tacked back on at the end. `browseChannelShow` and `addAllSeasonsToChannel`
needed no changes: they already just render/act on whatever `/api/show-seasons` returns, so Specials now
shows up as its own season button after every numbered one, and "Add every season" includes it.

`buildChannelItemsFromShows` -- the shared helper behind Quick Add's network channels, the Quick Channel
Wizard, and a Spotlight actor's whole filmography, none of which a person reviews episode-by-episode before
it is built -- now filters Specials back out for itself, so those three automated builders keep their prior
behavior instead of picking up recap/clip-show episodes nobody chose.

`openItemDetailsModal`'s season list now renders every regular season first, then Specials at the end,
instead of skipping it.

### Tests

`tests/worker.test.mjs` (2) -- `/api/show-seasons` appends Specials after the regular seasons for a normal
show, and still appends it after unpacking a compressed anime season into several real ones.
`tests/client.test.mjs` (2) -- `openItemDetailsModal` renders a show's Specials card last, after every
numbered season; `browseChannelShow` renders Specials as its own season button, after the numbered ones.

## 2026-09-16 - Air times that did not appear, and a date that read a day early

### Files Changed
`05_catalog-core.js`, `07_source-fetchers-tmdb-simkl.js`, `worker_entry_combined.js`, `CHANGELOG.md`,
`Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`

### Air times shipped and then did not show

Reported with a screenshot: The Ark S3E8, "Airs Tomorrow", date shown, no time. TVmaze has that show --
`schedule.time` 22:00, `America/New_York`, i.e. 10 PM ET -- so the data was there and the page was not
printing it.

The cause is the details cache, not the air-time code. `fetchTmdbItemDetails` keys on
`tmdb:itemdetails:<id>:<type>:<region>` and nothing else: entries live two hours fresh in isolate memory
and a week in KV. A show opened shortly BEFORE the air-time deploy had a copy stored without an `airTime`
field, and after the deploy that copy was still fresh and still served -- correct-looking, just missing the
new field, for up to two hours.

The key now carries `ITEM_DETAILS_SHAPE`, bumped to `v2` for this payload change. Every entry written by
the old code is on a key the new code never asks for, so the fix lands on deploy rather than two hours
later. The convention is written down where the constant is declared: a field added to or removed from the
details payload bumps it.

### A 1996 movie that read "Dec 31, 1995"

Visible in the same report's channel screenshot. `buildChannelMeta` emits each pick's date as
`<date>T00:00:00.000Z`, and a client renders that in the VIEWER's timezone -- so midnight UTC is the
previous evening across the whole of the Americas.

It is now 11:00 UTC. An instant at hour H shows as the intended date wherever the offset is in [-H, 24-H);
world offsets span UTC-12 to UTC+14, 26 hours, so no instant covers all of them and two hours' worth are
always wrong. H=11 covers UTC-11 to UTC+12:59 -- every inhabited zone except UTC+13/+14 -- and is one
better than midday, which also slips in New Zealand. The first attempt here WAS midday; the test written
alongside it caught the New Zealand case.

### Tests

`tests/worker.test.mjs` (3) -- the shape segment declared and actually used in the key, an old shape
landing on a different key than the new one, and a pick's date holding across eleven offsets from UTC-11
to UTC+12:45.

## 2026-09-16 - A movie in a Channel: tried, reverted, documented as a limit

### Files Changed
`05_catalog-core.js`, `25_api-catalog-routes.js`, `worker_entry_combined.js`, `README.md`, `CHANGELOG.md`,
`Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`

### What prompted it

Reported: a movie added to a Channel cannot be played in Stremio, and PenguPlay finds no stream for it,
while Nuvio plays it.

### The cause, which was already written down

`05_catalog-core.js` carried a NOTE calling this "a known soft spot": a Channel's meta is a SERIES, and
Stremio does not re-derive a type per video, so tapping a movie in one requests
`/stream/series/<the movie's plain imdb id>.json`. Most stream add-ons branch their whole handler on that
type param before they look at the id at all. The note guessed that lenient, Torrentio-style add-ons would
cope and others might not -- which is exactly the split the report describes. Nuvio resolves the id itself
(it renders from this add-on's full metadata, see the /meta route's own comment) and so was never affected.

### What can and cannot be fixed

Nothing here can make a third-party stream add-on answer a series-typed request for a movie. The id cannot
be reshaped into something they would answer either: `tt123:1:1` points at a season 1 episode 1 that does
not exist, and a bare number or a private prefix matches no `idPrefixes` anywhere, so no add-on is asked at
all.

What can be fixed is that the request is a DEAD END. This add-on answers that one id itself, with a single
stream whose `externalUrl` is `stremio:///detail/movie/<id>/<id>` -- handled by Stremio itself, so it moves
within the app to the movie's own page, where every stream add-on is asked for it as a movie and finds it.
One tap instead of nothing.

The video's id is left exactly as it was (`channelItemStreamId` still returns the movie's plain id), because
that is what Nuvio resolves today. This is an extra answer, not a different question.

### Keeping it off everyone else's playback

A `stream` resource is declared for every id matching its `idPrefixes`, so declaring it unconditionally
would have Stremio call this Worker on every episode anyone plays anywhere, for an answer that is always
empty. `channelMovieStreamIndex` builds the set of movie ids reachable from a config's enabled Channels, and
`buildManifest` declares the resource only when that set is non-empty.

The route matches the id against that same set rather than parsing it. An id with no season and episode is
not proof of a movie -- a show's own bare id is a real request Stremio makes -- and offering the link there
would be a dead link of a different kind.

### Reverted, on the report that it did not work

The deep link was tested in Stremio Web and does not work there. An `externalUrl` is treated as *leaving*
Stremio: it routes through a `stremio.com/warning` interstitial ("It seems you are leaving Stremio") and
then hands the `stremio://` scheme to the operating system. It may work in the desktop app, but where it
was tested it was a dead end -- and a dead end that looks like a working option is worse than an empty
stream list, which at least reads as "nothing here".

So the stream resource, the route, and `channelMovieStreamIndex` are all removed, and the code comment now
records the limit and what was tried, so the next person does not try the same thing.

Asked which of the three real options to take -- proxy the person's own stream add-on (reliable, but this
add-on would hold their debrid key), split a channel's movies into their own movie-typed row (reliable, but
out of the channel's play order), or remove the dead link and document -- the answer was to remove and
document.

### Tests

`tests/worker.test.mjs` (2) -- the channel meta still emitting the movie's plain id (what Nuvio resolves)
with no stream resource declared and no stream route served, and a pick's date holding across offsets.

## 2026-09-16 - Episode air times, from the one source that actually has them

### Files Changed
`02_http-and-creator-utils.js`, `07_source-fetchers-tmdb-simkl.js`, `09_page-shell.js`,
`17_client-my-lists-and-trakt-oauth.js`, `19_client-search-and-likes.js`,
`21_client-custom-list-builder.js`, `23_client-list-management.js`, `worker_entry_combined.js`,
`README.md`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/helpers-unit.test.mjs`,
`tests/worker.test.mjs`, `tests/client.test.mjs`

### What prompted it

Asked for: the air time beside or under the air date -- `9 PM ET`, `9:30 PM ET` -- for episodes airing
today or later.

### Why it needed a new source

TMDB has no episode air time anywhere in its TV payloads. It dates an episode and stops. Every "Airs
Tuesday" in this add-on has been a day with no hour behind it for that reason, and no amount of squeezing
TMDB was going to produce one.

Three candidates were checked against real payloads before picking:

| Source | Has the time? | Cost |
|---|---|---|
| TMDB | no | already paid |
| Cinemeta (already used here) | no -- `released` is the date at 05:00Z, i.e. midnight ET, not the broadcast hour | already paid |
| Trakt | yes (`airs.time` + `airs.timezone`) | needs `TRAKT_CLIENT_ID`, which is an optional secret |
| TVmaze | yes (`schedule.time` + the network country's IANA zone, and per-episode `airtime`) | **no API key at all** |

Cinemeta was checked directly: Game of Thrones' episodes come back as `2019-05-20T05:00:00.000Z` -- a date
shifted to midnight ET, not the 9 PM it actually aired. Trakt has the right data but behind a key a
self-hoster may not have set, which would have made this feature silently absent for them. TVmaze needs
nothing configured, so that is what this uses.

### What is fetched, and when

`fetchShowAirTime` is only ever called for a show with an episode still to come -- gated on TMDB's
`next_episode_to_air` as well as the strictly-future `isUnairedFuture`, because that flag does not fire for
an episode airing TODAY and today is exactly when someone wants to know the hour. A finished show costs
nothing: nothing displays a time against an episode that has already aired.

One call (`/lookup/shows?imdb=`) gives the show's regular slot and its network country's timezone. A second,
tiny one follows `_links.nextepisode` when there is one, because the next episode is what every "Airs
Tomorrow" badge is about and the one most likely to sit outside the regular slot. Measured against the live
API: an ended show costs 1 fetch, a running one 2, and both are cached for twelve hours in memory and a week
in KV, behind the same circuit breaker every other provider here sits behind.

`airTimeLabelForNextEpisode` is the single rule for choosing between the two labels, so the Worker's own
Stremio description and the page cannot print different times for the same episode.

### The label

`formatAirTimeLabel` (02, beside `formatAirDateBadge`) turns `"21:00"` + `"America/New_York"` into
`9 PM ET`. Minutes are dropped on the hour the way a listing writes it. North American zones are spelled
`ET`/`CT`/`MT`/`PT` from a small table rather than `EDT`/`EST`: a slot is 9 ET all year, and a label that
flips twice a year reads as though the time moved. Everywhere else asks `Intl` for the zone's own short
name on the day, and anything it cannot name recognisably (`GMT+5:30`) is dropped rather than printed.

The Worker ships the finished string, so the page never carries a timezone database.

### Getting it to the page

The air time is a fact about a SHOW, but it has to print beside episodes that reach the page from three
directions: the show's own page (has the details payload), an Airing Next tile (built from details, then
stored), and a Continue Watching entry (built from `/api/season`, which has never seen one). Threading a new
field through all of those -- and through everything already in every browser's local storage -- would have
been a migration.

So it is remembered per show instead. `rememberShowAirTime` is called from the two places a details payload
passes through (opening a show's page, and the Airing Next refresh, which sees every upcoming show), writing
a small entry under every id that show is known by. `showAirTimeLabel` reads it back by whichever id the
caller happens to hold, and expires an entry after a week -- a show can be moved to a new night. Airing Next
tiles also store the label directly, so a cold start knows the hour before the shelf refreshes.

### One badge, five shelves

The "Airs Tomorrow" pill was hand-written markup in five places (three in 17, one each in 21 and 23), which
would have meant teaching five renderers about air times. They now share `airDateBadgeHtml` /
`watchItemAirDateBadgeHtml`, and the hour goes on a second line inside the same pill rather than making it
wider -- these sit on posters barely 100px across.

### Tests

`tests/helpers-unit.test.mjs` (6) -- the label: on the hour and off it, midnight and noon, the North
American table, a zone outside it, and the empty answers (no time, unusable zone, junk input).

`tests/worker.test.mjs` (6) -- what is asked of TVmaze and what is made of it: a broadcast slot, a next
episode dated apart from it, a streaming show with no slot, a 404 and a thrown fetch both degrading to the
date alone, a `tmdb:` id costing no request, a next-episode link off TVmaze not being followed, and the
fetch meter the batch budget reads.

`tests/client.test.mjs` (8) -- the hour under the date for tonight's episode and later ones, the next
episode's own slot, nothing against an episode already out, nothing at all when TVmaze had none, the per-show
store found by every id and expiring after a week, and the badge with and without a time.

## 2026-09-16 - Season watch counts on a show's page, and "watched" measured against what has aired

### Files Changed
`09_page-shell.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`,
`22_client-creator-profile.js`, `worker_entry_combined.js`, `README.md`, `CHANGELOG.md`, `Changes.md`,
`FUNCTION-MAP.md`, `tests/client.test.mjs`

### What prompted it

Two asks about a show's item page. First: the season header says how many episodes a season has, so say how
many of them have been watched too -- `3/8`, `8/8`, `0/8`. Second: when every episode that has aired is
watched and the next one is still to come, Mark Show Watched should read Mark Show **Un**watched, because
there is nothing left to mark.

The second one is the same bug the first one would have made visible. "Fully watched" was counted against
TMDB's `episode_count`, which counts the episodes still to come as well. Five episodes watched out of a
ten-episode season with episode 6 a month away came out as 5/10 -- not caught up -- so the button offered to
mark watched what had already been watched, and pressing it would have flipped the season to unwatched.

`isSeasonFullyWatched` already knew better when `window._seasonEpisodesMap` held the season's real episode
list, but that only arrives after a season is expanded or Mark Show Watched fetches every season. On the
render that matters -- opening the page -- there was nothing but `episode_count`.

### Where the aired count comes from

`/api/details` already returns the show's next unaired episode: `nextEpisodeSeasonNumber`,
`nextEpisodeNumber`, `nextEpisodeAirDate` (TMDB's `next_episode_to_air`, plus the server's own fallbacks).
That single pointer places every season around it with no further request:

| Season vs. the pointer | Aired |
|---|---|
| after it | nothing |
| the one it falls in | everything before that episode (`nextEpisodeNumber - 1`) |
| before it | the whole season (`episode_count`) |

`seasonAiredEpisodeCount` reads three sources, most specific first: the loaded episode list, then that
pointer, then the season's own air date with `episode_count` standing in for "all of it is out". It is now
the denominator `isSeasonFullyWatched` compares against, and `seasonHasAiredEpisodes` -- which decides
whether a season button says "Airs Mar 4" -- consults the same pointer.

The pointer is counted in TMDB's season numbers, so it is not applied to a show whose seasons were
renumbered: an anime unpacked out of an episode group, or a series rebuilt from Cinemeta
(`resolveUnpackedShowData`, 07_source-fetchers-tmdb-simkl.js). Those payloads are the only ones carrying the
`episodeCount` alias, which is what `showSeasonsAreTmdbNumbered` keys off.

### The count itself

`watchedEpisodeNumbersInSeason` is the episode tally split out of `isSeasonFullyWatched`, so the "3/8" on a
season header and the button beside it cannot disagree about what has been watched.
`seasonEpisodeCountState` turns it into the label and a `complete` flag (the accent colour at 8/8), capped at
the season's own length so an episode TMDB has since dropped cannot render "9/8".

`updateSeasonEpisodeCounts` repaints the labels -- one season, or all of them -- and hangs off
`updateSeasonWatchedButton`, so every path that already refreshed a season button refreshes its count too.

### The show button

`showWatchedButtonState` / `applyShowWatchedButton` / `updateShowWatchedButton` give that button one
description, the way `seasonWatchedButtonState` already did for the season buttons. Three places set it and
each spelled out its own label and classes.

`refreshItemWatchState` (every season button, every count, the show button) is what an episode toggle now
calls, in place of repainting only `_currentSeasonNum`'s season button: the episode toggled may have been the
last one the show was waiting on, and its season is not always the one that global points at.

### One show's episode lists answering for another's

`_seasonEpisodesMap` and `_episodeDataCache` are keyed by season number and episode number, not by show, and
nothing cleared them between shows. Open a show, expand season 1, open a different show: that first show's
season 1 was still what "how many episodes of season 1 have aired" read. Both are cleared when a show's page
opens, and `_seasonEpisodesMap` joins `_episodeDataCache` in the sign-out reset.

### Tests

`tests/client.test.mjs` (15) -- the aired count from the pointer, in the airing season and either side of it;
a season and a show reading as caught up at 5 of 5 aired and not at 4; a loaded episode list overriding the
pointer; a renumbered show ignoring it; the button repainted from disk; the labels at 0/8, 3/8 and 8/8,
deduplicated, capped, and blank when a season has no episode count; and the page itself rendered, which is
both asks end to end -- `8/8`, `8/8`, `5/10` across the season headers with Mark Show **Un**watched above
them, and Mark Show Watched again one aired episode short.

## 2026-09-15 - A Channel's Play order is a menu of arrangements, not a rule applied over the top

### Files Changed
`13_tab-channels.js`, `16_client-row-core.js`, `20_client-channel-builder.js`,
`24_client-backup-restore-presets.js`, `worker_entry_combined.js`, `README.md`, `CHANGELOG.md`,
`Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`, `tests/client.test.mjs`

### What prompted it

Asked, of the "Sort by air date" checkbox shipped earlier the same day: what happens if a user selects sort
by air date and then manually moves an item? Nothing good. The flag was a SERVE-TIME rule -- the Worker
re-sorted on every request -- so the move was saved, shown in the builder, and then ignored on playback
except where two picks shared a date. The list on screen was not the list that played.

The fix is to change what a sort IS: an action that rearranges the stored picks once, rather than a rule
layered over them forever. Then the stored order is the only order, and a hand-moved pick needs no special
case to survive.

### The control

One **Play order** dropdown replaces both checkboxes and the "Shuffle picks now" button:

| Entry | Kind |
|---|---|
| As listed (custom) | state -- the stored order plays |
| Air date -- oldest first / newest first | one-shot sort, stays selected |
| Show, then season & episode | one-shot sort, stays selected |
| Title A-Z | one-shot sort, stays selected |
| Shuffle now | one-shot, falls back to "As listed" |
| Shuffle daily | the one persistent MODE (payload `shuffle`) |

A static sort is remembered as the payload's `autoSort` purely so it can be re-applied when picks are added
later; the Worker never reads it. `applyChannelDraftAutoSort` hooks `renderChannelDraftList` -- the one call
every add path in the builder already ends with (episode picker, "Add every season", movies, crossovers,
imports) -- so a sorted channel stays sorted as it grows without each of those paths knowing about sorting.

Both manual reorder paths (the position input and the hold-drag `reorderChannelDraftFromDom`) call
`clearChannelDraftAutoSort` BEFORE they re-render, which is the whole trick: the re-render is what would
re-apply the sort, so disarming first is what lets the moved pick stay put.

### Sorting rules

Every comparator falls back to the item's current index, so ties keep the order they are already in: two
episodes aired the same night, a whole season dropped on one day, anything undated. Undated picks sort last
in both air-date directions. "Show, then season & episode" ranks shows by first appearance, so it groups a
channel into runs of each show without also reshuffling which show opens it.

### Migration

`sortByAired` shipped a few hours earlier, so a channel could already carry it. The Worker keeps honouring
it -- a channel nobody edits plays exactly as it does now -- and `editChannelById` turns it into the
equivalent dropdown selection, which sorts the picks for real on the render that follows; `saveChannel`
then writes the sorted order with the flag cleared. `channelItemsInPlayOrder` stays in "See All" for the
same un-migrated case and falls straight through for everything else.

### Tests

`tests/client.test.mjs` (8) -- each sort rearranging the picks; a pick added later landing mid-list rather
than at the bottom; a hand-moved pick staying put, the dropdown falling back to "As listed", nothing armed
to re-sort, and a further add appending; "Shuffle now" arming nothing; a sort saving as the item order with
`sortByAired: false` while "Shuffle daily" saves the flag and leaves the picks alone; the dropdown restored
on edit; the legacy flag migrating; and "See All" still ordering an un-migrated channel.

`tests/worker.test.mjs` -- one added: the Worker never acts on `autoSort`, so the stored order is the play
order. The existing air-date tests stay, covering the retained `sortByAired` path.

## 2026-09-15 - A Channel can play in air date order

### Files Changed
`05_catalog-core.js`, `13_tab-channels.js`, `16_client-row-core.js`, `20_client-channel-builder.js`,
`24_client-backup-restore-presets.js`, `worker_entry_combined.js`, `README.md`, `CHANGELOG.md`,
`Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`, `tests/client.test.mjs`

### What was asked for

A way to sort a channel by aired date when creating or editing it -- working like the existing *Randomize
play order (reshuffles once a day)* checkbox, with only one of the two selectable at a time.

### Where the air date comes from

Nowhere new. Every channel pick has carried its air date since it was added:

- **Episodes**: `/api/show-episodes` maps TMDB's `air_date` for that exact episode to `released`, and every
  path that builds a draft item (the episode picker, *Add every season*, Quick Add Channel, the
  crossover/storyline builders) copies it onto the item.
- **Movies**: the movie's release date, falling back to `<year>-01-01` when the year was all TMDB gave.
- `compactChannelItemForStorage` already keeps `released` on the saved item (it drops `year`), and the
  payload the Worker reads is that same item list.

So the ordering is decided from the saved payload alone -- no TMDB request is made for it, on the page or
in the Worker, and a channel built before this change sorts correctly without being rebuilt.

### The change

**Worker (`05_catalog-core.js`)**. `channelItemAiredDate` reads an item's date as a sortable `YYYY-MM-DD`
string (accepting a full ISO timestamp, a bare year, or the `year` field), and `sortChannelItemsByAired`
orders a list by it: oldest first, undated items last in their saved order, ties keeping their saved order
-- which is what puts two episodes aired the same night back in broadcast order. `buildChannelMeta` applies
it after the rotation/shuffle branch, so it also orders a `dailyRotate` channel's lineup for the day
(the rotation still chooses *which* shows and episodes play; the sort chooses the order). The running
order is still renumbered 1..N afterwards and no stream id changes.

**One choice, not two.** The builder's two checkboxes clear each other (`setChannelPlayOrderMode`), and
`saveChannel` drops `shuffle` whenever `sortByAired` is set, so no payload this app writes carries both.
A payload old enough to carry both -- `shuffle` was the only flag that existed -- resolves the same way in
the Worker: the branch is `payload.shuffle && !payload.sortByAired`, and the sort is applied last.
Leaving both off keeps the picks in the order they are listed, which is why these are two checkboxes
rather than a radio group: "neither" is the default answer and a radio group would need a third option to
say it.

**Persistence.** `sortByAired` is carried through `saveLocalChannel`, `saveLocalChannelsMap` (all three
quota tiers) and `ensureAllChannelsSyncedFromRows`, so it survives a reload and rides the existing
`/api/creator/sync/save-channels` push to other devices like `shuffle` always has.

**"See All".** `openChannelDetailsPage` reads the saved items directly rather than going through the
Worker, so it was listing an air-date channel in whatever order its picks happened to be stored in --
contradicting the builder that had just been told otherwise. `channelItemsInPlayOrder` applies the same
ordering client-side (its regex uses `[0-9]` character classes, not `\d`, because these files are string
content inside `renderBuilder`'s template literal and a lone backslash never reaches the browser).

**Where it shows.** The channel card in *My Channels* and the source-row summary under a catalog row both
say which order a channel plays in ("air date order" / "shuffled daily").

### Tests

`tests/worker.test.mjs` -- oldest-first across shows without renumbering an id, the `year`-only fallback,
undated items last in saved order, same-night ties in saved order, the sort winning over a payload that
carries both flags, a rotating channel's day ordered without changing what it picked, and a channel with
neither flag left exactly as listed.

`tests/client.test.mjs` -- the checkboxes clearing each other (and unticking one not ticking the other),
`saveChannel` never saving both flags, `editChannelById` putting the saved order back on the right box,
and "See All" listing an air-date channel oldest first with undated picks last.

## 2026-09-15 - A Channel episode asks a stream add-on for the episode it actually is

### Files Changed
`05_catalog-core.js`, `20_client-channel-builder.js`, `worker_entry_combined.js`, `CHANGELOG.md`,
`Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`

### Root Cause

Reported: "Non-debrid addons (like Pengu) dont pickup the fake episodes order. I.e: FRIENDS randomized
channel has the S01E01 at the start of the queue when in fact it's, let's say, S05E13. With Debrid addons it
plays correctly the S05E13, but non debrid scrapes the original S01E01."

The first thing to establish is what a stream add-on can actually see, because the report assumes it sees
the channel's running order. It cannot. Stremio asks every installed stream add-on for
`/stream/<type>/<video.id>.json` and sends nothing else -- the addon SDK's own `defineStreamHandler`
documentation says the id it receives IS the video id, and stremio-core builds that request from
`video.id` alone. `buildChannelMeta` has always put the REAL episode there (`tt0108778:5:13`) and used
`season: 1, episode: i + 1` only for display, which is what makes the shuffled order hold in the UI. Those
two fields never leave this Worker. Confirmed against the live deployment: a four-item shuffled Friends
channel publishes ids `tt0108778:1:1`, `tt0108778:10:17`, `tt0108778:5:13`, `tt0108778:3:5` under running
numbers 1-4.

So for a Friends channel built from TMDB -- every item carrying a real `tt` id and a real season and
episode -- the request Pengu receives is byte-identical to the one it receives when someone opens Friends
from Cinemeta and clicks S05E13, and an S01E01 result is Pengu resolving it wrongly on its own side. That
half is not ours to fix.

What IS ours is every case where the id we publish is not the episode we display, and there were three:

1. `parseInt(it.season, 10) || 1` could not distinguish "no season stored" from season 0. An item missing
   either number -- or carrying `"0"` as a string -- was published as `<show>:1:1`. That is not a broken
   link that gets reported; it is that show's series premiere playing under the title of the episode we
   meant, which is exactly the symptom described.
2. A show TMDB has no IMDb id for was stored as a bare TMDB number (`String(ep.tmdbId)`) in the
   crossover/storyline builders, or as an empty string from the episode picker (whose buttons carried only
   `data-imdbid`, which `/api/show-seasons` leaves empty in that case). Those publish as `12345:5:13` and
   `:5:13`. Neither matches an `idPrefixes` entry anywhere, so no add-on is asked for either.
3. `/api/channel-preset` already used the correct `tmdb:<id>` fallback, so the same channel built two
   different ways published two different id shapes.

### What changed

**`05_catalog-core.js`** -- `channelItemShowId`, `channelItemNumber` and `channelItemStreamId`, directly
above `buildChannelMeta`. The show half is normalised to `tt...` or `tmdb:<id>` (a bare number is given the
prefix; anything else is unusable), and a season or episode has to be a real integer >= 0 -- 0 included,
which is what the old `|| 1` could not express. `buildChannelMeta` filters items through
`channelItemStreamId` BEFORE the daily rotation or the shuffle picks a lineup, so a dropped item costs the
channel one slot instead of leaving a hole in the middle of it, and the running order stays 1..N. Trading a
wrong episode for a missing one is the point: a missing episode can be reported, a wrong one looks like it
worked.

**`20_client-channel-builder.js`** -- `channelStreamShowId`, the same normalisation where draft items are
built, so the Worker's check has nothing left to catch: picked episodes, "Add every season", Quick Add
Channel and both crossover/storyline paths. The episode picker's two add buttons now carry `data-tmdbid`
beside `data-imdbid`, and `addCheckedEpisodesToChannel`/`addAllEpisodesToChannel` take it, which is what
gives a show with no IMDb id a real `tmdb:` fallback rather than an empty string. `tmdb:<id>:<s>:<e>` is
already a first-class shape elsewhere in the app (`23_client-list-management.js` splits it explicitly), so
nothing downstream had to change.

**`tests/worker.test.mjs`** -- eight cases against the real `buildChannelMeta`: the real season/episode
reaching the id while the display numbering stays the running order, an unnumbered item being dropped
rather than resolving to `:1:1`, season/episode 0 surviving as 0, a bare TMDB number gaining its prefix, an
unusable show id being dropped rather than publishing `:5:13`, the queue closing its gaps, a movie keeping
its plain id, and a shuffled channel reordering the queue without ever renumbering an id.

### Still open (not this change)

A stream add-on that resolves `tt0108778:5:13` to S01E01 is doing so from an identical request to the one
the normal Cinemeta detail page produces. The way to prove that to its author is to play the same episode
from outside a channel; if it is also wrong there, nothing in this repository is involved.

## 2026-09-15 - No "mark as watched" control can claim a future episode

### Files Changed
`09_page-shell.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`,
`worker_entry_combined.js`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/client.test.mjs`

### Root Cause

Reported: "if i use the Mark Show Watched the future season is marked as watched but the episode isnt marked
as watched and the show isnt added to continue watching, any mark as watched buttons should not mark a
future episode as watched."

Two of those three are one bug and the third is a second one.

`markShowWatched` never marked a future episode watched -- it filters on `isEpisodeAired` when it fetches
each season, which is why the episode was correctly absent from Watch History. What it did do was finish
with `document.querySelectorAll('.btn-mark-season-watched').forEach(...)` and relabel **every** season
button on the page to "Mark Season Unwatched", including a season with nothing aired and nothing watched.
The state was right; the only thing wrong was the button, and the button is what the person reads.

Behind that sat a smaller mess: four places set that same button (the item modal's first render,
`updateSeasonWatchedButton`, `markSeasonWatched`'s own post-write update, and the bulk relabel above) and
none of them had a case for "this season has not aired". `markSeasonWatched` on such a season fetched, found
zero aired episodes, and handed the button back enabled and labelled "Mark Season Watched" -- a control that
silently does nothing. And the episode modal offered "Mark as Watched" for any episode at all, with
`toggleWatchStatus` -- the single function every episode toggle goes through -- doing no air-date check, so
a future episode could be recorded as watched from there and then counted towards fully-watched, evicted the
show from Continue Watching, and been pushed to the account.

The third symptom is separate. `updateContinueWatching` deliberately keeps a caught-up show on the shelf
with its next, unaired episode (`isUnaired`, rendered with an "Airs ..." badge) -- that is what marking the
last aired episode one at a time does. `markShowWatched` then ran its own Continue Watching commit *after*
that reconciliation and unconditionally evicted the show, so the whole-show button was the one path that
dropped a caught-up show off the shelf.

### What changed

**One button state (`19`)** -- `seasonHasAiredEpisodes`, `seasonFirstAirDate`, `seasonWatchedButtonState`,
`watchedSeasonButtonState` and `applySeasonWatchedButton`. Airedness comes from the season's loaded episode
list when there is one and from its TMDB `air_date` otherwise; a season with no air date at all is unknown,
and unknown behaves exactly as before rather than being disabled on a guess. An upcoming season gets a
disabled button saying when it airs. All four call sites now go through it, `markShowWatched`'s included --
and that one only relabels the seasons whose episodes it actually wrote, from `allEpisodes`.

**Caught up is fully watched (`19`)** -- `isShowFullyWatched` and `markSeasonWatched`'s `allSeasonsWatched`
both skip seasons with nothing aired. One announced season used to make a show unfinishable.

**The episode door (`19`, `21`)** -- `episodeWatchButtonHtml` renders "Airs ..." disabled for an unaired
episode, and `toggleWatchStatus` refuses to ADD one. Removal is untouched: an entry made before this, or by
a scrobble, still has to be undoable. `markShowWatched` and `markSeasonWatched` now say so with a toast when
there is nothing aired to mark, instead of appearing to fail.

**Continue Watching (`21`)** -- `markShowWatched` keeps the upcoming entry the reconciliation just computed
for the show, and only evicts (and queues a storyline conclusion) when nothing is left to air.

**Supporting (`19`, `21`, `09`)** -- both mark paths now stash their fetched episode lists in
`_seasonEpisodesMap`, so `isSeasonFullyWatched` stops falling back to `episode_count` (which counts unaired
episodes) for those seasons; and `.lc-btn:disabled` finally looks disabled.

### Tests

Client: marking a whole show watched writes only the aired episode and leaves the future season's button
saying it has not aired; the show reads as caught up rather than unfinished; it stays on Continue Watching
with the unaired next episode; `toggleWatchStatus` refuses to add a future episode but still removes one
already recorded; the episode modal offers no wired-up button for an unaired episode and keeps one for an
episode already marked watched; marking a not-yet-aired season leaves a disabled button that says when it
airs; and a season with no air date is treated as ordinary.

## 2026-09-14 - Airing Next gets a remove, and Reset Account Data stops looking stuck

### Files Changed
`00_constants.js`, `02_http-and-creator-utils.js`, `09_page-shell.js`, `15_tab-settings-html.js`,
`16_client-row-core.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`,
`23_client-list-management.js`, `24_client-backup-restore-presets.js`,
`26_api-creator-and-admin-routes.js`, `schema.sql`,
`migrations/0012_add_airing_next_removals.sql`, `worker_entry_combined.js`, `CHANGELOG.md`, `Changes.md`,
`FUNCTION-MAP.md`, `README.md`, `tests/client.test.mjs`, `tests/worker.test.mjs`

### Root Cause

Two reports. "Reset Account Data takes a sec or two to complete and the user has no idea what is happening
during this time," and "airing next, add a remove feature to allow a user to stop seeing airing next for a
show but keep the episodes they currently have marked as watched and if they watch another episode it gets
added back to airing next."

**Reset.** `openResetAccountModal` clears this browser *before* it calls the server, and the comment above it
explains why: the reverse order leaves a window in which an autosave or a scrobble can push the old lists
straight back into the account that was just emptied. What it costs is a gap -- the confirm dialog has closed,
`clearLocalAccountData` has emptied every shelf on screen, and the fetch has not answered yet. Nothing at all
was rendered during that gap, so a successful reset and a failed one looked identical for a second or two.

**Airing Next.** The shelf is derived, not stored: `collectAiringNextCandidateShowIds` takes every show with a
watched episode and `refreshAiringNext` asks TMDB for each one's next air date. Nothing in that pipeline had a
notion of "not this show", so the only ways off the shelf were to delete the show's Watch History rows or mark
the whole show unwatched -- both of which destroy the record the person wanted to keep. The shape for the fix
was already in the file: `dismissContinueWatchingShow` records a *watched snapshot* rather than a flag, so
watching a newer episode supersedes the dismissal on its own.

### What changed -- Airing Next removals

**Client (`21`)** -- `removeAiringNextShow` records `{seasonNum, episodeNum}` for the show (its furthest-along
watched episode, via the new shared `latestWatchedEpisodeForShowIds`, which `dismissContinueWatchingShow` now
uses too), drops it from the cached shelf and pushes the shortened list with `intentionalRemoval` -- which is
what lets an empty shelf replace a stored one, since save-tracking otherwise refuses that.
`isAiringNextRemoved` is the only place the rule lives and is a pure read; `collectAiringNextCandidateShowIds`
applies it, which covers the 6-hourly refresh, the watch-state sync, the dashboard card's eligibility check
and the Stremio catalog push in one. `pruneSupersededAiringRemovals` (called from `syncAiringNextWatchState`,
where watch state has just moved) drops a record the person has already passed.

**UI (`21`, `22`, `23`)** -- an "x" on every Airing Next poster: the dashboard card, the generic list card,
and the full-page view (a `removeAiringShowId` field on the sample, deliberately not `removeShowId`, which
`livePreviewPosterHtml` reads as "this is a Continue Watching tile"). A "Removed from Airing Next" panel in
Settings -> Account & Sync (`15`, `22`) lists what is removed and puts one back; hidden when empty.

**Found on the way (`22`)** -- `compactCustomListItem` runs over every item on every local list save and
did not carry `canonicalTmdbId` through, so the resolved TMDB id that `refreshAiringNext`'s dedupe and
`buildLocalListCardHtml`'s badge matching both key on survived only until the next save. Kept now; it is also
what lets a removal cover both ids one show can be recorded under.

**Sync (`22`, `26`, `02`, `schema.sql`, `migrations/0012`)** -- the shelf is rebuilt from Watch History by
every device, so a removal held only where it was made is undone by the next device to rebuild and push. It
travels with the tracking record as `removedAiringNext` and lands in two new `creator_show_states` columns.
The write probes for those columns first (`d1HasAiringRemovalColumns`) and falls back to the pre-0012
statement when they are absent, so an unmigrated deployment keeps syncing everything else. A payload with no
`removedAiringNext` at all is treated as "no opinion", not "none" -- both in the D1 write and in the blob the
route stores -- so an older browser's ordinary autosave cannot clear the account's removals.

### What changed -- Reset Account Data

**Client (`16`, `22`, `09`)** -- a new `showAppBusy` beside `showAppAlert`/`showAppConfirm`: a dialog with a
spinner and no buttons, raised *before* the local clear and replaced by the outcome dialog when the request
finishes. And the spinner actually turns now -- `animation: spin` was referenced in two places and
`@keyframes spin` was declared in none.

### Tests

Client: a removal leaves Watch History whole, keeps the show out of the candidate set a rebuild starts from,
comes back when a later episode is watched and does not when an older one is rewatched, is forgotten once
superseded, can be undone from Settings, reaches the account with `intentionalRemoval`, and is applied (and
filtered out of an already-computed shelf) when another device made it. The reset shows the working dialog
before anything disappears and always lands on an outcome dialog, and no animation may be used by name
without being declared. Worker: the removal survives the save/load round trip and reaches
`creator_show_states`; a write that omits it leaves the stored ones alone; a database without migration 0012
still stores Watch History, Continue Watching and Airing Next, and reports no removals rather than failing.

## 2026-09-09 - Discover: a header and Refresh on every sub-nav tab, and poster previews that retry

### Files Changed
`09_page-shell.js`, `11_tab-quick-add.js`, `16_client-row-core.js`, `19_client-search-and-likes.js`,
`worker_entry_combined.js`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/client.test.mjs`,
`tests/worker.test.mjs`

### Root Cause

Two reports, one screenshot: "Discover, Popular Lists, has this at the top Popular Community Lists, Curated
has this at the top Curated For You ... and all the other sub nav tabs doesn't have anything at the top.
Popular Lists and Curated has a refresh button and the others does not," and separately, "Sometimes lists just
doesn't load in of the sub nav tabs."

The inconsistency was real and simple: `discoverSubPopular` and `discoverSubCurated` are each their own
`<div class="discover-subpanel">` with their own `.shelf-header` (a title plus a Refresh button that calls
`loadPopularListsFeed(true)` / `loadCuratedListsFeed(true)`). The other six pills — All, Movies, Shows, Hidden
Gems, Kids, Holidays, Genres — all share one container, `discoverListsFeed`, and it had never gotten either.

The loading bug took more digging, and turned out to explain itself once found. Every list card's 9-poster
strip is filled in by its own `POST /api/preview` call (`populateSearchResultPosters`,
`19_client-search-and-likes.js`) — up to 40 cards per render, 5 fetches running at once, and a mixed
movie+show card costing two calls. That is enough concurrent traffic to occasionally trip the endpoint's own
per-IP rate limit (`ratelimit:preview:`, 80/minute — `25_api-catalog-routes.js`) or hit a single slow upstream
response, and the code treated `!res.ok` or a network error as final: the slot's `catch (e) {}` did nothing,
and the `if (data.ok && ...)` guard around the rendering code meant a falsy `data.ok` just... rendered
nothing. No error, no log a user could see, no retry — the poster grid stayed exactly as empty as before the
fetch ever ran. Worse, the render is cached the moment it "completes" (`window._discoverFeedsCache[type]`), so
switching tabs away and back served the same blank result from the cache instead of trying again, and there
was no Refresh button on these six tabs to force a real reload either — the two reports were the same root
cause wearing two symptoms.

### What Changed

**`loadPosterSlot`, one card's fetch-and-render, pulled out on its own (`19`).** Previously inline in
`populateSearchResultPosters`'s concurrency loop. Fetching moved to two new top-level functions:
`fetchListPreviewOnce` (the unchanged single-attempt request) and `fetchListPreviewWithRetry`, which retries
once, immediately, on any failure. That is what makes the common case — a rate-limit burst, one timeout — self
heal with no visible symptom at all. `fetchPreviewForSlot`'s mixed-type branch retries each half
independently, so a card whose show half failed and movie half didn't only retries the half that needed it.

**A card that still fails after the retry says so, with a way back (`19`, `09`).** `loadPosterSlot` renders
"Couldn't load previews for this list." and a Retry button instead of leaving the slot's markup untouched.
`retryPosterSlot(btn)` resets the slot to its pre-fetch shape and calls `loadPosterSlot` again — the same code
a fresh render would run, reachable without a page reload. The slot keeps the `.poster-preview-slot` class for
exactly as long as the fetch (retry included) is in flight, success or failure: `stashCatalogSearchView`
(Search tab's view cache) reads that class to know a card has not resolved yet and skips snapshotting around
it, and that contract had to survive this untouched.

**A shared header for the six pills that share `discoverListsFeed` (`11`, `16`, `09`).** Same shape as Popular
Lists' and Curated's own: a `.shelf-header` with a title and a Refresh button. One header rather than six,
since one container is shared — `filterDiscoverShelves` sets its title from a `DISCOVER_FEED_TITLES` lookup
matching the active pill's label, and shows/hides it in the same place it already shows/hides the feed
container itself. Refresh calls `renderDiscoverChartsList(filter, true)` directly, which forces a real
re-render past `window._discoverFeedsCache` — the same call already wired to Popular/Curated's own Refresh
buttons, and, because a fresh render means a fresh `populateSearchResultPosters` pass, a working manual retry
for the loading bug above, on top of the automatic one.

### Verification
`bash verify.sh` — 464 pass, 1 skipped. Ten new tests (four behavioural, via `tests/client-harness.mjs`,
driving `loadPosterSlot`/`retryPosterSlot` against a stubbed `/api/preview`; six against the rendered markup
and `filterDiscoverShelves`'s own logic). Six mutations — the automatic retry removed, the failure state
reverted to blank, `retryPosterSlot`'s reset dropped, the header markup deleted, the header-visibility branch
disabled, one pill's title entry removed — each caught by the test written for it; one of those (the
visibility branch) was missed by a source-text match alone and needed a behavioural test that actually drives
`filterDiscoverShelves` and reads the header element back.

## 2026-09-09 - The KV write budget: telemetry counters move to D1

### Files Changed
`03_admin.js`, `worker_entry_combined.js`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `tests/worker.test.mjs`

### Root Cause

Reported as an admin bug: marking a support thread done answered `500`, and once the swallowed error was made
visible (previous change) it read **"KV put() limit exceeded for the day."** The feedback write was the victim,
not the cause. The free plan allows 1,000 KV writes a day across the whole namespace, and the two telemetry
recorders were spending them faster than anything else in the app:

- `recordTrackedEvent` wrote **four** keys per tracked title — `evtcount:{type}:{id}:days`,
  `evtcount:{type}:{id}:alltime`, `evtdayindex:{type}:{day}` and `evtmeta:{type}:{id}`. Measured end to end, a
  browser posting a ten-title batch to `/api/track-event` spent **41** KV writes. Roughly 250 watched titles in
  a day exhausted the whole allowance, at which point *every* KV write in the app fails — which is why a bug in
  the analytics beacon surfaced as a broken button in the admin panel.
- `recordSearchQuery` wrote three per search: **3** KV writes for one `/api/title-search`.

Two of those four were pure waste. `evtdayindex:` is one list per (type, day): the first event for a title
appends its id, and every later event that day re-serialised and rewrote a blob it had not altered.
`evtmeta:` was written on *every* event by design — the comment said "overwritten every time rather than only
on first sight — keeps title/mediaType current if either ever changes upstream, and lastSeen doubles as a cheap
staleness signal" — which is a real requirement that does not need a write per event to meet.

The larger point is the one the report asked: `bumpStat` moved its counters to D1 a while back. These two never
followed, so a D1-bound deployment was still paying KV write costs for the noisiest counters it has.

### What Changed

**Both recorders take the D1 branch `bumpStat` already had (`03`).** `d1BumpStat(env, kind, buckets, amount)`
with `kind` = `evt:{eventType}:{id}` or `searchq:{q}`, buckets `["total", day]` — one batched upsert,
`ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n`, which is atomic where the KV read-modify-write never
was. **No migration:** `stats` is keyed `(kind, day)` and its `kind` dimension is already unbounded —
`list_copy:{slug}` mints one row per list — so these go in beside the rows already there. The day index is not
written at all on this path; a range scan over `day` replaces it.

**The readers gained matching D1 branches (`03`).** `d1CountsByKindPrefix(env, prefix, window, cap)` is the
shared query: `day = 'total'` for all-time, `day >= ? AND day <= ? GROUP BY kind` for a window, `LIKE` with an
explicit `ESCAPE` so a `%` or `_` in an id or a search term stays a literal. `computeLeaderboard` uses it for
its candidates; `computeSearchLeaderboard` uses it directly, since a search term is its own display value and
has nothing to attach.

**`writeEventMetaIfChanged` (`03`), one helper both paths call.** The display blob is rewritten when the title
or media type has actually changed, and otherwise at most once a day per title so `lastSeen` stays meaningful.
It costs one KV read; on the free plan that is 100,000 a day against 1,000 writes. The day index on the KV path
got the same treatment — written only when an id is actually added.

**`backfillTitleCount` follows them (`03`).** Not for the write budget: `computeLeaderboard` now reads counts
from D1, so a backfill that only wrote KV would run to completion, report its title counts, and leave the All
Time board empty. It bumps `evt:{type}:{id}` at `total` only — no day bucket, for the reason its own comment
already gives.

**Deployments with no D1 bound are unchanged in behaviour** and keep both KV paths, with the two wasteful
writes fixed there too.

### The cost, measured

Per request, against a stub KV that counts `put()`:

| | before | after |
|---|---|---|
| `POST /api/track-event`, 10 titles, first sight | 41 | 11 |
| `POST /api/track-event`, 10 titles, seen before | 41 | 1 |
| `GET /api/title-search`, any term | 3 | 0 |

The 11 is ten first-sight display blobs plus the per-IP rate-limit counter; the 1 is that counter alone, which
is now the only KV write left on the beacon path.

### What an operator sees

Trending and Search & Queries restart from the switchover on a D1 deployment. The KV history stays under its
existing TTL (120 days daily, 400 all-time) and is not merged in — merging would mean reading the whole KV
corpus on every call to add a shrinking tail to rows D1 answers in one query, and the two would double-count
every day both paths wrote.

### Verification
`bash verify.sh` — 454 pass, 1 skipped. Ten new tests, and seven mutations — the D1 branch removed from each of the two recorders,
each of the two readers and the backfill; the once-a-day meta throttle disabled; and the window predicate
dropped from the range query — each caught by the test written for it.

## 2026-09-08 - UI reports from real use: page shift, PWA bars, See All counts, Search reloads

### Files Changed
`02_http-and-creator-utils.js`, `07_source-fetchers-tmdb-simkl.js`, `09_page-shell.js`, `15_tab-settings-html.js`, `16_client-row-core.js`, `19_client-search-and-likes.js`, `24_client-backup-restore-presets.js`, `worker_entry_combined.js`, `README.md`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`

### Root Cause

Six unrelated reports, four of which turn out to be one cause each rather than one per tab.

- **Four tabs "shift the whole page to the right."** Discover > Hidden Gems, Catalogs > Bulk Add, Lists > Liked and Import, Channels > Quick Add and Import. Nothing about those four panels is special except that each is short: they fit the viewport without scrolling, the classic scrollbar disappears with them, the content box gets ~15px wider, and a `max-width` block centred with `margin: 0 auto` moves right by half of that. One cause, four symptoms.
- **The PWA's status bar and home-indicator strip stay white in dark mode.** `<meta name="theme-color">` was already being flipped, and the page background was already black, and neither is what an installed PWA paints those strips from. It paints them from the UA's own surface, which stays light until the document declares `color-scheme: dark` — and the document had never declared a colour scheme at all. Compounding it, `viewport-fit=cover` was never set, so every `env(safe-area-inset-*)` this app writes (there are nine) evaluated to `0` and the document never reached into those strips to paint them itself.
- **TMDB and MDBList See All says 100 until you scroll.** The fix for this shipped for Trakt and did not generalise, for two separate reasons. `fetchTmdb` (user lists, watchlist, favourites) and `fetchTmdbCollection` never reported a total in the first place. Everything that did — MDBList lists, every TMDB chart, collections — reported it by hanging `totalItems` on the returned array, and the cache serialises with `JSON.stringify`, which drops properties hung on an array. So the count survived a hit in isolate memory and vanished on a KV or edge hit, which is exactly the shape that makes a bug look intermittent rather than absent.
- **The Search tab reloads itself.** `switchTab('search')` called `renderDefaultCatalogSearch()` unconditionally, so returning from a poster, from See All, or from any other tab tore the results down and refetched them. `setCatalogSearchFilter` did the same on every press of the Movies / Shows / Lists chips, in both directions. On the Lists chip that is a round trip plus one `/api/preview` per card.
- **Four Settings buttons are accent blue.** Open the Guide, Buy me a coffee, Try TorBox Debrid, Import. The two `<a>`s are the interesting half: `button, .actions a` (0,1,1) outranks a bare `.lc-btn` (0,1,0), so an anchor inside `.actions` came out blue whatever modifier class it carried — which is why the TorBox link carried a hard-coded `color:#ffffff` to stay legible.

### What Changed

**`html { scrollbar-gutter: stable }` (`09`).** Reserved for the document, so the layout stops depending on whether the tab currently showing happens to overflow. `stable` rather than `overflow-y: scroll` so a short page does not grow a dead track; engines without it use overlay scrollbars and never had the shift. `lockBackgroundScroll` (`16`) computed its modal compensation from `window.innerWidth - root.clientWidth` *before* setting `overflow: hidden` — with a reserved gutter that is a width that may still be reserved afterwards, so it would have padded the page in the other direction. It now measures `clientWidth` across the change and pads by the difference, which is zero when the gutter stays.

**`color-scheme`, a painted root canvas, and `viewport-fit=cover` (`09`, `24`).** `color-scheme: light` on `:root` and `dark` on `:root.dark-theme` is what tells the OS which surface to paint; it also brings the scrollbars, form controls and `<select>` popups along. `html` paints `var(--bg)` itself rather than relying on `body`'s background propagating, because the safe areas are outside `body`'s box. `viewport-fit=cover` makes the insets real, so `body` pays them back in padding — `calc(16px + env(safe-area-inset-top))` and `max(12px, env(safe-area-inset-left))` and their mirrors — or the header would sit under the clock and content under the notch in landscape. `apple-mobile-web-app-capable` is added alongside, because without it iOS ignores the `apple-mobile-web-app-status-bar-style` that was already there. The guide page gets the same treatment: it opens inside the installed PWA.

**The item count travels beside the rows, not on them (`02`).** `fetchWithPerUserCacheUncoalesced` stores `{ data, totalItems, freshUntil }` and hangs the total back on the array on the way out, for the two durable tiers as well as the memo. Entries written before this simply have no `totalItems` key, which reads as "no total" — the state every one of them was already in. That is one fix for MDBList lists, all of the TMDB charts and TMDB collections at once, and for anything that reports a total later.

**TMDB lists and collections report one (`07`).** A collection arrives whole, so `parts.length` is exact. A user list is walked page by page, and the honest answer differs by case: exact when the walk runs out of pages, exact from TMDB's `total_results` for the account watchlist/favourites endpoints (which are per-kind), and *deliberately absent* for a v4 list that has actually shown both movies and shows without being fully walked — `total_results` counts both kinds there and there is no way to split it without walking every page. That last case keeps saying "100+" and counting up, which is what it did before and is at least true.

**The Search tab keeps what it rendered (`19`, `16`).** The view is keyed on everything the render reads — which chip is active, what is in the box, and the three filter dropdowns. A request to render a key already on screen is a no-op; the markup of a view about to be replaced by a chip press is kept, one entry per chip, so switching back is instant. A half-loaded Lists view is not kept: a poster strip still in flight carries `.poster-preview-slot` until `populateSearchResultPosters` fills it, and that filler runs document-wide and cannot be re-aimed at one restored view, so snapshotting mid-flight would freeze those cards empty. Such a view renders fresh, exactly as it does today.

**`.lc-btn.secondary` (`09`, `15`).** A two-class rule (0,2,0) that outranks `button, .actions a`, carrying the same surface `button.secondary` already gives every Connect / Disconnect / Copy button. The four buttons move to it and the TorBox link drops its hard-coded white text and blue border.

### Verification
`bash verify.sh` — build drift, `node --check`, both scope checks, all four render passes, `FUNCTION-MAP.md` drift, and 430 tests.

## 2026-09-08 - v1.5.3: the last open items from Adversarial Audit III

### Files Changed
`00_constants.js`, `02_http-and-creator-utils.js`, `07_source-fetchers-tmdb-simkl.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`, `wrangler.toml`, `README.md`, `CHANGELOG.md`, `Changes.md`, `FUNCTION-MAP.md`, `AUDIT-2026-09-08-FIX-STATUS.md`, `tests/harness.mjs`, `tests/worker.test.mjs`, `tests/client.test.mjs`

### Root Cause
Five remediation rounds closed everything 🔴 and 🟠 in `AUDIT-2026-09-08-ADVERSARIAL-III.md`. What was left was one deferred scale change, two half-fixes whose second halves changed a client contract, the low-severity cleanup, and one decision the report explicitly handed to the maintainer. They share a shape: each one is cheap to state and needs a client or a storage-layout change to actually land, which is why they were deferred rather than fixed.

- **One key held the whole directory.** `index:publiclists` was read-modify-written by every public save, every anonymous publish and every like — 4.45 MB parsed, sorted and re-serialised for a one-number change, against KV's limit of one write per second to a given key. Round 5 took the *like* path off it with a cooldown; the key itself was still the bottleneck for everything else, and the audit was explicit that sharding must happen in one pass with a version marker, because a half-sharded index serves a fraction of the directory.
- **`/api/creator/lists` returned every list's full `items` array.** Round 5's paging bounded the KV *operations*; it did not bound the *bytes*, which were 15.08 MB for a 1,200-list account, re-sent after every save, delete, tab switch and background sync. The audit's own suggestion — "the dashboard renders name / type / count; it does not need the contents" — is wrong in one detail: the list card renders a nine-poster strip from `items`. So the fix could not be a projection alone.
- **Two paths still could not run on a free Worker.** `/api/details/batch` at 180 outbound fetches and the cron tick at 186, against a cap of 50. Both are terminated rather than slowed, and the cron's termination took Continue Watching with it — so on a free deployment that feature had never worked once.
- **The low-severity tail.** A non-string body field reaching `.trim` was the only uncaught 5xx in ~1,700 fuzzed requests; `/api/creator/reset-key` answered 200 on every failure, which round 1 had fixed for fourteen other endpoints and missed here; and `runListSearch()` was the single function in the client bundle with no reference of any kind.
- **`/api/publish-list`.** Unauthenticated, permanent, unowned, no caller in the shipped app, and vector A of the audit's stored-XSS finding. Round 5 tightened it and left keep-or-remove to the maintainer.

### What Changed

**The directory index is sharded (`02`).** Entries live in `index:publiclists:s0`…`s31`, bucketed on an FNV-1a hash of the entry id. Sharded on the id rather than on the first character of the slug as the audit suggested: same 32 buckets, but slug initials are heavily skewed ("the", "top", "best") and a bucket holding a fifth of the directory would not have fixed either half of the problem — and the hash has to be computable from the id alone, because that is all `updatePublicListIndex` is given.

The invariant that makes it safe to migrate incrementally: **a full publish writes all 32 shard keys, empty ones included, and only then deletes the pre-shard key.** So "shard N is absent" always means "this deployment is not sharded yet" and never "that bucket happens to be empty" — which is what lets the incremental write path decide in one KV read whether it may take the cheap route. A like now costs one get and one put against ~1/32 of the blob; a delete touches only the shards its ids are in, rather than all 32 (32 writes per delete would be a third of a free plan's daily budget for 31 deletes). The build state carries `v: 2`, so a scan started by pre-shard code is discarded rather than half-applied.

Two things came out of that which are improvements in their own right. `readPublicListIndex` reports the **oldest** shard's timestamp, so one busy bucket cannot hide a directory that has otherwise stopped being maintained. And the cron's staleness check reads a small `index:publiclists:meta` marker written only by a full build, instead of merging 32 shards — which also fixes a live defect: staleness used to be read from the index blob's own `updatedAt`, and every incremental write bumped it, so a deployment busy enough to matter looked freshly built forever and the daily re-derive never ran on exactly the deployments that needed it.

**`/api/creator/lists` sends metadata; the contents come separately (`26`, `22`).** The route returns `itemCount` and `updatedAt` and omits `items`. A new `POST /api/creator/lists/items` returns the contents of up to `CREATOR_LIST_ITEMS_BATCH_MAX` (100) named slugs, bounded by the request rather than by what the account owns, and mirroring the same Watchlist-from-the-tracking-blob fallback the paged route has. The client keeps a per-slug cache keyed on the server's `updatedAt` **and** `itemCount`, and asks only for what it does not already hold: after a one-list edit that is one list's items instead of all of them.

Every consumer of `lastCreatorListsData` still reads `.items` synchronously — there are sixteen of them across five files, including "add to an existing mixed list", the channel builder and backup — so the array is assembled before the response is handed back, exactly as before. That is the whole design: nothing downstream changed, and a delta fetch that cannot complete falls back to `includeItems: true`, which is byte-for-byte the shape this endpoint answered with before the split. Rendering a list with a silently-empty items array would be worse than transferring too much, so the fallback is unconditional and a partial answer counts as a failure.

**Three subrequest budgets, and one of them changes a default (`00`, `07`, `25`, `26`, `21`, `wrangler.toml`).** `/api/details/batch` spends its budget against *real* upstream calls rather than against the id count, because an id already in the memory, KV or edge cache costs nothing and the warm case is the entire reason the batch route exists — a fully warm 60-id refresh is still one invocation on either plan. Each id reserves its worst case (8 fetch sites, counted) before it starts and hands back the difference the moment it turns out to have cost less. Each id gets its **own** meter: six of these run concurrently, and a shared counter read before and after an `await` measures every worker's fetches rather than this id's — the first draft charged each completed id roughly six times what it spent and ran a 600-fetch budget out after 36 ids that had cost 108 between them.

The cron tick splits differently because its two halves do. The episode sweep is exactly two fetches per show and already resumes from a cursor, so it chunks perfectly. Chart pre-warming cannot be divided below one chart, and one chart is ~105 fetches — `fetchTmdbPagedResults` asks for five pages and then resolves details for every item on them — so no free-plan budget can warm one, and issuing them anyway is what took the whole tick down. Below that threshold it is skipped with one log line naming the variable that turns it back on; above it, the charts rotate from a cursor so a budget that fits only a few per tick still covers all of them. The sweep also now runs **first** and is awaited before the pre-warm starts, so the half a person actually sees has landed in KV before anything expensive begins.

**Where the three defaults sit, and why they are not all the same.** The first draft made all three the Free-plan number, reasoning that a Worker pasted into the Cloudflare dashboard has no `wrangler.toml` to read a variable from, so the constant is the only protection it has — and `wrangler.toml` would carry the Paid values for anyone deploying that way. The premise was right and the conclusion was backwards: the deployment this add-on is actually published from is a dashboard paste, so a default that only wrangler users benefit from protects nobody, and shipping the Free number would have switched chart pre-warming off and dropped the Continue Watching sweep to 8% on the live deployment.

The line the three are drawn on is what each budget does when it binds, not which plan is more common:

- `BULK_RESOLVE_SUBREQUEST_BUDGET` and `DETAILS_BATCH_SUBREQUEST_BUDGET` only **pace**. The client re-posts whatever the server did not reach, so the import still finishes and the shelf still rebuilds; a low default costs invocations and nothing else. Both stay at 48, free-safe, and neither needs configuring on any plan.
- `CRON_SUBREQUEST_BUDGET` **disables**. Below one chart's worth of budget there is no pre-warming at all, and the sweep runs at 12 shows a tick instead of 150. A default that silently switches off a working feature is the wrong default, so it is 10,000 and a free Worker steps it down to 48 — one plain-text variable under Settings → Variables and Secrets, which is the same amount of work the other arrangement would have cost the paid deployment, spent by the deployment that gains a feature rather than the one that loses one.

`wrangler.toml` still carries all three for the people who do deploy with it, and now documents the free direction as well as the paid one.

**`/api/publish-list` removed (`25`, `00`).** The maintainer's call. Every read path is untouched — existing records still serve at `/lists/user/<slug>`, still appear in the directory and search, and are still browsable and deletable from `/admin` — and the route leaves a comment saying exactly that, because the next person to read `publishedlist:user:` keys will want to know where they came from. Its dedicated `ANON_PUBLISH_*` ceilings went with it rather than being left as constants nothing reads.

**The cleanup (`25`, `26`, `19`).** `String()` at the five `/api/external-list/create` fields the audit named and the six sibling sites in the same file with the identical shape. `/api/creator/reset-key` answers 429 on its two throttles and 401 on the credential failures, with the message byte-identical across all of them so the status codes say nothing the body did not. `runListSearch()` deleted. The `item-add` / `item-remove` aliases are kept, with the reasoning in a comment: the audit said itself they cost nothing, `item-remove` is not even a pure alias, and deleting a published path breaks callers that cannot be seen from inside the repo.

### Two test helpers that were not testing what they claimed
A cron tick was driven by snapshotting `ctx.waitUntil` once and awaiting that snapshot. Several tasks call `ctx.waitUntil` *again* once they are already running — `advancePublicListIndexBuild` registers the actual rebuild chunk that way — so those were never awaited. The tests passed anyway because `prewarmSharedCatalogs` slept between ~47 chart warms, which was long enough for the deferred work to finish first. Budgeting the pre-warm removed the sleeps and the accident with them; the helper now drains in rounds, which is what the tests meant. The same fix went into the chart-cache test's own tick helper, and the new cron tests use a fresh isolate, because chart results are memoised in module scope and one test warming them left the next with nothing to write.

### Verification
`bash verify.sh` — byte-exact rebuild, `node --check`, the scope pass over both the Worker and the rendered bundle, all four render checks including the hostile one, `FUNCTION-MAP.md` drift, full suite. **428 tests pass, 1 skipped** (up from 401).

Ten mutations, one per behaviour this release introduces, each caught by the test written for it and by no other:

```
A  return items from /api/creator/lists again   -> "does not ship item contents"
B  reuse the client cache regardless of version -> "asks only for the list that changed"
C  paper over a missing slug with []            -> "falls back when the items route answers without a slug"
D  details/batch ignores its budget             -> "stays inside the free plan's 50 outbound fetches"
E  prewarm ignores its budget                   -> "skips chart pre-warming"
F  a full publish skips empty shards            -> "publishes every shard"
G  a like rewrites the whole directory          -> "writes ONE shard for a like"
H  the build state keeps its v1 marker          -> "restarts a build state written before the shards existed"
I  revert String() on a body field              -> "does not 500 on a body field that is not a string"
J  reset-key answers 200 again                  -> "answers reset-key failures with a status"
```

## 2026-09-07f - Audit sweep: the last three open findings closed, and every audit retired

### Files Changed
`02_http-and-creator-utils.js`, `03_admin.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`, `tests/worker.test.mjs`, `docs/history/*` (seven audit documents moved), `docs/history/README.md`, `audit/*/README.md`, `CHANGELOG.md`, `Changes.md`

### Root Cause
Four audit passes had accumulated at the repository root — the independent 2026-09-05 review, two adversarial rounds, and the frontend round — with three remediation trackers between them. Three of the four were fully closed and said so. The fourth, `AUDIT-2026-09-05-INDEPENDENT.md`, read as closed at a glance and was not: three items were recorded *inside* otherwise-fixed findings, in prose, where nothing pointed at them.

- **§3's tail.** The finding is "thread ids are capability tokens minted with `Math.random()`", and the fix (72 bits of CSPRNG) is described in full — then one sentence at the end says "a per-IP limit on `/api/feedback/threads` is still outstanding." It was: the endpoint took 20 ids per request, unauthenticated, with no bucket of any kind, so attempts against the id space were free.
- **§12.** `timingSafeEqualHex` returns on `a.length !== b.length` before its constant-time loop. Three of its four callers compare values whose length is fixed by construction; the fourth is `env.ADMIN_KEY`, whose length is whatever the deployer chose — so an unauthenticated endpoint leaked it by timing.
- **§14 and top-10 §9.** Lossy KV counters, and no TTL/sweep on the two key spaces that unauthenticated endpoints mint permanently. Both are real, and both are decisions rather than defects — but the reasoning existed only in an audit report, which is where reasoning goes to be re-litigated by the next person to read the code.

A fourth thing was simply stale: `AUDIT-2026-09-06-FIX-STATUS.md` still carried a line saying four mutations were "still open", contradicted by its own table twenty lines above, which lists all four as killed. Confirmed against the suite — all four have tests.

### What Changed
- **`25`**: `/api/feedback/threads` spends the shared per-IP bucket (`consumeRateLimit`, 60/minute) before it parses anything. Generous against real use — the support panel calls it when it opens and on a manual refresh, not on a timer — and ruinous against enumeration.
- **`02`**: `timingSafeEqualSecret(a, b)` digests both sides with SHA-256 and compares the two 64-character hex strings, so the comparison runs over the same length whatever came in. `26` uses it for the admin key. `timingSafeEqualHex` keeps its early return and now says in a comment why that is safe *there*, and when it is not.
- **`03`**: `bumpStat`'s KV branch records why it stays a get-then-put — KV has no atomic increment and no compare-and-swap, so the only correct fix is a different storage primitive, which is exactly what the D1 branch beside it already is. What is lost is a display statistic under simultaneous load.
- **`25`**: both `/api/save` and `/api/publish-list` record why neither key gets a TTL — the id *is* somebody's install URL, or a list link they have handed to other people, so an expiry breaks a stranger's install months later with nothing to point at. Growth is bounded at the door instead. The `/api/publish-list` comment also stopped claiming no route can delete these; one can, since the admin path landed.
- **Docs**: all seven audit documents moved to `docs/history/`, its README rewritten to list them and to say plainly that there is no open audit — an audit lives at the root while it has work in it. The probe READMEs under `audit/` were repointed; those directories stay where they are, because the probes still run.

### Verification
`bash verify.sh` — byte-exact rebuild, `node --check`, builder page, admin page, service worker, `FUNCTION-MAP.md` drift, full suite. Four new tests: the threads bucket is spent and answers 429 while a second IP is unaffected; `timingSafeEqualSecret` is correct for equal, unequal and different-length inputs, and the admin route cannot go back to the length-shortcutting comparison; the right admin key still works and five near-misses (including a prefix and a suffix of the real one) do not; and the two accepted limitations keep their reasoning where the code is, because a decision nobody can find gets undone by whoever tidies up next.

## 2026-09-07e - "See All" reported the page it was holding, not the size of the list

### Files Changed
`02_http-and-creator-utils.js`, `06_source-fetchers-mdblist-trakt.js`, `07_source-fetchers-tmdb-simkl.js`, `19_client-search-and-likes.js`, `23_client-list-management.js`, `worker_entry_combined.js`, `tests/worker.test.mjs`, `tests/client.test.mjs`

### Root Cause
A 303-item chart said "100 items". In Live Preview's See All the number climbed as scrolling paged the rest in; opened from a Discover card it stayed at 100 with 303 items on screen. Two causes, one on each side of the wire.

**Trakt never reported a total.** Every Trakt fetcher's `fetchFn` returned `res.json()` and let the Response — headers and all — go out of scope, so `X-Pagination-Item-Count`, which is Trakt stating exactly how big the collection is, was discarded on every call. `/api/preview` then fell back to the length of the page in hand, which it caps at `PAGE_SIZE` (100). MDBList and the TMDB fetchers have always reported `totalItems`; Trakt was the gap, and Trakt is what the Discover charts are built from.

**The browser printed a page length as a total.** `populateSearchResultPosters` showed `data.count` — the first page — on the card badge, and carried that number into the See All page as an *exact* item count via `data-items`. `formatSubtitle` then preferred it over the loaded count with no check that the two were still consistent, so 100 outranked the real number permanently.

### What Changed
- **`06`**: `traktPayloadWithTotal` / `traktPayloadItems` / `traktPayloadTotal` capture the header and thread the count through `fetchTrakt`, `fetchTraktWatchlist` and `fetchTraktHistory`; **`07`** does the same for `fetchTraktChart`. The count travels *with* the data, because these replies are cached across three tiers and the two durable ones store `JSON.stringify(payload)` — which drops a property hung on an array, so a total would survive a memory hit and vanish on a KV hit. The cached value is `{ items, totalItems }`, read back through accessors that still understand the bare array every pre-existing cache entry holds.
- **`02`**: `isEmptyPayload` learns that shape, so wrapping a payload to carry its total cannot quietly disarm `refuseEmptyOverwrite` for the shared chart caches.
- **`19`**: the card badge shows a real total when one is known and `100+` when all that is known is that a full page came back and more remains; the estimate is deliberately not passed on as an exact count.
- **`23`**: the See All header drops a "total" the loaded items have overtaken, says `100+` rather than `100` while pages remain, and brings a known total down when an item is removed.

### Verification
Nine tests. Server: Trakt's header reaches `/api/preview`; an endpoint that does not paginate reports no total rather than a fabricated one; a payload cached before the wrapper still reads; an empty wrapped reply still counts as empty. Client: the header reads 303 before anything is scrolled when the source reports a total; `100+` then an exact 303 when it does not; a handed-in 100 loses to the 303 actually loaded; a stored list's real count is still trusted against a single page; a removal decrements it. The two end-to-end preview tests run on a fresh isolate — the chart memo is per-isolate and keyed by chart/kind/page, so on the shared worker they were being answered by another test's stub.

### Note
Trakt replies are cached for up to a day, so a chart already in cache keeps reporting no total until its entry expires.

## 2026-09-07d - An admin could not see a creator's lists, so a duplicate run could not be deleted

### Files Changed
`03_admin.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`, `tests/worker.test.mjs`

### Root Cause
`/admin/api/delete-creator-list` takes exact slugs, and nothing in the admin dashboard could tell you what a creator's slugs are — the creator's own dashboard is the only place they appear, and an admin cannot open it. Workable for one reported list; useless for the case the tool keeps being needed for: an account carrying dozens of copies of one list under slugs nobody could guess (`coming-of-age-3` … `coming-of-age-53`, from the runaway that `/api/creator/lists/save`'s own comment records). Typing the base name deletes exactly one of them.

Worse, the records most in need of deleting are the hardest to find: the runaway was caused by lost entries in `creatorlistorder:`, and a record missing from that key is invisible on the creator's own dashboard while still being served at its URL.

### What Changed
- **`26`**: `GET /admin/api/creator-lists?username=&limit=&cursor=` enumerates the stored records — slug, name, type, item count, likes, visibility, `updatedAt`, and `inOrder` — paged with a cursor like the anonymous-list browse beside it. It reads the `creatorlist:` records themselves rather than the order key, deliberately, and reports the difference instead of hiding it.
- **`03`**: the delete panel grows Browse / filter / "Select all shown". The filter matches name *and* slug and treats spaces as the hyphens a slug uses, so typing the list's name finds `coming-of-age-37`. Selecting fills the slug box rather than deleting outright — the same way the anonymous browse does — so the existing confirmation still names everything that is about to go.
- **`03`**: a failed delete now reports what it removed before stopping. The endpoint returns `deleted` even when the sweep fails — most often the records are gone and only the directory cleanup did not finish — and showing just "Failed" made a delete that had worked read as one that had not.

### Verification
Four tests plus the authorization matrix: every stored list is reported including duplicates; a record whose order entry was lost is still listed and marked `inOrder: false`; an invalid username is rejected rather than reading a made-up key prefix; and browse → delete removes every copy and reports the deletion back to the creator's own `/api/creator/lists`. The FE-17 canary caught the new endpoint's read of a `creatorlist:` key and it is classified as a non-mutator with its reason.

## 2026-09-07c - The installed PWA pushed its stale state before it had read the account

### Files Changed
`02_http-and-creator-utils.js`, `22_client-creator-profile.js`, `24_client-backup-restore-presets.js`, `26_api-creator-and-admin-routes.js`, `worker_entry_combined.js`, `tests/worker.test.mjs`, `tests/client.test.mjs`

### Root Cause
Reported as: change Continue Watching, Watch History, or delete a list on the desktop, open the installed PWA on the phone minutes later, and the change is reverted. An installed PWA is re-launched rather than resumed, so it begins every session holding whatever it last saw and knowing no server version at all. Three consequences, all producing that one symptom.

**Ordering.** `activeCreator` is set the moment `/api/creator/restore` answers; the first `/api/creator/sync/load` is a second round trip behind it, and the page's own start-up work waits for neither — `refreshAiringNext` at 600ms and `backfillWatchHistoryEpisodeStills` at 1400ms both end in `scheduleTrackingSync`, and every autosave path does the same for the config blob. `save-tracking` and `sync/save` are full overwrites by design, so the phone replaced the account's state with its stale copy *before* the load that would have told it what the account held — then rendered the resurrected copy back as current.

**The conflict guards were disarmed.** `sync/save`, `save-presets` and `save-channels` refuse a push that cites a version the record has moved past, but every baseline lived in a `window.` variable, gone with the page. A new session cited nothing, which the server reads as "an older client with no opinion", i.e. last-write-wins. `save-tracking` had no guard at all. The same gap disarmed `shouldKeepLocalOnlyTracking`: it could only consult an in-memory stamp, so a relaunched app took its "first sync ever, keep everything" branch every single time.

**A deleted list left no trace for the other device.** Deleting a list removes its record, its order entry and its directory entry — so from any other browser, an account that no longer has the list is indistinguishable from one that never received it, which is the case `uploadMissingLocalListsToAccount` exists to repair. The phone uploaded it back.

### What Changed
- **`22`**: a gate — while a sign-in is known but its first load has not been applied, a push is remembered rather than sent and flushed once the load lands, with the intentional-removal flag preserved across the wait and a failsafe so a browser that starts offline still syncs.
- **`22`/`24`**: the config, tracking, presets and channels baselines are persisted per account, so the first push of a session cites the version this browser last actually saw.
- **`22`**: `shouldKeepLocalOnlyTracking` reads a persisted per-list baseline — the local list's own `updatedAt` at the last moment browser and account are known to have agreed. The plain server stamp cannot work, because the merge itself stamps `updatedAt = Date.now()`, which always lands after the version it just adopted.
- **`26`**: `save-tracking` takes `expectedClientVersion` and answers 409 rather than applying a push built on a version another browser replaced. Guarded on a dedicated `clientVersion` rather than `updatedAt`, because scrobble pings and the Continue Watching cron rewrite this record too and the existing rescue merge already handles those — a browser must not be refused because someone pressed play.
- **`02`/`26`**: `deleteCreatorLists` records the deletion on the account (`creatorlistdeleted:`, TTL- and size-bounded); `/api/creator/lists` reports it as `deletedSlugs`; `lists/save` retires it when the slug is deliberately re-created; the account purge takes it along, so a reclaimed username inherits nothing.

### Verification
Twenty tests covering both directions of each fix: the stale push is refused and the removal stands; the caught-up retry succeeds; a scrobble does not start a conflict; a versionless client still saves; a malformed version is rejected rather than dropping the guard; the delete reaches the other device and a re-create wins; the tracking push waits for the load and is not lost; a baseline belonging to another account is ignored.

### Note
The per-list tracking baseline only exists once a device has synced at least once on this build, so the first launch after deploying may still show one stale merge; from then on it is correct. The gate, the version guards and the deletion record take effect immediately.

## 2026-09-07b - Frontend audit: seventeen findings, and the first pass to drive a real browser

### Files Changed
`03_admin.js`, `09_page-shell.js`, `16_client-row-core.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`, `23_client-list-management.js`, `24_client-backup-restore-presets.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `render_check.js`, `html_checks.py`, `verify.sh`, `.github/workflows/ci.yml`, `tests/client-harness.mjs` (new), `tests/client.test.mjs` (new), `audit/frontend-2026-09-07/*`

### Root Cause
35,225 of 59,240 source lines are the builder UI, and every previous audit was a server-side audit: route execution against an instrumented Worker harness never renders a page or clicks anything. This pass drove a real browser against a real Worker. The full report and its 33 probes are in `docs/history/AUDIT-2026-09-07-FRONTEND.md` and `audit/frontend-2026-09-07/`.

The two criticals are worth restating. **FE-02**: ids from an imported list or channel reached markup unescaped — opening a shared list could execute script and read the victim's Creator Key from `localStorage`. **FE-01**: a single backslash inside the admin page's template literal became a real newline before the browser ever saw it, splitting a string across two lines and turning the whole 60 KB inline script into one `SyntaxError`; every admin control was dead for two days, and CI could not see it because nothing rendered that page.

### What Changed
All seventeen findings fixed — the ten ranked, the four below the line, and FE-17 found afterwards. Beyond the individual fixes:

- **`tests/client-harness.mjs`**: evaluates the real builder bundle against a DOM stub small enough to read, so the client's logic — payload shapes, response handling, state transitions — can be tested at all. It is not a browser and cannot test rendering; what it covers is the client/server contract, which is where a server change silently breaks the client.
- **CI**: renders and validates the admin page and the service worker as well as the builder page, because both are template literals that `node --check` sees as string content. That blind spot is what let FE-01 ship.
- **FE-17**: `/api/creator/sync/meta` gained a fifth stamp for custom lists. The four blob stamps could not carry a list change by construction, so a resumed browser kept rendering a list that had moved on. A canary test now fails the build if a new place mutates custom-list storage without bumping that stamp.

### Verification
315 tests, up from 286. Every fix verified twice: the probe that demonstrated the defect reports it gone, and the defect reintroduced by mutation makes the suite fail. Three tests were found to be decorative in the process and were replaced with ones that fail against the pre-fix code.

## 2026-09-06b - Adversarial audit II: cross-account disclosure, the cron, and KV/D1 consistency

### Files Changed
`02_http-and-creator-utils.js`, `03_admin.js`, `05_catalog-core.js`, `07_source-fetchers-tmdb-simkl.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `schema.sql`, `migrations/0001a`, `0001b`, `0003`, `0004`, `0005`, `gen_map.py`, `check_sync.py`, `tests/*`, `audit/adversarial-II-2026-09-06/*`

### Root Cause
A second adversarial pass over the code the first one had just fixed. Full report in `docs/history/AUDIT-2026-09-06-ADVERSARIAL-II.md`; what it found clustered in four places.

**Deleted data coming back.** A delete could report success while leaving the record live, and an account deleted and re-registered could inherit its predecessor's stray keys. **The cron.** Its sweep advanced past accounts it had not processed, one poisoned account could stop every account behind it, and `scheduled()` had none of the exception boundary `fetch()` had. **KV/D1 consistency.** Authentication read KV first, so a colo holding a cached pre-rotation record kept accepting the old key. **An empty provider reply erasing a good chart** — the write gate was "not null and not undefined", so a soft-failed upstream answering `200` with nothing counted as a refresh and overwrote all three cache tiers at exactly the moment the circuit breaker existed for.

### What Changed
Every finding fixed, plus five items the report left open (R1–R5): a delete path for anonymously published lists, which had none in any route; the conflict guard extended to the list write; a strongly-consistent D1 tombstone for deleted accounts; an index that removed a full table scan from the admin counters; and a read-and-union immediately before the list-order write, which took 12 concurrent creations from 9 surviving order entries to 12.

Three tests were found to be decorative and replaced — one of them because the whole suite runs in one Node process and a per-isolate memo made "the cache was not damaged" and "nothing happened" indistinguishable. `tests/harness.mjs` gained `freshIsolate()` so a test can ask what a cold colo actually sees.

### Verification
286 tests, up from 234. Seventeen mutations, one per fix: fifteen caught, and the two survivors explained rather than papered over — one decorative test replaced, one genuinely redundant line kept as belt-and-braces with the property tested instead of the mechanism. All 26 probes re-run against the fixed code.

## 2026-09-06a - Adversarial audit I: silent data destruction and false success

### Files Changed
`00_constants.js`, `02_http-and-creator-utils.js`, `03_admin.js`, `05_catalog-core.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `schema.sql`, `migrations/0003_add_missing_indexes.sql`, `tests/harness.mjs`, `tests/worker.test.mjs`, `audit/adversarial-2026-09-06/*`

### Root Cause
Twenty findings, and the first of them needed no credentials: `purgeCreatorData` built its D1 delete as `WHERE id LIKE '{username}:%'`, and `_` is LIKE's single-character wildcard. A creator named `a_c-films` deleting their own account also deleted every D1 row belonging to `abc-films`, `axc-films`, `a1c-films`. Usernames may be three all-underscore characters, so the scaled version needed one registration per length and `creator_lists` is empty for the whole deployment. KV still had the records, so nothing visibly broke — while the D1 like counts were gone and the next ordinary edit wrote those zeroes back into KV.

Four more were `ok: true` while doing nothing: a key rotation that reported success while rotating nothing, an account deletion that left the account authenticating, a failed purge that freed the username while the data survived, and an unpublish that answered success while the list stayed in the directory.

The structural cause behind several of them: D1 was preferred on read over KV, which is the store that is actually authoritative.

The test suite could not see any of it. `makeD1()` matched SQL with regexes, hardcoded `SELECT * FROM creator_lists WHERE id = ?` to return no rows — so `getCreatorList`'s D1 branch was never executed by any test — could never throw, and could not enforce a constraint. Seven of twelve controlled bugs survived the suite.

### What Changed
The harness first, because five of the fixes could not otherwise be proved: `tests/harness.mjs` now runs **real SQLite** loaded from the committed `schema.sql`, with foreign keys on and a fault injector. Then the twenty findings, in order of how bad the lie was.

Also landed: a size bound on the authenticated list write (an account had parked 21.8 MB across eight saves, returned in full on every dashboard render), `parseExpectedUpdatedAt` + `nextSyncVersion` so a frozen clock cannot defeat the conflict guard, no-store on every error response, a global exception boundary, and a schema-drift test that diffs both provisioning paths.

One item was deliberately not done and recorded with its reasoning: a `CHECK (visibility IN …)` constraint would have had to go into `schema.sql` alone, making a fresh database a different shape from a migrated one — exactly the drift that same pass had just closed.

### Verification
All twelve controlled bugs are killed, plus two new mutations aimed at the fixes themselves. The audit's own reproductions re-run: 120 random operations with D1 failing 15% and 40% went from 5 of 6 seeds diverging to all 6 consistent.

## 2026-09-05a - Independent production audit, and five bugs found by using the product

### Files Changed
`00_constants.js`, `02_http-and-creator-utils.js`, `03_admin.js`, `05_catalog-core.js`, `06_source-fetchers-mdblist-trakt.js`, `09_page-shell.js`, `16_client-row-core.js`, `20_client-channel-builder.js`, `22_client-creator-profile.js`, `23_client-list-management.js`, `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`, `html_checks.py`, `tests/*`, `docs/history/*`

### Root Cause
A full-repository pass that deliberately did not read the previous audits, so every finding was rediscovered from the source and by executing the Worker. Full report in `docs/history/AUDIT-2026-09-05-INDEPENDENT.md`. Two findings were release-blocking and both were silent:

**The public list directory permanently breaks itself at scale.** Past roughly 500 public lists the index rebuild exceeded Cloudflare's 1,000-subrequest limit, threw inside a `waitUntil`, never wrote the index, and the directory fell back forever to a truncated scan — with no error anywhere. An unauthenticated attacker could force it in about 90 minutes on a deployment with 20 real lists, because *private* junk lists still cost the rebuild one KV read each before the visibility filter ran.

**Creator accounts could be taken over by brute-forcing the recovery answer.** The only throttle was per-IP; rotating IPs defeated it entirely, and the endpoint hands back a working Creator Key.

Then five defects reported from real use, every one of them client-side — which is precisely where this audit's method does not look, and what prompted the frontend pass two days later. The worst had already left a live account with 129 public-directory entries for 22 real lists.

### What Changed
Both blockers fixed (resumable chunked rebuild; per-account daily failure budget plus minimum answer entropy), and the rest of the twenty findings besides: capability-grade thread ids with authorized appends, always-on rate limiting for the TMDB fan-out, SRI on the jsDelivr script, a scoped revocable token for media-server webhooks, slug allocation that can no longer overwrite an existing list, bounded and cacheable channel images, `applyLikeVote` retrying only on evidence that another writer landed, and `applyEnvApiKeys` called from both entry points so the cron cannot run with empty API-key globals.

The five field-reported bugs: channel "See All" collapsing every episode into one tile, Discover's Trakt lists 404ing, the runaway duplicate lists, a Watch History removal rebuilding the whole grid, and a grouped show tile removing from the wrong list.

`html_checks.py` gained the inline-handler resolution check the CSP comment had been citing for months without it existing, and the finished audit documents moved into `docs/history/`.

### Verification
The suite grew with a regression test per finding, each confirmed to fail against the pre-fix code. Three of the twenty findings are now recorded as accepted decisions rather than fixes — see `2026-09-07f` above, which closed the last of them.


## 2026-09-03d - Airing Next: legacy entries mislabelled type "movie" were filtered out of the series row

### Files Changed
`05_catalog-core.js`, `21_client-custom-list-builder.js`, `worker_entry_combined.js`, `tests/curated-recs-and-derived-lists.js`

### Root Cause
Diagnosed from live data rather than inference. The account's stored `airingNext` held both items correctly, the row's URL was correct (`autotrack:airing-next:series:james`), and `watch-history` / `continue-watching` previews returned 3 items each - but `airing-next` returned 0. The stored entries looked like this:

    { "id": "tt26545992", "type": "movie", "name": "The Weenie",
      "showId": "tt26545992", "showTitle": "Lanterns",
      "seasonNum": 1, "episodeNum": 4, "airDate": "2026-09-06", ... }

`fetchAutoTrackedCatalog` computed `isMovie` purely from the type string and dropped every one of them from a `:series:` row - while three lines later reading `showId`/`showTitle` to build a *series* meta from the same item. The type string and the structure of the item contradicted each other, and the weaker signal won.

The bad `type` came from an older client build. These entries are missing `canonicalTmdbId`, `episodeTitle`, `isSeasonPremiere` and `seasonFinaleEpisodeNumber` - all fields the current `airingEntryFrom` sets - so they predate it and had been carried in localStorage ever since. Nothing rebuilt them: `refreshAiringNext` short-circuits for six hours at a time, and its `needsEnrichment` escape hatch only fires on a missing `name`, which these have. So they survived indefinitely and were pushed to the account verbatim.

This is why the three previous fixes did not help - each addressed a real defect on the path between the browser and the account, but the data was arriving intact and being discarded at the last step.

### What Changed
- **`05`**: `fetchAutoTrackedCatalog` now decides movie-vs-series on structure first. An entry carrying `showId`, `showTitle`, `seasonNum` or `episodeNum` is a TV episode whatever its type string says; an entry with none of those still falls through to the original `kind`/`type` check, so real movie rows are unaffected. This is the same `isShow` heuristic the client's own list renderers already use - the two sides now agree about the same item.
- **`21`**: `airingEntryFrom` stamps `type: 'series'` explicitly instead of omitting it and letting each consumer apply its own default.
- **`21`**: `needsEnrichment` now also treats an entry whose `type` is anything other than `series` as stale-shaped, forcing exactly one rebuild for anyone still carrying legacy entries.

The server change alone fixes existing accounts without waiting for a client rebuild; the two client changes stop it recurring.

### Verification
Full pipeline: byte-consistency 27/27, `node --check`, sandboxed `renderBuilder()`, inner script (7 blocks), CSS balance (460 pairs), backtick counts in files 09-24 byte-identical to the project copies. All 21 suites pass. `curated-recs-and-derived-lists.js` gained 5 checks built from the actual failing production payload: the mislabelled entries serve in a series row and map with the show title, they do not leak into a movie row, and a genuine movie (no series fields) still sorts into the movie row and stays out of the series row - so the structural override cannot swallow real movie catalogs.

## 2026-09-03c - Airing Next catalog URLs never self-healed

### Files Changed
`23_client-list-management.js`, `worker_entry_combined.js`, `tests/airing-next-reaches-account.js`

### Root Cause
`repairAutotrackUrl` (called from `collectEntries`, so it runs on every Live Preview refresh and every autosave) rewrites the username segment of an `autotrack:` URL whenever it does not match the currently signed-in account. That covers a URL generated before `activeCreator` was threaded through - the old bug that baked the literal string `undefined` into that segment - and a URL left behind after switching Creator Profiles.

Its regex named only two slugs: `watch-history|continue-watching`. An `autotrack:airing-next:...` row was never matched, so it was the one autotrack row that could not correct itself. It kept resolving `creatorsynctracking:<wrong-username>`, missing, and returning an empty array - "No items found" indefinitely - while every other autotrack row on the same page silently repaired itself on the next `collectEntries()` and worked fine. That asymmetry is exactly the reported symptom: the dashboard card renders from localStorage and looked correct, the signed-out preview embeds a `customlist:v1:` snapshot of those same local items and worked, and only the signed-in row went through the URL that never got repaired.

### What Changed
- The slug is now matched generically (`[a-z0-9-]+`) rather than as a hardcoded pair, and the type segment accepts `mixed` alongside `movie`/`series`. Every autotrack slug reads the same per-account tracking record, so every one of them wants the same repair - and enumerating them individually meant each slug added later inherited the bug again. `watchlist` was silently in the same position and is now covered too.

### Verification
Full pipeline: byte-consistency 27/27, `node --check`, sandboxed `renderBuilder()`, inner script (7 blocks), CSS balance (460 pairs). Backtick counts in files 09-24 verified byte-identical to the pristine project copies (the earlier "hazard scan" figures were line counts, not occurrence counts - no backticks were introduced in any change this session). All 21 behavioural suites pass; `airing-next-reaches-account.js` gained 10 checks driving the real `repairAutotrackUrl` sliced out of the bundle, including that the two previously-covered slugs behave exactly as before and that a signed-out browser still leaves URLs alone.

### Note
The affected row repairs itself on the next Live Preview refresh once this is deployed - no need to remove and re-add it.

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
