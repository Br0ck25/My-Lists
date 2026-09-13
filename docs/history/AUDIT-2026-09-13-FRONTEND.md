# My Lists — Frontend Adversarial Audit (2026-09-13)

**Date:** 2026-09-13
**Commit audited:** `73f2dd8` ("optimizations and bug fixes"), on `claude/serene-ramanujan-kak7m7`.
That branch is **identical to `main`** (`git log main..HEAD` is empty), so everything below
describes `main`.
**Method:** independent pass first — no prior audit was read until §Regression Findings.
Static reading of the 16 frontend sources, then **execution**: the real
`worker_entry_combined.js` served over HTTP against the repo's own in-memory KV and
SQLite-backed D1, driven by **real Chromium**.
**Probes:** [`audit/frontend-2026-09-13/`](../../audit/frontend-2026-09-13/) — every claim
below names the probe that produced it and its output is quoted verbatim.

---

# Frontend Audit Summary

**Frontend files audited** (16 sources, 41,196 lines, concatenated into the served page):

`09_page-shell.js` (3,648) · `10_tab-search-add.js` (181) · `11_tab-quick-add.js` (86) ·
`12_tab-custom-lists.js` (162) · `13_tab-channels.js` (257) · `14_tab-presets-backup.js` (80) ·
`15_tab-settings-html.js` (419) · `16_client-row-core.js` (2,510) ·
`17_client-my-lists-and-trakt-oauth.js` (2,200) · `18_client-copy-and-trakt-export.js` (2,242) ·
`19_client-search-and-likes.js` (3,957) · `20_client-channel-builder.js` (9,517) ·
`21_client-custom-list-builder.js` (3,537) · `22_client-creator-profile.js` (5,965) ·
`23_client-list-management.js` (2,714) · `24_client-backup-restore-presets.js` (3,721)

**Generated files audited:** `worker_entry_combined.js` (3,325,143 bytes rebuilt — byte-identical
to the committed file modulo CRLF), the rendered builder page (1,972,580 chars), the split
`/app.js` bundle (1,625,769 chars) and `/app.css` (96,327 bytes), `/sw.js`, and the admin page.

**Environment:** Chromium 141.0.7390.37 (headless), Node v22.22.2, Linux.
Worker served on `127.0.0.1:8787` with real D1 (SQLite) + KV; upstream providers stubbed.

**Interactions performed:** ~1,050 scripted browser interactions across 16 probes — 9 viewports ×
6 tabs, 400 randomized modal sequences, 120 modal open/close cycles, 14 malformed backups,
9 injected API failure modes, 2 real accounts through a full sign-in/sign-out/switch cycle,
and a stored XSS payload published through the real API and loaded as a real navigation.

## Headline

**The frontend is in good shape.** Five of the seven areas this prompt treats as most
dangerous — XSS/DOM sinks, cross-account state, fault recoverability, modal lifecycle, and
offline/PWA — were tested adversarially and **held**. The hostile-render CI gate in particular
is doing real work: a `</script>`-breakout payload stored through the live publish API came
back `<`-escaped in the inline preamble and did not execute.

Two confirmed defects matter:

1. **FE2-01 (HIGH)** — a backup whose list `name` is a JSON **number** throws an uncaught
   `TypeError` partway through import. Reproduced end-to-end: **8 catalogs → 1**, no error
   shown. This is the exact failure the importer's own header comment says it exists to
   prevent.
2. **FE2-02 (HIGH)** — `markShowWatched` fires an un-awaited background job that races its own
   commit. Toggling watched→unwatched quickly leaves the show still flagged fully-watched and
   a phantom companion in Continue Watching while the button says the opposite. **This is also
   the one failing test on `main`** — CI is red at `73f2dd8`.

---

# Critical Frontend Bugs

