# Frontend Adversarial Audit — 2026-09-07

Scope: the **client side only** — the builder page and its bundle (`09_`–`24_`),
the admin dashboard's browser code (`03_admin.js`), the service worker, the
web manifest, and every assumption the browser makes about the Worker's replies.
Server-side logic was read only where a frontend expectation had to be checked
against it.

---

## Frontend Audit Summary

| | |
|---|---|
| **Date** | 2026-09-07 |
| **Commit audited** | `be20b1b` (branch `claude/project-audit-p4o1je`; `verify.sh` green at start: 286 tests, 285 pass, 1 skipped) |
| **Frontend sources audited** | `09_page-shell.js`, `10_`–`15_` (tab markup), `16_`–`24_` (client bundle), `03_admin.js` (admin page + its inline script) — 38,592 lines |
| **Generated artefacts audited** | `worker_entry_combined.js` (2,872,924 B), the rendered builder page (243,131 B), `/app.js` (1,395,319 B, 496 top-level functions), `/app.css` (85,755 B), `/sw.js`, `/app.webmanifest`, the rendered `/admin`, `/guide`, `/configure`, `/channels/:id` |
| **Test environment** | Chromium 141.0.7390.37 via Playwright 1.56.1, headless, against the **real Worker** running in-process over HTTP (`tests/harness.mjs` KV + real SQLite D1 from `schema.sql`), with a fault-injection proxy in front of it and TMDB/Trakt/MDBList/Simkl stubbed. A second instance was run with **D1 unbound** to isolate KV-only behaviour. |
| **Interactions performed** | 40 driver scripts. 9 viewports × 6 tabs of layout probing; 200 modal open/close cycles; 200 tab switches; 60 searches; 47 admin controls clicked; 14 malformed deep links; 7 fault-injection scenarios; 6 repeated double-click account creations; hostile payloads pushed through 13 storage keys, the published-list directory, the backup-restore box, and an attacker-controlled install link. |

**Headline:** two CRITICAL issues. The **admin dashboard has been entirely
non-functional since 2026-09-05** — its whole inline script fails to parse — and
**imported channel/list data reaches an inline event handler in a way `escapeAttr`
cannot protect**, giving a stored XSS that steals the victim's Creator Key. A
third, `FE-03`, makes an ordinary double-click on "Create Profile" produce an
account whose key does not work; it is a direct consequence of the D1+KV change.

Balanced against that: escaping is otherwise correct everywhere I could reach it,
error/fault handling is genuinely good, there are no memory or listener leaks,
account switching and sign-out clear state properly, and there is no horizontal
scroll at any viewport from 320 px to 1920 px.

---

## Critical Frontend Bugs

### FE-01 — The entire `/admin` dashboard script fails to parse; every control is dead

