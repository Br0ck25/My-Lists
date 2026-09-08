# Adversarial Audit III — remediation status

Tracker for [`AUDIT-2026-09-08-ADVERSARIAL-III.md`](./AUDIT-2026-09-08-ADVERSARIAL-III.md).
Baseline `932da34`. Branch `claude/my-lists-security-audit-3n895k`.

**Rating movement:** `CRITICAL — do not keep serving shared links` → `CRITICAL CLOSED` (round 1) → `ALL HIGH-SEVERITY SECURITY CLOSED` (round 2) → `PHASES 1–3 COMPLETE` (round 3) → `ALL 🔴 AND 🟠 CLOSED` (round 4) → **`EVERY FINDING CLOSED BAR THE DEFERRED SHARD AND THE LOW-SEVERITY CLEANUP`** (round 5)

---

## ✅ Round 1 — the critical XSS, closed

Items 1–3 of the recommended fix order. Together they are the whole of the CRITICAL finding:
the two escaping bugs, and the check that stops them coming back.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 1 | 🔴 | **`</script>` breakout in the inline preamble.** `JSON.stringify` escapes `"` and `\` — everything the JS parser needs and nothing the HTML parser does. An HTML tokenizer ends a script element at the first `</script`, so a published list's name, an item title, a creator display name, a config entry name, or an OAuth token ended the block and the rest was parsed as markup. | New `jsonForScript()` (`02_http-and-creator-utils.js`), applied at **all 21** stringify sites that land in a script element — not only the six a caller can reach today. Escapes `<`, `>`, U+2028, U+2029 as `\uXXXX`, which is valid in both grammars the output must satisfy. | Real Chromium: `p13`, `p14`, `p39` all now report the attacker script **did not run** |
| 2 | 🔴 | **Attribute breakout.** Five settings inputs interpolated straight into `value="${…}"` with no escaping, so a `"` in an install link's `tmdbKey` / `traktKey` / `traktUsername` / `mdblistKey` / `simklKey` ended the attribute and injected its own event handler. | `escapeHtmlServer()` at all five sites (`15_tab-settings-html.js`). | `p39_attr_browser.mjs`: handler does not fire, **and** the value still round-trips into the input unchanged |
| 3 | 🔴 | **Nothing could see either bug.** CI proved the page *parses* (`node --check`, the rendered-script check) and that inline handlers resolve. Nothing proved a hostile value came out inert — which is why two prior audits called this area clean: both tested the client-side render, where `escapeHtml` is applied correctly, and neither tested the server-rendered preamble. | `render_check.js --hostile` renders the builder page with every caller-supplied field set to a payload; `html_checks.py` asserts neither marker breaks out **and that both markers are present first**, so a render that quietly stopped including them cannot pass by proving nothing. Wired into `verify.sh` (step 4d) and `.github/workflows/ci.yml`. | Mutation-tested — see below |

### Mutation test of the new check

A check that cannot fail is worse than no check. Three mutations, each caught:

```
MUTATION 1  revert the script-preamble escape   -> FAIL: MYLXSSPROBE</script survived …            exit=1
MUTATION 2  revert one attribute escape         -> FAIL: MYLXSSATTR" survived …                    exit=1
MUTATION 3  hostile render stops injecting      -> FAIL: MYLXSSPROBE is absent -- the hostile
            the payloads (the trap)                      render did not reach the script preamble  exit=1
```

### Exploit re-tested, in a real browser

Every vector from the audit, re-run against the fixed build:

```
p13  stored, anonymous POST /api/publish-list -> /lists/user/<slug>
     attacker script executed in the victim's browser: false      (was: true)
     document.title after payload: unchanged                       (was: PWNED:MYL-VICT-IMSK-EY01)
     page errors: []

p14  reflected, install link
     A. /<config>/configure                       ran: false       (was: true)
     B. /<config>/manifest.json -> 302 -> configure  ran: false    (was: true)

p39  attribute injection via an install link's tmdbKey
     attribute-injected handler ran: false
     the key still round-trips: "x\" autofocus onfocus=\"…"        (escaping is lossless)
```