None. No exploitable XSS, no cross-user data exposure, no authentication bypass, and no
application-breaking failure was found. See [Confirmed Working Areas](#confirmed-working-areas)
for what was actually tested to reach that conclusion.

---

# Functional Bugs

## FE2-01 — HIGH — A backup with a numeric list name destroys the user's catalogs and reports nothing

| | |
|---|---|
| **File** | `16_client-row-core.js:2282` (sink) · `24_client-backup-restore-presets.js:203` `importConfigJson`, `:279` `validateAndRepairBackup`, `:387` `applyImportedConfig` (callers) |
| **Probe** | `t07_import_dataloss.mjs` (end-to-end), `t06_backup_fuzz.mjs` (case `wrong types`) |
| **Severity** | HIGH — reliable data loss on the one path users reach *because* something already went wrong |

**Exact problem.** `addRow` coerces defensively everywhere — `String(url \|\| '')`,
`String(name).trim()` on line 2244, `String(channelId)` — except on line 2282:

```js
const avatarLetter = escapeHtml(((name || group || 'L').trim()[0] || 'L'));
```

`.trim()` is called on `name` with no coercion. A truthy non-string `name` throws
`TypeError: (name || group || "L").trim is not a function`.

`validateAndRepairBackup` does not repair this. It reads the name as a string into a local
(`const name = String((e && e.name) || '')`, line 295 inside `validateAndRepairBackup`) but only ever writes back in the
name/url-swap case, so a numeric name reaches `addRow` unconverted.

**Reproduction** (`node audit/frontend-2026-09-13/t07_import_dataloss.mjs`):

1. Load the app with the default 8 catalog rows.
2. Paste this backup into the Import box and press Import — note entry 2's name is an
   unquoted number, which is what a hand-edited backup or a third-party generator produces:

```json
{"version":"3.0","entries":[
  {"name":"My Good List","url":"tmdb:chart:popular","type":"movie","enabled":true},
  {"name":2024,          "url":"tmdb:chart:top_rated","type":"movie","enabled":true},
  {"name":"Another List","url":"tmdb:chart:trending","type":"movie","enabled":true}]}
```

**Expected.** All three rows imported (the file's own contract: *"Nothing is rejected… repair
what can be repaired, report what cannot, and never fail silently"*), or a repair note saying
one name was coerced.

**Actual** (verbatim probe output):

```
rows BEFORE import: 8
   evaluate rejected (uncaught in handler): page.evaluate: TypeError: (name || group || "L").trim is not a function
AFTER import: { "rows": 1, "rowNames": ["My Good List"], "modalText": "", "scrollLocked": false, "stillWorks": true }
>>> DATA LOSS: valid entries were dropped and no report shown
```

The user's 8 existing catalogs are gone, 1 of 3 entries was imported, the import-report modal
never renders, and **nothing is shown to the user** — `importConfigJson` wraps only
`JSON.parse` in a `try`, so the throw escapes the click handler uncaught.

**Impact.** Someone restoring their only backup silently loses their catalog configuration and
two thirds of the backup. This is precisely the scenario the importer was written for.

**Reach — stated precisely.** This is reachable through **backup import only** (paste box and
file upload; both funnel into `applyImportedConfig`). It is **not** reachable through account
sync: `creator_lists.name` is a D1 `TEXT` column, so a numeric name POSTed to
`/api/creator/lists/save` is normalised and reads back as the string `"2024"` — verified.

**Recommended fix.** Coerce at the shared sink, which every caller goes through:

```js
const avatarLetter = escapeHtml((String(name || group || 'L').trim()[0] || 'L'));
```

Additionally, in `validateAndRepairBackup`, normalise and report rather than relying on the
sink — `if (e && e.name != null && typeof e.name !== 'string') { e.name = String(e.name); coerced++; }` —
and wrap `applyImportedConfig(data)` in `importConfigJson`/`uploadConfigFile` in a `try/catch`
that surfaces `showAppAlert` instead of letting an exception escape a click handler.

**Regression test.** `t06_backup_fuzz.mjs` already asserts the shape; add to
`tests/client.test.mjs`: import a backup with `name: 2024` and assert all three entries land and
`#lists .entry` count is 3. Mutation check: reverting line 2282 to `.trim()` must fail it.

---

## FE2-02 — HIGH — `markShowWatched`'s background job races its own commit (and is the failing test on `main`)

| | |
|---|---|
| **File** | `21_client-custom-list-builder.js:1812` (the un-awaited call) · `:1835` `markShowWatched` · `:1940–1985` (the commit it races) |
| **Probe** | `t02_markshowwatched_race.mjs` |
| **Severity** | HIGH — reliable wrong persisted state, and it syncs to the server |

**Exact problem.** `toggleBatchWatchStatus` ends with a floating promise:

```js
updateContinueWatchingForBatch(items).catch(() => {});   // line 1812, not awaited
...
return { added, removed, nowWatched: !allWatched };
```

`markShowWatched` calls that **synchronously**, then does its own authoritative commit inside
`withCwCommitLock` — evicting the completed show, injecting a storyline companion, or (on
unwatch) removing the queued companion. Both paths mutate `_fullyWatchedShowIds` and the
`continue-watching` list. The background job started first and finishes later, so a second
toggle that begins before it settles is overwritten by the first toggle's stale result.

**Reproduction** (`node audit/frontend-2026-09-13/t02_markshowwatched_race.mjs`). The probe
varies exactly one thing — the gap between "Mark Show Watched" and "Mark Show Unwatched":

```
{"settleMs":0,  "fullyWatched":["tt0903747","1396","tmdb:1396"],"cwIds":["tt9243946"],"companionLeft":true, "btn":"says-Watch"}
{"settleMs":1,  "fullyWatched":[],                              "cwIds":[],          "companionLeft":false,"btn":"says-Watch"}
{"settleMs":5,  "fullyWatched":[],                              "cwIds":[],          "companionLeft":false,"btn":"says-Watch"}
{"settleMs":25, "fullyWatched":[],                              "cwIds":[],          "companionLeft":false,"btn":"says-Watch"}
{"settleMs":100,"fullyWatched":[],                              "cwIds":[],          "companionLeft":false,"btn":"says-Watch"}
```

**Expected.** After unwatching, the show is not fully-watched and the queued companion
(`El Camino`, `tt9243946`) is gone.

**Actual at a 0 ms gap.** The show is **still flagged fully watched**, the companion is
**still in Continue Watching**, while the button reads "Mark Show Watched" — the UI and the
persisted state say opposite things. `scheduleCreatorSyncSave()` then pushes that wrong state
to the account.

**Technical root cause.** `updateContinueWatchingForBatch` → `updateContinueWatching(showId)`
re-derives and rewrites the same two pieces of state that `markShowWatched`'s locked commit
just wrote, but it is not inside `withCwCommitLock` and nobody awaits it. Instrumenting it
with one extra microtask (wrapping it in `Promise.resolve().then()`) makes the bug disappear —
the signature of a scheduling race, not a logic error.

**Impact.** In the harness, fetches resolve in microtasks, so the window is ~0 ms. **In a real
browser the window is a real network round trip**: `updateContinueWatching` issues its own
`/api/season` request (the probe shows a third season fetch — `seasonNum=3` for a two-season
show — coming from it). So the exploitable gap in production is hundreds of milliseconds, and
the button is re-enabled (`btn.disabled = false`, line 1912) *before* that background work
finishes. An impatient user toggling watched/unwatched is the intended repro.

**This is the failing test on `main`.** `tests/client.test.mjs:3086`
("markShowWatched synchronously evicts completed show and immediately injects storyline
companion") fails with *"queued companion must be cleaned up when show is unmarked"*.
`node --test tests/client.test.mjs` exits **1** (559 tests, 557 pass, 1 fail, 1 skipped), so the
repo's own CI "Test suite" step is red at this commit.

**Corroboration from the codebase itself.** The *other* call site already awaits it, and its
comment names the fire-and-forget explicitly (`21_…:2068-2073`, in `addItemsToWatchHistory`):

```js
// Awaited (unlike toggleBatchWatchStatus's own fire-and-forget call
// above) -- this is what a bulk importer processing dozens or hundreds
// of shows actually needs: ...
const cwResult = await updateContinueWatchingForBatch(items);
```

So the bulk path was made to wait; the interactive toggle path was not.

**Recommended fix.** Await the background reconciliation before committing, and put it under
the same lock:

- have `toggleBatchWatchStatus` **return** the promise (`return { ..., cwUpdate: updateContinueWatchingForBatch(items) }`)
  instead of dropping it, and have `markShowWatched` `await result.cwUpdate` before entering
  `withCwCommitLock`; or
- move the `updateContinueWatchingForBatch` call **inside** `withCwCommitLock` so the lock
  serialises it against the commit.

Keep the button disabled until the whole sequence settles.

**Regression test.** The existing test already covers it — it must go green. Add a second case
asserting `_fullyWatchedShowIds` is empty after unwatch, since today the companion assertion
fails first and masks that.

---

# Mobile / Responsive Bugs

## FE2-03 — MEDIUM — The "Update Link" CTA is two-thirds clipped at 320 px

| | |
|---|---|
| **File** | `09_page-shell.js:3217` (`.unsaved-install-banner`), `:3264` (`.unsaved-install-banner-btn`), markup `:3350` |
| **Probe** | `t05_banner_320.mjs` |
| **Severity** | MEDIUM — the primary call-to-action for pushing config changes to Stremio/wako |

**Exact problem.** The banner is `display:flex` with the default `flex-wrap:nowrap`,
`white-space:nowrap`, and `max-width: calc(100vw - 24px)`. The button is `flex-shrink:0`.
The label span has no `min-width:0` / `overflow:hidden`, and with `nowrap` its min-content
width *is* its full text width — so it cannot shrink, the flex line overflows the banner's own
capped box, and the button is pushed past it. `.page` is `overflow-x:hidden`, so there is no
scrolling to it.

**Reproduction.** Add a catalog row, generate an install link, change something (the banner
gets `.show`), at each viewport width. Verbatim, after the 0.25 s transition settles:

```
W=320   bannerRect{l:12,r:308}  btn{l:283,r:394,w:111}  visibleW=37   hitAtCentre=unsavedInstallBtn
W=375   bannerRect{l:12,r:363}  btn{l:283,r:394,w:111}  visibleW=92   hitAtCentre=unsavedInstallBtn
W=412   bannerRect{l:12,r:400}  btn{l:283,r:394,w:111}  visibleW=111  hitAtCentre=unsavedInstallBtn
W=768   bannerRect{l:178,r:575} btn{l:449,r:560,w:111}  visibleW=111  hitAtCentre=unsavedInstallBtn
```

**Expected.** The button is fully inside the viewport at every supported width.

**Actual.** At 320 px only **37 px of its 111 px** is on screen (its right edge is at x=394,
74 px past the viewport and 86 px past the banner's own right edge). The label is cut mid-word
and the remaining tap target is 37 px wide — under the 44 px minimum. Degrades through 375 px
(92 px) and 390 px (107 px); correct from 412 px up.

**Two things this is *not*** — both checked, because the first measurement suggested them:

- It is **not** unreachable: the visible strip is hittable (`hitAtCentre=unsavedInstallBtn`).
- The bottom nav does **not** cover it. An earlier measurement taken mid-transition showed
  `NAV.bottom-nav` at the hit point; that was the `translateY(30px)` entry animation, not the
  settled layout. Once settled, `overlapsNav:false` at every width.

**Recommended fix.** Let the label give up space instead of the button:

```css
.unsaved-install-banner { flex-wrap: wrap; }          /* or keep nowrap and add: */
#unsavedInstallText { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
```

Removing `white-space:nowrap` from the banner (keeping it on the button) also fixes it.

**Regression test.** Extend `t12_responsive.mjs`: at 320 px assert
`btn.getBoundingClientRect().right <= window.innerWidth` for `#unsavedInstallBtn` with the
banner shown.

---

# Race Conditions

**FE2-02** above is the one with persisted consequences; its competing operations and why the
stale write wins are documented there.

## What was tested and did *not* race

| Concurrent interaction | Result |
|---|---|
| Double-click Like / rapid like-unlike | **Safe.** `19_client-search-and-likes.js:1142` sets `likeBtn.disabled = true` before the fetch, re-enables in `finally`, and the delegated handler re-checks `!likeBtn.disabled`. The count rendered is the server's `data.likes`, not the optimistic guess. |
| Double-click "Create Profile" / "Login" | **Safe.** `beginSubmit('restoreProfile', …)` is a single-flight guard, armed *after* validation so a rejected form does not latch it. |
| Rapid typing in title search | **Safe.** `currentTitleSearchSequence` is captured and re-checked after `await` on all three exit paths (`runCatalogSearch`, `19_…:3915/3934/3948` — the captured seq at 3915 re-checked at 3934 and 3948). |
| Rapid typing in list search | **Safe.** `currentListSearchSequence`, same pattern, checked after `Promise.all` of four parallel fetches (`19_…:422/472`). |
| Cross-device list edit | **Safe by design.** `expectedUpdatedAt` optimistic-concurrency token, with `409 → loadCreatorSync({background:true})` rather than clobbering (`22_client-creator-profile.js`, `pushChannelsSync` and siblings). |

### Not reproduced — cross-mode search clobber (POTENTIAL, see §Potential)

`runCatalogSearch` keeps **two independent counters** and both write into the same
`#catalogSearchResult`. Switching the chip from Movies to Lists mid-flight does not bump the
title counter, so a stale title response still passes its guard. The success path is saved by
`applySearchFilters`'s (3745) `if (currentCatalogSearchType === 'lists') return;`, but the *error* and
*empty* paths (`19_…:3936`, `:3941`, `:3949`) write `resEl.innerHTML` with no type check.
**I could not make this visibly clobber** — the captured `resEl` appears to be detached by the
time the stale response lands. Logged as POTENTIAL, not a confirmed bug.

---

# State Management Bugs

Beyond FE2-02, the two scroll-lock defects below are state-lifecycle bugs in the modal layer.

## FE2-04 — LOW (latent) — Scroll-lock depth is incremented on re-open but not on redundant close

| | |
|---|---|
| **File** | `19_client-search-and-likes.js:3142` (in `openSelectListModal`, 2845) · `22_client-creator-profile.js:5137` (in `openCreateListModal`, 5094) · counter at `16_client-row-core.js:912` |
| **Probe** | `t03_scrolllock_invariant.mjs` |

`lockBackgroundScroll` is correctly depth-counted. But the two static modals call
`lockBackgroundScroll(true)` **unconditionally on open**, including when already displayed,
while `closeSelectListModal`/`closeCreateListModal` early-return when already hidden and
therefore do **not** decrement. Two opens plus one close leaves the depth stuck above zero:
no modal visible, page permanently unscrollable, refresh-only.

A 400-sequence randomized test of the invariant *"no modal open ⇒ page not scroll-locked"*
finds 6 violations, every one of them a double-open:

```
INVARIANT VIOLATIONS (no modal open but page scroll-locked): 6
  SEQ: openSelect > openSelect > openSelect > openSelect
  SEQ: closeSelect > openCreate > openCreate > openCreate
  SEQ: openSelect > openCreate > openCreate > openSelect
  ...
```

**Honest reachability.** I could **not** reach it through the UI. Mouse double-click on
"+ New List" does not work — the modal covers the trigger before the second click
(`t12`-style check: `afterClose overflow:""`). Keyboard double-Enter does not work either —
`openCreateListModal` moves focus into an input, so the second Enter does not re-fire
(`after Enter #2` leaves depth at 1, `after Escape` → `overflow:""`). Classified **latent /
hardening**, not a live user bug. It is one line each to make it safe.

**Fix.** Make open idempotent, mirroring close:

```js
const modal = document.getElementById('createListModal');
if (modal && modal.style.display !== 'flex') { modal.style.display = 'flex'; lockBackgroundScroll(true); }
```

## FE2-05 — LOW — A dialog raised over a static modal releases the static modal's scroll lock

| | |
|---|---|
| **File** | `16_client-row-core.js:1052` (`showModal`) / `:1081` (`closeModal`) |
| **Probe** | `t04_scrolllock_static.mjs` |

`showModal` begins with an unconditional `closeModal()`, and `closeModal` calls
`lockBackgroundScroll(false)` whether or not a dynamic overlay existed — consuming a *static*
modal's lock. Closing the dynamic dialog then drops the depth to zero while the static modal is
still open:

```
B) dynamic modal over static modal
    {"afterStaticOpen":"hidden","afterAlertOpen":"hidden","afterAlertClose":"","staticStillOpen":"flex"}
    page scrolled behind open modal to Y = 600
```

**Impact.** Cosmetic-with-consequence: the page scrolls away under a still-open dialog, worst
on mobile. The inverse (a stray `closeModal()` underflowing the counter) is correctly guarded —
`if (_scrollLockDepth === 0) return;` — and case C of the probe confirms it.

**Fix.** Only release the lock for an overlay that actually existed:

```js
function closeModal() {
  const existing = document.getElementById('activeModalOverlay');
  if (!existing) return;                 // nothing of ours is open; do not touch the counter
  existing.remove();
  document.removeEventListener('keydown', handleModalKeydown, true);
  lockBackgroundScroll(false);
  ...
}
```

---

# Authentication / UI Security

**No finding.** This area was attacked directly and held.

### Stored XSS through the real publish path — does not execute

A `</script>`-breakout payload was published through the live API into the list `name`,
`description`, item `name`, item `year` and item `poster`:

```
POST /api/creator/lists/save  {"name":"</script><img src=x onerror=\"window.__XSS=…\"><svg onload=…> EvilList", …}
-> {"ok":true,"url":"http://127.0.0.1:8787/lists/alice/evil-list"}
```

Loading `/lists/alice/evil-list` as a **real browser navigation** (`Sec-Fetch-Mode: navigate`,
251,204-byte HTML page) shows the payload `<`-escaped inside the inline preamble:

```js
const SERVER_DEEP_LINK_LIST = {"name":"</script><img src=x onerror=\"window.__XSS=…\">…"}
```

`raw '</script><img' present: False` · `raw 'onerror="window.__XSS' present: False` ·
`< count: 9`. In Chromium: `{"xss":0,"strayImg":0,"straySvg":0,"booted":true}`.
Non-vacuity was checked — a benign control list renders its name normally, and the escaped
payload *is* present in the page, so the check is not passing by rendering nothing.

Note the same path answers **`application/json`** to non-navigation requests (with
`X-Content-Type-Options: nosniff`), so the raw payload visible in that JSON is inert.

### Hostile API data through every render path — does not execute

`t10_hostile_render.mjs` serves every list/item/creator/search field as an XSS payload and
clicks through all six tabs. Result: `{"xss":0,"xssurl":0,"rawProbeInText":false}`, zero page
errors. 1,053 attributes contained the payload **as data** (`data-title="…"`,
`data-poster="…"`) with no breakout. The 423 `img[onerror]` and 133 `javascript:` hrefs on the
page are the app's own `handlePosterImgError(this)` and `javascript:void(0)` — not injected.

**One hardening note (INFO).** An attacker-controlled `poster` value reaches
`<img src>` and `data-poster` unvalidated — `IMG[src]=javascript:window.__XSSURL=1` was
observed. `javascript:` in `img src` is not a navigable context and did not fire
(`__XSSURL: 0`). It is only a problem if `data-poster` is ever copied into an `<a href>` or
`location`. Every navigation sink in the client is `ORIGIN`-prefixed today
(`17_client-my-lists-and-trakt-oauth.js:426/570/1199/1493`), so this is defence-in-depth, not a
bug. Suggest rejecting any poster URL not matching `^https?:` at the render helper.

### Account switching — no contamination

`t11_account_switch.mjs` runs two real accounts (`alice`, `bob`) through the real
`/api/creator/restore`, seeds alice with a marker watch-history item, a Trakt token and a liked
list, signs out, and signs in as bob:

```
AFTER SIGNOUT ls keys: ["myListAddon:discoverSubmenu","myListAddon:activeTab","myListAddon:state","myListAddon:localCustomLists"]
LEAK AFTER SIGNOUT: {"hasAliceMovie":false,"hasAliceToken":false,"domHasAlice":false,"memWatchIds":0,"memLists":["watchlist"]}
AFTER BOB LOGIN:    {"activeCreator":"bob","hasAliceMovie":false,"hasAliceToken":false,"domHasAlice":false}
```

Clean across localStorage, sessionStorage, the DOM, and in-memory sets.
`clearLocalAccountData` (`22_client-creator-profile.js:1158`) correctly clears the
sessionStorage mirror too — `loadLocalCustomLists` reads sessionStorage *before* localStorage,
so clearing only the latter would have left the previous account's lists on screen.

### Shared `/app.js` carries no per-request data

This one matters because `APP_BUNDLE` is a **module-level singleton** populated by whichever
request renders first, then served to every visitor under an immutable 1-year cache. If any
per-request value leaked into the marker region, the first visitor's OAuth tokens would be
cached and served to everyone. `t01_bundle_stability.mjs` renders six variants — different
origin, configure mode, OAuth tokens, entries, deep link — and the extracted bundle is
**byte-identical (1,625,769 chars) in all six**, with none of the sentinel secrets present.

---

# Frontend ↔ Backend Contract Bugs

None found. The D1 + KV migration has not left stale assumptions in the client on the paths
exercised.

| Frontend expectation | Actual backend behaviour | Verdict |
|---|---|---|
| `/api/preview` → `{ok, count, totalItems, maybeMore, sample[]}` | Matches (`25_api-catalog-routes.js:968`) | OK |
| `/api/creator/lists/save` → `{ok, slug, updatedAt, url}` | Matches; `updatedAt` feeds the `expectedUpdatedAt` conflict guard | OK |
| 409 on a stale `expectedUpdatedAt` → pull, don't clobber | Client handles `res.status === 409` explicitly | OK |
| `/lists/<creator>/<slug>` returns a page to browsers, JSON to fetches | Content-negotiated on `Sec-Fetch-Mode` (`02_http-and-creator-utils.js:294`) | OK |
| Non-JSON / non-ok responses | Client checks `res.ok` **and** `content-type` before `.json()` in the list-search fetches | OK |
| Numeric `name` POSTed to the list API | Normalised to TEXT by D1, reads back as `"2024"` | OK — and why FE2-01 is import-only |

**Rate-limit behaviour is live and shapes the UX:** a second `POST /api/creator/create` from
the same IP returns `{"ok":false,"error":"Please wait a moment before creating another Profile."}`.
The client surfaces this verbatim, which is correct.

---

# PWA / Service Worker

**No bug found.** The hypothesis I went in with — that a post-deploy visit to a non-`/` page
caches the new bundle and evicts the old one, stranding the still-cached old shell offline —
**did not reproduce**. `t13_sw_offline.mjs` runs it end-to-end against two real builds on one
origin (`server-hotswap.mjs`):

```
1. first online load (deploy v1)   SW controller: true   caches: {"mylists-shell-v2":["/"]}
2. offline reload                  title OK, app booted offline: true
3. DEPLOY v2, visit /guide then /?src=share
                                   caches: {"mylists-shell-v2":["/"],
                                            "mylists-assets-v2":["/app.css?v=6e29…","/app.js?v=758d…"]}
4. offline, navigate to "/"        {"booted":true,"bodyLen":4169}  -> offline still works
```

Two observations worth recording (neither is a defect today):

- **The assets cache is empty after the very first load.** The SW claims clients on `activate`,
  which is after that page's subresources were already requested — so `/app.js` on a first
  visit never goes through the SW. Offline survival of `/app.js` on that first session rests on
  the **HTTP** cache (`max-age=31536000, immutable`), not the SW cache. That is fine, but it
  means the SW's asset cache is a second line of defence, not the first.
- **The asset cache prunes the previous hash for the same pathname** (`sw.js`, the
  `cache.keys()` loop). Combined with the shell being refreshed only on a bare `/` navigation
  (`url.pathname === SHELL_URL && !url.search`), a stale shell paired with a pruned bundle is
  *theoretically* possible; it did not occur here because the shell tracked the new deploy.
  Cheap hardening: key the shell entry by the bundle hash it references, or don't prune a hash
  that the currently-cached shell still points at.

---

# Performance / Memory

- **No listener or node leak in the modal layer.** 120 `showModal`/`closeModal` cycles:
  element count **5758 → 5758**, `#activeModalOverlay` count 0, `overflow` restored,
  `document.body.children` unchanged. `showModal` calls `closeModal()` first, so overlays
  cannot stack, and `handleModalKeydown` is removed on every close.
- **No `AbortController` anywhere in the client.** In-flight requests are never cancelled on
  navigation/modal close; staleness is handled by sequence counters instead. That works (the
  guards are correct) but means abandoned work still completes and still costs quota. INFO.
- **Load-time request fan-out.** A cold load issues **78 API calls** (51 distinct). I initially
  flagged 27 of these as duplicates — **that was wrong and is retracted**: with realistic
  responses they are `fetchListPreviewWithRetry`'s single retry, which only fires because my
  first stub returned empty lists. Stack traces confirmed it (`fetchListPreviewWithRetry:7831`
  sync vs `:7836` async). Worth knowing: `fetchListPreviewWithRetry` retries **immediately** on
  any non-ok that is not a 429, and `fetchPreviewForSlot` additionally retries with the opposite
  media type when a preview returns an empty sample — so a genuinely empty or failing list
  costs up to 4 requests per card against a rate-limited endpoint. Consider backing off on 5xx
  the way it already does on 429.

---

# Accessibility Bugs

The modal and tab work here is genuinely good (see Confirmed Working). One real finding:

## FE2-06 — LOW — Three inputs are labelled only by their placeholder

| Input | Tab | Placeholder |
|---|---|---|
| `#listFilterInput` | Catalogs | "Filter catalogs by name…" |
| `#channelMergeNameInput` | Channels | "Combined catalog name" |
| `#catalogSearchInput` | Search | "Search by title or list" |

Per-tab scan (`t14_a11y.mjs`), all other inputs are labelled — Settings has 22 inputs and
**0** unlabelled:

```
catalogs   {"inputs":4,"unlabelled":1,...}   lists    {"inputs":0,"unlabelled":0,...}
channels   {"inputs":2,"unlabelled":1,...}   discover {"inputs":0,"unlabelled":0,...}
search     {"inputs":4,"unlabelled":1,...}   settings {"inputs":22,"unlabelled":0,...}
```

A placeholder is not an accessible name: it disappears on first keystroke and is inconsistently
announced. **Fix:** add `aria-label` to those three. One line each.

### Two INFO-level observations

- **Two `<h1>` elements** on the page (`h1count: 2`). Harmless but ambiguous for
  screen-reader document structure; demote one to `<h2>` or make it visually-hidden.
- **One live region for the whole app** (`[aria-live]/[role=status]/[role=alert]` count: 1).
  Async outcomes — search finished, import repaired N rows, save failed — are rendered into
  ordinary containers, so a screen-reader user is not told. Routing `showAddedToast` /
  `showAppAlert` text through an `aria-live="polite"` region would cover most of it.

---

# Confirmed Working Areas

Everything here was **executed**, not read. This section exists so the report is not just a
list of problems — most of what I attacked held.

| Area | What was done | Result |
|---|---|---|
| **Stored XSS via published lists** | `</script>`-breakout payload stored through the real publish API, page loaded as a real navigation in Chromium | **Inert.** `<`-escaped in the preamble, `__XSS: 0`. Non-vacuity verified against a benign control. |
| **Hostile API data end-to-end** | Every list/item/creator/search string served as a payload; all 6 tabs clicked | **Inert.** 1,053 tainted attributes, zero breakouts, zero page errors. |
| **Shared bundle isolation** | 6 render variants (origin, configure, OAuth tokens, entries, deep link) | Bundle **byte-identical** (1,625,769 chars), no sentinel secret present. |
| **Account switching** | Two real accounts, full sign-in → seed → sign-out → sign-in cycle | No contamination in localStorage, sessionStorage, DOM, or memory. |
| **Fault recoverability** | 9 injected failure modes — 500, 401, 429, malformed JSON, empty body, HTML-not-JSON, `ok:true` with no fields, null arrays, aborted connection | **9/9 recover.** No stuck spinner, no blocking overlay, no leaked scroll lock, navigation still works, **zero page errors** in every case. The answer to *"can a normal user get stuck without refreshing?"* is **no** on every path I could fault. |
| **Modal lifecycle** | 120 open/close cycles; Escape; outside click; stacked modals | No node growth (5758 → 5758), no duplicate overlays, Escape closes, focus moves to the `<h2>` on open and returns to the trigger on close. |
| **Offline / PWA** | First load, offline reload, deploy, deep-link visit, offline navigation | Works at every step, including offline **across a deploy**. |
| **Responsive** | 9 viewports (320→1920) × 6 tabs | **Zero page-level horizontal scroll everywhere.** Off-viewport pills are inside a real `overflow-x` strip (`.subnav-pills-bar`, scrollWidth 952 / clientWidth 315), not clipped. Only FE2-03 is a genuine clip. |
| **Accessibility basics** | Per-tab scan + keyboard | **0** clickable non-buttons, **0** images without `alt` (351 images), **0** buttons without an accessible name, 12 `role="tab"` all carrying `aria-selected`, 2 `role="tablist"`, focus ring present. |
| **Double-submit guards** | Like, Create Profile, Login | All single-flight; like uses the server's authoritative count. |
| **Search staleness (same mode)** | Sequence counters in both search paths | Correct — captured before `await`, re-checked on every exit path. |
| **Backup import robustness** | 14 malformed backups | 13/14 handled cleanly — empty object, null entries, non-array entries, missing fields, transposed name/url, XSS in names, unsafe id chars, **`__proto__` and `constructor.prototype` pollution** (both blocked: `polluted: null`), 1.x and 2.0 formats, duplicate ids, 300 entries. Only the numeric-name case (FE2-01) fails. |
| **External CDN failure** | `cdn.jsdelivr.net` unreachable in this sandbox | Handled: `typeof fflate === 'undefined'` guards with a real user-facing message at all three call sites. |
| **Build integrity** | `python3 build.py` + diff | No drift; combined Worker matches its 27 sources byte-for-byte (modulo CRLF). `node --check` passes. |

---

# Console / Network Errors (actually observed)

Only one, and it is an artifact of this sandbox having no outbound internet:

```
error: Failed to load resource: net::ERR_CONNECTION_RESET
  GET https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
  GET https://fonts.googleapis.com/css2?family=Space+Grotesk…
```

**Zero uncaught page errors** across every probe: tab sweep, hostile-data render, 120 modal
cycles, 9 fault-injection scenarios, 9 viewports, and the account-switch cycle. The only
JavaScript exception produced in the entire audit is FE2-01's `TypeError`.

---

# Source vs Generated Frontend

Verified, not assumed:

- `python3 build.py` reproduces `worker_entry_combined.js` — `git diff --ignore-cr-at-eol` is empty, `node --check` passes. The committed artifact has **CRLF** line endings while the committed sources have **LF**, which is why every check in `verify.sh` and CI is CRLF-insensitive. That is deliberate, not drift — but see **FE2-07**.

## FE2-07 — LOW — `check_sync.py` fails on a clean checkout, and its suggested remedy churns the Worker

| | |
|---|---|
| **File** | `check_sync.py` |
| **Severity** | LOW — developer-facing tooling, but the advice it prints is actively harmful |

`check_sync.py` compares bytes **exactly**. The committed `worker_entry_combined.js` blob
contains CRLF; the committed sources (e.g. `00_constants.js`) are LF-only; there is no
`.gitattributes`. So on a clean, unmodified checkout it fails:

```
$ git status --porcelain -- worker_entry_combined.js     # empty: tree is clean
$ python3 check_sync.py
  MISMATCH: expected 3,325,143 bytes, found 3,392,943
  first difference at byte 2,960
    built:     b'const ADDON_ID = "app.my-list";\nconst ADDON_VERSION = ...'
    committed: b'const ADDON_ID = "app.my-list";\r\nconst ADDON_VERSION = ...'
  run: python3 build.py
```

Its own header says it "now does the same thing they do" as `verify.sh` and CI. It does not:
those two use `git diff --ignore-cr-at-eol`, which is CRLF-insensitive; this is not.

**Why it matters.** The remedy it prints — `python3 build.py` — rewrites the file with LF
endings and produces a 3.3 MB diff of pure line-ending churn. CI would still pass (it ignores
CR at EOL), so that churn can be committed and will re-flip for the next person on a different
platform.

**Fix.** Either normalise the comparison the way the other two checks do:

```python
if bytes(expected).replace(b"\r\n", b"\n") == actual.replace(b"\r\n", b"\n"):
```

or add a `.gitattributes` pinning `worker_entry_combined.js` (and the numbered sources) to a
single line ending so all three checks agree byte-for-byte.
- The served page is produced from those sources at runtime (`renderBuilder`), so there is no separate stale generated frontend to drift.
- `splitAppBundle` / `splitAppCss` (`02_http-and-creator-utils.js:919/955`) lift the shared regions out of the rendered HTML at request time and serve them content-hashed. Confirmed live: page references `/app.css?v=6e2905ae81d96c330842` and `/app.js?v=d2b392f081203e685630`, both 200 with correct content types; changing one byte inside the bundle region changes the hash to `758d8c5d4e2db7bdb041` (`server-hotswap.mjs`), so the deploy→hash→page-ETag chain works as documented.
- `/app.webmanifest`, `/icon.png`, `/guide`, `/sitemap.xml`, `/robots.txt`, `/sw.js` all 200.

---

# Dead Code

I did not find frontend code that is safe to delete with confidence, and per the prompt I
deleted nothing. Two notes:

**REQUIRES MORE VALIDATION**

- `extract_html.py` — a standalone helper that regex-extracts `renderBuilder`'s template into
  `test.html` / `test_inner.js`. It is not referenced by `verify.sh`, `build.py`, `gen_map.py`,
  or CI; `render_check.js` + `html_checks.py` supersede it (they evaluate the function rather
  than regex the file). Likely obsolete, but confirm no local workflow uses it before removing.
- `check_sync.py` — by its own header, now does exactly what `verify.sh` and CI do
  (rebuild + compare). Kept deliberately as a standalone entry point. Not dead; do not remove
  without replacing the documented `python3 check_sync.py` invocation.

**DO NOT DELETE — runtime-dependent.** The many `typeof fn === 'function'` guards across the
client modules look redundant in a single concatenated scope, but they are load-order
insurance between modules that share one script scope. Removing them is the class of change
that produced the `isShow` / `clientId` / `listName` incidents the CI's `scope_check.mjs` step
exists to catch.

---

# Duplicate Code / Duplicate Logic

- **Two independent search-staleness counters** (`currentTitleSearchSequence`,
  `currentListSearchSequence`) guarding writes to **one** element. Consolidating to a single
  counter bumped by both paths would be safe and would close the POTENTIAL item below.
- **Two scroll-lock release paths** (`closeModal` for dynamic, `closeStaticModal` +
  each static modal's own closer). The asymmetry between them is exactly FE2-04/FE2-05.
  Consolidating open/close for the four `STATIC_MODALS` into one pair of helpers would remove
  both defects at once — and is the same consolidation the 2026-09-07 audit recommended for
  FE-12.
- **Five near-identical `+ New List` buttons** (`12_tab-custom-lists.js:15/27/39/52/64`)
  differing only in the destination argument. Harmless.

---

# POTENTIAL / NEEDS VALIDATION

1. **Cross-mode stale search response** (see §Race Conditions). The code path is real and the
   two counters genuinely do not interlock; I could not produce a visible clobber. Fix is cheap
   regardless: have `runCatalogSearch` bump **both** counters on entry, or check
   `currentCatalogSearchType` before each `resEl.innerHTML` write.
2. **Stale shell + pruned bundle offline** (see §PWA). Mechanically possible from the two SW
   rules; did not occur in an end-to-end deploy test because the HTTP cache and the shell
   refresh both covered it.
3. **`poster` URL into `<img src>` / `data-poster`** without scheme validation (see
   §Authentication/UI Security). Not exploitable today; one `^https?:` check makes it stay that
   way.

---

# Testing Gaps

1. **A failing test is being shipped.** `node --test tests/*.test.mjs` exits **1** on `73f2dd8`
   (557 pass / 1 fail / 1 skipped). CI's own "Test suite" step is therefore red on `main`.
   Whatever the cause, a red suite on the default branch means the next real regression has no
   signal to break.
2. **No test coerces types on import.** The suite covers missing/extra/old-format fields but
   never a field of the *wrong JSON type*. One numeric name is all FE2-01 needed. Add a
   type-fuzz case per importable field.
3. **No browser-level layout assertion.** `html_checks.py` proves the page parses; nothing
   asserts geometry, which is why FE2-03 has survived. A single check — "every visible control's
   right edge is inside the viewport at 320 px" — would have caught it.
4. **No invariant/property tests.** The randomized modal-sequence test (`t03`) found FE2-04 in
   400 sequences. The same technique applied to list ordering, watch state, and search would be
   cheap.
5. **Mutation-testing observation.** Reverting `16_client-row-core.js:2282` to `.trim()`, or
   removing the CW cleanup branch in `21_…:1971-1977`, leaves the suite *otherwise* green —
   only the one already-failing test notices the second. Both need a dedicated regression test.

---

# Regression Findings

*(Read only after the independent pass was complete, per the brief.)*

The previous frontend audit (`docs/history/AUDIT-2026-09-07-FRONTEND.md`, FE-01…FE-17) is
**largely and verifiably fixed**. I re-tested its findings blind and can confirm:

| Prior finding | Status now | Evidence |
|---|---|---|
| FE-02 stored XSS → Creator Key theft | **FIXED** | `t09/t10`: payload inert; `hasUnsafeIdChar` drops hostile ids on import |
| FE-06 obsolete search response overwrites newer | **FIXED** (same-mode) | sequence guards present and correct |
| FE-08 modal scroll lock never worked | **FIXED** | lock now on `documentElement` and depth-counted; `t15` confirms |
| FE-09 account switch leaks previous account's data | **FIXED** | `t11`: clean across all four stores |
| FE-10 modals have no keyboard/SR affordances | **FIXED** | `role="dialog"`, `aria-modal`, focus trap, Escape, focus restore — all verified |
| FE-11 `role="tablist"` with no tabs | **FIXED** | 12 `role="tab"`, all with `aria-selected`, 0 missing |
| FE-14 bottom nav label clipped at 320 px | **FIXED** | `t12`: 0 off-viewport nav controls |
| FE-15 app not usable offline | **FIXED** | `t13`: offline works, including across a deploy |
| **FE-12 one modal close path leaks the scroll lock** | **PARTIALLY FIXED** | the depth counter closed the reported path; the **open** side is still asymmetric → **FE2-04**, and `showModal`'s unconditional `closeModal()` → **FE2-05** |

**New this round (missed previously):** FE2-01, FE2-02, FE2-03, FE2-06, FE2-07.

One cross-audit observation worth flagging. `AUDIT-2026-09-08-ADVERSARIAL-III.md:1265` records
the **identical defect class on the server**:

```
/api/external-list/create | wrong-types | 500 | {"ok":false,"error":"(body.name || \"\").trim is not a function"}
```

That was found and hardened server-side. **The same `(x || …).trim()` pattern in the client's
`addRow` was never swept for** — and it is the more damaging of the two, because on the server
it produces a 500 while in the client it destroys the user's local configuration. Worth a
one-off grep for `.trim()` on an uncoerced value across the client modules as part of the fix.

---

# Frontend Interaction Map

**Page bootstrap**

```
GET /                                    (or /:config/configure, /lists/<creator>/<slug>)
  -> renderBuilder(origin, opts)
  -> htmlPageResponse -> pageWithExternalBundle
       -> splitAppBundle  : <script>/*BUNDLE_START*/…  ->  <script src="/app.js?v=<hash>">
       -> splitAppCss     : <style>/*CSS_START*/…      ->  <link href="/app.css?v=<hash>">
  page  = small per-request preamble (ORIGIN, IS_CONFIGURE, SERVER_DEEP_LINK_LIST,
          serverEntries, OAuth tokens)  +  shared immutable bundle
  -> SW registers (/sw.js) -> shell cached on bare "/" navigations only
```

**Catalog row add (Discover → Catalogs)**

```
click .curatedAddBtn
  -> document-level delegated handler (19_:1105)
  -> addRow(title, url, type, true, group)          [16_:2228]  <-- FE2-01 sink is here
  -> saveState() -> localStorage myListAddon:state
  -> checkUnsavedInstallLink() [24_:1988] -> .unsaved-install-banner.show   <-- FE2-03
  -> "Update Link" -> updateInstallLinkFromBanner -> generate() -> POST /api/save
```

**Like a published list**

```
click .searchLikeBtn -> btn.disabled = true
  -> POST /api/lists/like {username, slug, action, creatorName?, creatorKey?}
  -> data.likes (authoritative) -> card.dataset.likes + .like-num
  -> rememberLikedList/forgetLikedList -> localStorage myListAddon:likedLists
  -> if signed in: POST /api/creator/sync/like  (fire-and-forget)
  -> finally btn.disabled = false
```

**Mark a show watched**  *(FE2-02 lives in the fork marked ⚠)*

```
click #btnMarkShowWatched -> markShowWatched(imdbId)              [21_:1835]
  -> btn.disabled = true
  -> GET /api/season x N  (concurrency 4, 3 retries)
  -> btn.disabled = false        [21_:1913]    <-- re-enabled before the async tail settles
  -> toggleBatchWatchStatus(allEpisodes, wasFullyWatched)         [21_:1682]
        -> writes watch-history + _watchedItemIds
        -> ⚠ updateContinueWatchingForBatch(items).catch(()=>{})  [21_:1812] NOT awaited
              -> updateContinueWatching(showId) -> GET /api/season -> rewrites CW + fullyWatched
  -> setShowFullyWatched(alias, nowWatched)
  -> await withCwCommitLock(...)   evict show / inject or remove companion   [21_:1940]
  -> scheduleCreatorSyncSave() -> (1.2 s debounce) -> POST /api/creator/sync/save
```

**Search (Search tab)**

```
input #catalogSearchInput -> handleCatalogSearchInput -> 350 ms debounce -> runCatalogSearch  [19_:3903]
  type = movie/series : ++currentTitleSearchSequence
                        GET /api/title-search?type&q       -> guard -> _rawCatalogTitleItems -> applySearchFilters
  type = lists        : executeUnifiedListSearch            [19_:413]
                        ++currentListSearchSequence
                        Promise.all[ mdblist popular, /api/trakt-search,
                                     /api/search-published-lists, /api/tmdb-search-lists ]
                        -> guard -> renderListSearchResults -> #catalogSearchResult
                        -> populateSearchResultPosters -> POST /api/preview per card
```

**Backup import**

```
paste -> #configJsonBox -> importConfigJson()                     [24_:195]
   JSON.parse (guarded, 203)  ->  applyImportedConfig(data) [209]  <-- NOT guarded
      -> detectBackupFormat -> validateAndRepairBackup            [24_:279]
      -> dropUnsafeImportedIds  (hasUnsafeIdChar)
      -> entries.forEach(addRow)                                  <-- FE2-01 throws here
      -> customLists/channels/presets -> localStorage + sessionStorage mirror
      -> report modal                                             <-- never reached on throw
```

---

# API Call Inventory

65 distinct endpoints are referenced by the client. The ones exercised in this audit:

| Endpoint | Method | Primary caller | Notes |
|---|---|---|---|
| `/api/preview` | POST | `fetchListPreviewOnce` (19_:759), retry wrapper `fetchListPreviewWithRetry` (19_:781), `loadPosterSlot`, list-detail pagination | 78 calls on a cold load; 1 retry, plus an opposite-type retry on an empty sample |
| `/api/title-search` | GET | `runCatalogSearch` (19_:3928) | sequence-guarded |
| `/api/search-published-lists` | GET | `executeUnifiedListSearch` (19_:457) | sequence-guarded |
| `/api/trakt-search`, `/api/tmdb-search-lists` | GET | `executeUnifiedListSearch` | `res.ok` + content-type checked |
| `/api/season` | GET | `markShowWatched` (21_:1877), `updateContinueWatching` | 3 retries, concurrency 4 |
| `/api/lists/like`, `/api/lists/like-external` | POST | delegated like handler (19_:1131 handler, fetch at :1144 / :1221) | button disabled across the call |
| `/api/creator/create`, `/restore`, `/reset-key` | POST | profile modals (22_) | IP rate-limited; `beginSubmit` single-flight |
| `/api/creator/lists/save`, `/delete`, `/reorder`, `/items` | POST | list management (23_) | `expectedUpdatedAt` conflict guard, 409 → pull |
| `/api/creator/sync/load`, `/save`, `/save-channels`, `/save-tracking`, `/save-presets` | POST | debounced sync (22_:1747) | gated on `creatorSyncGateOpen()` |
| `/api/details`, `/api/details/batch`, `/api/show`, `/api/title` | GET/POST | item modal, Airing Next | budget-paced server-side |
| `/api/track-search`, `/api/track-event`, `/api/track-install` | POST | analytics | `keepalive`, errors swallowed |
| `/app.js`, `/app.css` | GET | page `<script>`/`<link>` | content-hashed, immutable, 304 on ETag |
| `/sw.js`, `/app.webmanifest`, `/icon.png` | GET | PWA | `sw.js` served `no-cache` (correct) |

---

# File-by-File Punch List

### `16_client-row-core.js`
- **Bug:** line 2282 — `.trim()` on an uncoerced `name` (**FE2-01**, HIGH). Wrap in `String(...)`.
- **Bug:** `closeModal` (1081) releases the scroll lock even when no dynamic overlay existed (**FE2-05**). Early-return when `#activeModalOverlay` is absent.
- **Clean:** `showModal` (1052), the focus trap, `lockBackgroundScroll`'s depth counter, and `STATIC_MODALS` Escape handling all verified correct.
- **Tests needed:** numeric/object/array `name` into `addRow`; "no modal open ⇒ not scroll-locked" invariant.

### `21_client-custom-list-builder.js`
- **Bug:** line 1812 — un-awaited `updateContinueWatchingForBatch` races the commit at 1940 (**FE2-02**, HIGH). Await it, or move it inside `withCwCommitLock`.
- **Cleanup:** `markShowWatched` re-enables the button (1913) before its async tail settles; keep it disabled to the end.
- **Tests needed:** the existing `client.test.mjs:3086` must go green; add a `_fullyWatchedShowIds` assertion.

### `24_client-backup-restore-presets.js`
- **Bug:** `applyImportedConfig` (387) is called unguarded from `importConfigJson` (209) and the file-upload path (1728); an exception escapes the handler with no user-facing message.
- **Cleanup:** `validateAndRepairBackup` (279) should coerce non-string `name`/`group` and count it as a repair note.
- **Clean:** `hasUnsafeIdChar` / `dropUnsafeImportedIds` verified against hostile ids and prototype-pollution payloads.
- **Tests needed:** one wrong-JSON-type case per importable field.

### `09_page-shell.js`
- **Bug:** `.unsaved-install-banner` (3217) — `nowrap` + non-shrinking label pushes the CTA off-screen ≤390 px (**FE2-03**).
- **Cleanup:** two `<h1>` elements; only one live region for the whole app.
- **Tests needed:** a 320 px geometry assertion for visible controls.

### `19_client-search-and-likes.js`
- **Cleanup:** `openSelectListModal` (2845, lock at 3142) locks scroll unconditionally on re-open (**FE2-04**).
- **Cleanup:** `#catalogSearchInput` needs an `aria-label` (**FE2-06**).
- **Cleanup:** two search sequence counters writing one element; the error/empty branches (3937/3941/3948) should check `currentCatalogSearchType`.
- **Cleanup:** `fetchListPreviewWithRetry` (781) retries immediately on 5xx; back off as it does for 429.
- **Clean:** the like handler's single-flight guard and authoritative count.

### `22_client-creator-profile.js`
- **Cleanup:** `openCreateListModal` (5094, lock at 5137) locks scroll unconditionally on re-open (**FE2-04**).
- **Clean:** `clearLocalAccountData` (1158) verified complete, sessionStorage mirror included; `beginSubmit` guards verified.

### `12_tab-custom-lists.js`, `13_tab-channels.js`
- **Cleanup:** `#channelMergeNameInput` and `#listFilterInput` need `aria-label` (**FE2-06**).

### `02_http-and-creator-utils.js` *(serving the frontend)*
- **Clean:** `splitAppBundle`/`splitAppCss` and the `APP_BUNDLE` singleton verified safe — bundle byte-identical across six render variants.

### `check_sync.py`
- **Bug:** byte-exact comparison against a CRLF-committed artifact built from LF sources — fails on a clean tree (**FE2-07**). Normalise line endings, or add `.gitattributes`.

### `sw.js` (from `09_page-shell.js`)
- **Cleanup (hardening):** the asset cache prunes the previous hash for a pathname while the shell is only refreshed on a bare `/` navigation. Don't prune a hash the cached shell still references.

---

# Top 10 Fixes

Ranked by security → data integrity → user impact → reliability → maintainability.

| # | Fix | Why |
|---|---|---|
| 1 | **FE2-01** — `String(name \|\| group \|\| 'L')` at `16_:2282`, plus a `try/catch` around `applyImportedConfig` | Data integrity. Restoring a backup currently destroys the user's catalogs silently. |
| 2 | **FE2-02** — await / lock `updateContinueWatchingForBatch` | Data integrity + **it is the red test on `main`**. Wrong state is synced to the account. |
| 3 | **Get CI green.** | A red default branch means the next regression has no signal. |
| 4 | Coerce + report non-string fields in `validateAndRepairBackup`; sweep the client for `.trim()` on uncoerced values | Closes the whole defect class, not just the one instance — and matches the server-side hardening already done in Audit III. |
| 5 | **FE2-03** — let the banner label shrink/wrap | The main CTA is unusable-looking at 320 px. |
| 6 | **FE2-05** — `closeModal` early-return when no overlay exists | Page scrolls away under an open dialog. |
| 7 | **FE2-04** — make static-modal open idempotent | Removes a refresh-only dead-page state before someone finds a path to it. |
| 8 | **FE2-06** — `aria-label` on three inputs (+ one live region for async status) | Three one-line changes. |
| 9 | Interlock the two search sequence counters | Closes the POTENTIAL cross-mode clobber; also removes duplicated logic. |
| 10 | Validate `poster` URLs against `^https?:` before rendering | Defence-in-depth on the one attacker-controlled value that reaches a URL attribute. |
| — | **FE2-07** — make `check_sync.py` CRLF-insensitive (or add `.gitattributes`) | It fails on a clean checkout and tells you to run a command that churns 3.3 MB. |

---

# Recommended Test Suite

Concrete additions, in the repo's existing idiom:

**`tests/client.test.mjs`**
1. `addRow` accepts a non-string name: `addRow(2024, 'tmdb:chart:popular', 'movie', true)` renders a row with avatar letter `2` and does not throw. *(mutation: revert 2282 → fails)*
2. Import a 3-entry backup with `name: 2024` in the middle → all 3 rows present, report modal shown. *(FE2-01)*
3. Import fuzz: for each of `name`, `url`, `type`, `group`, `enabled`, substitute a number, an object, an array and `null` → never throws, always reports.
4. `markShowWatched` twice with **no** gap → `_fullyWatchedShowIds` is empty and no `precedingShowId` item remains. *(FE2-02; the existing test at 3086 is case 1 of this)*
5. Invariant: after any sequence drawn from {open/close × dynamic/selectList/createList}, `_scrollLockDepth === 0` whenever no modal is visible. *(FE2-04/05 — `t03` is the prototype)*

**`html_checks.py`** (or a new browser check)
6. At 320 px with `.unsaved-install-banner.show`, assert `#unsavedInstallBtn`'s right edge ≤ viewport width. *(FE2-03)*
7. Assert every `input`/`select`/`textarea` on every tab has an accessible name. *(FE2-06)*

**CI**
8. Keep `node --test tests/*.test.mjs` failing the build — and fix the current failure rather than skipping the test.

---

## Severity Recap

| ID | Severity | Title | Status |
|---|---|---|---|
| FE2-01 | **HIGH** | Numeric list name in a backup destroys catalogs on import | Confirmed, reproduced end-to-end |
| FE2-02 | **HIGH** | `markShowWatched` background job races its own commit | Confirmed; also the failing test on `main` |
| FE2-03 | MEDIUM | "Update Link" CTA clipped at ≤390 px | Confirmed, measured |
| FE2-04 | LOW | Scroll-lock depth asymmetry on modal re-open | Confirmed in code + randomized test; **not reachable via UI** |
| FE2-05 | LOW | Dialog over a static modal releases its scroll lock | Confirmed |
| FE2-06 | LOW | Three inputs labelled only by placeholder | Confirmed |
| FE2-07 | LOW | `check_sync.py` fails on a clean checkout; its remedy churns the Worker | Confirmed |
| — | INFO | Two `<h1>`; one live region; no `AbortController`; unvalidated poster URL; SW asset-prune vs shell freshness | Observations |

No CRITICAL findings.