| | |
|---|---|
| **Severity** | CRITICAL (application-breaking, core functionality) |
| **File** | `03_admin.js:2418, 2424, 2426, 2542, 2554, 2560, 2562` |
| **Function** | `runDeleteCreatorLists()`, `runDeletePublishedLists()` (inside `renderAdminPage`'s template literal) |

**Exact problem.** The admin page is returned as one big JavaScript **template
literal**. Escapes written with a single backslash are consumed by that outer
literal before they ever reach the browser. Seven such escapes exist:

| source | intended | what `/admin` actually receives |
|---|---|---|
| `'…"?\n\n' +` (×2 sites, 4 escapes) | `\n` inside a JS string | a **real newline**, splitting a single-quoted string across two lines |
| `split(/[\s,]+/)` (×3 sites) | `\s` | `split(/[s,]+/)` — splits on the letter *s* |

The newline is a hard syntax error, and it is in the **same `<script>` block as the
whole dashboard** (60,707 characters). One `SyntaxError` discards all of it.

**Reproduction.**
1. `GET /admin`, submit the admin key.
2. Console: `SyntaxError: Invalid or unexpected token`.
3. `typeof window.switchAdminMainTab` → `"undefined"` (same for all 13 dashboard entry points).
4. Click any control → `ReferenceError: switchAdminMainTab is not defined`.

Measured: 47 elements carry an `onclick`; every visible one throws. Two distinct
errors from 6 clicks — you cannot even change tab.

```
admin globals after login:
 { runDeleteCreatorLists:"undefined", loadAnalytics:"undefined", loadFeedback:"undefined",
   switchAdminTab:"undefined", loadLeaderboard:"undefined", runRebuildIndex:"undefined",
   loadPublishedLists:"undefined", runResetCreatorKey:"undefined", loadApiUsage:"undefined",
   runProviderLookup:"undefined", loadSchemaStatus:"undefined", runNetflixPreview:"undefined",
   runMigrateD1:"undefined" }
clicked 6 visible admin controls -> 6 new page errors
distinct errors: ["ReferenceError: switchAdminMainTab is not defined",
                  "ReferenceError: switchAdminSubTab is not defined"]
```

**Expected.** The dashboard's tabs, feedback inbox, leaderboard, provider lookup,
Netflix preview, schema check, `migrate-d1`, rebuild-public-index, reset-creator-key,
delete-creator-list and delete-published-list all work.

**Actual.** Only the server-rendered Overview numbers appear. Every interactive
feature, including all moderation tooling, is inert.

**Root cause.** Template-literal escape swallowing. The rest of this repo writes
`\\n` / `\\s` inside these literals (see `24_client-backup-restore-presets.js`,
which does it correctly); these two functions did not.

**Impact.** The only way to remove a list published anonymously, to reset a locked
creator's key, to read the feedback inbox, or to check migration status is the
admin dashboard — and it has not worked since `c1e0829` (2026-09-05). The second
`confirm()` block was added later still, by `4ba6e0a` (2026-09-06), the previous
audit's own fix commit.

**Recommended fix.** Double every backslash at those seven sites: `\\n\\n` and
`/[\\s,]+/`. Note the regex sites are wrong *independently* of the syntax error —
`'my-best-lists, another-slug'.split(/[s,]+/)` yields
`["my-be","t-li","t","another-","lug"]` — so fixing only the newlines leaves the
delete tools silently mangling slugs.

**Regression test.** Extend `html_checks.py` (or add a sibling) to render `/admin`
and `node --check` each inline `<script>`, the same way the builder page is
checked. This is the one CI gap that let a completely dead page ship: `verify.sh`
step 4 only ever renders `renderBuilder()`.

---

### FE-02 — Stored XSS: imported channel/list ids break out of inline handlers and steal the Creator Key

| | |
|---|---|
| **Severity** | CRITICAL (exploitable, credential theft) |
| **File** | `20_client-channel-builder.js` (17 sites: 5074, 5652, 5655, 5659, 5671, 5681, 5682, 6347, 6350, 6416, 6429, 6442, 6443, 7035, 7044, 7057, 7073); `22_client-creator-profile.js:3124, 3329, 3331, 3333`; `19_client-search-and-likes.js` (15 sites, e.g. 2306, 2326, 2340); `16_client-row-core.js:1160` — 37 sites total |
| **Sink pattern** | `onclick="fn(&quot;' + escapeAttr(value) + '&quot;)"` |

**Exact problem.** `escapeAttr` is `escapeHtml` (`19_client-search-and-likes.js:146`, aliased at `:154`),
which turns `"` into `&quot;`. These sites delimit the *JavaScript* string inside
the handler with `&quot;`. The HTML parser decodes attribute entities **before**
the JavaScript is parsed, so `escapeAttr`'s own output reconstitutes the delimiter:

```
value      : "); window.__pwned = 1; //
escapeAttr : &quot;); window.__pwned = 1; //
in markup  : onclick="fn(&quot;&quot;); window.__pwned = 1; //&quot;)"
JS the browser runs: fn(""); window.__pwned = 1; //")
```

Escaping is not the defence here; it is the delivery mechanism.

**Reproduction A — a shared backup file** (the documented Presets & Backup flow):

1. Sign in (so `myListAddon:creatorKey` is set).
2. Settings → Presets & Backup, paste:
   ```json
   {"version":"3.0","entries":[],
    "channels":{"\"); window.__pwned = localStorage.getItem('myListAddon:creatorKey'); //":
      {"channelId":"\"); window.__pwned = localStorage.getItem('myListAddon:creatorKey'); //",
       "name":"Cool Sci-Fi Channel","type":"series","items":[{"id":"tt0944947","type":"series"}]}}}
   ```
   and press Restore. The app reports **"✓ Restore Complete … restored successfully"**.
3. Channels → My Channels. Click the channel card (an entirely ordinary action).
4. `window.__pwned === "MYL-VICT-IMSK-EY01"` — the victim's Creator Key.

Observed handler markup:
```
editChannelById(""); window.__pwned = ... ; //")
deleteLocalChannel(""); window.__pwned = ... ; //", "Cool Sci-Fi Channel")
toggleChannelInCatalog(""); window.__pwned = ... ; //")
```

**Reproduction B — a pasted install link** (the app's primary sharing mechanism):
paste `https://attacker.example/<config>/manifest.json` into Settings → Import.
`resolveInstallLinkData` (`24_client-backup-restore-presets.js:598`, emitted at `/app.js:27949`) fetches
`targetOrigin + '/api/resolve?config=…'` from **any** origin and returns its JSON
wholesale; `extractCustomListsAndChannelsFromPreset` then stores `data.channels`
verbatim. Confirmed end-to-end against a local attacker origin: `window.__pwned =
"KEY=MYL-VICT-IMSK-EY01"`.

The page CSP (`connect-src 'self' https:`) blocked only my *http* test origin —
and did not stop the attack, because step 2 of `resolveInstallLinkData` falls back
to the Worker's own `/api/resolve?config=…&url=…` **server-side proxy**, which
fetched the attacker's URL and handed the response back. A real attacker on an
https domain is permitted by the CSP directly.

**Expected.** Data that arrived from another person cannot execute script.

**Actual.** It executes on the victim's origin with access to `localStorage`,
i.e. the Creator Key — the only credential this app has. With it an attacker can
read, rewrite and delete every list, channel and preset on the account.

**Impact.** Full account takeover from a shared file or a pasted link. The Creator
Key is bearer-only; there is no second factor and no session to revoke.

**Recommended fix (two layers, both worth doing).**
1. Stop building JS string literals inside HTML attributes. Emit
   `data-channel-id="…"` and read it in a delegated listener, as
   `.searchLikeExternalBtn` / `.searchAddBtn` already do a few lines away in the
   same file. That removes the class, not just the instance.
2. Where a handler must stay inline, add a dedicated `escapeJsInAttr()` that
   escapes `\`, `'`, `"`, `<`, `&`, newlines and `/` **before** HTML-escaping, and
   use it at all 37 sites. `escapeAttr` is correct for a plain attribute and must
   not be used for a script context.
3. Independently, validate on the way in: `applyImportedConfig` should reject
   channel ids and list slugs that are not `[A-Za-z0-9._:-]{1,128}`, and
   `resolveInstallLinkData` should not accept `channels`/`customLists` from a
   remote origin it did not verify.

**Regression test.** `tests/client.test.mjs`: build a channel map with an id
containing `");`, call the channel-card renderer, and assert the emitted
`onclick` attribute parses to a call with exactly one argument (or, after fix 1,
that no `onclick` is emitted at all and the id lands in `dataset`).

---

### FE-03 — Double-clicking "Create Profile" produces an account whose key never works

| | |
|---|---|
| **Severity** | CRITICAL (account lockout / data loss on first use) |
| **File** | `22_client-creator-profile.js:2459` → `submitCreateProfile()` (emitted at `/app.js:22210`) |
| **Reproducibility** | **6 / 6** in Chromium with D1 bound |

**Exact problem.** `submitCreateProfile()` has no double-submit guard — the button
is never disabled and no in-flight flag is kept. Two clicks send two concurrent
`POST /api/creator/create`. Both succeed and return **different** keys. The
browser stores whichever response lands last, and shows that key in the
"Profile Created — save this key somewhere safe" modal. Only one of the keys
actually authenticates, and with D1 bound it is not the one kept.

**Reproduction.**
1. Load `/`, open Create Profile, type a fresh username, double-click **Create**.
2. Modal shows a key; it is also written to `myListAddon:creatorKey`.
3. `POST /api/creator/restore` with that key → **401 `Username or Key is incorrect.`**
4. Every authenticated call now 401s: `sync/load`, `creator/lists`, `lists/save`,
   `sync/save`, `sync/save-tracking`, `scrobble-token`, `track-status`.

```
run 0: stored=MYL-CDKQ-HR2F-SFBE shownToUser=MYL-CDKQ-HR2F-SFBE restore=401 <-- BROKEN ACCOUNT
… 6/6 double-clicks produced an account whose key does not authenticate
```

**Technical root cause — and why this is a D1+KV regression.** `/api/creator/create`
writes KV unconditionally (last write wins) and *additionally* `INSERT`s into D1,
where the second insert violates the primary key and is swallowed as non-fatal
(`26_api-creator-and-admin-routes.js:1281-1300`). Reads prefer D1. So D1 keeps the
**first** request's key hash while KV keeps the **last** — and the browser keeps
the last. Measured on the same code with the binding toggled:

```
D1 bound   : over 5 double-creates -> first response's key valid 4/5, second 1/5
D1 UNbound : over 5 double-creates -> first response's key valid 0/5, second 5/5
```

KV-only, the missing guard was harmless: the stored key was always the valid one.
Adding D1 turned it into an account-breaking bug. This is exactly the class the
brief asks for in §22.

**Impact.** A new user's very first interaction can leave them with an account
they can never sign into, holding a key they were told to save. Recovery is only
possible if they set a recovery answer during that same signup.

**Recommended fix (frontend, in scope).** Disable the submit button and set an
in-flight flag for the whole of `submitCreateProfile()`, re-enabling in a
`finally`. Apply the same to `submitRestoreProfile()`, `submitForgotKey()` and
`saveCreatorListEdit()`. (Making `/api/creator/create` idempotent per username
would be the belt-and-braces server fix, but the frontend guard is what stops the
double request being sent at all.)

**Regression test.** Client test: call `submitCreateProfile()` twice without
awaiting the first, assert exactly one `POST /api/creator/create` is recorded.

---

## Functional Bugs

### FE-04 — HIGH — Failed provider writes are reported as successful

**File:** `19_client-search-and-likes.js:2187` (`removeSingleExternalItemDirect`, whose request is at `:2223`) and
6 further `/api/external-list/item-mutate` call sites: `17_client-my-lists-and-trakt-oauth.js:2111, 2134, 2157`,
`19_client-search-and-likes.js:2790`, `22_client-creator-profile.js:4399`, `23_client-list-management.js:1249`.

All seven discard the response. `removeSingleExternalItemDirect` does
`await fetch(...)` inside `try { } catch(e) {}` and then unconditionally calls
`showAddedToast('Removed from TRAKT.')`. The one site that reads anything uses
`Promise.allSettled` and never inspects the results.

Before the request is even sent it has already flipped the local membership
index, unchecked the box, removed the "In List" badge and hidden the button.

**Reproduction** (server rejects, UI says done):
```
server's answer: {"status":400,"body":"{\"ok\":false,\"error\":\"Please connect your Trakt account first.\"}"}
client outcome : {"toast":"Removed from TRAKT.","membership":{"trakt:watchlist:watchlist::tt0137523":false}}
```

**Impact.** Any expired provider token, provider outage, 401/403/429 or dropped
connection silently desynchronises the app from Trakt / TMDB / Simkl / MDBList.
The user believes the item was removed; it is still in their list, and the local
index now says otherwise so the UI will not offer to remove it again.

**Fix.** Read `res.ok` and the `{ok,error}` body; on failure roll back the
optimistic membership change, restore the row, and surface the server's message.
**Test:** stub `item-mutate` → 400 and assert no success toast and that
membership is unchanged.

---

### FE-05 — HIGH — The main list-edit path can silently lose another device's edit

**File:** `21_client-custom-list-builder.js:539` → `saveCreatorListEdit()` (request at `:550`), plus 9 other unguarded `lists/save` callers.

The server implements optimistic concurrency: send `expectedUpdatedAt` and it
answers **409** rather than overwriting. Of 12 client call sites, exactly two arm
it — both inside `saveCreatorListWithBaseline()` (`22_client-creator-profile.js:4561`), which is only
used by the two *remove-one-item* paths. The primary "save my edits to this list"
button sends the whole `items` array with no baseline.

**Reproduction** (the exact payload `saveCreatorListEdit` sends, from two devices):
```
baseline updatedAt: 1788753443756  items: 1
device1 save: 200 {"ok":true,...}      # adds B
device2 save: 200 {"ok":true,...}      # adds C
final items: ["A","C"]                 # B is gone; both saves reported ok
with expectedUpdatedAt -> first: 200  second: 409 {"ok":false,"error":"conflict",...}
```

**Impact.** Two browsers/devices on one account, or one device with a slow first
save, silently drop one side's work. The mechanism to prevent it already exists
and already works.

**Fix.** Route every list write through `saveCreatorListWithBaseline` (it already
handles the 409 by re-applying the edit to the fresh copy and retrying once), or
at minimum send `expectedUpdatedAt` from `saveCreatorListEdit` and
`submitCreateListModal`. **Test:** two saves citing the same baseline; assert the
second gets 409 and the client re-fetches rather than clobbering.

---

### FE-06 — MEDIUM — An obsolete search response overwrites a newer one

**File:** `19_client-search-and-likes.js:3199` (`runCatalogSearch`).

There is no `AbortController` anywhere in the 1.4 MB bundle and no sequence guard
in this function — both responses write `window._rawCatalogTitleItems` and call
`applySearchFilters()`. The sibling `executeUnifiedListSearch` **does** guard
itself with `currentListSearchSequence` (`19_client-search-and-likes.js:314, 325, 375`), so the pattern is
already in the file.

**Reproduction** (4 s delay on one query, 100 ms on the other):
```
t=+2.1s (fast landed, slow pending) shows: "FAST-RESULT 2020"
t=+6s   input box = "fastq"           shows: "SLOW-RESULT 1990"   <- obsolete response won
```
Second case — clear the box mid-flight:
```
after clearing the box: input = ""  results = "SLOW-RESULT 1990"
```
`renderDefaultCatalogSearch` checks `inputEl.value.trim()` after its await;
`runCatalogSearch` never does.

**Impact.** On a slow connection the results shown do not match the query in the
box, and results appear for a query the user deleted.

**Fix.** Mirror `executeUnifiedListSearch`: take `const seq = ++catalogSearchSeq`
at entry and bail after the await if `seq !== catalogSearchSeq`; also re-check the
input value. **Test:** two `runCatalogSearch` calls with the first resolving last;
assert only the newer results render.

---

### FE-07 — MEDIUM — A restored backup can permanently break Discover, and reports success

**File:** `24_client-backup-restore-presets.js:538` (`applyImportedConfig`);
crash site `19_client-search-and-likes.js:744` (`getLikedListsSet`) and `:1273` (`likedKeywords`).

`getLikedListsSet()` builds a `Set` from `myListAddon:likedLists` assuming an array
of **URL strings**. `applyImportedConfig` accepts `s.likedLists` on `Array.isArray`
alone — no element check — while the neighbouring `s.fullyWatchedShowIds` is
correctly coerced with `.map(String)`. `validateAndRepairBackup`, whose whole
purpose is catching this class, does not look at it.

**Reproduction.** Restore a backup containing
`{"settings":{"likedLists":[{"url":"https://mdblist.com/lists/a/b","name":"Sci-Fi"}]}}`:

```
restore reported: "✓ Restore Complete — Your setup, lists, watch history, channels,
                   and settings have been restored successfully."
Discover > Curated: "Watch more items or like community lists to build personalized
                     recommendations."           <- looks like a normal empty state
console: "Curated lists error: TypeError: u.split is not a function"
after a full reload: identical, three times over
```

**Impact.** The Discover → Curated feed is dead for good, presented as an empty
state, with no way for the user to connect it to the restore. Only clearing site
data fixes it. Like-state everywhere else is also silently wrong, since
`getLikedListsSet().has(url)` can never match an object.

**Fix.** Coerce on read (`.filter(v => typeof v === 'string')` in
`getLikedListsSet`) **and** on write in `applyImportedConfig` and the
`sync/load` handler (`22_client-creator-profile.js:1978-1980`). Add a
`validateAndRepairBackup` check that reports the repair, since the point of that
function is to say what it fixed. **Test:** seed `likedLists` with objects and
assert the Curated renderer completes.

---

### FE-08 — MEDIUM — The modal scroll lock has never worked

**File:** `09_page-shell.js:218` — `html { … overflow-x: hidden; }`; lock set at `19_client-search-and-likes.js:2571`, released at `09_page-shell.js:3292` and `19_…:2559-2560, 2703-2704, 2820-2821`.

Setting `overflow-x` on `<html>` to a non-`visible` value makes its computed
`overflow-y` **`auto`** rather than `visible`. Once `<html>` has an explicit
overflow, `body { overflow: hidden }` no longer propagates to the viewport. So
every `document.body.style.overflow = 'hidden'` in this app is a no-op.

**Reproduction** (390 × 780, real wheel events over the backdrop):
```
modal open, body.style.overflow = hidden
scrollY behind an OPEN modal after wheel: 900
computed html overflow-y: auto
```

**Impact.** The page scrolls behind every modal — most visible on mobile, where
the underlying list scrolls away under the dialog.

**Fix.** Lock the scrolling element instead: `document.documentElement.style.overflow
= 'hidden'` (or `position: fixed; top: -scrollY` on body, restoring scroll on
close). Do this **together with FE-12**, or the leak below becomes a hard lock.

---

### FE-12 — LOW — One modal close path leaks the scroll lock

**File:** `19_client-search-and-likes.js:2546`.

Inside `openSelectListModal`, the "+ Create New List" button hides the modal
without restoring `document.body.style.overflow`, while the sibling
`emptyCreateListLink` handler eleven lines below does restore it, and so does the
Cancel button (`09_page-shell.js:3292`). `createListModal`'s own Cancel and ✕
(`09_page-shell.js:3202, 3244`) never touch overflow either.

**Reproduction.** Open Add/Remove-from-Lists → "+ Create New List" → Cancel:
```
before:                    bodyOverflow=""
selectListModal open:      bodyOverflow="hidden"
after create modal opens:  bodyOverflow="hidden"
after Cancel:              bodyOverflow="hidden"   <- no modal open
```

Harmless **today only because of FE-08**. Fixing FE-08 without this one turns it
into a permanent, refresh-only scroll lock.

**Fix.** One `closeSelectListModal()` helper used by all four exits.

---

### FE-13 — LOW — A non-array `dashboardListOrder` crashes the dashboard renderer

**File:** `22_client-creator-profile.js:3240-3241` and `:3572-3573`.

Both sites `JSON.parse` inside `try/catch` and then test `savedOrder && savedOrder.length`
— which a **string** passes — before calling `savedOrder.map`. Seeding
`myListAddon:dashboardListOrder = '"nope"'` gives
`TypeError: savedOrder.map is not a function` ×2 and no dashboard.

All current writers are `Array.isArray`-guarded, so this needs corrupted storage
rather than an app path; it is the same missing-type-check family as FE-07.
**Fix:** `const savedOrder = Array.isArray(parsed) ? parsed : []`.

---

### FE-14 — LOW — The bottom nav's last label is clipped at 320 px

At 320 px the "Settings" item spans x=282→344 against a 320 px viewport, so the
label renders as "Settin". The icon stays tappable (`elementFromPoint` at x=313
still hits the button) and there is no horizontal page scroll, so this is
cosmetic-with-consequences rather than unreachable. Every other width (375, 390,
412, 768, 1024, 1280, 1440, 1920) is clean.

**Fix.** Shrink the label font or allow wrapping below 360 px, or use
`justify-content: space-between` with a smaller horizontal padding.

---

## Frontend ↔ Backend Contract Bugs

| # | Frontend expectation | Actual backend behaviour | Result |
|---|---|---|---|
| FE-04 | `/api/external-list/item-mutate` always succeeds; the response is not worth reading | Returns `400 {"ok":false,"error":"Please connect your Trakt account first."}`, and other 4xx from providers | Success toast on a rejected write; local membership index desynchronised |
| FE-05 | `/api/creator/lists/save` is last-write-wins | Answers **409 `{ok:false,error:"conflict",conflict:true,updatedAt}`** when `expectedUpdatedAt` is cited | 10 of 12 call sites never cite it, so the guard is off for the main edit path |
| FE-03 | `/api/creator/create` is effectively idempotent for one username | With D1 bound, concurrent creates each return a distinct key but only the *first* authenticates; KV-only, only the *last* does | The browser keeps the last → 401 on every later request |
| — | `/api/creator/sync/save` may 409 | It does | ✅ Handled correctly (`/app.js:21365`): pulls the newer state instead of clobbering |
| — | `/api/creator/lists` returns `updatedAt` per list | It does | ✅ Consumed by `saveCreatorListWithBaseline` |
| — | Every response is JSON | 429/502 can be text/HTML | ✅ Handled: `res.json()` throws into the catch and a real error is shown |

**Endpoints the client calls that no longer exist:** none. All 65 distinct
frontend paths resolve to a live route in `25_`/`26_`.

**Routes no client code calls** (server-only or protocol-facing, not dead):
`/api/publish-list`, `/api/public-lists.json`,
`/api/external-list/item-add`, `/api/external-list/item-remove`,
`/api/creator/sync/share-tracking`, `/api/channel-logo`, `/api/channel-poster`,
`/api/poster-badge`. (`/api/scrobble` is not fetched but its URL is built for the
scrobble webhook at `22_client-creator-profile.js:892`.)

---

## Race Conditions

### FE-09 — HIGH — An account switch lets the previous account's data land in the new session

**File:** `22_client-creator-profile.js:1827` → `loadCreatorSync()` (fetch at `:1833`).

`loadCreatorSync` checks `if (!activeCreator) return` at entry and **never
re-checks after `await fetch(...)`**. `submitRestoreProfile` calls
`clearLocalAccountData()` then `loadCreatorSync()`, so a slow response for the
previous account resolves into the new one.

**Competing operations.** `loadCreatorSync(alice)` issued at t=0 (slow) vs
`submitRestoreProfile(bob)` at t=1.2 s, which clears state and issues
`loadCreatorSync(bob)` (fast). Bob's answer applies at ~t=1.5 s; **alice's applies
at t=7 s and wins**, because nothing tells it that it is stale.

```
t=+3.7s : {"who":"bob","rows":["bob-ROW"], "liked":"[…/bob/liked]"}
t=+10.7s: {"who":"bob","rows":["alice-ROW"],"liked":"[…/alice/liked]"}
*** alice's sync payload was applied to bob's signed-in session ***
```

**Why the stale result wins.** It is simply the last writer. The response carries
no identity the client checks, and there is no request generation counter.

**Blast radius.** The exposure is in the UI: another account's catalog
configuration and liked lists are rendered under Bob's name. It does **not**
persist — `pushCreatorSync` (`22_client-creator-profile.js:1574`) then cites Alice's `updatedAt`, the server answers
**409**, and the 409 handler re-pulls Bob's state, so the account itself is safe.
That is the server's guard doing its job, not the client's.

**Fix.** Capture `const who = activeCreator.creatorName` before the fetch and
`if (!activeCreator || activeCreator.creatorName !== who) return;` after it. Same
pattern for `renderCreatorDashboard`, `pushTrackingSync` and the other
`activeCreator`-reading async functions.

**Test:** delay the first `sync/load`, switch accounts, assert the first
response's config never reaches the DOM.

### FE-06 (above) — search responses race; the older one wins.

### FE-03 (above) — two concurrent `create` requests; the surviving key is not the stored one.

### Races tested and found **safe**

| Interaction | Result |
|---|---|
| Rapid like / unlike | ✅ Button `disabled` for the duration, restored in `finally`, count taken from the server's reply (`19_client-search-and-likes.js:866-938`) |
| Sequential double-click on Create Profile (slow enough to serialise) | ✅ Second gets "That username is already taken" and does not overwrite local state |
| `sync/save` colliding with another device | ✅ 409 → pull latest, keep the pending edit for the next autosave |
| Remove-one-item on a list edited elsewhere | ✅ 409 → re-apply the removal to the fresh copy, one retry, then stop |
| Switching tabs / navigating during a preview fetch | ✅ Per-shelf writes are scoped to their own DOM node |

---

## State Management Bugs

**Storage keys inventoried:** 63 distinct `myListAddon:*` keys plus `theme`. Full list and
writer/reader map in the punch list below.

- **FE-07, FE-13** — reads that check container type but not element type.
- **FE-09** — in-flight state not bound to the identity that requested it.
- **`myListAddon:localCustomLists` lives in both `localStorage` and
  `sessionStorage`** by design (`saveLocalCustomListsMap` mirrors it;
  `loadLocalCustomLists` reads sessionStorage **first**). This is documented and
  `clearLocalAccountData` now wipes both — verified below.

### Verified clean

**Account switching and sign-out** were tested end-to-end with two seeded server
accounts:

```
signed in as alice: rows=["alice-ROW"] dashboard="ALICE-SECRET-LIST Private…"
                    localLists=[watchlist, alice-secret-list] liked=[…/alice/liked]
switched to bob   : rows=["bob-ROW"]   dashboard="BOB-PUBLIC-LIST Public…"
                    localLists=[watchlist, bob-public-list]   liked=[…/bob/liked]
after sign-out    : rows=[] dashboard="Watchlist" localLists=[watchlist] liked=null
                    activeCreator=null  creatorKey=""  no "ALICE"/"BOB" text anywhere
```

No cross-account residue in DOM, `localStorage`, `sessionStorage` or in-memory
caches, in either direction. (The one way to get contamination is FE-09's timing
window.)

---

## Authentication / UI Security

- **FE-02 — stored XSS → Creator Key theft.** Detailed above.
- **FE-03 — an account whose key never authenticates.** Detailed above.
- **FE-09 — another account's data displayed under the current account.** Detailed above.

### Unsafe DOM sinks — full sweep

301 `innerHTML` / `insertAdjacentHTML` sites across the client bundle were
enumerated and every interpolation classified. **The only exploitable class is
FE-02's script-context sinks.** Everything reaching an HTML *text* or *attribute*
context is correctly escaped. Verified by pushing
`"><img src=x onerror="window.__xss=1">` through, and finding it inert in, every
one of:

| Source | Route | Outcome |
|---|---|---|
| Published list name, description, and creator display name | `/api/search-published-lists`, `/api/public-lists.json` (server returns them raw — confirmed) | escaped at render |
| TMDB / Trakt title, overview, list name | `/api/title-search`, `/api/trakt-search`, `/api/tmdb-search-lists` | escaped (`data-title="&lt;img src=x…&gt;"`) |
| 13 `localStorage` keys (list names, channel names, item names, presets, usernames, watch history, liked lists) | page load + all six tabs + every subnav pill | `__xss` stayed 0 |
| URL: `#/list?name=…&type=…&url=…`, `#/item?id=…&type=…`, path traversal, 5 KB hashes, NUL bytes | 14 malformed deep links | `__xss` 0, `jsHrefs` all `javascript:void(0)`, 0 page errors |
| Feedback message / contact / creator name into the admin inbox | `/admin` | escaped (and unreachable anyway — see FE-01) |

`escapeHtml` itself (`19_client-search-and-likes.js:146`) is correct: it escapes
`& < > " '` and maps `null`/`undefined` to `''`.

### Other checks

- No `eval`, `Function()`, `document.write`, or string-argument `setTimeout` in the client bundle.
- CSP is present and meaningful on every page: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`. `'unsafe-inline'` is deliberate (the UI is driven by inline handlers) and documented; it is also precisely what makes FE-02 exploitable.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` on all pages.
- The Creator Key is never placed in a URL, a query string, or a rendered link. It is shown once in the reveal modal and stored in `localStorage` (inherent to the passwordless design).

---

## Mobile / Responsive Bugs

Tested at **320, 375, 390, 412, 768, 1024, 1280, 1440, 1920 px**, all six tabs at
each width, plus live resizing between them.

```
w=320  maxHScroll=0  navVisible=true   navItemsOffscreen=1  tinyTargets=0
w=375  maxHScroll=0  navVisible=true   navItemsOffscreen=0  tinyTargets=0
w=390  maxHScroll=0  navVisible=true   navItemsOffscreen=0  tinyTargets=0
w=412  maxHScroll=0  navVisible=true   navItemsOffscreen=0  tinyTargets=0
w=768…1920            navVisible=false navItemsOffscreen=0  tinyTargets=0
pageerrors: 0
```

- **FE-14** (above) — "Settings" label clipped at 320 px only.
- **FE-08** (above) — the page scrolls behind modals; worst on mobile.
- **No horizontal page scroll at any width.** No clipped buttons, no unreachable
  controls, no overlapping elements, no tap target under 24 px.
- Drag & drop has real touch support on all four surfaces — catalog rows
  (`initTouchDrag`, `23_client-list-management.js`), channels (`20_client-channel-builder.js`),
  custom lists (`21_client-custom-list-builder.js`) and the dashboard
  (`initCreatorListTouchDrag`, `22_client-creator-profile.js`) — real
  `pointerdown`/`touchstart`/`touchmove`/`touchend`, not `draggable="true"` alone.

---

## Accessibility Bugs

### FE-10 — MEDIUM — Modals have no keyboard or screen-reader affordances

There is **no `Escape` handler anywhere in the client bundle** (zero matches for
`Escape`, `keyCode === 27`). Measured against both modal systems:

```
showModal + Escape       : {before:"present", after:"present"}   <- still open
createListModal + Escape : {before:"flex",    after:"flex"}      <- still open
focus before/during/after modal: {before:"BUTTON#themeToggleBtn",
                                  during:"BUTTON#themeToggleBtn",
                                  after:"BUTTON#themeToggleBtn"} <- focus never enters
modal semantics: {hasTabindex:false, role:null, ariaModal:null}
after Tab from the last modal button, focus is: BODY  insideModal=false
```

So: Escape does nothing, focus never moves into the dialog, Tab walks straight out
of it into the page behind, and there is no `role="dialog"` / `aria-modal="true"`.
`showModal` (`16_client-row-core.js:838`) handles only backdrop clicks.

**Fix.** In `showModal`: add `role="dialog" aria-modal="true"`, focus the first
control, trap Tab within the overlay, close on `Escape`, and restore focus to the
opener on close. Wire the four static modals in `09_page-shell.js` to the same helper.

### FE-11 — MEDIUM — `role="tablist"` with no tabs, declared twice

```html
<div class="tab-bar" role="tablist">            <!-- desktop, no aria-label -->
  <button type="button" class="tab-btn" data-tab="catalogs" onclick="switchTab('catalogs')">Catalogs</button>
  …
<nav class="bottom-nav" role="tablist" aria-label="Main navigation">   <!-- mobile -->
  <button type="button" class="bottom-nav-item" data-tab="catalogs" …>
```

Measured: `[role=tablist]` × 2, `[role=tab]` × **0**, `[role=tabpanel]` × 0, no
`aria-selected`, no `aria-controls`. An ARIA `tablist` may only contain `tab`
children, so assistive technology sees an empty tab list. Both bars are in the DOM
at all times (only CSS hides one), so the six navigation items are announced
twice.

**Fix.** `role="tab"` + `aria-selected` + `aria-controls` on the buttons,
`role="tabpanel"` + `aria-labelledby` on `[data-tab-panel]`, and `aria-hidden="true"`
(or `display:none`, which it already has) plus removal from the a11y tree on
whichever bar is not shown.

### Smaller a11y findings

- **20 form controls with no accessible name** — mostly `<select>`s
  (`createListModalDestination`, `createListModalType`, `addShelfModalType`,
  `listGroupFilterSelect`, …) whose visible label is a sibling `<label>` with no
  `for`. Fix with `for`/`id` or `aria-label`.
- **No `aria-live` region anywhere** (0 found), so loading, error and "saved"
  states are never announced. Add one polite live region and route
  `showAddedToast` / `.testresult` text through it.
- **1 clickable non-button** — `span.drag-handle-list` carries `onclick` with no
  `tabindex` or `role`. (Only one, out of 665 `onclick` elements — the rest are
  real buttons.)
- **No skip link**; **two `<h1>`** on the page.

### Verified good

- **Focus visibility is fine.** Real keyboard tabbing gives `outline: auto 1px`
  on every one of the first 14 tab stops (`:focus-visible` matched on all of them).
  My first measurement said otherwise; that was an artefact of using programmatic
  `.focus()`, which does not trigger `:focus-visible`.
- Every `<img>` has an `alt` attribute (0 missing).
- Two landmark elements (`<header>`, `<nav>`).

---

## PWA / Service Worker Bugs

### FE-15 — MEDIUM — The app is not usable offline at all

`sw.js` (served from `02_http-and-creator-utils.js`) intercepts **only** `GET /app.js?v=…`; every other request, including the
navigation, is passed through untouched (`if (!isBundle) return;`).

```
service worker: [{scope:"http://127.0.0.1:8787/", active:true, state:"activated"}]
after visit 1: {}                                                    <- SW not yet controlling
after visit 2: {"mylists-app-v1":["…/app.js?v=127fbc649eb09df54139"]}
after visit 3: unchanged
OFFLINE reload (bundle cached): FAILED -> net::ERR_INTERNET_DISCONNECTED
```

The README advertises *"Installable PWA with offline caching (`/sw.js`)"*, and the
manifest declares `display: standalone` — so launching the installed app without
a connection gives the browser's network-error page, not the app.

**Fix.** Cache the navigation response and `/app.css` under the same versioned
scheme, and serve a cached shell (or a small offline page) on navigation failure.
If offline is *not* intended, correct the README instead — but a `standalone` PWA
that cannot open offline is a poor experience either way.

### Verified good

- **No stale-bundle risk.** `/app.js` is versioned by content hash
  (`?v=127fbc649eb09df54139`); the SW keeps exactly one entry and deletes the rest
  on a new URL. `/` is served `Cache-Control: no-cache` with an `ETag`, so a new
  deploy is picked up on the next load — a user cannot get wedged on an old
  frontend.
- `skipWaiting()` + `clients.claim()` on install/activate: no two-refresh update dance.
- SW failures fall through to `fetch(e.request)`; a cache error cannot break the page.
- Manifest is valid and served as `application/manifest+json`.

Minor: `background_color`/`theme_color` are the light palette (`#F2F2F7`) only, so
the splash flashes light for dark-mode users.

---

## Performance / Memory

No leaks found. Chrome DevTools `Performance.getMetrics` before and after
sustained interaction:

```
baseline      : {nodes:10314, listeners:835, docs:3, heapMB:1.8}
200 modal open/close : {nodes:9986,  listeners:830, heapMB:1.2}
200 tab switches     : {nodes:10064, listeners:843, heapMB:1.3}
60 searches          : {nodes:10077, listeners:844, heapMB:1.3}
delta: listeners +9, nodes -237, heapMB -0.5
```

- 67 `addEventListener` calls, nearly all delegated at `document`/`window` and
  registered once at load — hence no growth.
- Two `setInterval`s: the 60 s foreground-sync poll (module scope, once) and the
  Trakt device-code poll (cleared on success, on expiry, and before re-arming).
- Both modal systems remove their node on close; nothing accumulates.

Observation (not a defect): the bundle is 1.36 MB of uncompressed JavaScript
parsed on every cold load. It is split out of the HTML and content-hashed, which
is the important part.

---

## Console / Network Errors — actually observed

| Where | Error | Verdict |
|---|---|---|
| `/admin`, every load | `SyntaxError: Invalid or unexpected token` | **FE-01** |
| `/admin`, any click | `ReferenceError: switchAdminMainTab is not defined`, `switchAdminSubTab is not defined` | **FE-01** |
| Discover → Curated, after FE-07 | `Curated lists error: TypeError: u.split is not a function` | **FE-07** |
| Any tab, `dashboardListOrder` corrupted | `TypeError: savedOrder.map is not a function` (×2) | **FE-13** |
| Every page load in my sandbox | `net::ERR_CONNECTION_RESET` for `fonts.googleapis.com` and `cdn.jsdelivr.net/npm/fflate` | **environment, not a defect.** fflate's absence is handled with a real message (`18_client-copy-and-trakt-export.js:792, 1141, 1424`); fonts fall back. |
| `/api/preview` under load from one IP | `429` | **correct** — the shared rate limiter. The client renders the server's message and stays usable. |

The builder page itself produces **zero** page errors across a full crawl of all
six tabs, every subnav pill, and 14 deep links.

---

## Dead Code

### SAFE TO DELETE

| Symbol | Location | Evidence |
|---|---|---|
| `renderCustomListSearchResults()` | `21_client-custom-list-builder.js:32` | The only unreferenced function of 496. Zero references in the bundle, in the rendered page markup, or in `tests/`. Grep across all repo `.js`/`.mjs` returns only its own definition. |

### REQUIRES MORE VALIDATION

- `/api/resolve-show`, `/api/external-list/item-add`, `/api/external-list/item-remove`,
  `/api/creator/sync/share-tracking`, `/api/publish-list`, `/api/public-lists.json`
  — no *direct* client call site. `resolve-show` is reached through the `endpoint`
  variable at `19_…:2722`, `21_…:82`, `22_…:4246`; the others may be protocol- or
  server-driven. **Do not remove** without checking the Stremio/wako protocol paths.

The client is otherwise remarkably clean — 495 of 496 functions are live, and
`html_checks.py` already fails the build on duplicate top-level declarations, which
is why there are none.

---

## Duplicate Code / Duplicate Logic

| What | Where | Safe to consolidate? |
|---|---|---|
| The 12-line "read every provider credential from the DOM then `localStorage`" block, verbatim | **15 occurrences** (e.g. `19_…:2211-2220`, `19_…:2779-2787`) — while `collectKeys()` (`23_client-list-management.js:444`) already does exactly this | **Yes.** Replace with `collectKeys()`. Highest value: 15 places to update whenever a provider is added. |
| `openMdblistAiringNextDetailsPage` / `openTraktAiringNextDetailsPage` / `openSimklAiringNextDetailsPage` | `17_client-my-lists-and-trakt-oauth.js:115, 920, 1726` — 0.87–0.91 token similarity | Yes, with a `provider` parameter. Behavioural differences are confined to field names. |
| `enrichMdblistAiringNextDates` / `enrichTrakt…` / `enrichSimkl…` | `17_…:59, 864, 1668` — 0.67–0.81 | Yes, same shape. |
| `getChannelDragAfterElement` / `getCustomListDragAfterElement` | `20_…:5312` / `21_…:318` — 0.89 | Yes — pure geometry, no state. |
| `initChannelHoldDrag` / `initCustomListHoldDrag` | `20_…:5172` / `21_…:178` — 0.87 | Yes, parameterise the container and the reorder callback. |
| `renderMyMdblistLists` / `renderMyPrivateTraktLists` | `17_…:150, 960` — 0.85 | Probably; check the per-provider action buttons first. |
| `copyShareListUrl` / `copyShareUrlById` | `22_…:573, 2633` — 0.77 | Yes. |
| `importFromLink` / `restoreListsFromLink` | `24_client-backup-restore-presets.js:665, 788` — 0.64 | Yes; the second is the first minus the catalog-row half. |

**Zero byte-identical function bodies** — no accidental copy-paste duplicates.

---

## Testing Gaps

`tests/client.test.mjs` has **12 tests for 1.36 MB of client code**, all added by
the previous audit and all about two things: the `expectedUpdatedAt` conflict
guard and account switching. Nothing else in the client is covered.

Gaps that would have caught the findings above, in priority order:

1. **`/admin` is never rendered or syntax-checked.** `verify.sh` step 4 and
   `html_checks.py` only exercise `renderBuilder()`. Rendering `/admin` and
   `node --check`-ing its `<script>` blocks would have failed the build on FE-01
   two days ago. **This is the single highest-value test to add.**
2. **No test asserts what an inline handler attribute contains.** `html_checks.py`
   proves handlers *resolve*; nothing proves the argument list survives hostile
   input (FE-02).
3. **No double-submit test on any mutating action** (FE-03).
4. **No test reads a non-`ok` response body** for `item-mutate` (FE-04).
5. **No stale-response test** for `runCatalogSearch` or `loadCreatorSync` (FE-06, FE-09).
6. **No malformed-backup test** — `validateAndRepairBackup` has no test at all,
   despite existing entirely to handle bad input (FE-07).
7. **No layout/a11y assertions at all** (FE-08, FE-10, FE-11, FE-14).

### Mutation observations

Mutations I applied mentally or in the harness that **current tests do not catch**:

| Mutation | Suite result |
|---|---|
| Remove `expectedUpdatedAt` from `saveCreatorListWithBaseline` | ❌ caught (this is what the 12 tests cover) |
| Remove the 409 branch from `pushCreatorSync` | **survives** — nothing exercises it |
| Make `escapeAttr` the identity function | **survives** — no test inspects rendered markup |
| Delete the whole `catch` in `removeSingleExternalItemDirect` | **survives** |
| Invert `if (savedOrder && savedOrder.length)` | **survives** |
| Break any `03_admin.js` inline script | **survives** — and did, for two days |

---

## Regression Findings *(read only after the independent pass)*

Prior audits read: `AUDIT-2026-09-05-INDEPENDENT.md`,
`AUDIT-2026-09-06-ADVERSARIAL.md`, `AUDIT-2026-09-06-ADVERSARIAL-II.md` and both
FIX-STATUS files.

They were, by their own account, **server-side audits** — `tests/client-harness.mjs`
says so in its header. Only three findings across all three documents are frontend.
All three are **still fixed**:

| Prior finding | Status now | Evidence |
|---|---|---|
| **#19** — removing one Watch History item rebuilt the whole grid | ✅ still fixed | `22_client-creator-profile.js:4715` prefers `updateWatchHistoryGridAfterRemoval()` (`23_client-list-management.js:1354`) and only falls back to a full render |
| **#20** — a grouped Watch History tile removed from Continue Watching instead | ✅ still fixed | `23_client-list-management.js:1889-1891` sets `removeShowId` only when `isCw` and `removeHistoryId` when `isHistory`; `23_…:1087-1092` dispatches on the right one |
| **#10** — double-escaped creator name in the admin reply placeholder | ✅ still fixed | `03_admin.js:2902` interpolates the pre-escaped `who` once |

**Prior findings that were backend-only and are irrelevant here:** N1–N12, A1–A17,
P2/P3 — all Worker-side (KV/D1 authority, purge honesty, cron cursor, cache
headers, PBKDF2 throttling).

**What the previous audits missed, and why.** Every finding in this report except
FE-05 and FE-09 is invisible to a server-side harness. FE-01 in particular is
invisible even to the *existing* frontend checks, because those only ever render
the builder page. The prior audit's own closing note — *"Its blind spot is the
client"* — is still accurate: the client harness it introduced is a good tool with
12 tests pointed at one feature.

One finding is a **regression introduced by a prior audit's fix**: the second
broken `confirm()` block (FE-01) came in with `4ba6e0a`, *"Close the audit's
remaining open items (R1–R5)"*.

And FE-03 is a **regression caused by the D1+KV architecture change itself**: the
missing double-submit guard was harmless while KV was the only store.

---

## Frontend Interaction Map

**Sign in**
```
#restoreKeyInput + click Sign In
  → submitRestoreProfile()                       22_client-creator-profile.js:2557
  → POST /api/creator/restore {creatorName, creatorKey}
  → 200 {ok, creatorName, displayName} | 401 {ok:false, error}
  → clearLocalAccountData(); activeCreator = {...}
  → localStorage: creatorName, creatorDisplayName, creatorKey
  → renderCreatorProfileBar / renderAccountKeySection / renderCreatorDashboard
  → await loadCreatorSync()  ── FE-09: no identity re-check after the await
       → POST /api/creator/sync/load → applies config, likedLists, hidden lists, keys
       → DOM: #lists rebuilt from synced.config
```

**Edit and save a Custom List**
```
Lists → My Lists → Edit → customListDraftItems mutated in memory
  → saveCreatorListEdit(name)                    21_client-custom-list-builder.js:539
  → POST /api/creator/lists/save {creatorName, creatorKey, slug, name, type, items, visibility}
       ── FE-05: no expectedUpdatedAt → last write wins
  → 200 {ok, slug, updatedAt, url}
  → loadLocalCustomLists() / saveLocalCustomListsMap() → localStorage + sessionStorage mirror
  → renderCreatorDashboard() → #creatorListRows
```

**Add / remove a title from provider lists**
```
poster "+" overlay → openSelectListModal(id,type,title,poster)   19_…:2273
  → body.style.overflow='hidden'  ── FE-08: no-op ── FE-12: leaked by one exit
  → renders checkboxes from _selectListModalTempLists
  → Remove → removeSingleExternalItemDirect(...)                 19_…:2187
       → optimistic: setExternalListMembership(false), uncheck, hide button
       → POST /api/external-list/item-mutate {action:'remove', provider, target, listId, id, …tokens}
       → response DISCARDED  ── FE-04
       → showAddedToast('Removed from TRAKT.')  regardless of outcome
```

**Search**
```
#catalogSearchInput oninput → handleCatalogSearchInput()  (350 ms debounce)
                    Enter   → runCatalogSearch()          (immediate, bypasses debounce)
  → POST /api/track-search (fire and forget)
  → GET  /api/title-search?type=…&q=…
  → window._rawCatalogTitleItems = data.results   ── FE-06: no sequence guard
  → applySearchFilters() → #catalogSearchResult innerHTML
```

**Restore a backup**
```
#configJsonBox → importConfigJson()               24_…:193
  → JSON.parse (guarded)
  → validateAndRepairBackup()  — checks entries, keys, item ids, order, empty rows
                                 does NOT check likedLists element types ── FE-07
  → applyImportedConfig(data)
       → saveLocalChannelsMap(data.channels)      no validation at all ── FE-02
       → localStorage[likedLists] = s.likedLists  Array.isArray only (24_…:538) ── FE-07
  → showImportReport() → "✓ Restore Complete"
```

**Channels tab render**
```
switchTab('channels') → renderMyCreatedChannelsList()   20_client-channel-builder.js:6322
  → loadLocalChannels() from localStorage
  → per channel: '<button onclick="editChannelById(&quot;' + escapeAttr(ch.channelId) + '&quot;)">'
       ── FE-02: escapeAttr emits &quot;, the HTML parser decodes it, the JS string breaks
```

---

## API Call Inventory

124 `fetch` call sites → **64** distinct `ORIGIN + '/api/…'` endpoints, plus
`/api/resolve-show` reached through a variable (`19_…:2722`, `21_…:82`, `22_…:4246`),
plus one direct third-party call to `api.themoviedb.org`. Callers are the client
module and function; `→` shows the state the reply mutates.

| Endpoint | Method | Principal caller(s) | Reply consumed as |
|---|---|---|---|
| `/api/creator/create` | POST | `submitCreateProfile` (22_) | `{ok, creatorName, displayName, creatorKey}` → `activeCreator`, 3 storage keys **FE-03** |
| `/api/creator/restore` | POST | `submitRestoreProfile`, `submitForgotKey` (22_) | `{ok, creatorName, displayName}` → sign-in |
| `/api/creator/reset-key` | POST | `submitForgotKey` (22_) | `{ok, creatorKey}` → reveal modal |
| `/api/creator/account/reset`, `/api/creator/delete-account` | POST | Settings → Account (22_) | `{ok}` → `clearLocalAccountData` |
| `/api/creator/sync/load` | POST | `loadCreatorSync` (22_) | full state blob → DOM + storage **FE-09** |
| `/api/creator/sync/save` | POST | `pushCreatorSync` (22_) | `{ok, updatedAt}` \| **409** → re-pull ✅ |
| `/api/creator/sync/meta` | POST | `handleForegroundResumeSync` (22_) | 4 timestamps → skip/do a full load |
| `/api/creator/sync/save-presets` / `-channels` / `-tracking` | POST | `pushPresetsDirectly`, `pushChannelsSync`, `pushTrackingSync` (22_, 24_) | `{ok, …UpdatedAt}`; first two send `expectedUpdatedAt` |
| `/api/creator/sync/like` | POST | like handler (19_) | fire and forget |
| `/api/creator/lists` | POST | `fetchCreatorListsOnce` (22_) | `{ok, lists[], order[]}` → dashboard **FE-13** |
| `/api/creator/lists/save` | POST | 12 sites; only `saveCreatorListWithBaseline` arms the guard | `{ok, slug, updatedAt, url}` \| 409 **FE-05** |
| `/api/creator/lists/delete` | POST | `deleteCreatorListBySlug` (23_) | `{ok}` |
| `/api/creator/lists/reorder` | POST | drag-drop persist (23_) | `{ok}` |
| `/api/creator/scrobble-token`, `-seen-users`, `/track-status` | POST | Settings → Track Playback (22_) | `{ok, …}` |
| `/api/external-list/item-mutate` | POST | 7 sites (19_, 21_, 22_) | **discarded at all 7** **FE-04** |
| `/api/external-list/create`, `/delete` | POST | `submitCreateListModal` (22_) | `{ok, listId}` |
| `/api/preview` | POST/GET | `renderLivePreview` (23_), row Test (18_), 4 more | `{ok, sample[], maybeMore}` → shelves |
| `/api/title-search` | GET | `runCatalogSearch`, `renderDefaultCatalogSearch` (19_), channel/list pickers (20_, 21_) | `{ok, results[]}` **FE-06** |
| `/api/search-published-lists` | GET | `executeUnifiedListSearch` (19_) | `{ok, lists[]}` (guarded by sequence ✅) |
| `/api/trakt-search`, `/api/tmdb-search-lists`, `/api/trakt-popular-lists`, `/api/toplists` | GET | `executeUnifiedListSearch` (19_) | list arrays |
| `/api/trakt-my-lists`, `-my-private-lists`, `/api/tmdb-my-lists`, `/api/mdblist-my-lists`, `/api/simkl/my-lists` | GET/POST | provider panels (17_) | `{ok, lists[]}` |
| `/api/trakt/device/code`, `/token` | POST | `startTraktDeviceLogin` (17_) | polled on `setInterval`, cleared correctly ✅ |
| `/api/{trakt,tmdb,simkl,mdblist}/oauth/start` | GET | Settings connect buttons (17_) | redirect |
| `/api/details`, `/api/details/batch`, `/api/season`, `/api/show-seasons`, `/api/show-episodes` | GET/POST | item details, channel builder (19_, 20_) | metadata |
| `/api/resolve-movie`, `/api/resolve-show` | GET | id resolution (19_, 21_, 22_) | `{ok, imdbId}` |
| `/api/bulk-resolve` | POST | Letterboxd CSV import (18_) | `{ok, results[]}` |
| `/api/poster-fallback` | GET | `resolveMissingPostersInDom` (16_) | `{ok, poster}` |
| `/api/lists/like`, `/api/lists/like-external` | POST | like handler (19_) | `{ok, likes}` → server-authoritative count ✅ |
| `/api/feedback`, `/api/feedback/threads` | POST/GET | Settings → Feedback (16_) | `{ok, entry}` |
| `/api/recommendations` | POST | Discover → Curated (19_) | `{ok, movies[], shows[]}` **FE-07** |
| `/api/save`, `/api/resolve` | POST/GET | install-link build & import (24_) | `{ok, config}` / full config **FE-02(B)** |
| `/api/track-event`, `/api/track-install`, `/api/track-search` | POST | telemetry (16_, 19_, 24_) | fire and forget |
| `/api/channel-preset`, `/api/quick-channel-shows` | GET | channel quick-add (20_) | presets |
| `/api/external-sync/history`, `/api/trakt-history-raw`, `/api/mdblist-history-raw` | POST/GET | history import (18_) | item arrays |
| `https://api.themoviedb.org/3/find/…` | GET | `syncCustomListPayload` (19_) | direct third-party call with the user's own key |

---

## File-by-File Punch List

### `03_admin.js`
- **Bugs:** **FE-01** (lines 2418, 2424, 2426, 2542, 2554, 2560, 2562 — swallowed `\n`/`\s`, whole dashboard script dead).
- **Cleanup:** none needed once fixed.
- **Tests needed:** render `/admin` and `node --check` every inline `<script>`; assert `switchAdminMainTab` is defined after login.
- **Safe change:** double the backslashes. Nothing else in this file needs to move.

### `09_page-shell.js`
- **Bugs:** **FE-08** (`html{overflow-x:hidden}` at line 218 defeats every scroll lock); **FE-11** (`role="tablist"` with no `role="tab"`, lines ~3160 and the bottom nav); **FE-10** (four static modals with no Escape/focus handling, lines 3198–3299); **FE-12** (createListModal's Cancel/✕ never restore overflow, lines 3202/3244); **FE-14** (bottom nav at 320 px).
- **Cleanup:** the four static modals each hard-code `style.display='none'` in an `onclick`; route them through one helper.
- **Tests needed:** a layout test asserting no page scroll while a modal is open; an a11y test asserting Escape closes and focus is trapped.

### `16_client-row-core.js`
- **Bugs:** **FE-10** — `showModal`/`closeModal` (839-853) have no focus, Escape, or ARIA handling; **FE-02** — one `&quot;`+`escapeAttr` sink at 1160.
- **Confirmed good:** `resolveMissingPostersInDom` (`16_…:810`) guards re-entry with `dataset.fallbackRequested`; the duplicate-declaration trap for `handlePosterImgError` is documented and CI-enforced.
- **Safe change:** add `role="dialog" aria-modal="true"`, focus management and an Escape listener inside `showModal` — every dynamic modal in the app inherits the fix.

### `17_client-my-lists-and-trakt-oauth.js`
- **Bugs:** three of the seven response-ignoring `item-mutate` sites (**FE-04**, lines 2111, 2134, 2157).
- **Cleanup:** three near-identical Airing Next openers and three enrichers (0.67–0.91 similarity).
- **Confirmed good:** the Trakt device-code `setInterval` is cleared on success, on expiry, and before re-arming.

### `18_client-copy-and-trakt-export.js`
- **Confirmed good:** fflate's absence is detected and reported with an actionable message at all three use sites; `MAX_PAGES` caps the pagination loop.
- **Tests needed:** a malformed-zip test for the Trakt/Letterboxd importers.

### `19_client-search-and-likes.js`
- **Bugs:** **FE-06** (`runCatalogSearch`, 3199); **FE-07** (`getLikedListsSet`, 744, and the `likedKeywords` map at 1273); **FE-12** (2546); **FE-04** (`removeSingleExternalItemDirect`, 2187); **FE-02** (15 handler sinks).
- **Cleanup:** the provider-credential block appears here 4 times; use `collectKeys()`.
- **Confirmed good:** `escapeHtml`/`escapeAttr` themselves; `executeUnifiedListSearch`'s sequence guard; the like button's disable/`finally` pattern.

### `20_client-channel-builder.js`
- **Bugs:** **FE-02** — 17 handler sinks, and this is the file the confirmed exploit lands in (6347, 6350, 6416, 6429, 6442, 6443, 7035, 7044, 7057, 7073).
- **Cleanup:** `getChannelDragAfterElement` / `initChannelHoldDrag` duplicate the custom-list equivalents.
- **Tests needed:** the rendered-attribute test from FE-02.

### `21_client-custom-list-builder.js`
- **Bugs:** **FE-05** (`saveCreatorListEdit`, 539/550 — no baseline).
- **Dead code:** `renderCustomListSearchResults` (line 32) — **safe to delete**.
- **Cleanup:** drag helpers duplicated from `20_`.

### `22_client-creator-profile.js`
- **Bugs:** **FE-03** (`submitCreateProfile`, 2459 — no submit guard); **FE-09** (`loadCreatorSync`, 1827 — no identity re-check after the await); **FE-13** (`savedOrder.map`, 3241/3573); **FE-02** (4 handler sinks); **FE-07** (`likedLists` written unchecked at 1980).
- **Confirmed good:** `clearLocalAccountData` (`22_…:1181`) is thorough — in-memory tokens, list arrays, tracking sets, poster caches, drafts, `localStorage`, **and** the `sessionStorage` mirror, plus form inputs and checkboxes. Verified empirically with a two-account switch. `pushCreatorSync`'s 409 handling is correct.
- **Tests needed:** double-submit; stale-`sync/load`-after-switch.

### `23_client-list-management.js`
- **Confirmed good:** `renderLivePreview` handles `!data.ok`, empty samples and thrown `res.json()` per shelf without leaving spinners; `showPosterPlaceholderFor` handles all four call-site DOM shapes (the prior audit's fix, still correct).
- **Tests needed:** a preview test asserting a failed shelf clears its own spinner.

### `24_client-backup-restore-presets.js`
- **Bugs:** **FE-07** (`applyImportedConfig`, 331; the unchecked write is at 538); **FE-02(B)** (`resolveInstallLinkData`, 598 — accepts `channels`/`customLists` from an arbitrary origin, and falls back to the Worker's own proxy when CSP blocks the direct fetch).
- **Cleanup:** `importFromLink` (665) / `restoreListsFromLink` (788) are 0.64 similar.
- **Confirmed good:** `saveLocalCustomListsMap`'s quota ladder (compact → ultra-compact → report) works under real `QuotaExceededError`; `validateAndRepairBackup`'s five existing repairs are sound and its `\\`-escaping is correct throughout — the model for fixing `03_admin.js`.
- **Tests needed:** `validateAndRepairBackup` has no test at all. Add malformed / wrong-type / old-format / huge cases.

### `sw.js` (served from `02_http-and-creator-utils.js`)
- **Bugs:** **FE-15** — navigation and `/app.css` are not cached, so offline never works.
- **Confirmed good:** single-entry versioned cache, `skipWaiting`+`claim`, error fall-through.

---

## Top 10 Fixes

Ranked by security → data integrity → user impact → reliability → maintainability.

1. **FE-02** — stop building JS string literals inside `onclick`; move ids to `data-*` + delegated listeners (37 sites). *Security: full account takeover from a shared link or file.*
2. **FE-01** — double the backslashes at the seven `03_admin.js` sites, and add `/admin` to the render+`node --check` CI step. *The entire admin dashboard, including all moderation tooling, is dead today.*
3. **FE-03** — disable the submit button for the duration of `submitCreateProfile` (and the other credential forms). *Data integrity: a double-click creates an unusable account.*
4. **FE-04** — read the `item-mutate` response; roll back the optimistic change and surface the error on failure. *Data integrity: silent desync with Trakt/TMDB/Simkl/MDBList.*
5. **FE-05** — route all `lists/save` calls through `saveCreatorListWithBaseline`. *Data integrity: lost updates between devices.*
6. **FE-09** — re-check `activeCreator` after every await in `loadCreatorSync` and its siblings. *Security-adjacent: one account's data displayed under another.*
7. **FE-07** — type-check `likedLists` on read and on both write paths, and report the repair. *Reliability: silent, permanent feature loss presented as an empty state.*
8. **FE-06** — add the sequence guard to `runCatalogSearch`, matching `executeUnifiedListSearch`. *User impact: wrong results on slow connections.*
9. **FE-10 + FE-11** — Escape, focus trap, focus restore and `role="dialog"` in `showModal`; `role="tab"`/`aria-selected`/`role="tabpanel"` on the two nav bars. *Accessibility: modals and navigation are unusable by keyboard and screen reader.*
10. **FE-08 (+FE-12)** — lock `documentElement`, not `body`, and give the select-list modal one close helper. *User impact: the page scrolls behind every modal.*

---

## Recommended Test Suite

Concrete additions. The first is worth more than the rest combined.

**A. Extend the render+parse check to every page the Worker serves.** In
`html_checks.py` / `verify.sh`, loop over `/`, `/configure`, `/guide`, `/admin`
(post-login) and `/channels/:id`; `node --check` each inline `<script>`; keep the
existing duplicate-declaration and handler-resolution checks. Catches FE-01 and
its whole class.

**B. `tests/client.test.mjs` — rendered-markup assertions.**
```js
test("a channel id cannot break out of its inline handler", () => {
  const c = loadClient({ storage: { "myListAddon:localChannels": JSON.stringify({
    ['"); window.__pwned=1; //']: { channelId: '"); window.__pwned=1; //', name: "C", type: "series", items: [] } }) } });
  const html = c.call("renderMyChannelsListHtml");           // or read __byId("channelsList").innerHTML
  for (const attr of html.matchAll(/onclick="([^"]*)"/g)) {
    // after entity decoding, the handler must still be a single call with balanced quotes
    assert.doesNotThrow(() => new Function(decodeEntities(attr[1])));
    assert.ok(!/__pwned/.test(decodeEntities(attr[1])));
  }
});
```

**C. Double-submit guards.**
```js
test("create profile sends exactly one request however many times it is clicked", async () => {
  const c = loadClient({ routes: { "/api/creator/create": async () => ({ json: { ok:true, creatorName:"a", displayName:"a", creatorKey:"MYL-A" } }) } });
  c.call("submitCreateProfile"); c.call("submitCreateProfile"); c.call("submitCreateProfile");
  await tick();
  assert.equal(requestsTo(c, "/api/creator/create").length, 1);
});
```
Repeat for `submitRestoreProfile` and `saveCreatorListEdit`.

**D. Failed writes must not report success.**
```js
test("a rejected external-list removal does not claim success", async () => {
  const c = loadClient({ routes: { "/api/external-list/item-mutate": async () => ({ status: 400, json: { ok:false, error:"Please connect your Trakt account first." } }) } });
  let toast = null; c.set("showAddedToast", (m) => { toast = m; });
  await c.call("removeSingleExternalItemDirect", "trakt", "watchlist", "watchlist", "tt1", "movie", null);
  assert.ok(!/Removed/.test(toast || ""));
});
```

**E. Stale responses lose.**
```js
test("an obsolete search response does not replace a newer one", async () => { /* resolve #1 after #2 */ });
test("a sync/load for the previous account is discarded", async () => { /* switch mid-flight, assert config untouched */ });
```

**F. Every list write cites a baseline.**
```js
test("no lists/save call omits expectedUpdatedAt for a list that has one", async () => { /* drive each entry point */ });
```

**G. `validateAndRepairBackup` — a table test** over: valid v1.x / v2.0 / v3.0,
empty, `likedLists` of objects, `dashboardListOrder` a string, items with no id,
name/url transposed, a 10 MB blob, unknown fields. Assert it repairs or reports,
and never leaves storage in a state that crashes a renderer.

**H. Layout and a11y smoke test** (Playwright, or the existing `vm` harness for
the markup half): no page scroll while a modal is open; Escape closes; focus is
inside the dialog; `[role=tablist]` contains only `[role=tab]`; every form control
has an accessible name.

---

## Confirmed Working Areas

Tested, exercised, and found correct. Listed so this report is not read as a list
of everything.

| Area | How it was verified |
|---|---|
| **Account switching & sign-out state hygiene** | Two real server accounts, switched without reload. No DOM text, `localStorage`, `sessionStorage`, in-memory cache, catalog row or liked-list entry survives the switch or the sign-out. `clearLocalAccountData` wipes the `sessionStorage` mirror too. |
| **Fault tolerance / recoverability** | 7 injected failures — search 500, malformed JSON, 502 with an HTML body, 429, sign-in 401, dropped connection, preview 500. **Every one recovered**: real error text, no stuck spinner, no disabled button, no leftover overlay, no leaked scroll lock. The answer to *"can a user get stuck without refreshing?"* is **no**, on every path I could fault. |
| **XSS resistance outside FE-02's sinks** | Hostile payloads through published-list names/descriptions/creator names, TMDB & Trakt search results, 13 storage keys, 14 deep links, and the admin feedback inbox — **all inert**. `escapeHtml`/`escapeAttr` are correct for text and plain-attribute contexts. |
| **Memory and event-listener hygiene** | 200 modal cycles + 200 tab switches + 60 searches → listeners +9, DOM nodes −237, heap −0.5 MB. No leak. |
| **Responsive layout** | 9 viewports × 6 tabs: **zero horizontal page scroll**, zero tap targets under 24 px, zero clipped or unreachable controls, zero page errors. Only the 320 px "Settings" label (FE-14). |
| **Touch drag & drop** | Real `pointerdown`/`touchstart`/`touchmove`/`touchend` handlers on all four reorderable surfaces, not `draggable="true"` alone. |
| **Optimistic concurrency where it is armed** | `sync/save` 409 → pull latest, keep the pending edit. `saveCreatorListWithBaseline` 409 → re-apply the edit to the fresh copy, retry once, then stop. Both verified against the real server. |
| **Rate-limit handling** | A real 429 from `/api/preview` and `/api/title-search` renders the server's message; the UI stays usable and retries work. |
| **Storage robustness** | Every `myListAddon:*` key set to `"{not json,,,"` → **0 page errors, 0 console errors**, all six tabs still render. `localStorage` filled to `QuotaExceededError` → `saveLocalCustomListsMap` compacts, retries, and still returns `true` with the data readable. |
| **Deep links & URL state** | 14 malformed/hostile URLs (empty ids, `javascript:` params, 5 KB hashes, path traversal, NUL bytes) → graceful empty states, no exceptions, no injection, no blank dead-ends. |
| **Service-worker versioning** | Content-hashed `/app.js?v=…`, single cache entry, old entries deleted on a new URL, `no-cache`+ETag on the shell. **A user cannot get stuck on a stale frontend.** |
| **Security headers** | CSP, `nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin` on every page including assets. No `eval`, no `Function()`, no string `setTimeout`. |
| **Source ↔ generated sync** | `python3 check_sync.py` byte-exact at 2,872,924 B. I appended 13 bytes to the committed Worker and the check failed with the exact offset, then passed again on restore. The drift guard is real. |
| **Focus visibility** | Real keyboard tabbing gives `outline: auto 1px` and `:focus-visible` on all of the first 14 tab stops. |
| **Dead-code hygiene** | 495 of 496 client functions are live; zero byte-identical duplicate bodies; `html_checks.py` already fails the build on duplicate top-level declarations and unresolved inline handlers (733 call sites checked). |

---

## POTENTIAL / NEEDS VALIDATION

Reported here rather than above because I could not close them.

1. **The other 33 `escapeAttr`-in-handler sites (FE-02's class).** I proved the
   sink is exploitable and confirmed two end-to-end paths through channel ids. The
   remaining sites carry provider list ids, IMDb/TMDB ids, feedback thread ids and
   hard-coded storyline ids. I could not construct an inbound path that puts a
   quote into those specific fields, but they are the same defect and should be
   fixed together rather than triaged individually.
2. **`/api/creator/sync/like` (`26_api-creator-and-admin-routes.js:3162`)** rebuilds `blob.likedLists` with
   `new Set(Array.isArray(...) ? ... : [])` and no `.map(String)`, unlike
   `sync/save` (`26_api-creator-and-admin-routes.js:2338`). Stored data reaches it already coerced, so I could
   not make it produce a bad blob — but it is the one write path without the
   coercion.
3. **Two `<h1>` elements and no skip link** — flagged by inspection; I did not
   test with an actual screen reader.
4. **Manifest `background_color` / `theme_color` are light-only** — a dark-mode
   user gets a light splash. Cosmetic; not measured on a real install.

---

## Appendix — how to reproduce the rig

The harness used for this audit is not committed; it is reproducible in about 100
lines:

- `tests/harness.mjs` already exports `worker`, `makeKv`, `makeD1`, `makeEnv`.
  Wrap `worker.fetch` in a `node:http` server, set a distinct `CF-Connecting-IP`
  per request (otherwise the shared 60 s rate limiter throttles the crawl), and
  stub `globalThis.fetch` for the four upstream providers.
- Put a small fault-injection layer in front: match on the request URL and
  optionally delay, force a status/body, or destroy the socket. This is what
  produced the search race, the sync race, and the seven fault scenarios.
- Drive it with `playwright` (`/opt/pw-browsers/chromium`), routing every non-
  local request to `route.abort()` so external fonts/CDN/images do not dominate
  the run time.
- Run a second instance with `DB` unbound to isolate KV-only behaviour — that is
  what turned FE-03 from "a race" into "a D1+KV regression".