### The fix is lossless

The regression risk of `<` escaping is that it changes a parsed value. It does not —
it is a valid escape in JSON *and* in JavaScript source, so only the wire bytes change
(`p40_roundtrip.mjs`, real Chromium, on a list named
`Sci-Fi <3 & "Classics" — 2000s   top 10 > 8.0 ❤️ 日本語`):

```
list name round-trips exactly : true
item title round-trips exactly: true
serverEntries still an array  : true
chart tables still populated  : true
ld+json still parses as JSON  : true
page errors                   : []
```

`bash verify.sh` green: build reproduces byte-for-byte, `node --check` passes, all four render
checks pass including the new hostile one, FUNCTION-MAP.md has no drift, **356 tests pass**.

---

## ✅ Round 2 — both `/api/resolve` findings and the ghost-list race

Items 4–7. Three audit findings, four edits — the ghost-list finding has two halves and
shipping only the first leaves the window half-closed.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 4 | 🟠 | **`/api/resolve` served one account's MDBList key and Trakt/MDBList OAuth tokens with `Cache-Control: max-age=3600`.** A GET, no `Vary`, so a browser or any shared cache in front of the Worker could store somebody's tokens for an hour. It was the only per-account GET in the app that was cacheable; the six siblings all answer `no-store`, and the page rendering the same secrets sets `no-store` deliberately. | `isPrivateApiPath()` now names it — the choke point whose whole purpose is that a route added later cannot forget — and both success paths return via `jsonPrivate()`. | `p34_cache.mjs`: now `no-store`, matching all six siblings |
| 5 | 🟠 | **`/api/resolve` was an unauthenticated request proxy.** Host, port and scheme came straight from the query string; the Worker fetched that origin and echoed the body back. No allowlist, no rate limit. `/api/preview` grew both for the same shape and this sibling was missed. | New `isRemoteResolveOrigin()`: https only, default port, DNS-named host with an **alphabetic TLD** — which rejects every IP literal in every encoding a URL parser accepts — minus explicit private suffixes. It cannot reuse `/api/preview`'s provider allowlist because the legitimate target is *another deployment of this add-on*, on whatever domain its owner chose. Outbound branch charged against a 20/min per-IP bucket. | `p20_ssrf.mjs`: **0** outbound requests, was 27. `p41`: 20 unit cases + 11 live variants blocked |
| 6 | 🟠 | **The purge's second pass stranded directory rows.** The first pass hands its ids to `removeListsFromPublicIndex`; the second deleted only the KV keys, so a list landing between the two passes lost its record and kept its index row — a directory entry advertising an item count that 404s on click. | Second pass collects `lateListIds` and drops them too. `updatePublicListIndex` additionally refuses an ADD for an account whose deletion tombstone is already written — and the tombstone is the *first* thing `purgeCreatorData` writes. | `p26`, `p27` |
| 7 | 🟠 | **An ownerless list stayed public and unremovable.** A save that authenticated a millisecond before its owner deleted the account keeps running and its KV put lands after both sweeps — 6 of 10 plain concurrent runs. The record is genuinely `public`, so it stayed readable, listed and searchable, and could never be removed: every authenticated route answers 401 for that username. | Fail closed on read. `/lists/:user/:slug` 404s a creator list with no creator record; the rebuild skips orphans; both cold-index fallbacks filter through one memoized `makeCreatorExistsMemo()`. Gated on `isCreatorList` so anonymous lists (no account, by design) are untouched; a *failed* read counts as present, so a KV blip cannot hide a live list. | `p26_ghostpublic.mjs`: page **404**, directory **empty**, search **empty** — was 200, listed, listed |

### A correction to this tracker

