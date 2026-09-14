# ADVERSARIAL AUDIT II — CURRENT MAIN

> **These findings have since been fixed.** This document is the audit record
> and describes the code as it stood at `3d4c24f`; it is deliberately not
> edited to match the repairs. See
> **[`AUDIT-2026-09-06-ADVERSARIAL-II-FIX-STATUS.md`](AUDIT-2026-09-06-ADVERSARIAL-II-FIX-STATUS.md)**
> for what was done about each one, what was deliberately left alone, and the
> residuals that remain.

Independent, invariant-driven, executed. Run against `claude/full-audit-urjcp9`
at `3d4c24f` (the merge of the previous adversarial audit's fixes).

**Method note, because it changes how the findings should be read.** The first
pass was performed without opening `AUDIT-2026-09-05-INDEPENDENT.md`,
`AUDIT-2026-09-06-ADVERSARIAL.md`, `AUDIT-2026-09-06-FIX-STATUS.md`,
`Changes.md`, or anything under `docs/history/`. Every finding below was derived
from the code and from executed probes first; the prior audits were read only
afterwards, and only to classify. Every claim in §1 is backed by a script in
`audit/adversarial-II-2026-09-06/` that runs against the **committed
`worker_entry_combined.js`**, not against the numbered sources.

Baseline before I started: `node --test tests/*.test.mjs` → **234 tests, 233
pass, 0 fail, 1 skipped**. `verify.sh` passes, including a byte-exact rebuild
that I reproduced with my own independent reimplementation of `build.py`
(sha256 `2eefaae8…`, 2,798,585 bytes, identical).

---

## Executive Verdict

# NEEDS FIXES

The structural work the previous audits drove is real and it holds. I could not
break cross-creator authorization, the optimistic-concurrency guards, visibility
fail-closed on write, pagination, the caps, route fuzzing, the KV-only↔KV+D1
differential, or a 8-seed × 120-operation randomized model check — all executed,
all clean (§15).

What survived is a single recurring shape, and it is the same shape the prior
audits were built to eliminate: **an operation reports `ok: true` while a
secondary effect it is responsible for did not happen.** Last time it was
`delete-account` and key rotation. This time it is the *per-list* delete, the
directory cleanup in three of its four callers, and the Continue Watching cron.
Two findings are worse than that shape and are the reason for the verdict:

* **N4** — any authenticated write in flight when `delete-account` runs
  re-creates account data *after* the purge finished, and the freed username
  then inherits it. That includes the previous owner's TMDB/Trakt provider API
  keys out of `creatorsync:{user}.keys`.
* **N6/N7** — the Continue Watching cron permanently starves accounts, and one
  account that fails once stops the sweep for the entire deployment forever.

| | Count |
|---|---|
| New confirmed defects | 12 |
| Partial fixes (prior work covered part of the class) | 5 |
| Regressions | 0 |
| Already known, still open | 2 |
| Prior-audit conclusions I can show are wrong | 2 |
| Test-suite blind spots (mutation-proved) | 6 survivors of 23 |

---

## Contents

1. [New confirmed defects](#1-new-confirmed-defects)
2. [Partial fixes](#2-partial-fixes)
3. [Regressions](#3-regressions)
4. [KV ↔ D1 consistency report](#4-kv--d1-consistency-report)
5. [Schema / migration report](#5-schema--migration-report)
6. [Partial-failure report](#6-partial-failure-report)
7. [Authorization matrix](#7-authorization-matrix)
8. [State-machine failures](#8-state-machine-failures)
9. [Test-suite blind spots](#9-test-suite-blind-spots)
10. [Performance / scale findings](#10-performance--scale-findings)
11. [Unconfirmed investigations](#11-unconfirmed-investigations)
12. [File-by-file punch list](#12-file-by-file-punch-list)
13. [New tests to add](#13-new-tests-to-add)
14. [Top 10 remaining risks](#14-top-10-remaining-risks)
15. [What I tried to break but could not](#15-what-i-tried-to-break-but-could-not)
16. [Prior-audit conclusions I can show are wrong](#16-prior-audit-conclusions-i-can-show-are-wrong)

---

## 1. New confirmed defects

### N1 — `/api/creator/lists/delete` answers `{ok:true}` while the list is still in KV and still served publicly

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `02_http-and-creator-utils.js:1571-1575` (`deleteCreatorLists`), route at `26_api-creator-and-admin-routes.js:1843-1861` |
| **Invariant violated** | *Deleting a list must remove the primary record.* A delete that reports success must have deleted something. |
| **Classification** | **NEW** |
| **Repro** | `audit/adversarial-II-2026-09-06/p02_listdelete.mjs` case A, `p26_verify.mjs` case 3 |

`deleteCreatorLists` deletes the D1 row, then:

```js
try {
  await env.CONFIGS.delete(key);
} catch (e) {
  console.error("deleteCreatorLists: could not delete", key, e);
}
```

The route then returns `json({ ok: true })` unconditionally — it does not even
look at `out.deleted` / `out.missing`.

**Expected.** A KV delete that fails is a delete that did not happen; say so.

**Actual.**

```
lists/delete with a failing KV delete -> 200 {"ok":true}
   record still in KV: true
   public page still serves it: 200 [{"id":"ttx",…}]
   D1 row deleted (stores now disagree): true
```

**Impact.** A creator presses "delete" on a public list, is told it worked, and
the list stays live and readable at `/lists/:user/:slug` and `.json`
indefinitely — nothing retries. It is also the worst possible divergence
direction: the D1 row *is* gone, so the admin panel agrees the list was deleted
while the public store keeps serving it.

**Root cause.** The identical `catch`-and-carry-on that A3/A5 removed from
`delete-account` and key rotation was never removed from the per-list path, and
the route discards the function's own `deleted`/`missing` result.

**Minimal fix.** Track a failure flag in `deleteCreatorLists` exactly as
`purgeCreatorData` tracks `dataSweepFailed`, return it, and have both callers
(`/api/creator/lists/delete`, `/admin/api/delete-creator-list`) return a 500
rather than `ok: true`.

---

### N2 — Three of the four callers of `removeListsFromPublicIndex` ignore its documented return value, so a deleted account's lists stay in the public directory and the delete still reports success

| | |
|---|---|
| **Severity** | **MEDIUM-HIGH** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `02_http-and-creator-utils.js:1592` (`deleteCreatorLists`), `:2450` (`purgeCreatorData`) |
| **Invariant violated** | *Deleting a list/account must remove its public-directory references.* |
| **Classification** | **PARTIAL FIX of A8** — see §2 |
| **Repro** | `p01_deletion.mjs` case 3, `p02_listdelete.mjs` cases B/D/E |

`removeListsFromPublicIndex` returns `true`/`false` and its own doc comment
states the contract:

> *"A REMOVAL is different: it is the mechanism by which making a list private
> stops it being advertised, so a caller that ignores a false here is reporting
> a privacy change that did not happen."*

`/api/creator/lists/save`'s make-private branch honours that. The other three
call sites discard the boolean:

| Caller | Checks result? |
|---|---|
| `/api/creator/lists/save` (public → private) | **yes** — returns 500 |
| `deleteCreatorLists` (per-list delete, admin delete) | no |
| `purgeCreatorData` (`/api/creator/delete-account`) | no |
| `purgeCreatorData` (`/api/creator/account/reset`) | no |

**Actual**, with `index:publiclists` unwritable:

```
delete-account                 -> {"ok":true,"cleared":{"lists":2,"keys":18}}   stillListedInDirectory=true  identityDeleted=true
account/reset                  -> {"ok":true,"cleared":{"lists":1,"keys":15}}   stillListedInDirectory=true
admin delete-creator-list      -> {"ok":true,"deleted":["pub-list"],…}          stillListedInDirectory=true
/lists/public.json afterwards  -> still returns the deleted list
```

**Impact.** "Delete my account" reports success, removes the identity, frees the
username — and `/lists/public.json` plus `/api/search-published-lists` keep
advertising the account's list names, item counts and like counts under the
now-unowned username until the next daily rebuild (up to ~24 h). This is exactly
the failure mode A8 was written to close, closed on one path only.

**Minimal fix.** `if (!(await removeListsFromPublicIndex(...))) dataSweepFailed = true;`
in `purgeCreatorData`, and propagate a failure out of `deleteCreatorLists` the
same way N1 requires.

---

### N3 — `/api/lists/like` is an existence oracle for private lists and lets any anonymous visitor mutate a private list's stored like count

| | |
|---|---|
| **Severity** | **MEDIUM-HIGH** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `25_api-catalog-routes.js:5689-5700, 5729-5772` |
| **Invariant violated** | *A private list must not be observable, or writable, by anyone but its owner.* |
| **Classification** | **NEW** |
| **Repro** | `p03_visibility.mjs` cases 4-6, `p26_verify.mjs` case 2 |

The route looks the record up, calls `stampListVisibilityIfNeeded`, and then
records the vote. **It never checks `isPublicListVisibility`.** Visibility is
only consulted later, to decide whether to touch the directory index.

**Actual.**

```
POST /api/lists/like {username:"vizowner", slug:"no-such-list"}  -> 404 {"ok":false,"error":"List not found."}
POST /api/lists/like {username:"vizowner", slug:"secret-movies"} -> 200 {"ok":true,"likes":1,"liked":true}   # PRIVATE list
   KV likes: 1   D1 likes: 0 -> 1   ledger key created: true
   after the owner later publishes it, the directory shows likes: [1]
```

**Impact.** Three separate problems from one missing check:

1. **Existence oracle.** 404 vs 200 tells an unauthenticated caller exactly
   which private slugs a creator owns. Usernames are published by
   `/lists/public.json` for anyone with one public list, so no guessing is
   needed for the first half of the pair. §15 of the previous audit certified
   private lists unreachable via the page, the directory and search — this path
   was not in that set.
2. **Unauthenticated write to a private object.** Both stores' `likes` field on
   a private record is changed by a stranger, and a permanent
   `listlikevoters:{user}:{slug}` KV key is created for it.
3. **Carry-over.** The inflated count survives into the public directory the
   moment the owner publishes, because `lists/save` deliberately preserves
   `likes` across an edit.

**Minimal fix.** After the `stampListVisibilityIfNeeded` call, add
`if (!isPublicListVisibility(likeData.visibility)) return json({ ok:false, error:"List not found." }, 404);`
— the same generic 404 as a missing list, so the oracle closes too.

---

### N4 — A write in flight during `delete-account` re-creates account data after the purge, and the reclaimed username inherits it — provider API keys included

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `02_http-and-creator-utils.js:2360-2596` (`purgeCreatorData`), every authenticated write route |
| **Invariant violated** | *An account deleted from the system must leave no account-owned data, and a reclaimed username must inherit nothing.* |
| **Classification** | **NEW** |
| **Repro** | `p17_resurrect.mjs`, `p18_resurrect2.mjs` |

`purgeCreatorData` is a one-shot sweep. Every authenticated write route
authenticates once at the top and then writes; nothing re-checks that the
account still exists at write time, and nothing tombstones the username. So a
request that authenticated before the purge and lands after it puts its key
back.

**Actual** — every authenticated write path tested, all seven resurrect:

```
RESURRECTED  /api/creator/sync/save           delete=true inflight=200 leftover=["creatorsync:…"]
RESURRECTED  /api/creator/sync/save-tracking  delete=true inflight=200 leftover=["creatorsynctracking:…"]
RESURRECTED  /api/creator/sync/save-presets   delete=true inflight=200 leftover=["creatorsyncpresets:…"]
RESURRECTED  /api/creator/sync/save-channels  delete=true inflight=200 leftover=["creatorsyncchannels:…"]
RESURRECTED  /api/creator/lists/save          delete=true inflight=200 leftover=["creatorlist:…:ghost-list","creatorlistorder:…"]
RESURRECTED  /api/creator/sync/share-tracking delete=true inflight=200 leftover=["creatorshare:…"]
RESURRECTED  /api/creator/scrobble-token      delete=true inflight=200 leftover=["creatorscrobbletoken:…"]
```

and the inheritance is real:

```
delete-account -> {"ok":true,"cleared":{"lists":0,"keys":17}}
KV keys left behind: ["creatorsync:ghost1"]
someone else registers "ghost1"; their /api/creator/sync/load returns
  config = [{"inflight":true}]        <-- the previous owner's data
```

**Impact.** `creatorsync:{user}` carries `keys`, which is where the user's own
TMDB / Trakt / MDBList / Simkl credentials live — I verified `sync/load` returns
them (`p26_verify.mjs` case 1). So the reclaim path can hand a stranger the
previous owner's provider API keys. The `lists/save` variant leaves a **public**
list record plus its order entry live at a URL under a username nobody owns; the
`scrobble-token` variant leaves a live webhook credential, which is precisely
what `purgeCreatorData`'s scrobble-token block exists to prevent.

**How likely is the race?** Not exotic. "Delete my account" is a button on the
dashboard, and the dashboard autosaves on a timer; `handleSubtitlesTrack` and
`handleMediaServerScrobble` write `creatorsynctracking:` from outside the browser
entirely, on any playback event, at any moment.

**Minimal fix.** Write a short-lived tombstone (`creatordeleted:{u}`, TTL a few
minutes) *before* the sweep; have `authenticateCreator` reject a username with a
live tombstone, and have `/api/creator/create` refuse to hand out a tombstoned
username. That closes the reclaim inheritance and the post-purge write in one
step, and it also narrows N5.

---

### N5 — KV read-caching defeats "the old key stops working immediately" and "a deleted account stops authenticating"

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** against modelled KV semantics (not against live KV) |
| **File** | `02_http-and-creator-utils.js:2598-2617` (`getCreator`) |
| **Invariant violated** | *A creator's old key must stop authenticating immediately after rotation. An account deleted from the system must no longer authenticate.* |
| **Classification** | **NEW** — the prior audit listed "KV eventual consistency is not modelled at all" as a blind spot; this is what is inside it |
| **Repro** | `p16_kv_eventual.mjs` |

`getCreator` reads KV first and falls back to D1 **only on a miss**. Cloudflare
KV reads are edge-cached, so a colo that did not serve the write keeps answering
with the pre-change record for the propagation window. D1 is updated first and
synchronously — the fix A5 installed — but its fresh value is never consulted
while KV serves a stale hit.

**Actual**, with a colo modelled as serving the pre-change `creator:{u}`:

```
rotation:
  old key on a stale colo -> {"ok":true,…}                        <-- rotated-away key still works
  new key on a stale colo -> {"ok":false,"error":"Username or Key is incorrect."}   <-- the new key is REJECTED

deletion:
  restore    -> {"ok":true,…}
  sync/save  -> {"ok":true,"updatedAt":…}      and it re-created creatorsync:{u}
```

**Impact.** For the propagation window a rotated key keeps authenticating and
the *new* key intermittently fails, which is also a support-visible correctness
bug, not only a security one. For deletion it compounds N4: the still-valid
credential can write keys the completed purge will never revisit.

**Note on scope.** I cannot execute this against real Cloudflare KV from here,
so I have graded it CONFIRMED-against-model rather than CONFIRMED-in-production.
The mechanism is Cloudflare's documented read behaviour and the code path is not
in dispute; what is unmeasured is the real window.

**Minimal fix.** When `env.DB` is bound, have the authentication path prefer the
D1 `key_hash` (or cross-check it) rather than the KV copy — D1 is strongly
consistent and every rotation/delete writes it first. Failing that, the N4
tombstone bounds the delete half.

---

### N6 — The Continue Watching cron permanently starves accounts that share a page with a heavy account

| | |
|---|---|
| **Severity** | **MEDIUM-HIGH** (silent, permanent, feature-fatal for affected accounts) |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `07_source-fetchers-tmdb-simkl.js:1701-1704, 1826` |
| **Invariant violated** | *Bounded progress must be fair: every account is reached as the cursor cycles.* |
| **Classification** | **PARTIAL FIX of A17** — see §2 |
| **Repro** | `p12_cron.mjs` case A |

```js
for (const key of listResult.keys) {
  if (showChecksUsed >= SHOW_CHECK_BUDGET) break;   // remaining accounts skipped
  …
}
…
await env.CONFIGS.put('cron:continuewatching:cursor',
  listResult.list_complete ? '' : (listResult.cursor || ''));   // advances past them anyway
```

`ACCOUNT_BATCH_SIZE` is 25 and `SHOW_CHECK_BUDGET` is 150 **across the whole
batch**. One account with ≥150 entries in `fullyWatchedShowIds` consumes the
budget, the loop breaks, and the cursor is still moved to the end of the page.
KV pages are deterministic for a stable key set, so the same accounts sit behind
the same greedy account on every cycle — forever.

**Actual**, 30 accounts (account 00 holding 200 fully-watched shows), 6 ticks:

```
after 6 ticks, 24 accounts were NEVER read:
["cronuser01" … "cronuser24"]
cursor now = ""     (a full cycle completed, and it completed by skipping them)
```

**Impact.** Continue Watching silently never picks up newly-aired episodes for
those accounts. No error, no counter, nothing in the admin dashboard.

**Comment vs code.** The code says *"The cursor advances only once this batch has
actually been processed."* It does not: the budget break leaves the batch
unprocessed and the cursor moves regardless.

**Minimal fix.** When the loop exits on the budget, persist a cursor positioned
at the last account actually processed (KV cursors are opaque, so the practical
form is: only advance when the batch completed; otherwise re-list from the same
cursor next tick and carry a per-tick "skip the first N of this page" offset, or
lower `ACCOUNT_BATCH_SIZE` to 1 page-of-work per tick).

---

### N7 — One failing account is a poison pill that stops the cron for the whole deployment, and a rejected cursor wedges it permanently

| | |
|---|---|
| **Severity** | **HIGH** (deployment-wide, silent, permanent) |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `07_source-fetchers-tmdb-simkl.js:1688-1827` |
| **Invariant violated** | *A scheduled sweep must make progress.* |
| **Classification** | **NEW** |
| **Repro** | `p13_cron_poison.mjs`, `p12_cron.mjs` case B |

`checkForNewEpisodes` has **no try/catch anywhere**. `ensureTrackingMigrated`,
`env.CONFIGS.get`, and the KV `list()` are all unguarded, and the cursor is only
written at the very end. So any throw aborts before the cursor advances, and the
next tick restarts and dies at exactly the same account.

**Actual** — one account whose tracking key fails to read:

```
tracking keys the sweep managed to read: ["…:poison0","…:poison1","…:poison2"]
cursor after 4 ticks: undefined            (never written at all)
FAIL - accounts after the poison key are never swept: ["poison3","poison4"]
```

and with a cursor the KV binding rejects (Cloudflare returns an error for an
invalid cursor):

```
cursor after 3 ticks is still "THIS-CURSOR-IS-NO-LONGER-VALID"
- every tick throws on it and nothing resets it
```

**Impact.** One durably-unreadable account, or one bad stored cursor, stops
Continue Watching for **every** account behind it, forever, with the only signal
being a log line. Note this interacts with A17's fix: moving the cursor write to
the end (correct for the crash case) is what makes the poison pill permanent
rather than self-healing.

**Minimal fix.** Wrap the per-account body in try/catch and continue to the next
account; wrap the `list()` call and, on failure with a cursor present, clear
`cron:continuewatching:cursor` and return so the next tick restarts from the
beginning.

---

### N8 — `scheduled()` has no exception boundary, unlike `fetch()`

| | |
|---|---|
| **Severity** | **LOW** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:4727-4762` |
| **Classification** | **NEW** (the mirror of A13, which was fixed for `fetch` only) |
| **Repro** | `p12_cron.mjs` case D |

```
scheduled() rejected with: KV totally down
```

`ctx.waitUntil(Promise.all([...]))` rejects as soon as any of the three tasks
does, and there is no `try`. The sibling `fetch` handler grew a boundary
specifically because *"one boundary here is worth more than remembering to do
that at every future call site"* — the same argument applies here and was not
applied.

**Impact.** Low: the three tasks are started before the rejection, so work still
happens; the cost is a cron invocation recorded as failed and a rejection that
hides which task actually broke. It becomes material once N7 is fixed by
catching per account, because then this is the only thing that would surface a
genuine sweep failure.

**Minimal fix.** Wrap each task in `.catch(e => console.error(...))` and the
whole body in a `try`, matching `fetch`.

---

### N9 — `/admin/api/migrate-d1` cannot repair a drifted `creator_lists` row

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:3748-3751` |
| **Invariant violated** | *The documented repair tool must be able to reconcile the mirror to the authoritative store.* |
| **Classification** | **NEW**, and it contradicts A14's stated conclusion — see §16 |
| **Repro** | `p11_migrate.mjs`, final two assertions |

```sql
INSERT INTO creator_lists (…) VALUES (…)
ON CONFLICT(id) DO UPDATE SET likes=excluded.likes, visibility=excluded.visibility
```

`name`, `type`, `items_json`, `created_at` and `updated_at` are written on INSERT
and never on conflict. So an existing D1 row whose content drifted from KV can
never be repaired.

**Actual.**

```
after migrate over a drifted D1 row:
{"id":"valid1:good", … "name":"D1 NEWER", "items_json":"[{\"id\":\"a\"}]", "likes":5, "updated_at":9999999999999}
PASS - migration restores KV's authoritative like count       (likes 999 -> 5)
FAIL - migration also repairs a drifted name/items in D1      (name stays "D1 NEWER")
```

**How the drift happens.** `/api/creator/lists/save` writes D1 inside a catch
that logs and carries on. A D1 blip during one edit leaves D1 holding the
pre-edit name/type/items permanently. `getCreatorList` falls back to D1 whenever
KV misses, and the admin Community Lists panel and leaderboard read the D1 row
directly — so the panel shows the stale name and item count forever.

This is the exact argument the migration's own comment gives for why the
`creators` branch had to move from `DO NOTHING` to `DO UPDATE`:

> *"DO NOTHING meant it could create a row but never correct one … the only tool
> for repairing that state could not repair it."*

**Minimal fix.** Extend the lists branch's `DO UPDATE` to
`name=excluded.name, type=excluded.type, items_json=excluded.items_json, updated_at=excluded.updated_at`.
All five are KV-derived, so idempotence is preserved; leave `created_at` out for
the same reason the `creators` branch does.

---

### N10 — Authenticated responses carrying private data (including the user's provider API keys) inherit `Cache-Control: max-age=3600`

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (headers captured) |
| **File** | `02_http-and-creator-utils.js:119-153` (`json`) plus the routes below |
| **Classification** | **PARTIAL FIX of A12** — see §2 |
| **Repro** | `p07_headers.mjs`, `p26_verify.mjs` case 1 |

A12's fix made **failures** `no-store` and added explicit `no-store` to
`/api/creator/create`, `/api/creator/reset-key`,
`/admin/api/reset-creator-key`, `/api/creator/scrobble-token` and the admin
endpoints. Successful responses that carry private data did not get it:

```
METHOD PATH                                    STATUS CACHE-CONTROL       VARY
POST /api/creator/sync/load                    200    max-age=3600        (none)   <-- returns keys{} = the user's TMDB/Trakt/MDBList/Simkl credentials
POST /api/creator/lists                        200    max-age=3600        (none)   <-- private + public list contents
POST /api/creator/sync/meta                    200    max-age=3600        (none)
POST /api/creator/restore                      200    max-age=3600        (none)
POST /api/creator/track-status                 200    max-age=3600        (none)
GET  /api/search-published-lists?q=…           200    max-age=3600        (none)
GET  /admin/api/*                              200    no-store            (none)   <-- correct
```

verified directly:

```
1) sync/load Cache-Control: max-age=3600
   returns provider keys  : {"tmdbKey":"TMDB-SECRET-123","traktToken":"TRAKT-SECRET-456"}
```

**Impact.** Two different weights.

* The POSTs are protected in practice by the method, not the header — the same
  caveat A12 recorded. Still wrong, and `/api/creator/sync/load` is the most
  sensitive response the Worker produces.
* **`/api/search-published-lists` is a GET**, so browsers and shared caches will
  store it. A list unpublished at T is still returned by that cached search
  response until T+1h even though the API itself has stopped returning it. That
  is a real, currently-unlisted cache-consistency hole in the "make it private"
  path, next to `/lists/:u/:s.json`'s `public, max-age=300`.

**Minimal fix.** `no-store` on `/api/creator/sync/load`, `/api/creator/lists`,
`/api/creator/sync/meta`, `/api/creator/restore`, `/api/creator/track-status`;
drop `/api/search-published-lists` to something on the order of `max-age=60`
to match `/lists/public.json`'s 120.

---

### N11 — Every credential-verifying route except `/api/creator/restore` runs PBKDF2-100k with no throttle at all

| | |
|---|---|
| **Severity** | **MEDIUM** (resource exhaustion / cost), **LOW** (guessing) |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:466-510` (`handleMediaServerScrobble`) and every route calling `authenticateCreator` |
| **Classification** | **NEW** |
| **Repro** | `p25_bruteforce.mjs` |

```
/api/creator/restore (same IP)                 attempts=60 rejected=20 throttled=40
/api/creator/restore (rotating IPs)            attempts=60 rejected=60 throttled=0    <-- NO THROTTLE
/api/scrobble?creator=&key= (same IP)          attempts=60 rejected=60 throttled=0    <-- NO THROTTLE
/api/creator/lists/save (same IP)              attempts=60 rejected=60 throttled=0    <-- NO THROTTLE
/api/creator/sync/load (same IP)               attempts=60 rejected=60 throttled=0    <-- NO THROTTLE
/api/creator/reset-key (same IP)               attempts=60 rejected=60 throttled=0    <-- NO THROTTLE
```

Two things fall out.

1. **Cost/CPU.** One failed verification is one PBKDF2(100,000, SHA-256):
   **~15.6 ms of CPU measured here**. Any unauthenticated caller can drive that
   at will through `/api/scrobble?creator=X&key=Y`, `/api/creator/sync/load`, or
   any other credentialed route. On Cloudflare's free plan that alone is at or
   past the 10 ms CPU budget per request; on paid plans it is billed CPU time.
   Resource exhaustion is #8 on this audit's own priority list and nothing here
   bounds it.
2. **The per-account failure budget only guards the weak secret.**
   `RESET_KEY_ACCOUNT_MAX_FAILURES` was added because *"rotating source
   addresses is free, so it bought an attacker unlimited guesses"* — and it was
   applied to the recovery answer only. `/api/creator/restore` still has a
   per-**IP** daily budget and no per-account one, which the second row above
   walks straight through. The Creator Key is ~60 bits so this is not a
   practical takeover, but the reasoning that produced the recovery-answer fix
   applies verbatim and was not carried across.
   `/api/creator/reset-key` shows 0/60 throttled here because the per-IP daily
   cap is 10 *and my probe rotates the guess, not the IP* — the per-account
   budget does fire, it just answers with the generic message rather than a 429.

**Minimal fix.** Put `consumeRateLimit(env, ctx, "creatorauth", ip, N)` in
`authenticateCreator` itself — one place, every route — so the PBKDF2 run is
gated before it happens. Add the per-account failure budget to
`/api/creator/restore` alongside the per-IP one.

---

### N12 — `migrations/0001` cannot be completed if it is interrupted between its two statements

| | |
|---|---|
| **Severity** | **LOW-MEDIUM** |
| **Confidence** | **CONFIRMED** (executed in real SQLite) |
| **File** | `migrations/0001_add_likes_to_creator_lists.sql` |
| **Classification** | **NEW** (Phase 6's "migration interrupted halfway / rerun after interruption") |
| **Repro** | `p10_schema.mjs`, "migration rerun behaviour" section |

```
0001: rerun THROWS -> duplicate column name: likes
0001 after partial apply: THROWS -> duplicate column name: likes (index never created)
    idx_creator_lists_likes present afterwards: false
```

Statement 1 (`ALTER TABLE … ADD COLUMN likes`) is not idempotent — documented.
Statement 2 (`CREATE INDEX IF NOT EXISTS idx_creator_lists_likes`) is. If the
session dies between them (dashboard console timeout, a dropped `wrangler`
connection), re-running the file aborts on statement 1 and **statement 2 never
runs**. The database is left permanently without the index and the file's own
guidance ("you should only apply it once") gives no recovery path.

**Impact.** Silent loss of an index. Not corruption — but see §10: that index is
not actually used by the query it was added for, which makes the whole thing
easy to never notice.

**Minimal fix.** Split into `0001a` (the ALTER) and `0001b` (the index), or add
a comment naming the exact recovery statement to run.

---

## 2. Partial fixes

Prior work addressed part of a defect class. Each of these is a live defect
today; they are listed separately from §1 only so the earlier work is credited
correctly.

| Prior finding | What was fixed | What was not | Now |
|---|---|---|---|
| **A8** — unpublishing returns `ok:true` while directory removal fails silently | `/api/creator/lists/save`'s make-private branch awaits and reports | the other three callers of `removeListsFromPublicIndex` still discard the boolean | **N2** |
| **A3/A5** — silent success on partial failure (`delete-account`, key rotation) | both paths made honest, with `dataSweepFailed` and `rotateCreatorKeyHashInD1` | the *per-list* delete kept the same swallowing catch and the unconditional `ok:true` | **N1** |
| **A12** — `json()` defaults to `max-age=3600` | non-2xx and `ok:false` now `no-store`; explicit `no-store` on the two key-issuing routes | successful private-data 200s (`sync/load`, `lists`, `restore`, search) still inherit it | **N10** |
| **A14** — `migrate-d1` cannot repair a stale row | fixed for `creators` (`DO NOTHING` → `DO UPDATE`); counters now use `meta.changes`; skips counted | `creator_lists` left on a two-column `DO UPDATE`, with A14 asserting that was correct | **N9** |
| **A17** — cron cursor advanced before the work | write moved to after the loop | the loop can exit early on the show-check budget, and the cursor still jumps the whole page; no error handling was added, which turns the new ordering into a permanent wedge | **N6, N7** |

---

## 3. Regressions

**None.** Every A-series fix I re-tested still holds:

| Prior finding | Re-verified by | Result |
|---|---|---|
| A1 (`LIKE` wildcard purge) | `p01`, code read (`WHERE username = ?`) | holds |
| A2 (edit zeroes like count) | `p04_kvd1.mjs` case F | holds — a rename after a D1 like-outage keeps KV at 3 |
| A3 (`delete-account` no-op) | `p01_deletion.mjs` cases 1-2 | holds on the healthy path |
| A4 (failed enumeration leaves lists live) | `p01`, `dataSweepFailed` path | holds |
| A5 (rotation reports success, rotates nothing) | `p04_kvd1.mjs` case D | holds — 503, old key still valid, no new key issued |
| A6 (dashboard vs public disagree on visibility) | `p04_kvd1.mjs` case B, `p22_differential.mjs` | holds |
| A9/A10 (concurrency guards) | `p05_concurrency.mjs` (7 cases incl. frozen and backward clocks) | holds |
| A11 (no size bound on `lists/save`) | `p24_caps.mjs` | holds — CAP/CAP+1 correct on items, name and bytes |
| A13 (no exception boundary) | `p04_kvd1.mjs` case E | holds for `fetch` (see N8 for `scheduled`) |
| A15 (schema drift) | `p10_schema.mjs` | holds — see §5 |
| A19 (unbounded reorder) | `p24_caps.mjs` | holds — 5000 cap enforced exactly |
| A20 (FK blocks lists for unmigrated accounts) | `p04_kvd1.mjs` case E, `p11_migrate.mjs` | holds — backfill-and-retry works |

---

## 4. KV ↔ D1 consistency report

### Data authority matrix (proved from code and from executed probes)

| Data family | KV key | D1 table | Authoritative | Mirrored | Reader preference | Writer order | Failure behaviour |
|---|---|---|---|---|---|---|---|
| Creator identity | `creator:{u}` | `creators` | **KV** | yes | KV, D1 on miss | rotation: **D1 then KV**; create: **KV then D1** | rotation aborts if D1 can neither update nor drop; create tolerates D1 loss. **N5**: a stale KV hit hides a fresh D1 value |
| Creator lists | `creatorlist:{u}:{slug}` | `creator_lists` | **KV** | yes | KV, D1 on miss | **D1 then KV** | D1 failure logged + FK self-heal retry; KV failure → 500 (no `ok:true`). Drift is unrepairable — **N9** |
| List likes | `listlikevoters:{u}:{slug}` (ledger, authoritative) → denormalised onto both records | `creator_lists.likes` | **KV ledger** | yes | KV | ledger → KV record → D1 | D1 write swallowed; **mirror never re-converges** (see §11.2). No visibility check on the way in — **N3** |
| List ordering | `creatorlistorder:{u}` | — | KV | no | KV | RMW on one key | lossy under concurrency (3/12 lost, `p06`); dashboard orphan-sweep masks it |
| Anonymous lists | `publishedlist:user:{slug}` | — | KV | no | KV | KV | **no delete path exists at all** (§ Already known) |
| Source groups | `stats:sourcegroup:{g}:total` | `source_groups` | D1 when bound, else KV | one-way | D1 then KV | D1 | documented counter round-trip loss on unbind |
| Counters | `stats:{kind}:{bucket}` | `stats` | **D1 when bound**, else KV | one-way | D1, KV on missing row | D1 | documented |
| Auth failure budget | `authfail:{scope}:{day}` | `stats` rows | D1 when bound, else KV | one-way | D1, KV on throw | D1 | KV path is looser by design |
| Sync blobs (config/tracking/presets/channels) | `creatorsync*:{u}` | — | KV | no | KV | KV | 500 on failure; guarded by `expectedUpdatedAt` |
| Share opt-in | `creatorshare:{u}` | — | KV | no | KV | KV | strict `=== true` on read |
| Scrobble token | `scrobbletoken:{t}` + `creatorscrobbletoken:{u}` | — | KV | no | KV | KV | revoked via reverse index during purge |
| Public directory index | `index:publiclists` (+ `:build`, `:removed`) | — | derived cache | n/a | KV | RMW, daily rebuild | removal failures ignored by 3 of 4 callers — **N2** |
| Provider caches | `cache:*` | — | KV | no | KV | KV | see §11.1 |
| Cron cursor | `cron:continuewatching:cursor` | — | KV | no | KV | KV | never reset on error — **N7** |

### Failure matrix (Phase 4 states), executed in `p04_kvd1.mjs`

| State | Behaviour | Verdict |
|---|---|---|
| A — both healthy | as designed | ✅ |
| B — KV works, D1 throws (create) | account fully usable from KV; `ok:true`; D1 backfilled later | ✅ documented |
| B — KV works, D1 throws (rotation) | 503, old key still works, no new key handed out | ✅ |
| B — KV works, D1 throws (like) | KV correct; **D1 never re-converges** | ⚠️ §11.2 |
| C — D1 works, KV throws (`lists/save`) | 500, `ok:false`, D1 holds an orphan row that is not resurrected as a real list | ✅ |
| D — KV has it, D1 does not | reads work; list writes FK-fail then self-heal via `backfillCreatorRowInD1` | ✅ |
| E — D1 has it, KV does not | account reachable via the mirror; `delete-account` still revokes it correctly | ✅ |
| F — both present, values differ | KV wins on every read path; public page and dashboard agree | ✅ |
| G/H — one store newer | KV always wins; migrate-d1 pushes KV → D1 for `likes`/`visibility` only | ⚠️ **N9** |

### Differential: KV-only vs KV+D1

`p22_differential.mjs` — 18 externally observable operations (create, duplicate
create, public/private save, dashboard, public page, directory, search, like /
repeat-like / unlike, make-private, directory-after, reorder, sync save/load,
key rotation, old-key-after-rotation), normalised for timestamps and identifiers:

**zero observable differences.**

---

## 5. Schema / migration report

Built in real SQLite (`node:sqlite`), `p10_schema.mjs`.

**Fresh (`schema.sql`) vs fully migrated (pre-0001 shape + 0001 + 0002).**
Identical in every respect that the code depends on — same tables, same column
types, same NOT NULLs, same defaults, same indexes
(`idx_creator_lists_username`, `_visibility`, `_likes`), same FK
(`username → creators.username ON DELETE CASCADE`), same `stats` composite
primary key. A15 is genuinely fixed.

The only difference is **column order**: `likes` is 7th in a fresh database and
last in a migrated one, because `ALTER TABLE ADD COLUMN` appends. Every
statement in the Worker names its columns and every read goes through
`row.<name>`, so this is inert. Recorded, not reported as a defect.

**Idempotence.**

| | Rerun | Interrupted halfway, then rerun |
|---|---|---|
| `0001` | throws `duplicate column name: likes` (documented) | **index never created, and cannot be** — **N12** |
| `0002` | clean, `IF NOT EXISTS` | clean |

**Referential integrity, proved rather than assumed.** With
`PRAGMA foreign_keys = ON` (node:sqlite's default, matching D1's documented
default): an orphan `creator_lists` insert is **rejected**, and deleting a
creator **cascades** its lists away. Confirmed live through the Worker too —
`p11_migrate.mjs` shows `List ghostuser:orphan: FOREIGN KEY constraint failed`
recorded as an error rather than silently dropped, and the row absent from D1.

**Adversarial `migrate-d1` (Phase 8).** Against a KV set containing malformed
JSON, a creator with no key hash, a list with no creator, legacy and garbage
visibility, likes as a string and as a negative number, malformed timestamps, an
unparseable published list, a non-numeric counter, a JSON stats blob and a
sentinel key:

```
{"ok":true,"done":true,"results":{"creators":3,"lists":6,"published":1,"sourcegroups":1,
 "stats":3,"skipped":1,"errors":[
   "Creator badjson1: …", "List ghostuser:orphan: FOREIGN KEY constraint failed",
   "List valid1:badjson: …", "Published …anonbad: …"]}}
```

Correct on: completion, error reporting, skip counting, `likes:"12"` → `12`,
legacy visibility stamped, source groups counted once in their own table,
non-numeric counters skipped, **re-running changes nothing** (byte-identical
snapshot of all three tables), and **nothing rolls backward** — a hand-edited
`likes=999` in D1 is correctly restored to KV's `5`.

Two blemishes: `likes: -4` migrates as `-4` (only reachable from hand-edited KV),
and `created_at: "yesterday"` is accepted into an `INTEGER NOT NULL` column via
SQLite type affinity. Both LOW; a `CHECK (likes >= 0)` and
`CHECK (typeof(created_at)='integer')` would make them structural.

---

## 6. Partial-failure report

Every row executed with fault injection at the named point.

| Operation | Injected failure | Outcome | Verdict |
|---|---|---|---|
| `lists/save` (new) | KV `put` on `creatorlist:` | 500 `ok:false`; D1 holds an orphan row that no read path surfaces | ✅ |
| `lists/save` (make private) | KV `put` on `index:publiclists` | 500 with a specific message; record already private | ✅ |
| `lists/save` | D1 insert throws | `ok:true`, KV correct, D1 mirror stale and **unrepairable** | ⚠️ N9 |
| `lists/delete` | KV `delete` on `creatorlist:` | **`ok:true`, list still live and public** | ❌ **N1** |
| `lists/delete` | KV `put` on `index:publiclists` | **`ok:true`, still in the directory** | ❌ **N2** |
| `admin/delete-creator-list` | KV `put` on `index:publiclists` | **`ok:true`, still in the directory** | ❌ **N2** |
| `account/reset` | KV `put` on `index:publiclists` | **`ok:true`, lists still in the directory** | ❌ **N2** |
| `delete-account` | KV `put` on `index:publiclists` | **`ok:true`, identity gone, username freed, lists still advertised** | ❌ **N2** |
| `delete-account` | concurrent authenticated write (7 routes) | **`ok:true`, data resurrected, inherited on reclaim** | ❌ **N4** |
| `reset-key` / `admin reset-creator-key` | D1 UPDATE **and** DELETE both throw | 503, KV untouched, old key still works | ✅ |
| `reset-key` | D1 UPDATE throws, DELETE succeeds | rotation proceeds; D1 row dropped so it cannot answer with the old hash | ✅ |
| `create` | D1 insert throws | `ok:true`, account fully usable from KV | ✅ documented |
| `like` | D1 UPDATE throws (3 votes) | KV = 3 (correct); D1 = 0 and stays 0 through a later rename | ⚠️ §11.2 |
| cron sweep | one account's KV `get` throws | **sweep dies there every tick; accounts behind it never swept** | ❌ **N7** |
| cron sweep | `list({cursor})` rejects | **cursor never cleared; wedged permanently** | ❌ **N7** |
| `scheduled()` | total KV outage | **rejects out of the handler** | ❌ **N8** |

---

## 7. Authorization matrix

`p08_authz.mjs`. 18 authenticated creator routes × {anonymous, wrong key, Creator
B against Creator A's resource}, plus 17 admin routes × {no session, forged
cookie}.

| Role | Creator routes | Admin routes |
|---|---|---|
| Anonymous | **401 on all 18** | 401 on all 17 (`/admin` itself returns the login form, 200, and leaks nothing — verified against creator names, list names, feedback bodies, emails and `ADMIN_KEY`) |
| Wrong Creator Key | **401 on all 18** | — |
| Creator B naming Creator A's resource | 200 for B's *own* namespace only; **A's list, config and tracking all verified byte-intact afterwards** | — |
| Forged `admin_session` cookie | — | 401 on all 17 |

No IDOR. No privilege escalation. The one gap is not in this matrix: `N3`, where
an *unauthenticated* caller can read the existence of, and write to, a private
list through `/api/lists/like`, which takes no creator credentials at all and so
never appears in a credentials-based matrix.

---

## 8. State-machine failures

**Creator.** `NONEXISTENT → CREATED → ACTIVE → ROTATED → RESET → DELETED →
RECLAIMED`, all transitions plus the invalid ones (double delete, reset a
deleted account, rotate during reset, old key after reuse):

* healthy path clean — `p01`, `p15_stateful.mjs` (rotation is inside the
  randomized sequence and the old key is re-checked after every rotation across
  8 seeds; never once authenticated).
* `DELETED → (concurrent write) → RECLAIMED` **fails** — **N4**.
* `ROTATED` / `DELETED` under a stale KV read **fails** — **N5**.

**List.** `NONEXISTENT → PRIVATE → PUBLIC → EDITED → RENAMED → PRIVATE →
PUBLIC → DELETED`, with KV, D1, the public page, the directory index and the
like ledger inspected after **every** transition, across 8 seeds × 120 random
operations (`p15_stateful.mjs`): **no divergence.**

Failures are all in the delete/unpublish edges under fault injection — N1, N2 —
and in the like edge — N3.

**Likes.** Anonymous, repeated, unlike, concurrent, at the 5000 voter cap and one
below it, while the owner edits, with D1 unavailable: all correct
(`p24_caps.mjs`, `p15_stateful.mjs`). Two gaps: N3, and the D1 mirror never
re-converging after an outage (§11.2).

**Sync.** Stale write rejected; legacy client without `expectedUpdatedAt` keeps
last-write-wins as documented; a frozen clock still rejects the second stale
write; a clock that jumps backwards still produces a strictly increasing
version; a config save destroys neither tracking, presets nor channels. Clean.

---

## 9. Test-suite blind spots

The suite is green (233/234) and `verify.sh` passes. I mutation-tested it:
**23 controlled, semantically real bugs**, each rebuilt through `build.py`,
`node --check`ed, and run through `node --test tests/*.test.mjs`.
Scripts: `audit/adversarial-II-2026-09-06/mutate2.sh`, `mutate3.sh`.
(A 24th, labelled M1, was a no-op edit of mine and is excluded — its "survival"
means nothing.)

**17 killed, 6 survived.**

| # | Mutation | Result |
|---|---|---|
| M2 | `isPublicListVisibility` inverted | killed (23 fail) |
| M3 | `normalizeListVisibility` defaults to public | killed (1) |
| M4 | `lists/save` skips the KV write | killed (24) |
| M5 | `lists/save` skips the D1 write | killed (4) |
| M6 | sync conflict guard removed | killed (3) |
| M7 | `nextSyncVersion` returns a bare `Date.now()` | killed (2) |
| M8 | `listAllKeys` stops following the cursor | killed (1) |
| M10 | `creatorlist` key prefix changed on read | killed (7) |
| M12 | purge never removes the KV identity | killed (5) |
| M13 | `timingSafeEqualHex` always true | killed (15) |
| M14 | `updatePublicListIndex` ignores removals | killed (2) |
| M16 | like route writes its stale snapshot back | killed (1) |
| M1b | `delete-account` accepts any credentials | killed (2) |
| M17 | `deleteCreatorLists` never deletes the KV record | killed (2) |
| M20 | like endpoint accepts any username/slug | killed (1) |
| M21 | `reset-key`'s per-account failure budget removed | killed (2) |
| M23 | `reorder` accepts arbitrary slug strings | killed (1) |
| **M9** | **`pickFreeSlug` numbered scan off by one** | **SURVIVED** |
| **M11** | **`invalidateCreatorAuthMemo` becomes a no-op** | **SURVIVED** |
| **M15** | **`/api/creator/create`'s per-IP rate limit removed** | **SURVIVED** |
| **M18** | **the account purge skips the public-directory cleanup entirely** | **SURVIVED** |
| **M19** | **the cron cursor advances before the batch is processed** | **SURVIVED** |
| **M22** | **`share-tracking` accepts any slug, not just the three allowed** | **SURVIVED** |

Note what the killed rows prove, because it is the good news: the visibility
enum, the KV *and* D1 writes on save, the conflict guard, the version
monotonicity, the cursor loop, key verification, the identity purge, the
directory removal on the save path, the like re-read, the recovery-answer budget
and the reorder charset all have real behavioural coverage now. That is a large
improvement on the previous audit's 7-of-12 survival rate.

The survivors that matter most:

* **M18 is N2's test.** Deleting `removeListsFromPublicIndex` from
  `purgeCreatorData` outright leaves 233/233 green. The suite proves the
  directory is cleaned on the *list-save* path (M14 is killed) and never on the
  *account* path.
* **M19 is A17's regression test, and it does not exist.** Reverting the
  previous audit's cron-cursor fix leaves the suite green. A fixed defect with
  no test guarding it is a defect waiting to come back.
* **M9 was already reported as a survivor by the previous audit (its m10) and is
  still a survivor.** Boundary/exhaustion paths remain untested.
* **M11** — nothing proves that rotating a key stops the old one working *from a
  warm isolate memo*. It is safe today only because `storedHash` is part of the
  memo key; remove that and no test notices.
* **M15** — the per-IP account-creation limit has no test at all.
* **M22** — `share-tracking`'s `ALLOWED_SHARE_SLUGS` allow-list is untested.
  Harmless today (the read side in `/lists/:u/:slug` only ever consults the
  three known slugs, so an extra key is inert), but it is the guard standing
  between an arbitrary body field and a stored share flag.

Two structural gaps beyond mutation:

* **KV eventual consistency still is not modelled.** The previous audit flagged
  this; N5 is what was hiding inside it. `p16_kv_eventual.mjs` shows the shape a
  test would take.
* **Nothing tests any endpoint's behaviour when a secondary write fails.**
  `makeKv()` grew fault-injection hooks for exactly this and the suite uses them
  only for the paths the previous audit fixed — which is why N1 and N2 are
  invisible.

---

## 10. Performance / scale findings

`EXPLAIN QUERY PLAN` against `schema.sql` in real SQLite (`p10_schema.mjs`, and
the plans below).

| Query | Plan | At 1M rows |
|---|---|---|
| `SELECT username, display_name, created_at, last_active FROM creators ORDER BY last_active DESC, created_at DESC LIMIT ?` | **`SCAN creators` + `USE TEMP B-TREE FOR ORDER BY`** | full table scan + full sort on **every admin dashboard load** |
| `SELECT … FROM creator_lists WHERE visibility='public' ORDER BY likes DESC, updated_at DESC LIMIT ?` | `SEARCH … USING INDEX idx_creator_lists_visibility` + `USE TEMP B-TREE FOR ORDER BY` | ~half the table read and sorted to return 200 |
| `SELECT kind, n FROM stats WHERE day='total' AND kind LIKE ? ORDER BY n DESC LIMIT ?` | `SCAN stats` + temp B-tree | `stats` grows as (distinct kind) × (day); `list_copy:{slug}` makes *kind* unbounded |
| `SELECT day, n FROM stats WHERE kind = ?` | `SEARCH … USING sqlite_autoindex_stats_1` | ✅ |
| `SELECT * FROM creator_lists WHERE username = ?` / `WHERE id = ?` | indexed | ✅ |
| `SELECT COUNT(*) FROM creators` | covering index | ✅ |

Two concrete fixes:

* **`CREATE INDEX idx_creators_last_active ON creators(last_active DESC, created_at DESC);`**
  There is no index on `last_active` at all. This is the admin dashboard's
  hottest query and it is a full scan today.
* **`CREATE INDEX idx_creator_lists_vis_likes ON creator_lists(visibility, likes DESC, updated_at DESC);`**
  I verified this turns the community-lists query into a pure index seek with no
  sort. Note the consequence for `idx_creator_lists_likes`: with
  `idx_creator_lists_visibility` present, SQLite never chooses the likes index
  for the directory query — the index migration 0001 added *for that query* is
  not used by it. (The previous audit reached the same conclusion by a different
  route; recorded here with the plan that shows it.)

**Public index sizing.** `PUBLIC_INDEX_MAX = 20000` entries in a single KV
value — roughly 4 MB — and `rebuildPublicListIndex` persists a build state blob
of comparable size once per chunk at `PUBLIC_INDEX_BUILD_OPS_PER_RUN = 300`. At
20,000 lists that is ~67 chunks; driven by the 6-minute cron, a cold rebuild
takes ~7 hours, rewriting a multi-megabyte KV value each time. Correct, and
convergent (verified at 999/1000/1001/1999/2000/2001 lists, §15), but the
cost curve is worth knowing before a deployment gets there.

---

## 11. Unconfirmed investigations

1. **An empty-but-successful upstream reply poisons the shared chart caches.**
   Confirmed: with every provider answering `200 {}`, one `scheduled()` tick
   writes **48 KV keys**, including `cache:trakt:chart:trending:movie:1 =
   {"data":{},"freshUntil":…}` and `cache:tmdb:chart:trending:movie:0:US:0 =
   {"data":[],…}`, each with `expirationTtl: 86400`
   (`p20_emptycache.mjs`). What I could **not** confirm is the sharper claim —
   that an empty reply *overwrites a previously good* cached chart — because I
   could not construct a payload that the TMDB chart parser accepts as
   non-empty in the harness (`p21_cachepoison.mjs` is inconclusive, not
   passing). Worth resolving: "don't cache an empty result over a non-empty
   one" is a two-line guard if the answer is yes.
2. **The D1 like mirror never re-converges after an outage.** `p04_kvd1.mjs`
   case F: three likes recorded while D1 rejects the UPDATE leaves KV at 3 and
   D1 at 0, and a subsequent rename does not repair it (correctly — `likes` is
   deliberately out of that `DO UPDATE`). `migrate-d1` does repair it, so this
   is "requires a manual sweep" rather than "unrepairable". Impact is confined
   to the admin Community Lists ranking. Recorded rather than filed because the
   right fix may simply be documenting it.
3. **`creatorlistorder:{u}` loses entries under real concurrency.** With KV gets
   forced to take a real tick, 12 concurrent list creations produced 12 records
   but only **9 order entries** (`p06_order_race.mjs`). The dashboard's orphan
   sweep hides it — all 12 lists still render — so the visible symptom is only
   that the user's chosen ordering silently loses positions. The duplicate-list
   catastrophe this used to cause is genuinely fixed.
4. **`/api/creator/lists/save` has no staleness guard.** Two devices editing the
   same list is last-write-wins with both answering 200 — the exact shape the
   sync blobs got `expectedUpdatedAt` for. List records were left out of that
   work. Not filed as a defect because it may be a deliberate scope decision,
   but it is the largest remaining un-guarded write.
5. **`/api/creator/lists/reorder` accepts `.` and uppercase** (`[a-zA-Z0-9._-]`)
   while `slugifyServer` only ever emits `[a-z0-9-]`, so `..` and `.` are
   storable order entries. They resolve to nothing in KV's flat namespace and I
   could not turn them into anything, but the two validators disagreeing is how
   the `:` hazard the previous audit recorded came about.

---

## 12. File-by-file punch list

### `02_http-and-creator-utils.js`

| Finding | Priority | Line | Defect | Minimal safe change |
|---|---|---|---|---|
| **N1** | P0 | 1571-1575, 1587 | `deleteCreatorLists` swallows the KV delete failure and returns no failure signal | add a `failed` flag; return it in `out`; both callers 500 on it |
| **N2** | P0 | 1592, 2450 | `removeListsFromPublicIndex`'s boolean discarded in `deleteCreatorLists` and `purgeCreatorData` | `if (!ok) dataSweepFailed = true` / propagate |
| **N4** | P0 | 2360-2596 | `purgeCreatorData` is one-shot; nothing stops a concurrent authenticated write from re-creating keys after it | write `creatordeleted:{u}` (short TTL) before the sweep; check it in `authenticateCreator` and in `/api/creator/create` |
| **N5** | P1 | 2598-2617 | `getCreator` prefers KV and only falls back on a miss, so a stale KV hit outranks a fresh D1 value for authentication | when `env.DB` is bound, read the key hash from D1 for auth (or cross-check) |
| **N11** | P1 | 393-402 | PBKDF2 runs unthrottled on every credentialed route | gate it inside `authenticateCreator` with `consumeRateLimit` |
| §11.5 | P3 | — | `reorder`'s charset and `slugifyServer`'s charset disagree | narrow the reorder filter to `[a-z0-9-]` |

### `26_api-creator-and-admin-routes.js`

| Finding | Priority | Line | Defect | Minimal safe change |
|---|---|---|---|---|
| **N1** | P0 | 1843-1861 | `/api/creator/lists/delete` returns `{ok:true}` unconditionally, ignoring `deleted`/`missing` | return 500 when the shared helper reports a failure |
| **N9** | P1 | 3748-3751 | `migrate-d1`'s lists `DO UPDATE` sets only `likes` + `visibility`, so a drifted row is unrepairable | add `name`, `type`, `items_json`, `updated_at` to the `DO UPDATE` |
| **N10** | P1 | 2668+, 1426+, 2612+, 1384+, 1028+ | `sync/load`, `lists`, `sync/meta`, `restore`, `track-status` inherit `max-age=3600` while returning private data | add `{"Cache-Control":"no-store"}` at each call site |
| **N10** | P2 | 3010 | `/api/search-published-lists` is a cacheable GET at `max-age=3600` | `max-age=60` |
| **N8** | P2 | 4727-4762 | `scheduled()` has no exception boundary | wrap the body in `try`, and each task in `.catch` |
| **N11** | P1 | 466-510 | `/api/scrobble`'s `creator`+`key` path has no rate limit or failure budget | per-IP bucket, and route it through the gated `authenticateCreator` |
| §11.4 | P3 | 1616 | `lists/save` has no `expectedUpdatedAt` guard | consider extending the sync-blob guard to list records |
| — | P3 | 1889-1903 | **Stale comment.** The block above `/api/creator/account/reset` still says `delete-account` "deletes `creatorprofile:` … so it currently leaves most of an account's data behind." Both callers have shared `purgeCreatorData` since `2dc536e`. | delete the paragraph |

### `25_api-catalog-routes.js`

| Finding | Priority | Line | Defect | Minimal safe change |
|---|---|---|---|---|
| **N3** | P0 | 5689-5700 | `/api/lists/like` never checks visibility: private-list existence oracle + unauthenticated write to a private record | `if (!isPublicListVisibility(likeData.visibility)) return json({ok:false,error:"List not found."},404)` after the stamp |
| §11.1 | P2 | 5604-5676 | `/api/publish-list` mints a permanent KV key no route can delete (already known, still open) | an admin delete path for `publishedlist:user:*` |

### `07_source-fetchers-tmdb-simkl.js`

| Finding | Priority | Line | Defect | Minimal safe change |
|---|---|---|---|---|
| **N7** | P0 | 1688-1827 | no try/catch anywhere; one failing account stops the sweep for every account behind it, forever; a rejected cursor wedges it | try/catch per account and continue; on a `list()` failure with a cursor, clear the cursor and return |
| **N6** | P1 | 1701-1704, 1826 | budget exhaustion breaks out of the loop but the cursor still advances past the unprocessed accounts | only advance the cursor when the batch completed |
| **N6** | P3 | 1817-1825 | comment claims "the cursor advances only once this batch has actually been processed" — untrue on the budget path | correct it alongside the fix |

### `schema.sql`, `migrations/`

| Finding | Priority | Defect | Minimal safe change |
|---|---|---|---|
| **N12** | P2 | `0001` interrupted between its two statements can never be completed by re-running it | split into two files, or document the recovery statement |
| §10 | P2 | no index on `creators.last_active`; the community-lists query cannot use `idx_creator_lists_likes` | add `idx_creators_last_active` and `idx_creator_lists_vis_likes` (as a new migration **and** to `schema.sql`, so the two paths stay identical) |
| §5 | P3 | `likes` and `created_at` accept negative / non-integer values via type affinity | `CHECK (likes >= 0)`, `CHECK (typeof(created_at) = 'integer')` |

### `tests/`

See §13. `makeKv()`'s fault hooks and `makeD1().failWhen` already exist; the gap
is that almost nothing uses them outside the paths the last audit fixed.

### Repository root / documentation

| Priority | Item |
|---|---|
| P3 | `gen_map.py`'s `ROUTE` regex only matches `path === "…"`, so FUNCTION-MAP.md's route table (108 entries) omits **every** prefix and regex route — `/lists/:user/:slug`, `/channels/…`, `/api/scrobble…`, `/:config/manifest.json`, `/:config/catalog/…`. Anyone building a route inventory from that table gets an incomplete one. Extend the regex to `path.startsWith(` and `path.match(`. |
| P3 | `check_sync.py` only asserts each source file appears *somewhere* in the combined output. It would pass on a combined file with the modules out of order, duplicated, or with extra content appended. It is not run by `verify.sh` or CI (both use the stronger rebuild-and-diff), so it is a misleading leftover rather than a hole — delete it or make it call `build.py`. |

---

## 13. New tests to add

Each of these fails on the current code and passes after the named fix. All of
them are one file away — the harness already has every hook they need.

1. **N1** — save a public list, set `kv._hooks.beforeDelete` to throw on
   `creatorlist:`, call `/api/creator/lists/delete`; assert the response is not
   `ok:true` **and** that `/lists/:u/:s.json` no longer returns 200.
2. **N2** — four cases (`lists/delete`, `admin/delete-creator-list`,
   `account/reset`, `delete-account`) with `beforePut` throwing on
   `index:publiclists`; assert each reports failure and that
   `/lists/public.json` does not still list the record. **This is mutation M18's
   missing test.**
3. **N3** — create a private list; assert `/api/lists/like` returns the *same*
   status and body for it as for a non-existent slug, and that neither the KV
   record's `likes` nor `listlikevoters:` is created.
4. **N4** — gate the KV put of an in-flight `sync/save`, run
   `delete-account` to completion, release; assert zero KV keys mention the
   username, then re-register it and assert `sync/load` returns an empty config.
   Repeat for `lists/save` and `scrobble-token`.
5. **N5** — a KV double that serves a pre-write snapshot for one key; assert the
   rotated-away key 401s and the deleted account 401s even from that view.
6. **N6** — 30 accounts, one holding 200 fully-watched shows; run 6 ticks;
   assert every account's tracking key was read at least once.
7. **N7** — make one account's tracking read throw; assert accounts *after* it
   are still swept, and that a `list()` failure clears the cursor.
8. **N8** — `scheduled()` against a KV that throws on everything; assert it
   resolves rather than rejecting.
9. **N9** — hand-edit a D1 `creator_lists` row's `name`, run `migrate-d1` to
   completion, assert the row's `name` matches KV again.
10. **N10** — header assertions for `sync/load`, `lists`, `sync/meta`,
    `restore`, `track-status` and `search-published-lists`.
11. **N11** — 60 wrong-key POSTs to `/api/scrobble` and `/api/creator/sync/load`
    from one IP; assert at least one 429.
12. **N12** — apply `0001`'s ALTER only, then the whole file; assert
    `idx_creator_lists_likes` exists afterwards.
13. **Regression guards for the mutation survivors** — a `pickFreeSlug` test
    that pins the exact number of numbered candidates (M9); a rotation test that
    proves an old key fails from a warm memo (M11); a per-IP creation-limit test
    (M15); **a cron test that fails if the cursor write moves back above the
    loop (M19)**.

---

## 14. Top 10 remaining risks

1. **Deletion is not atomic with respect to in-flight writes** (N4) — the only
   finding here that produces cross-account data disclosure.
2. **Continue Watching stops silently and permanently** (N6, N7) — a whole
   feature, deployment-wide, with no signal.
3. **`ok:true` on a delete that deleted nothing** (N1, N2) — the class the last
   two audits were built to remove, still present on the paths they did not
   touch.
4. **KV read-caching vs immediate revocation** (N5) — the codebase asserts
   "immediately" in four separate comments; the storage layer cannot deliver it
   on the current read order.
5. **Unthrottled PBKDF2** (N11) — cheap, unauthenticated, uncounted CPU.
6. **`/api/lists/like` bypasses visibility** (N3) — the one public route that
   touches a private record without checking.
7. **The D1 mirror can drift and only `migrate-d1` repairs it — and for lists it
   cannot** (N9, §11.2).
8. **Anonymous published lists cannot be deleted by anything** — already known,
   still open, and now a content-moderation and data-retention problem rather
   than a storage one.
9. **`creatorlistorder:` remains a single-key read-modify-write** (§11.3) — the
   catastrophic symptom is fixed, the lossiness is not.
10. **The suite does not test failure paths, boundaries, or KV consistency**
    (§9) — six surviving mutations, two of them guarding fixes that already
    shipped.

---

## 15. What I tried to break but could not

All executed against the committed Worker. Recorded so this ground is not
re-covered and so the report is not read as uniformly negative.

* **Cross-creator authorization.** 18 authenticated routes × 3 hostile roles,
  plus 17 admin routes × 2. 401 everywhere it should be; Creator A's list,
  config and tracking verified byte-intact after everything Creator B did
  (`p08_authz.mjs`).
* **Randomized stateful model check.** 8 seeds × 120 random operations (create,
  duplicate-name create, edit, rename, visibility flip, like, unlike, delete,
  reorder, sync, key rotation), with an independent model compared against KV,
  D1, the public page and the directory index **after every single operation**,
  and the old key re-tested after every rotation: **all seeds clean**
  (`p15_stateful.mjs`).
* **Route contract fuzzing.** 286 calls: 11 routes × 26 payload shapes —
  no body, `{}`, `[]`, strings for objects, numbers, booleans, nulls, 5,000-char
  names, `null`-byte ids, nested arrays, duplicate ids, path-traversal slugs
  (`../../etc/passwd` → `etc-passwd`), colon slugs, 400-char slugs, unicode,
  `"NaN"` and negative `expectedUpdatedAt`. **Zero uncaught throws and zero
  corrupt persistent state** — every stored record kept a valid enum visibility,
  an array `items`, a numeric `likes`, and a well-formed 3-segment key; every D1
  row had a matching KV record (`p23_fuzz.mjs`).
* **Cap boundaries at CAP-1 / CAP / CAP+1.** Items (9999/10000/10001 → 200/200/413),
  name length (199/200/201 → 200/200/400), serialized bytes, reorder
  (4999/5000/5001 → stored 4999/5000/5000), admin bulk delete (49/50/51 →
  200/200/413), like-voter cap (4999 accepts, 5000 returns `capped:true` and does
  not grow). An over-cap list leaves **no** partial KV record and **no** D1 row
  (`p24_caps.mjs`).
* **Pagination correctness.** Index rebuild driven to completion at 999, 1000,
  1001, 1999, 2000 and 2001 lists, then paged through `/lists/public.json` at
  limit 500: every indexed entry appears **exactly once**, no duplicates, no
  gaps, offsets past the end handled (`p14_pagination.mjs`).
* **KV-only vs KV+D1 differential.** 18 operations, both modes, normalised:
  **zero** observable differences (`p22_differential.mjs`).
* **Optimistic concurrency.** Stale write rejected; cross-blob independence
  (a config save destroys neither tracking, presets nor channels); a **frozen
  clock** still rejects the second stale write (`nextSyncVersion`'s +1 does its
  job); a clock jumping **backwards** still yields a strictly increasing version
  (`p05_concurrency.mjs`).
* **Partial-failure honesty on the paths the last audit fixed.** `lists/save`
  with KV down → 500 and no phantom list; rotation with D1 fully broken → 503,
  old key intact, no new key issued; account deletion with only a D1 mirror →
  correctly revoked (`p04_kvd1.mjs`).
* **Adversarial migration.** 23 deliberately ugly KV records; correct
  completion, honest error list, accurate counters, FK violations reported not
  swallowed, **re-run byte-identical**, and **nothing rolled backward** over a
  hand-edited newer D1 row (`p11_migrate.mjs`).
* **Referential integrity, proved not assumed.** Orphan insert rejected,
  `ON DELETE CASCADE` fires, both in isolated SQLite and through the live Worker
  (`p10_schema.mjs`, `p11_migrate.mjs`).
* **Provider contract mutation.** 14 upstream behaviours — malformed JSON, `{}`,
  array-for-object, `results:null`, items missing id/title, duplicates, 204,
  301, 401, 403, 404, 429, 500, and a request that never resolves — driven
  through a full `scheduled()` tick. **No throw escaped, and no account-owned
  state changed** in any case (`p19_providers.mjs`). The one blemish is §11.1.
* **Build differential.** I reimplemented `build.py` independently and rebuilt
  the Worker from `header.js` + the 27 numbered sources: **byte-identical**,
  2,798,585 bytes, sha256 `2eefaae8f34875c339331d02424b48acad0a0e338bcb0cb7e58e8411a672cea7`.
  Each source chunk appears exactly once, at exactly the expected offset, with
  **zero** bytes of unaccounted content anywhere in the file — so nothing has
  been hand-edited into the generated Worker.
* **`/admin` unauthenticated.** Returns only the login form; verified it leaks
  no creator name, list name, feedback body, email address or `ADMIN_KEY`
  (`p09_adminpage.mjs`).
* **Schema drift.** Fresh vs fully-migrated are identical in every property the
  code uses; A15 is genuinely closed (`p10_schema.mjs`).

---

## 16. Prior-audit conclusions I can show are wrong

Stated only where I can demonstrate it.

**G1 — `AUDIT-2026-09-06-ADVERSARIAL.md` §A14** concludes about `migrate-d1`'s
lists branch:

> *"The lists branch three statements later gets this right (`DO UPDATE SET
> likes=excluded.likes, visibility=excluded.visibility`)."* and
> *"`name`/`type`/`items_json` are left alone on conflict. Re-running it is safe."*

Re-running it *is* safe — that half is right, and I re-verified it. But "gets
this right" is not: leaving `name`/`type`/`items_json` alone is precisely the
`DO NOTHING` disease that finding diagnosed one paragraph earlier for
`creators`. A `creator_lists` row that drifted from KV — which `lists/save`'s
swallowed D1 catch produces routinely — can never be repaired by the tool whose
stated job is reconciling KV into D1. Demonstrated in `p11_migrate.mjs`; filed
as **N9**.

**G2 — `AUDIT-2026-09-06-ADVERSARIAL.md` §15, "Account deletion" and "Key
rotation".** Both are certified with the qualifier "on the healthy path", which
is honest — but the healthy path is not where either invariant is at risk. On
the concurrent path, deletion resurrects data and hands it to the next owner of
the username (**N4**); on a stale-KV read, rotation leaves the old key working
and rejects the new one (**N5**). The same section's "a reclaiming owner
inherits nothing" is true only when nothing was in flight.

**Not a false positive, but worth correcting:** §15 also certifies
"Private-list leakage … A private list is unreachable via `/lists/:u/:s`,
`.json`, `?format=object`, `/lists/public.json`, `/api/public-lists.json` and
`/api/search-published-lists`." Every one of those is still true — I re-verified
all six. The set was simply incomplete: `/api/lists/like` is a seventh public
path to a private record, and it is the one that is wrong (**N3**).

---

## Reproducing this audit

```bash
node --test tests/*.test.mjs          # baseline: 233 pass / 0 fail / 1 skipped
bash verify.sh                        # build drift, syntax, page render, map, tests

for f in audit/adversarial-II-2026-09-06/p*.mjs; do
  echo "== $f"; node "$f"; done

# mutation testing (destructive to a COPY; restores itself)
git archive HEAD | tar -x -C /tmp/mut && cd /tmp/mut
cp ../My-Lists/audit/adversarial-II-2026-09-06/mutate2.sh . && bash mutate2.sh
cp ../My-Lists/audit/adversarial-II-2026-09-06/mutate3.sh . && bash mutate3.sh
```

Every probe runs against the committed `worker_entry_combined.js` through
`tests/harness.mjs` (real SQLite for D1, key-positioned opaque cursors for KV,
fault injection on both). No probe touches production, and none makes a network
call except `p19_providers.mjs`/`p20`/`p21`, which stub `globalThis.fetch`
entirely.