Item 6 above said "re-sweep `creatorlist:` after the identity is removed". That sweep
**already existed** — the audit said "after the *existing* post-identity sweep" and the
one-line restatement lost the word. A third sweep would only narrow the window again, since
nothing bounds how late a KV write may land, so none was added. The two gaps the audit actually
named — the second pass not cleaning the directory, and the read side not failing closed — are
what got fixed.

### Legitimate behaviour, checked rather than assumed

```
$ node p41_resolve_fixed.mjs
1. a link from a sibling deployment
   status 200 | entries: 1 | name: From the sibling deployment
   outbound: [ 'https://someone-else.workers.dev/api/resolve?config=…' ]
   Cache-Control: no-store
2. the SSRF cases                      11 variants, outbound=0 on every one
3. rate limit on the outbound branch   30 calls from one IP -> 20 allowed, 10 throttled
4. an ordinary import                  40 local resolves from the SAME throttled IP -> 40 succeeded
```

Three directory tests failed on the first run. They seeded `creatorlist:` keys with **no
`creator:` record** — a state no write path can produce, since every creator-list write goes
through `authenticateCreator`. The fixtures were unrealistic, not the check: they now seed the
account too, which also makes them catch a regression in the new filter. Three tests added pin
the behaviour; the half that only fires on a genuine race says so in a comment and points at the
two probes that cover it, rather than shipping a test that passes for the wrong reason.

`bash verify.sh` green — **358 tests pass**. Auth matrix, admin matrix, rebuild-privacy and the
XSS probes all re-run clean.

---

## ✅ Round 3 — the three unbound identifiers, the dead directory url, and the check that finds them

Items 10–14. Four defects, one root cause: **27 sources concatenated into one scope, with
nothing checking that identifiers resolve.** Two of the three sat behind a bare `catch`, which
is why 358 tests, a full render check and five prior audits all went past them.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 10 | 🟠 | **`/lists/curated/<slug>` answered HTTP 500 on every request.** `isShow` was declared nowhere. The client's own `getListCleanPath` puts that path in the address bar whenever one of the twelve curated shelves is opened, so reloading or sharing any of them landed on an error. | The twelve shelves now live in one `CURATED_LIST_ENTRIES` table (`08_quickadd-chart-data.js`), read by the route **and** embedded into the client, which builds its own preset list from it. A slug regex would have fixed the crash and still got `true-crime-mystery` wrong — it is a series and its slug says neither. | 5 slugs asserted for name/type/url + an unknown slug falling through; `p03_curated.mjs` |
| 11 | 🟡 | **Trakt OAuth never learned the user's username.** `clientId` is declared only inside the `/api/trakt/device/*` blocks — siblings, not enclosing scopes — so the header object threw before `fetch` was called and the surrounding catch ate it. The device flow did the same lookup correctly, so the two paths silently disagreed. | `TRAKT_CLIENT_ID`, the value the token exchange fifteen lines above already uses. | `p02_clientid.mjs`: `/users/me` is now fetched and the redirect carries `&trakt_username=` |
| 12 | 🟡 | **The only `list-copy` event in the app never fired.** `listName` is a `const` inside the chunking loop; the reference was outside it. `stats:list_copy:` never received a write, so the admin “copies” column — and the `likes + copies×2` ranking beside it — has always been structurally zero. A previous round rewired the *server* side of this namespace and shipped it without checking a client event could reach it. | `created[0].name`, already in scope. | `p04b_listcopy_e2e.mjs`: **1** `/api/track-event` request, was 0 |
| 14 | 🟡 | **The cold-index directory advertised urls that 404.** Anonymous lists live at `publishedlist:user:<slug>` and serve from `/lists/user/<slug>`, but the fallback scan built the path from the display label — `/lists/Anonymous/<slug>`. Not an edge case: that scan runs on a fresh deployment and for the whole of the first index rebuild. | Build the url from the key namespace, keep `Anonymous` as the label. Also reads `publishedAt`, so `updatedAt` is no longer `null` for anonymous lists. | New test follows the advertised url and asserts it resolves; `p19_anonurl.mjs` |
| 13 | 🔴 | **Nothing checked that identifiers resolve.** `node --check` proves a file parses and says nothing about whether the names in it exist. | New `scope_check.mjs` (acorn + eslint-scope), run over the combined Worker **and** the rendered client bundle, in `verify.sh` (step 3b) and CI. Allows only what is genuinely a global by construction: the runtime's own names, `window.*` exports, sloppy-mode implicit globals, and anything the author guarded with `typeof`. | Mutation-tested — below |

### Mutation test of the new check

Each of the three original bugs, reintroduced one at a time:

```
MUTATION A  bring back isShow    -> FAIL: isShow (1 reference, first at line 51477)      exit=1
MUTATION B  bring back clientId  -> FAIL: clientId (9 references, first at line 53514)   exit=1
MUTATION C  bring back listName  -> FAIL: listName (2 references, bundle line 5106)      exit=1
```

Clean run: `2,194` global references in the Worker and `8,290` in the bundle, all resolving —
across `675` top-level declarations, `135` `window.*` exports and `218` `typeof` guards.

### One thing worth knowing

`scope_check.mjs` is the first thing in this repo that needs npm. It is two pinned packages,
`--no-save`, into an already-gitignored `node_modules`; `verify.sh` installs them only if they
are missing. That is a real change to a deliberately bare setup, and it is the trade for
catching a bug class that had three live instances and no other way to see them.

`bash verify.sh` green — **360 tests pass**.

## ✅ Round 4 — the false success, the three unarmed guards, the plan docs, and the byte count

Items 8, 9, 16, 17 of the fix order, plus the addendum's byte-count finding. Four defects; two of
them are one story and are shipped together on purpose.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 8 | 🟡 | **A failed list edit reported success.** `saveLocalCustomListEdit()` sent the account mirror inside `try { … } catch (e) {}` with `if (data.ok && data.url)` and no `else`, then showed the "saved" modal unconditionally. A 401, a 409 and a 500 all ended on the same success screen while nothing reached the account — so on the next sign-in the server's older copy won and the edit was gone, having been reported saved. Its sibling fifty lines above had a proper error path; the two disagreed. | The mirror's outcome is read and reported: a conflict names the other device, a 401 says the key was rejected, a network failure says so, anything else quotes the server. The **local** save stays unconditional — that is what the function is for and it worked; only the reported outcome was wrong. | `p42_falsesuccess_fixed.mjs`: all three failures now surface, the local copy is still written, a genuine 200 still shows the modal. `p33` re-run: **no** "saved" modal on any of the three |
| 9 | 🟡 | **The optimistic-concurrency guard was armed on 2 of 12 `lists/save` call sites.** The server answers 409 + `conflict: true` on a stale write and the field is additive, so a client that omits it keeps last-write-wins. The eight *creates* are fine unguarded. The three that pass an explicit `slug` are whole-list replacements of an existing list — exactly the case the guard exists for. `removeWatchedItemFromWatchlist()` was the worst of them: it rewrote the entire Watchlist from a possibly-stale local copy, fire-and-forget (`.catch(() => {})`), so a second device's additions could be erased with nothing reported anywhere. | All three routed through the existing `saveCreatorListWithBaseline()`. That helper grew two things it needed to serve them: it **returns the outcome** instead of swallowing it (item 8 cannot be fixed without this), and it accepts a **null** re-apply function, meaning "this edit is a replacement, not a delta — hand the conflict back". Where the edit *is* a delta the merge-and-retry now covers two more paths. | `p43_guards_armed.mjs`: `4200 -> 9000` baselines on both delta paths, and the other device's item survives the conflict in each. 12 new tests |
| — | 🔵 | **The list-size guards were stated in bytes and measured in UTF-16 code units.** `CREATOR_LIST_BYTES_MAX` exists because of D1's 2,000,000-**byte** maximum string size; the check was `JSON.stringify(items).length`. ASCII makes the two agree, which is why five audits went past it. CJK is 1 unit and 3 bytes per character, so a 1,775,971-unit list was 4,711,971 bytes: KV stored it, the public page served it, the D1 mirror failed inside a catch that logs and carries on, and every `migrate-d1` run afterwards reported the same error that could never be cleared. | New `utf8ByteLength()` (`02_…`), applied at **all four** byte ceilings — the creator list, the watchlist inside `sync/save-tracking`, the anonymous published list and the saved install config — not only the one with a live consequence. | `p36_d1_bytes.mjs` re-run: `413`, nothing in KV, nothing in D1, `migrate-d1 repairs it: []`. Tests pin both directions: the CJK list is refused, an ASCII list of the same character count still saves |
| 16, 17 | 🟡 | **The documented deployment target could not run several core paths, and the code's own comments had the wrong number.** README said "your own free Cloudflare Worker" with no qualification. `00_constants.js:64` sized `/api/bulk-resolve` against *"Cloudflare's 1,000-subrequest-per-invocation limit"* — but 1,000 is the KV/D1 storage-operation cap, and the outbound-`fetch` cap is **50** on Free and 10,000 on Paid. The measurement in that comment (~400) is right; its conclusion is right for Paid and wrong for Free. | README gains a **Which Cloudflare plan do I need?** section with both caps, both plans, and the three measured consequences: the Letterboxd import dies above ~25 titles, the 6-minute cron dies every tick, and ~500 page views spend the whole 1,000-writes-per-day KV budget **unless D1 is bound**, which takes the same page view to zero KV writes. Step 4 is still headed *Optional* — the app genuinely works without D1 — but now says to bind it as soon as anyone but you uses the deployment. Every comment that attached "1,000" to the word "subrequest" now says which cap it means. | The numbers are `p22`–`p24`, unchanged; this item is the documentation catching up to them. The JSON-LD blanket claim in `09_…` (which named Continue Watching — the feature the free cron cannot run) dropped the word |

### One correction to make to the finding, not to the code

The audit lists `saveLocalCustomListEdit` at `21_…:663` under *both* findings and recommends
routing it through `saveCreatorListWithBaseline()` alongside the other two. It is now routed
through it, but **without** a re-apply function, and that is deliberate rather than a partial fix.
The helper's contract is that a conflict is resolved by re-running the *edit* against the copy the
other device saved. A removal and a single-item toggle are edits in that sense. What this function
holds is a whole replacement array built in the builder, which is not a delta — re-applying it
would erase precisely what the guard just prevented. So the helper hands the conflict back and the
person is told, which is what its sibling `saveCreatorListEdit()` already did for the same reason.

Passing `null` there also surfaced a defect in the first draft of this change: the helper reached
`removeItem(fresh.items)` unconditionally, so a 409 with no re-apply function threw and was
reported to the user as a network error. Caught by the 409 test, fixed before the commit.

### Two things the tests were quietly not testing

* The DOM stub had no `document.getElementsByName`, so `cancelEditCustomList()` threw a
  `TypeError` on every save path that reached it. The older paths wrap that in their own `catch`,
  so four existing tests passed while the code under them reported a network error that never
  happened. Added to the stub.
* Three of the new tests initially saw **two** `lists/save` requests. The second was real: seeding
  a local list for a signed-in account whose `/api/creator/lists` returns nothing makes the
  load-time "upload the lists this account is missing" pass fire. The fixture was wrong, not the
  code — the account now holds the list, as it would in the case being tested.

`bash verify.sh` green — **377 tests pass**, 1 skipped (up from 361).

---

## ✅ Round 5 — the dashboard's hard wall, the free-plan import, the hot key, and the open write endpoint

Items 15, 18, 19 and 22 of the fix order. The first is the last 🟠 in the report.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 15 | 🟠 | **`/api/creator/lists` crossed Cloudflare's 1,000-KV-operations-per-invocation cap at 990 lists.** The creator dashboard's only data source read the account's whole list order and then issued one KV `get` per list, with no cap, no `limit`/`offset` and no projection. At 990 lists the invocation is terminated, so the dashboard 500s forever — and because deleting a list is done *from* the dashboard, the account had no in-app way back. Not hypothetical: one real account reached 129 list records for 22 real lists through the duplicate-slug bug. | The route pages. The slug *order* is resolved in full first (one KV get plus the orphan sweep's `list()` pages, both independent of list count) and only the requested window is read, so cost is bounded by `limit` rather than by what the account owns. The client loops until `hasMore` is false. Two things had to move with it: `deletedSlugs` is now filtered against every slug the account owns rather than against the page (a live list on page 2 would otherwise have been reported deleted, and the client deletes what is named there), and the conditional-response version became per-page, with the paging fields riding along on an `unchanged` reply so a cached page 0 can still learn page 1 exists. | `p30_breakpoint.mjs`: **210 KV ops at 980, 990, 995 and 1,000 lists** — was 991/1,001/1,011. `p29_dashscale.mjs`: ops flatten at 209 and the response at 2.52 MB, was 15.08 MB at 1,200 lists |
| 18 | 🟡 | **`/api/bulk-resolve` could not run on the deployment target the README documents.** Two TMDB calls per title against a 200-title request is ~400 outbound fetches; Cloudflare allows **50** per invocation on Free and 10,000 on Paid. So a Letterboxd import died above roughly 25 titles on a free Worker. | The *request* size stays 200 — lowering it would make every paid deployment issue eight times the calls for the same import — and the **server** decides how much of it fits, answering with `nextIndex` and `done`. The client resumes from exactly what was consumed. `BULK_RESOLVE_SUBREQUEST_BUDGET` in `wrangler.toml` raises it for a paid plan. The per-IP bucket moved from 20 *requests* a minute to 4,000 *titles*: counting requests would have cut the real ceiling from 4,000 titles to 480 the moment a request started being split. | `p23_subrequests.mjs`: **48** outbound fetches at the 200-title maximum, was 400. A client test drives the resume loop over 100 titles at 24 per invocation and gets all 100, in order |
| 19 | 🟡 | **`index:publiclists` is one global key, read-modify-written on every like.** 4.45 MB parsed, sorted and re-serialised for a one-number change, against KV's one-write-per-second-per-key limit on both plans. Likes are the frequent write, so past roughly one like per second across the whole deployment the index was being issued faster than KV accepts it. Separately, it truncates at `PUBLIC_INDEX_MAX` and nothing said so. | Like-driven index updates claim a short global cooldown first. Below one like every 10 seconds the cooldown is always free and every vote updates the directory exactly as before — which is every deployment this code has run on; above it the writes coalesce and the skipped counts ride along on the list's next save or the daily rebuild. The vote itself is never affected. And `/admin/api/schema-status` now reports the index's entry count and whether it is at the cap. | `p44_hotkey_and_publish.mjs`: 25 votes in a burst cost **1** whole-directory rewrite, and all 25 are still on the record |
| 22 | 🟡 | **`/api/publish-list` is an unauthenticated permanent-write endpoint with no caller in the app.** 10 publishes a minute at 2 MB apiece is 20 MB/minute of unowned storage from one address — a free plan's whole 1 GB namespace in under an hour — removable only by an operator, by hand. It was also vector A of this audit's stored-XSS finding. | Tightened, not removed — see below. Its ceilings were shared with the *authenticated* save, and the two are not the same risk; it now has its own: 5,000 items, 512 KB, 5 publishes a minute. Plus per-item shape validation, because the endpoint accepted any JSON at all and nothing that cannot render should be able to occupy the namespace permanently. | `p44_hotkey_and_publish.mjs`: one IP now gets **5** records and **2.10 MB** a minute, was 10 and up to 20 MB; five kinds of non-item entry refused with 400 and **0** records created |

### Two judgement calls, stated rather than buried

**`/api/publish-list` is tightened, not deleted.** The audit offers both and says the choice is
whether the feature is live. The shipped bundle never calls it, which argues for removal — but
records exist in production (the admin panel has a tool built specifically to browse and delete
them), and removing a public endpoint breaks any out-of-band caller, which cannot be verified from
here. Tightening closes the abuse and reachability the finding is actually about and is reversible;
deleting the route is a product decision and is **the maintainer's to make**. Say the word and it
goes.

**The directory index is not sharded.** That is the other half of finding 19, and it is deliberately
not in this change. The audit is explicit that it wants sharding done in one pass with a version
marker in the build state, because a half-sharded index serves a fraction of the directory and is
worse than the current behaviour — and that it is "not urgent below a few thousand lists". The
throughput half (the hot write) and the visibility half (silent truncation) are both closed here;
the blob size at the 20,000-entry cap is not.

### Still over the free plan's outbound budget, and out of scope here

`p23` re-run shows two more endpoints past the 50-fetch cap that this round did not touch, because
neither is on the audit's remaining list: `/api/details/batch` at 180, and the cron tick at 186.
Both are named in the free-plan finding and both are now documented in README's plan section.

### What the tests were not testing

`makeEnv()` silently dropped every key but `CONFIGS`, `ADMIN_KEY` and `DB`, so a test setting an
env var the Worker reads was setting nothing at all. It spreads now — which is what let the
paid-budget test actually exercise `BULK_RESOLVE_SUBREQUEST_BUDGET` rather than pass by accident.

### Mutation-tested

Six mutations, each reintroducing one half of this round's work; each caught by exactly the test
written for it and by no other:

```
A  read every list again (un-page)      -> 5 failures, led by "spends a bounded number of KV operations"
B  filter deletedSlugs against the PAGE -> "reports a deleted slug only when it is deleted"
C  drop the like-index cooldown         -> "coalesces like-driven index writes behind a cooldown"
D  drop the publish-list shape check    -> "refuses entries that are not list items at all"
E  client ignores hasMore               -> "keeps asking until the server says there is no more"
F  client advances by the chunk size    -> "resumes from exactly what the server processed"
```

`bash verify.sh` green — **401 tests pass**, 1 skipped (up from 377).

---

## 🔜 Remaining, in order

Nothing 🔴 or 🟠 is open, and the production fix order (Addendum A) is complete. What is left is one
deferred scale change and the low-severity cleanup.

| # | Severity | Issue | Where |
|---|---|---|---|
| 1 | 🟡 | Shard `index:publiclists` across 32 keys — one change, with a version marker in the build state. Not urgent below a few thousand public lists; see the note above | fix order 19 (second half) |
| 2 | 🟡 | Chunk `/api/details/batch` (180 outbound fetches) and the cron tick (186) to a 50-subrequest budget, the way `/api/bulk-resolve` now is | free-plan finding |
| 3 | 🟡 | Drop `items` from `/api/creator/lists` and give the three call sites that need them a per-list read. Paging removed the wall; this is the transfer half | fix order 15 (second half) |
| 4 | 🔵 | `String()` the five `/api/external-list/create` body fields; `/api/creator/reset-key` 401/429 instead of 200; remove `runListSearch()` and the dead aliases | fix order 20, 21, 23 |
| 5 | ℹ️ | Document that the install link carries provider tokens and the Creator Key; consider an `ADMIN_KEY` generation counter so admin sessions can be revoked | fix order 24–26 |
| — | ❓ | **Maintainer decision:** remove `/api/publish-list` outright, or keep the tightened version | fix order 22 |
