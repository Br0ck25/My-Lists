# ADVERSARIAL AUDIT — CURRENT MAIN

**Repository:** `Br0ck25/My-Lists` · **Commit audited:** `8e2ad72` · **Date:** 2026-09-06

**Method.** Invariant-driven and adversarial, not a lint pass. The architecture was
rebuilt from source before any prior audit was opened; candidate findings were produced
and reproduced first, and only then compared against
`AUDIT-2026-09-05-INDEPENDENT.md`, `Changes.md`, `CHANGELOG.md` and `docs/history/*`
for classification. Every finding below was **executed**, not reasoned about: the
harness in `audit/adversarial-2026-09-06/` runs the real
`worker_entry_combined.js` against a **real SQLite D1** (`node:sqlite`, loaded from the
committed `schema.sql`, `PRAGMA foreign_keys = ON` to match D1's documented default), an
instrumentable KV with opaque key-positioned cursors, and fault injection on both stores.
No production data was touched and no live endpoint was called.

**No production source was modified.** This report is discovery only, as instructed.
The only files added are this report and the reproduction harness.

---

## Executive Verdict

# NEEDS FIXES

Not "not production ready" — the core is genuinely solid, and the sections below say
exactly what I tried to break and could not. But three of the defects found are
**silent destruction of data that the code itself calls authoritative**, one of them
reachable by an unauthenticated stranger, and two more are **`ok: true` responses on
operations that did nothing** — including "delete my account" and "rotate my leaked key".

The unifying cause is not a bug anywhere in particular. It is a structural asymmetry
that has been introduced in the D1 layer:

> **Every D1 *write* is treated as optional (wrapped, swallowed, logged).
> Every D1 *read* is treated as preferred (`getCreator` / `getCreatorList` try D1 first).**

That combination means any dropped D1 write becomes a permanent, invisible lie — and
because `/api/creator/lists/save` reads through `getCreatorList` and then writes the
result back into KV, a lie in D1 gets *promoted into the authoritative store on the next
ordinary edit*. The comment at `02_http-and-creator-utils.js:2300` says "D1 is an optional
accelerator in front of KV, never a replacement for it." Behaviour disagrees, and where
comment and behaviour disagree, behaviour wins.

Everything in §1 with severity HIGH or above follows from that one sentence.

**Fix in this order:** A1, A5, A3, A4, A2, A6. That is six changes, none large.

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
16. [False positives in prior audits](#16-false-positives-in-prior-audits)
17. [Architecture map](#17-architecture-map-built-from-source)

---

## 1. New confirmed defects

### A1 — SQL `LIKE` wildcard lets one creator delete every other creator's D1 list rows

| | |
|---|---|
| **Severity** | **CRITICAL** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `02_http-and-creator-utils.js:2206` |
| **Function** | `purgeCreatorData` |
| **Invariant violated** | "Creator A must never read/write Creator B's private state." |
| **Classification** | **NEW** — no prior audit mentions `LIKE`, wildcards, or `_` in usernames |

**Evidence.**

```js
// 02_http-and-creator-utils.js:2206
await env.DB.prepare("DELETE FROM creator_lists WHERE id LIKE ?").bind(`${u}:%`).run();
```

`validateCreatorUsername` (`02_…:481`) permits `/^[a-z0-9_-]+$/`. In SQL `LIKE`, **`_`
matches any single character**. The username is interpolated straight into the pattern,
so a username containing `_` is a wildcard against every other account's list ids. The
statement has no `ESCAPE` clause.

**Reproduction** — `audit/adversarial-2026-09-06/t01_like_wildcard.mjs`:

```
D1 rows before:      a_c-films:top-ten, abc-films:top-ten
abc-films gets a real like:                  likes = 1
a_c-films deletes their OWN account:         200 {"ok":true,"cleared":{"lists":1,"keys":17}}
D1 rows after:       []            <-- abc-films' row is gone too
D1 creators after:   abc-films     <-- the victim account itself is untouched
```

The scaled form is worse. Usernames are 3–25 characters and `___` is a legal username,
so `t04_wildcard_mass.mjs` registers one all-underscore name per length and calls
`/api/creator/account/reset` on each — a self-service, repeatable endpoint that runs the
same purge:

```
D1 list rows before: 6 (alice, bobby, carl, dee-jay, eve1, frankie-films)
attacker registered + reset 23 underscore accounts
D1 list rows after:  []
```

**23 self-service resets by one anonymous actor empty `creator_lists` for every account
on the deployment.** Account creation is public and rate-limited at 1/min/IP, so this is
about half an hour of work with no credentials.

**Expected.** Deleting or resetting account *u* touches only rows whose id begins
`u:`.

**Actual.** It deletes every row whose id matches the username as a `LIKE` pattern.

**Impact.** KV survives, so pages keep rendering via the read-side fallback — which is
exactly what makes this dangerous: nothing visibly breaks. What is actually lost:
* every affected list's D1 `likes` value;
* the admin dashboard's Community Lists panel, which reads only D1
  (`03_admin.js:865`) and goes empty;
* and then, via **A2**, the victims' real like counts in **KV** on their next ordinary
  edit. `t05_chain.mjs` runs that end to end: four genuine likes → a stranger resets
  a `_____` account → the owner renames their own list twice → dashboard, directory and
  KV all read `0`.

**Root cause.** A `LIKE` pattern built from untrusted input with no escaping, used where
the intent is a prefix scan.

**Minimal fix.** Do not use `LIKE` for this at all. Either
`DELETE FROM creator_lists WHERE username = ?` (the column exists and is indexed by
`idx_creator_lists_username`), or `WHERE id GLOB ?` with `u:*`, or keep `LIKE` and add
`ESCAPE '\'` with `_`/`%`/`\` escaped in `u`. The `username =` form is the right one: it
is a plain equality on an indexed column and removes the whole class. Audit the same
pattern at `03_admin.js:1133` (`kind LIKE ?`), where the prefixes are internal constants
and so currently harmless, but `list_copy:` and `authfail:` both contain `_`.

**Regression test.** Create `abc` and `a_c`, give each a list, delete `a_c`'s account,
assert `abc`'s D1 row still exists with its original `likes`. Add a second case with
username `___` and three-character victims.

---

### A2 — An ordinary list edit silently zeroes a real like count, first in D1 and then in KV

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:1749` (and `:2317` for the watchlist), `02_http-and-creator-utils.js:2331` |
| **Function** | `/api/creator/lists/save`, `getCreatorList` |
| **Invariant violated** | "Saving a list must not reset its like count." |
| **Classification** | **PARTIAL FIX** of a class prior work addressed elsewhere — see §2 |

**Evidence.** The upsert never binds `likes`:

```js
// 26_…:1749
"INSERT INTO creator_lists (id, username, name, type, visibility, items_json, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET name=…, type=…, visibility=…, items_json=…, updated_at=…"
```

On **`ON CONFLICT`** that is correct — `likes` is deliberately left alone. On **`INSERT`**
it is not: the column takes its `DEFAULT 0` even though the true count is sitting in the
KV record the same handler is about to write.

Then two things compound it:

1. `getCreatorList` (`02_…:2331`) prefers D1 and returns `likes: row.likes || 0`.
   The dashboard, `/lists/:user/:slug` and the directory now read `0`.
2. The very next save re-reads through `getCreatorList` (`26_…:1732`), takes
   `likes = existing.likes` — i.e. D1's `0` — and writes it into the **KV** record
   (`26_…:1759`), which every other read path and the migration treat as authoritative.

**Reproduction** — `t03_likes_reset2.mjs` (D1 has the `creators` row, not yet this list's row):

```
BEFORE                    dashboard: 5   KV: 5   D1: []
AFTER ordinary edit #1    dashboard: 0   KV: 5   D1: [{"likes":0}]      <- split brain
AFTER ordinary edit #2    dashboard: 0   KV: 0   D1: [{"likes":0}]      <- KV corrupted
directory likes: top-ten=0
ledger untouched: {"voters":[...5 voters...]}
```

**How the precondition is reached in production** — four independent ways, none exotic:

* **A1's wildcard wipe** (`t05_chain.mjs`).
* **The migrate-d1 chunk boundary.** `MIGRATE_D1_PREFIXES` puts `creator:` before
  `creatorlist:`, so on any deployment needing more than one chunk there is a window in
  which D1 knows the accounts and none of their lists. `t09_chunk_window.mjs`, 400
  accounts: `chunk 1: creators=349 lists=0`. Every one of those 349 accounts is in the
  vulnerable state until chunk 2 lands.
* **A single transient D1 error on a like.** `/api/lists/like`'s D1 `UPDATE`
  (`25_…:5770-5776`) is wrapped in a swallowing catch. `t20_faultinject.mjs` produced exactly
  this from random 15 %-rate D1 failures:
  `op#11 like: dashboard likes classics model=1 api=0` → `op#14 edit: KV likes classics model=1 kv=0`.
* **A list over D1's 2 MB row limit** (see A11) — the D1 write fails permanently, so the
  row never exists.

**Expected.** A rename never changes a like count.

**Actual.** It sets it to zero in both stores and in the public directory. It recovers
only when a *new* voter likes the list (the count is re-derived from the ledger), which
may be never.

**Minimal fix.** Two lines, either of which alone fixes it; do both.
1. Bind `likes` in the INSERT column list and leave it out of the `DO UPDATE` set:
   `INSERT INTO creator_lists (…, likes, created_at, updated_at) VALUES (…,?,?,?) ON CONFLICT(id) DO UPDATE SET name=…, type=…, visibility=…, items_json=…, updated_at=…`
   — exactly the shape `/admin/api/migrate-d1` already uses at `26_…:3550`.
2. In `/api/creator/lists/save`, read the prior `likes` from **KV** rather than through
   `getCreatorList`. KV is the store the like route writes unconditionally; sourcing an
   authoritative field from the optional accelerator is the actual defect.

Apply the same to the watchlist upsert at `26_…:2317`.

**Regression test.** With D1 bound: seed `creatorlist:u:s` in KV with `likes: 5` and no
D1 row; POST `lists/save`; assert D1 row `likes = 5`, KV `likes = 5`, dashboard `5`.
Then save again and assert all three are still `5`.

---

### A3 — `delete-account` returns `{ok:true}` while the account keeps working

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed, fault-injected) |
| **File** | `02_http-and-creator-utils.js:2284-2290` |
| **Function** | `purgeCreatorData` (identity branch), `getCreator` |
| **Invariant violated** | "An account deleted from the system must no longer authenticate." |
| **Classification** | **NEW** |

**Evidence.**

```js
// 02_…:2269  deleteIdentity branch
await env.CONFIGS.delete(`creator:${u}`);         // KV: gone
…
if (env.DB) {
  try { await env.DB.prepare("DELETE FROM creators WHERE username = ?").bind(u).run(); }
  catch (dbErr) { console.error("D1 write error (purgeCreatorData identity):", dbErr); }
}
```

If that `DELETE` throws, the D1 row survives — and `getCreator` (`02_…:2313`) prefers D1.

**Reproduction** — `t21_delete_fail.mjs` §A:

```
delete-account -> 200 {"ok":true,"cleared":{"lists":0,"keys":17}}
KV identity gone: true
D1 row left behind: [{"username":"alice"}]
the DELETED account's key still authenticates: 200 {"ok":true,…}
and can still write: 200 {"ok":true,"slug":"back",…}
```

**Expected.** After a successful delete, the key is dead and the username is free.

**Actual.** The person is told their account is gone. It authenticates, can publish
lists, and — because `getCreator` sees the D1 row — the username reports "already taken"
so it cannot even be re-registered. It is not a takeover (the *new* registrant is
refused, which is the safer of the two failures), but it is a deletion that deleted
nothing durable while reporting success.

**Root cause.** The read path prefers a store whose write path is best-effort.

**Minimal fix.** Make identity deletion the one D1 write that is *not* best-effort:
on a throw, return a 500 and do not report success. Better still, restore the invariant
structurally — if the D1 identity delete fails, the KV delete must be undone or the
response must say the delete did not complete. A cheaper hardening that closes the whole
family: have `getCreator` return the D1 row only when KV *also* has the account, i.e.
treat D1 as an accelerator (fill in from D1, existence decided by KV) rather than as a
preferred source. That is what the comment already claims it is.

**Regression test.** Inject a throw on `DELETE FROM creators`, call `delete-account`,
assert the response is not `ok:true` **and** that `/api/creator/restore` with the old key
returns 401.

---

### A4 — A failed KV enumeration during account deletion leaves every list live, and the reclaimed username inherits them — private ones included

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed, fault-injected) |
| **File** | `02_http-and-creator-utils.js:2199-2202`, `:2269` |
| **Function** | `purgeCreatorData` |
| **Invariant violated** | "Deleting an account removes everything it owns"; "a reclaimed username inherits nothing." |
| **Classification** | **NEW** (prior work fixed the *like ledger* half of the inheritance problem, not this) |

**Evidence.** The list sweep is wrapped in a catch that logs and continues:

```js
// 02_…:2199
} catch (e) {
  console.error("purgeCreatorData: list enumeration failed", e);
}
```

Execution then falls straight through to `if (deleteIdentity)` at `:2269` and removes
`creator:{u}`, freeing the username — *without* the data ever having been removed.

**Reproduction** — `t21_delete_fail.mjs` §C and `t22_inherit.mjs`:

```
delete -> {"ok":true,"cleared":{"lists":0,"keys":17}}
orphaned KV records: creatorlist:alice:holiday-photos, creatorlist:alice:private-notes
still in the public directory: ["holiday-photos"]
still publicly readable: 200

username reclaimed by a stranger: alice / "Somebody Else"
their dashboard now contains:
    holiday-photos | Holiday Photos | public  | 2 items | [{"id":"tt1"},{"id":"tt2"}]
    private-notes  | Private Notes  | private | 1 items | [{"id":"tt9"}]
```

The stranger sees the **private** list and its full contents, because
`/api/creator/lists` has an orphan-recovery sweep (`26_…:1492`) that adopts any
`creatorlist:{user}:*` record missing from the order key — a fix for the duplicate-list
bug that, combined with this failure path, becomes a cross-account disclosure.

**Expected.** Either the whole account goes, or the delete fails loudly and the identity
stays so the owner can retry — which is precisely what the function's own comment at
`:2270` says it does ("Done after the data sweep so that a failure partway through leaves
an account that can still sign in and retry").

**Actual.** The comment describes the intent; the `catch` at `:2199` defeats it. A sweep
that *threw* is indistinguishable from one that found nothing.

**Minimal fix.** Track failure. Set a flag in that `catch` (and in the `dataKeys` loop),
and gate `deleteIdentity` on it: if any part of the sweep failed, skip the identity
delete and return a non-`ok` response. Note `cleared: { lists: 0 }` was already the
signal — it just was not acted on.

**Regression test.** Inject a `list()` throw scoped to `creatorlist:{u}:`, call
`delete-account`, assert `ok:false`, assert `creator:{u}` still exists, assert the lists
still exist, and assert the username cannot be re-registered.

---

### A5 — Key rotation reports success and rotates nothing when the D1 write throws, and no repair tool can fix it

| | |
|---|---|
| **Severity** | **HIGH** |
| **Confidence** | **CONFIRMED** (executed, fault-injected) |
| **File** | `26_api-creator-and-admin-routes.js:1278-1296` and `:1354-1372`; `:3519` |
| **Function** | `/api/creator/reset-key`, `/admin/api/reset-creator-key`, `/admin/api/migrate-d1` |
| **Invariant violated** | "A creator's old key must stop authenticating immediately after rotation"; "a failed key rotation must not return a new unusable key." |
| **Classification** | **PARTIAL FIX** — see §2 |

**Evidence.** Both rotation endpoints check `meta.changes` (the fix for the zero-rows
case recorded in `docs/history/AUDIT-STATUS.md` item 5) but treat a **throw** as
non-fatal:

```js
try {
  const d1Res = await env.DB.prepare("UPDATE creators SET key_hash = ? WHERE username = ?")…;
  if (!(d1Res && d1Res.meta && d1Res.meta.changes > 0)) console.warn(…);
} catch (dbErr) {
  console.error("D1 write error (creator reset):", dbErr);   // <-- swallowed
}
await env.CONFIGS.put(`creator:${v.normalized}`, JSON.stringify({ ...profile, keyHash }));
return json({ ok: true, …, creatorKey });
```

KV now holds the new hash; D1 holds the old one; `getCreator` prefers D1.

**Reproduction** — `t06_rotation_split.mjs`:

```
reset-key response: 200 { ok: true, gotNewKey: true }
  the OLD key (must be dead): 200 AUTHENTICATES
  the NEW key (must work):    401 rejected
KV hash: pbkdf2:100000:a6b5771de0…   D1 hash: pbkdf2:100000:943e66cb82…
```

And the documented repair does not repair it:

```
migrate-d1 finished after 1 calls
D1 hash after migrate-d1: pbkdf2:100000:943e66cb82…   (unchanged)
  the OLD key: 200 AUTHENTICATES
  the NEW key: 401 rejected
```

because the migration's creators branch is `ON CONFLICT(username) DO NOTHING`
(`26_…:3519`). Only a *second, successful* rotation clears it — which the person locked
out of their own account cannot perform through `/api/creator/reset-key`, since that
endpoint hands them another key that also will not work.

**Expected.** A rotation either takes effect everywhere or reports failure.

**Actual.** `ok:true` plus a key that never works, while the key the person is rotating
*because it leaked* keeps working indefinitely. This is the worst possible direction for
this endpoint to fail in.

**Minimal fix.** In both rotation handlers, on a D1 throw, either return
`{ ok:false }` with a 500 before writing KV, or — better, and cheap —
`DELETE FROM creators WHERE username = ?` so the stale accelerator row cannot answer a
lookup, then proceed with the KV write. Separately, change migrate-d1's creators upsert
to `DO UPDATE SET display_name=excluded.display_name, key_hash=excluded.key_hash,
recovery_answer_hash=excluded.recovery_answer_hash` so the endpoint whose stated job is
to reconcile KV into D1 can actually reconcile it (it is already the shape used for
lists at `:3532`).

**Regression test.** Inject a throw on `UPDATE creators SET key_hash`, call both
rotation endpoints, and assert: response is not `ok:true`, the old key 401s, the new key
authenticates. Second test: leave D1 with a stale hash, run migrate-d1 to completion,
assert the D1 hash now equals the KV hash.

---

### A6 — A single dropped D1 write leaves the owner's dashboard permanently disagreeing with the public store about visibility

| | |
|---|---|
| **Severity** | **MEDIUM-HIGH** |
| **Confidence** | **CONFIRMED** (executed, randomized fault injection) |
| **File** | `26_api-creator-and-admin-routes.js:1746-1756`, `02_http-and-creator-utils.js:2331` |
| **Function** | `/api/creator/lists/save`, `getCreatorList` |
| **Invariant violated** | "Public page reads KV, dashboard reads D1, a write updated only one — both now confidently show different answers." (split brain) |
| **Classification** | **NEW** |

**Reproduction** — `t20_faultinject.mjs`, 120 random operations with D1 failing 15 % of
the time; 5 of 6 seeds diverged:

```
D1 failure rate 0.15  seed=11  DIVERGED
   op#17 create: dashboard visibility top-ten model=public api=private
   op#18 create: dashboard visibility top-ten model=public api=private
   …persists for the rest of the run
```

and the mirror image, `t20` §2 (KV `put` fails after the D1 upsert succeeded):

```
KV says : {"visibility":"private","items":[{"id":"tt1"}], …}
D1 says : [{"visibility":"public","items_json":"[{\"id\":\"tt1\"},{\"id\":\"tt2\"}]"}]
/lists/alice/doc.json      -> 404   (reads KV)
dashboard (reads D1 first) -> [{"slug":"doc","vis":"public","n":2}]
```

**Impact.** The owner's own dashboard is the only place they can check whether a list is
public. After one dropped write it can say **private** while the world can read the list,
or say **public** while nobody can. Nothing repairs it until that exact slug is saved
again. Making a list private and being shown "private" while it is in fact still served
is a privacy-relevant misreport, not just a cosmetic one.

**Minimal fix.** The same structural change A2 and A3 point at: `getCreatorList` should
merge D1 onto KV rather than replacing it, or the dashboard should read KV. Failing that,
the save handler should verify its own D1 write (`meta.changes`) and, on failure, delete
the D1 row so reads fall through to the authoritative store rather than to a stale one.

**Regression test.** Inject one D1 upsert failure during a visibility change; assert the
dashboard's reported visibility equals `/lists/:u/:s`'s actual behaviour.

---

### A7 — Unpublishing a list during an in-flight index rebuild silently re-publishes it for up to 24 hours

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed through the real routes) |
| **File** | `02_http-and-creator-utils.js:2008` (`rebuildPublicListIndex` final write) vs `:1800` (`updatePublicListIndex`) |
| **Invariant violated** | "Making a list private must remove it from every public discovery mechanism." |
| **Classification** | **NEW** |

**Evidence.** A rebuild snapshots entries into `index:publiclists:build` across many
chunks and publishes them with `writePublicListIndex(env, state.entries)` when the last
chunk lands. `updatePublicListIndex(…, null)` — the removal an unpublish performs —
edits the *live* key. A removal that happens after a slug has been scanned but before
the rebuild finishes is therefore overwritten by the rebuild's pre-change snapshot.

**Reproduction** — `t17_rebuild_clobber.mjs` (900 filler lists so the rebuild takes more
than one chunk; the unpublish goes through `/api/creator/lists/save`):

```
seeded index in 2 chunks; family-photos indexed: true
rebuild chunk 1 -> done = false | build state parked: true
unpublish -> 200 true | record visibility: private
   directory right after unpublishing, indexed: false      <-- correct
   /lists/alice/family-photos.json -> 404                  <-- correct
rebuild finished after 1 more chunks
   indexed again: true                                     <-- WRONG
   /lists/public.json advertises it: true
   search returns it: {"name":"Family Photos","items":1,"creatorName":"alice",…}
```

**Impact.** The list body is protected (404), so this is metadata exposure — title, item
count, creator, likes, and a URL that looks live — in `/lists/public.json`,
`/api/public-lists.json` and `/api/search-published-lists`. It persists until the *next*
daily rebuild. On a large deployment a rebuild spans hours of cron chunks
(`PUBLIC_INDEX_BUILD_OPS_PER_RUN = 300` per 6-minute tick), so the exposure window is
wide and the recovery window is a day.

The rebuild's own comment documents the opposite case (a list published behind the
cursor is missed) and calls it an acceptable tradeoff. The removal case is not
documented and is not equivalent: missing a publish costs visibility, clobbering an
unpublish costs privacy.

**Minimal fix.** Record removals during a build. `updatePublicListIndex(id, null)`
appends `id` to a `removed` array on the build state (or a short-TTL
`index:publiclists:removed` key); the final `writePublicListIndex` filters those ids out.
Cheap, and it also fixes the equivalent clobber for deletes.

**Regression test.** Start a rebuild, stop after one chunk, unpublish a list that was in
that chunk, finish the rebuild, assert the list is absent from `/lists/public.json` and
from search.

---

### A8 — Unpublishing returns `ok:true` while the directory removal — a fire-and-forget `waitUntil` — fails silently

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed, fault-injected) |
| **File** | `26_api-creator-and-admin-routes.js:1771`; `02_http-and-creator-utils.js:1818` |
| **Classification** | **NEW** |

`/api/creator/lists/save` delegates the index update to
`ctx.waitUntil(updatePublicListIndex(...))`, and that function's own `catch` logs and
returns. Phase 23's rule applies exactly: *a background task should not be silently
responsible for an invariant that must hold immediately.* Removing a list from the public
directory when its owner makes it private is such an invariant.

**Reproduction** — `t12_index_privacy.mjs`:

```
unpublish response: 200 { ok: true, … }
record visibility in KV: private
the list page itself: 404
directory AFTER unpublishing:  [{"name":"Family Photos","slug":"family-photos",…}]
search AFTER unpublishing:     [{"name":"Family Photos","creatorName":"alice",…}]
```

**Minimal fix.** For the *removal* direction only, `await` the index update and reflect
its failure in the response (the addition direction can stay in `waitUntil`; a list that
is slow to appear is not a privacy problem). `deleteCreatorLists` already gets this
right — it awaits `removeListsFromPublicIndex`.

---

### A9 — The optimistic-concurrency guard is defeated by a same-millisecond timestamp and silently disabled by a non-number

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:1981`, `:1987` |
| **Classification** | **NEW** — `expectedUpdatedAt` appears in no prior audit |

```js
const expectedUpdatedAt = Number.isFinite(body.expectedUpdatedAt) ? body.expectedUpdatedAt : null;
if (expectedUpdatedAt !== null) { … if (Number(current.updatedAt) > expectedUpdatedAt) { …409… } }
```

Two defects:

**(a) `>` is the wrong comparison for a `Date.now()` version.** In Workers, `Date.now()`
is frozen for the duration of a request and only advances on I/O, so two concurrent saves
genuinely can stamp the same millisecond. With a frozen clock as the deterministic
stand-in (`t14_concurrency.mjs` §3):

```
stale save -> 200 ACCEPTED; stored = C-stale      (B-newer silently destroyed)
```

**(b) The guard fails open on a wrong type.** `Number.isFinite("1788650901055")` is
`false`, so a client that round-trips the value through `localStorage`, a dataset
attribute or a form field sends a string and gets **last-write-wins with no error**
(`t14_concurrency.mjs` §2):

```
expectedUpdatedAt="1788650901055" (string) -> 200 accepted; stored=STALE
expectedUpdatedAt=""              (string) -> 200 accepted; stored=STALE
expectedUpdatedAt=null                     -> 200 accepted; stored=STALE
expectedUpdatedAt=0               (number) -> 409 conflict; stored=NEWER   <- correct
```

Failing open for an *absent* field is the documented, deliberate back-compat choice and
is fine. Failing open for a *present but malformed* one is not — it is silent data loss
that looks like success.

**Minimal fix.** `const raw = body.expectedUpdatedAt; if (raw !== undefined && raw !== null) { const n = Number(raw); if (!Number.isFinite(n)) return 400; … if (Number(current.updatedAt) >= n) → 409 }`. Use `>=`, and treat a
present-but-unparseable value as a client error rather than as absence.

---

### A10 — Three of the four sync blobs have no conflict guard at all; the Watchlist has neither a guard nor a merge

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_…:2360` (`save-presets`), `:2387` (`save-channels`), `:2051` (`save-tracking`, `watchlist` at `:2252`) |
| **Classification** | **NEW** |

Only `/api/creator/sync/save` carries `expectedUpdatedAt` — grep confirms a single client
call site (`22_client-creator-profile.js:1575`). The three siblings are wholesale
last-write-wins:

```
/api/creator/sync/save-presets:  before=["keep"] after a stale autosave=["other"]
/api/creator/sync/save-channels: before=["keep"] after a stale autosave=["other"]
```

Presets and Channels are the blobs the code itself calls "the one piece of synced state
that can genuinely grow large" — a TV Channel's `url` is its entire episode list. Losing
one is losing real work.

`save-tracking` is the sharpest case. It has careful protection for every array *except*
`watchlist`: `watchHistory` gets a scrobble rescue-merge, `continueWatching` gets a
server-precedence merge, `fullyWatchedShowIds` gets a union, `airingNext` and
`curatedRecommendations` each get an "an empty incoming list never replaces a non-empty
stored one" guard. `watchlist` gets `Array.isArray(body.watchlist) ? body.watchlist : []`
and overwrites both the tracking blob **and** `creatorlist:{u}:watchlist` (KV and D1):

```
watchlist after a stale device pushes an empty one: []
the Watchlist custom list:                          []
```

The tell that this is an oversight rather than a decision: the endpoint already accepts
and stores a `watchlistUpdatedAt` from the client (`26_…:2060`) and never compares it to
anything.

**Minimal fix.** Give `watchlist` the same empty-guard the other derived arrays have
(skip the overwrite when the incoming array is empty and the stored one is not, unless
`intentionalRemoval`), and actually use `watchlistUpdatedAt` as the version check it was
evidently added to be. Extend `expectedUpdatedAt` to `save-presets` and `save-channels`.

---

### A11 — `/api/creator/lists/save` has no size bound of any kind, unlike its anonymous sibling

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:1642`; contrast `00_constants.js:30-40` and `25_…:5633` |
| **Classification** | **NEW** |

`00_constants.js` reasons carefully about bounds for the two *unauthenticated* write
endpoints and enforces them (`t15_fuzz.mjs` confirms `/api/publish-list` correctly
rejects 10,001 items, a 2 MB payload and a 201-character name). The *authenticated*
creator save has no item cap, no byte cap and no name cap:

```
name 5000 chars      200 accepted   (stored name length 5000)
huge items (20000)   200 accepted   (stored 4,609,029 bytes)
```

`t24_scale.mjs`, one account, eight saves:

```
total KV bytes parked by one account: 21.8 MB across 8 lists
D1 items_json bytes:                  21.8 MB
GET the dashboard: 200, response 21.8 MB, 410 ms
```

Account creation is public. `/api/creator/lists` returns **every list's full items array**
and the dashboard calls it on every render, so this is also a self-inflicted foot-gun for
a genuine power user, not only an abuse vector.

There is a correctness consequence too: **D1's maximum string/row size is 2,000,000
bytes**. A 2.73 MB `items_json` cannot be written, the failure is swallowed at
`26_…:1753`, and the list is then permanently missing from D1 — which is exactly A2's
precondition.

**Minimal fix.** Apply `PUBLISHED_LIST_ITEMS_MAX`, `PUBLISHED_LIST_NAME_MAX` and a
serialized-byte ceiling to `/api/creator/lists/save` and to the `watchlist` path in
`save-tracking`, rejecting rather than truncating — the same reasoning `00_constants.js`
already spells out. Keep the D1 ceiling below 2 MB so the mirror never silently stops.

---

### A12 — `json()` defaults to a cacheable `max-age=3600`; admin 401s are cached for an hour and credential-bearing responses inherit it

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (headers captured) |
| **File** | `02_http-and-creator-utils.js:119-131` |
| **Classification** | **NEW** |

Every JSON response defaults to `Cache-Control: max-age=3600` with **no `Vary`** header.
`t10_headers.mjs` and `t11_authz_vis.mjs` capture the table (full version in §6):

```
GET /admin/api/analytics      -> 401 {"ok":false,"error":"Not authorized."}  CC=max-age=3600
GET /admin/api/feedback       -> 401 …                                       CC=max-age=3600
GET /admin/api/leaderboard    -> 401 …                                       CC=max-age=3600
POST /api/creator/create      -> 200 {…,"creatorKey":"MYL-…"}                CC=max-age=3600
POST /api/creator/reset-key   -> 200 {…,"creatorKey":"MYL-…"}                CC=max-age=3600
POST /api/creator/scrobble-token -> 200                                      CC=no-store   <- correct
GET /admin/api/analytics (authed) -> 200                                     CC=no-store   <- correct
```

Two distinct problems:

**(a) Cached 401s break the admin dashboard.** Any cross-origin page can issue
`<img src="https://…/admin/api/analytics">`; the browser caches the 401 for an hour, and
because there is no `Vary: Cookie` the *same URL after logging in* is served from cache.
The admin panel then shows "Not authorized" on a valid session until the cache expires.
Low-impact, but it is a remotely-triggerable denial of the admin UI.

**(b) The two endpoints that hand out a Creator Key in plaintext — the only moments that
key ever exists outside its owner — are marked publicly cacheable for an hour.** They are
POSTs, so in practice browser caches will not store them; the protection is the method,
not the header. `/api/creator/scrobble-token` was deliberately given `no-store` for
exactly this reason, which shows the intent exists and simply was not applied to the more
sensitive pair. The provider-list GETs (`/api/trakt-my-lists?token=…`,
`/api/mdblist-my-lists?apikey=…`, `/api/simkl/my-lists?token=…`,
`/api/tmdb-my-lists?session_id=…`) return a user's private lists under a URL that
contains their access token, also at `max-age=3600`.

**Minimal fix.** Change `json()`'s default to `no-store` and set an explicit
`Cache-Control` on the handful of routes that genuinely want caching (they already do:
`/lists/public.json` sets `public, max-age=120`, `/lists/:u/:s.json` sets
`public, max-age=300`, `/api/details` sets `max-age=60`). If a blanket change is too
broad, at minimum: `no-store` on every non-2xx, on `/api/creator/create`,
`/api/creator/reset-key`, `/admin/api/reset-creator-key`, and on the four
provider-list GETs.

---

### A13 — No global exception boundary: an uncaught throw escapes as a Cloudflare error page with no CORS and no security headers

| | |
|---|---|
| **Severity** | **MEDIUM** |
| **Confidence** | **CONFIRMED** (executed) |
| **File** | `26_api-creator-and-admin-routes.js:4494-4498`; `07_source-fetchers-tmdb-simkl.js:1161`, `:1490` |
| **Classification** | **NEW** (a prior audit noted one instance, `bulk-resolve`'s `request.json()`; the general boundary is not covered) |

```js
export default {
  async fetch(request, env, ctx) {
    const response = await handleFetch(request, env, ctx);   // no try/catch anywhere
    return withSecurityHeaders(response);
  },
```

`handleFetch` has no top-level `try`. Two demonstrated escapes:

```
t21 §D  lists/save with a KV put failure: the exception escaped worker.fetch entirely
        -> Cloudflare answers with its own 1101 page: no JSON, no CORS, no security headers
t23     GET /api/details with TMDB returning a 200 and a truncated body -> THREW
        (unguarded `await findRes.json()` at 07_…:1161 and :1490, inside `if (findRes.ok)`)
```

The KV case is not hypothetical: KV allows roughly one write per second per key, and
`/api/creator/lists/save` — unlike its sibling `/api/creator/sync/save`, which wraps its
put and returns a clean 500 — does not handle a throwing `put`.

**Minimal fix.** Wrap `handleFetch` in the `export default` at `26_…:4496`:
`try { … } catch (err) { return json({ ok:false, error: safeErrorMessage(err) }, 500); }`.
`safeErrorMessage` already exists and already redacts. Separately, wrap the two
`findRes.json()` calls.

---

### A14 — `/admin/api/migrate-d1` cannot repair a stale account row, and its result counters count attempts rather than migrations

| | |
|---|---|
| **Severity** | **LOW-MEDIUM** |
| **Confidence** | **CONFIRMED** |
| **File** | `26_api-creator-and-admin-routes.js:3519`, `:3512-3524` |
| **Classification** | **NEW** |

* `ON CONFLICT(username) DO NOTHING` means an existing D1 `creators` row is never
  refreshed from KV. `display_name`, `recovery_answer_hash` and `key_hash` can drift
  permanently — which is the second half of **A5** and the reason that finding is
  unrecoverable. The lists branch three statements later gets this right
  (`DO UPDATE SET likes=excluded.likes, visibility=excluded.visibility`).
* `results.creators++` fires on every key processed, including no-op conflicts, so
  `{"creators": 60}` does not mean 60 rows were written.
* Keys that fail a shape check are skipped with a bare `return` — no counter, no
  `noteError`. `if (!raw) return;`, `if (!u || !slug) return;`,
  `if (!Number.isFinite(n)) return;`. The endpoint answers `{ok:true, done:true}` with an
  empty `errors` array whether or not records were silently dropped.

**Answering Phase 8's specific question — does it roll data backward?** No. The lists
branch only ever writes `likes` and `visibility`, both derived from KV, which is
authoritative for both; `name`/`type`/`items_json` are left alone on conflict. Re-running
it is safe: `phase6`/`t09` confirm repeated runs converge and change nothing.

---

### A15 — `schema.sql` and the migration chain produce different schemas

| | |
|---|---|
| **Severity** | **LOW** |
| **Confidence** | **CONFIRMED** (both schemas built in real SQLite and diffed) |
| **File** | `schema.sql`, `migrations/0001_add_likes_to_creator_lists.sql` |
| **Classification** | **PARTIAL FIX** — see §2 |

`phase6_schema.mjs`:

```
INDEXES differ for creator_lists:
  fresh schema.sql : idx_creator_lists_username, idx_creator_lists_visibility, (pk)
  old + 0001 + 0002: idx_creator_lists_likes, idx_creator_lists_username, idx_creator_lists_visibility, (pk)
```

A deployment provisioned the documented way (run `schema.sql`) has no
`idx_creator_lists_likes`; one that grew through the migrations does. Also:
`fresh schema.sql + 0001` → `duplicate column name: likes`, so an operator following
both sets of instructions hits an error, and `0001` is not idempotent (documented, but
worth stating in the drift report).

Column *order* also differs (`likes` at position 7 vs 9), which is harmless here because
every statement names its columns — worth keeping true.

See §16 F2: the index is never actually used by any query, so the drift costs nothing
today. It should still be fixed, because the next query that *would* use it will behave
differently on the two schemas.

**Minimal fix.** Add `CREATE INDEX IF NOT EXISTS idx_creator_lists_likes ON creator_lists(likes);`
to `schema.sql`, and add `IF NOT EXISTS`-style guarding guidance to `0001`'s header (SQLite
has no `ADD COLUMN IF NOT EXISTS`, so the honest fix is the note that already exists plus
the index in both files).

---

### A16 — Binding D1 makes it the only store for every counter, so unbinding it silently reverts the dashboard

| **Severity** LOW · **Confidence** CONFIRMED (code) · **File** `03_admin.js:66-84` (`bumpStat`) · **Classification** NEW |
|---|

`bumpStat` writes to D1 **and returns** when `env.DB` is bound; the KV branch is an
`else`. `readStatCount` falls back to KV only when D1 has *no row*. So every page view,
install, playback ping and per-provider API call recorded while D1 is bound exists
nowhere else. `wrangler.toml` says "the app is fully functional with this block commented
out" and `00_constants.js` describes D1 as something that "can be added, removed, or
rebuilt at any time without data loss". For counters that is not true: removing the
binding rolls every number back to its pre-migration KV value, and rebuilding D1 from
`schema.sql` (which `DROP`s everything) loses them outright. This is a deliberate design
choice for atomicity — the finding is that the documentation promises something the code
does not do.

---

### A17 — The Continue Watching cron advances its cursor before doing the work

| **Severity** LOW · **Confidence** CONFIRMED (code) · **File** `07_source-fetchers-tmdb-simkl.js:1694-1697` · **Classification** NEW |
|---|

```js
const listResult = await env.CONFIGS.list(listOpts);
await env.CONFIGS.put('cron:continuewatching:cursor', listResult.list_complete ? '' : (listResult.cursor || ''));
for (const key of listResult.keys) { … }        // work happens after the cursor moved
```

A tick that throws or hits the CPU/time limit partway through has already committed the
cursor, so that batch of up to 25 accounts is skipped entirely until the cursor wraps.
Self-healing over a full cycle, invisible in the meantime. Move the cursor write to after
the loop, or make it conditional on completing the batch.

---

### A18 — The "daily" shuffle rolls over at UTC midnight while every stat bucket rolls at Eastern midnight

| **Severity** LOW · **Confidence** CONFIRMED (executed) · **File** `02_…:219` vs `03_admin.js:17-28` · **Classification** NEW |
|---|

`t18_clock.mjs` confirms `easternDateKey` is correct across both DST transitions and the
year boundary — no bug there. But `getDailySeed` uses `Math.floor(Date.now() / 86400000)`,
a UTC day:

```
02:00 UTC Jun 2 = 22:00 ET Jun 1
  statsToday() (Eastern) : 2026-06-01
  getDailySeed()  (UTC)  : (a new day's seed)
```

So the deterministic daily shuffle changes at 7 or 8 p.m. Eastern — mid-evening, during
peak use — rather than overnight. Cosmetic, but it is the kind of "why did my rows
reshuffle while I was watching" report that is very hard to diagnose later.

---

### A19 — `/api/creator/lists/reorder` accepts an unbounded, unvalidated slug array

| **Severity** LOW · **Confidence** CONFIRMED (executed) · **File** `26_…:1830` · **Classification** NEW |
|---|

```
10000 entries          200 stored 10000 entries, 108901 bytes
foreign + 300 chars    200 stored 2 entries, 329 bytes
```

The regex filter `/^[a-zA-Z0-9_.:-]+$/` permits `:` (which is the KV key separator) and
imposes no length or count limit, and no check that the slugs belong to the account. The
blast radius is confined to the caller's own order key, so this is hygiene rather than a
vulnerability — but it is an unbounded authenticated KV write.

---

### A20 — With D1's foreign keys enforced, list writes for a not-yet-migrated account fail silently

| **Severity** LOW-MEDIUM · **Confidence** CONFIRMED (executed against real SQLite with `PRAGMA foreign_keys = ON`) · **File** `schema.sql` FK + `26_…:1746` · **Classification** NEW |
|---|

Cloudflare's documentation states D1 "enforces that foreign key constraints are valid
within all queries and migrations… identical to `PRAGMA foreign_keys = on`". The
`creator_lists.username → creators.username` FK therefore rejects a list insert for an
account whose `creators` row has not been migrated — which is precisely the state
`getCreator`/`getCreatorList` are explicitly written to tolerate. `t02_likes_reset.mjs`
shows it:

```
D1 write error (creatorlist put): Error: FOREIGN KEY constraint failed
save #1: 200 {"ok":true,…}
```

Swallowed, so nothing surfaces. The account works (KV is authoritative), but its lists
never reach D1 until `/admin/api/migrate-d1` runs, and until then the admin Community
Lists panel cannot see them. `ON DELETE CASCADE` was also verified live: deleting a
`creators` row does cascade its `creator_lists` rows, so the explicit
`DELETE FROM creator_lists` in `purgeCreatorData` is belt-and-braces — which is fine,
except that it is the belt that carries **A1**.

---

## 2. Partial fixes

Prior work addressed part of a defect class and stopped short. All four are still live.

| ID | Prior fix | What it covered | What it did not |
|---|---|---|---|
| **P1** (= A5) | `docs/history/AUDIT-STATUS.md` #5, "D1 zero-row split-brain": rotation now checks `meta.changes` and always writes KV | A D1 `UPDATE` that matches **zero rows** | A D1 `UPDATE` that **throws**. The `catch` around it still swallows, still returns `ok:true`, and still leaves D1 holding a credential that `getCreator` prefers. The verification recorded was "Live with D1 bound: new key works, old key 401" — which only exercises the healthy path. |
| **P2** (= A2) | `AUDIT-STATUS.md` #12: migrate-d1 now inserts `likes` and repairs on re-run | The **migration**'s insert | `/api/creator/lists/save`'s insert (`26_…:1749`) and `save-tracking`'s watchlist insert (`26_…:2317`), neither of which binds `likes`. The recorded verification — "editing a list keeps likes at 2" (`AUDIT-STATUS.md` item D) — tested the `ON CONFLICT` branch, where `likes` is correctly untouched. The `INSERT` branch was never tested. |
| **P3** (= A15) | `AUDIT-STATUS.md` item D: "Added the column to `schema.sql` **and** a non-destructive `migrations/0001`… Added an index for popularity sort." | The `likes` **column** in both files | The **index**, which exists only in `0001`. A fresh `schema.sql` deployment does not get it. |
| **P4** (= A9, A10) | The `expectedUpdatedAt` conflict guard on `/api/creator/sync/save` | One of the four synced blobs, on the happy path | `save-presets`, `save-channels` and `save-tracking` have no guard at all; and on the guarded one, `>` admits a same-millisecond stale write and a non-number `expectedUpdatedAt` disables the guard silently. |

---

## 3. Regressions

**None found.** Every fix recorded in `docs/history/AUDIT-STATUS.md`,
`docs/history/AUDIT-2026-09-05-STATUS.md` and `AUDIT-2026-09-05-INDEPENDENT.md` that I
re-tested still holds on the current head:

* per-account reset-key throttle and the 8-character recovery-answer floor — present and enforced;
* fail-closed visibility on writes (`t15_fuzz.mjs`: `"PUBLIC"`, `1`, `true` all store as `private`);
* `pickFreeSlug` returning `""` and both call sites treating it as failure;
* `applyLikeVote`'s ledger-derived count and idempotent voting;
* chunked, resumable public-index rebuild and chunked `migrate-d1`;
* `purgeCreatorData` covering `listlikevoters:`, `creatortrack:`, `scrobbleseenusers:`
  and the scrobble token — `t13_deletion.mjs` finds **zero** account-owned keys left after
  a healthy delete;
* `applyEnvApiKeys(env)` called from both `fetch` and `scheduled`;
* build reproducibility, `FUNCTION-MAP.md` currency, all 186 tests green.

---

## 4. KV ↔ D1 consistency report

### Data authority matrix (proved from code, not from comments)

| Data family | KV key | D1 table | Authoritative | Mirrored? | Reader preference | Writer order | Behaviour when the D1 write fails |
|---|---|---|---|---|---|---|---|
| Creator identity | `creator:{u}` | `creators` | **KV** (unconditional put) | yes | **D1 first**, KV fallback | KV → D1 (create); D1 → KV (rotate) | `ok:true`; D1 keeps the old hash and answers reads → **A5** |
| Creator lists | `creatorlist:{u}:{slug}` | `creator_lists` | **KV** | yes | **D1 first**, KV fallback | D1 → KV | `ok:true`; dashboard diverges → **A6**; `likes` lost → **A2** |
| List likes (truth) | `listlikevoters:{u}:{slug}` | — | **KV ledger** | no | ledger only | ledger → record → D1 | count re-derived on next vote |
| List likes (denormalised) | inside `creatorlist:…` | `creator_lists.likes` | **KV** | yes | **D1 first** | KV → D1 | count reads 0 and is written back into KV → **A2** |
| Anonymous published lists | `publishedlist:user:{slug}` | — | KV | no | KV | KV | n/a |
| List display order | `creatorlistorder:{u}` | — | KV | no | KV | KV | n/a; self-healing orphan sweep at `26_…:1492` |
| Public directory index | `index:publiclists` | — | derived cache | no | KV | `waitUntil` | stale until the daily rebuild → **A7**, **A8** |
| Index build state | `index:publiclists:build` | — | KV | no | KV | KV | restart from empty |
| Sync: config | `creatorsync:{u}` | — | KV | no | KV | KV | 500 returned (handled) |
| Sync: tracking | `creatorsynctracking:{u}` | — | KV | no | KV | KV | 500 returned (handled) |
| Sync: presets | `creatorsyncpresets:{u}` | — | KV | no | KV | KV | 500 returned (handled) |
| Sync: channels | `creatorsyncchannels:{u}` | — | KV | no | KV | KV | 500 returned (handled) |
| Watchlist (as a list) | `creatorlist:{u}:watchlist` | `creator_lists` | **KV** | yes | D1 first | D1 → KV | as creator lists, plus **A10** |
| Share opt-in | `creatorshare:{u}` | — | KV | no | KV | KV | n/a |
| Scrobble token | `scrobbletoken:{t}` + `creatorscrobbletoken:{u}` | — | KV | no | KV | KV | n/a |
| Counters | `stats:{kind}:{bucket}` | `stats` | **D1 when bound**, else KV | one-way (KV→D1) | D1, KV only when D1 has no row | D1 **only** | counter silently not recorded → **A16** |
| Source groups | `stats:sourcegroup:{g}:total` | `source_groups` | **D1 when bound** | one-way | D1, KV fallback | D1 only | as above |
| Auth failure budget | `authfail:{scope}:{day}` | `stats` | **D1 when bound** | no | D1, KV fallback | D1 only | throttle silently loosens |
| Last active | `creatorlastseen:{u}` | `creators.last_active` | KV | yes | KV for the value; D1 for the admin list | KV → D1 | admin list ordering only |
| Feedback threads | `feedback:{id}` | — | KV | no | KV | KV | n/a |
| Rate limits | `ratelimit:*`, `resetkeyrate:*` | — | KV | no | KV | KV | fails open (documented) |
| Provider caches | `cache:*`, `tmdbdetail:*` | — | KV | no | KV | KV | n/a |

**The structural finding.** Read the "Authoritative" and "Reader preference" columns
together. For the three families where D1 is a mirror rather than the store — identity,
lists, likes — **KV is authoritative and D1 is preferred on read.** Every finding from A2
to A6 is a direct consequence.

### Failure matrix (Phase 4 states)

Executed per operation; `t20_faultinject.mjs` drives A–C and F–H randomly.

| State | Creator create | Auth | Key rotation | List save | List delete | Like | Account delete |
|---|---|---|---|---|---|---|---|
| **A** both work | ok | ok | ok | ok | ok | ok | ok |
| **B** KV ok, D1 throws | ok; D1 lacks the row (harmless) | ok (KV fallback) | **A5 — `ok:true`, nothing rotated** | **A6 — `ok:true`, dashboard diverges** | ok (KV delete is unconditional) | **A2 — `ok:true`, count diverges then is lost** | **A3 — `ok:true`, account still authenticates** |
| **C** D1 ok, KV throws | uncaught → **A13** | ok | uncaught → A13 | uncaught → **A13**, D1 now newer than KV | ok (logged) | ok (ledger holds) | **A4 — `ok:true`, data survives, username freed** |
| **D** KV has it, D1 does not | ok — designed fallback | ok | ok (`meta.changes` warns) | **A2** (INSERT resets `likes`) | ok | D1 update matches 0 rows, ignored | ok |
| **E** D1 has it, KV does not | "username already taken" | **authenticates a deleted account (A3)** | rotates D1 only | list readable via D1, invisible to public paths | ok | list not found (like reads KV) | ok |
| **F** both present, values differ | — | D1 wins | D1 wins | D1 wins on read, KV on public paths → **A6** | both cleared | D1 wins → **A2** | both cleared |
| **G** KV older, D1 newer | — | **D1's older credential wins → A5** | — | dashboard shows D1 | — | — | — |
| **H** D1 older, KV newer | — | **D1 wins — the stale one → A5** | — | **A6** | — | **A2** | — |

Rows **B/E/G/H** are the same defect wearing four hats: a preferred read over an optional write.

### Differential: KV-only vs KV+D1

`t07_differential.mjs` runs an identical 18-operation sequence in both modes and
normalises the values that legitimately vary:

```
0 behavioural difference(s) between KV-only and KV+D1 across 18 operations.
```

On the healthy path the two modes are observationally identical, which is the right
answer. Every divergence found in this audit requires a *failed* or *absent* D1 write.

---

## 5. Schema / migration report

Built with real SQLite from the committed files (`phase6_schema.mjs`).

**Fresh `schema.sql`** — `creators` (username PK, display_name, key_hash,
recovery_answer_hash, created_at, last_active), `creator_lists` (id PK, username FK→creators
ON DELETE CASCADE, name, type, visibility DEFAULT 'private', items_json DEFAULT '[]',
likes DEFAULT 0, created_at, updated_at), `source_groups`, `stats` (PK kind,day). Indexes:
`idx_creator_lists_username`, `idx_creator_lists_visibility`.

**Old + `0001` + `0002`** — identical except `likes` sits at column position 9 rather
than 7, and `idx_creator_lists_likes` **exists**.

| Test | Result |
|---|---|
| Fresh DB from `schema.sql` | ✅ |
| Old DB + `0001` | ✅ |
| Old DB + `0001` → `0002` | ✅ |
| `0001` run twice | ❌ `duplicate column name: likes` (documented as expected) |
| `0002` run twice | ✅ idempotent |
| `schema.sql` then `0001` | ❌ `duplicate column name: likes` — an operator following both docs hits this |
| `schema.sql` then `0002` | ✅ |
| Migration interrupted / rerun after interruption | n/a — both files are single-statement-per-concern and neither carries state |
| Column already exists | `0001` errors (harmless), `0002` no-ops |
| Existing production records | `ADD COLUMN … NOT NULL DEFAULT 0` backfills 0; `/admin/api/migrate-d1` then repairs from KV |
| Effective schema == `schema.sql` | ❌ **A15** — `idx_creator_lists_likes` missing from `schema.sql` |

**Constraints.** `visibility` and `type` are free-text `TEXT NOT NULL` with no `CHECK`,
so nothing in the database prevents `visibility = 'garbage'`. The Worker normalises on
every write (`normalizeListVisibility` fails closed) and reads fail closed too, so this is
defence-in-depth rather than a live defect — but a `CHECK (visibility IN ('public','private'))`
would make the privacy invariant enforceable by the store instead of only by convention.

**Referential integrity — proved, not assumed.** With `PRAGMA foreign_keys = ON` (D1's
documented default): inserting a `creator_lists` row for an absent creator **fails**
(A20); deleting a `creators` row **does** cascade its lists. So the D1 half of an account
delete is doubly covered — and the redundant explicit delete is the one carrying A1.
Orphans can still exist in KV (A4) because KV has no constraints at all.

---

## 6. Partial-failure report

Every mutation endpoint, with what happens when a storage call fails mid-operation.

| Operation | KV fails | D1 fails | Response | Verdict |
|---|---|---|---|---|
| `/api/creator/create` | uncaught throw → 1101 | account still created in KV | `ok:true` | acceptable (D1); **A13** (KV) |
| `/api/creator/reset-key` | uncaught throw | **nothing rotates** | `ok:true` + a dead key | **A5 — invalid success** |
| `/admin/api/reset-creator-key` | uncaught throw | **nothing rotates** | `ok:true` + a dead key | **A5 — invalid success** |
| `/api/creator/lists/save` | uncaught throw → 1101 | dashboard/D1 diverge; `likes` lost | `ok:true` | **A2, A6, A13 — invalid success** |
| `/api/creator/lists/delete` | logged; KV delete is unconditional | logged | `ok:true` | acceptable |
| `/api/creator/lists/reorder` | uncaught throw | n/a | — | **A13** |
| `/api/creator/account/reset` | sweep skipped, reported as `lists:0` | D1 rows survive | `ok:true` | **invalid success** (same shape as A4) |
| `/api/creator/delete-account` | data survives, identity removed | account still authenticates | `ok:true` | **A3, A4 — invalid success** |
| `/api/creator/sync/save` | 500, clear message | n/a | `ok:false` | **correct — the model to copy** |
| `/api/creator/sync/save-tracking` | 500, clear message | logged | `ok:false` / `ok:true` | correct for KV |
| `/api/creator/sync/save-presets` | 500, clear message | n/a | `ok:false` | correct |
| `/api/creator/sync/save-channels` | 500, clear message | n/a | `ok:false` | correct |
| `/api/lists/like` | ledger retried 3×, then reports storage | count diverges | `ok:true` | **A2 — invalid success** |
| `/api/publish-list` | uncaught throw | n/a | — | **A13** |
| unpublish (visibility → private) | index removal in `waitUntil`, swallowed | n/a | `ok:true` | **A8 — invalid success** |
| `/admin/api/migrate-d1` | chunk state lost, restarts | per-key `noteError` | `ok:true` | counters inaccurate — **A14** |
| `/admin/api/rebuild-public-index` | progress lost, restarts | n/a | `ok` | acceptable, idempotent |
| `checkForNewEpisodes` (cron) | batch skipped, cursor already moved | n/a | — | **A17** |

**Phase 29 census — mutation endpoints that can return success after an internal failure:**
`/api/creator/reset-key`, `/admin/api/reset-creator-key`, `/api/creator/lists/save`,
`/api/creator/delete-account`, `/api/creator/account/reset`, `/api/lists/like`,
`/admin/api/migrate-d1`. Of those, **six are semantically invalid** — the caller is told
an operation happened that did not. Only migrate-d1's is defensible (it is explicitly
resumable), and even that one over-reports.

### Cache-header table (Phase 16)

| Route | Auth | Sensitive | `Cache-Control` | CORS | Risk |
|---|---|---|---|---|---|
| `GET /lists/public.json` | none | no | `public, max-age=120` | `*` | fine |
| `GET /api/public-lists.json` | none | no | `public, max-age=120` | `*` | fine |
| `GET /lists/:u/:s.json` | none | no | `public, max-age=300` | `*` | 5-min window after an unpublish |
| `GET /api/search-published-lists` | none | no | `max-age=3600` | — | 1 h of stale results after a delete/unpublish |
| `GET /manifest.json` | none | no | `max-age=3600` | `*` | fine |
| `GET /app.js`, `/app.css` | none | no | `immutable` when `?v=` matches, else `no-cache` + ETag | — | correct |
| `GET /sw.js` | none | no | `no-cache` | — | correct |
| `GET /api/trakt-my-lists?token=…` | token in URL | **yes** | `max-age=3600` | — | **A12** |
| `GET /api/mdblist-my-lists?apikey=…` | key in URL | **yes** | `max-age=3600` | — | **A12** |
| `GET /api/simkl/my-lists?token=…` | token in URL | **yes** | `max-age=3600` | — | **A12** |
| `GET /api/tmdb-my-lists?session_id=…` | session in URL | **yes** | `max-age=3600` | — | **A12** |
| `GET /admin` | cookie | yes | `no-store` | — | correct |
| `GET /admin/api/*` (200) | cookie | yes | `no-store` | — | correct |
| `GET /admin/api/*` (401) | — | no | **`max-age=3600`, no `Vary`** | — | **A12(a)** |
| `POST /api/creator/create` | none | **yes — returns the key** | `max-age=3600` | — | **A12(b)** |
| `POST /api/creator/reset-key` | recovery answer | **yes — returns the key** | `max-age=3600` | — | **A12(b)** |
| `POST /api/creator/scrobble-token` | key | yes | `no-store` | — | correct |
| `POST /api/creator/lists`, `sync/load`, `sync/meta` | key | yes | `max-age=3600` | — | POST, so not cached in practice |

CORS is correctly restricted: `isPublicCorsPath` allows `*` only on catalog/manifest/
public-list/asset paths. **No creator or admin endpoint advertises CORS** — verified
across the whole table.

---

## 7. Authorization matrix

`t11_authz_vis.mjs`, each cell a fresh isolated environment.

| Route (POST) | Anonymous | A → A's own | B → A's resource | B → B's own |
|---|---|---|---|---|
| `/api/creator/lists/save` | 401 | 200 | **401** | 200 |
| `/api/creator/lists/delete` | 401 | 200 | **401** | 200 |
| `/api/creator/lists/reorder` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/save` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/save-tracking` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/save-presets` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/save-channels` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/share-tracking` | 401 | 200 | **401** | 200 |
| `/api/creator/account/reset` | 401 | 200 | **401** | 200 |
| `/api/creator/delete-account` | 401 | 200 | **401** | 200 |
| `/api/creator/scrobble-token` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/load` | 401 | 200 | **401** | 200 |
| `/api/creator/lists` | 401 | 200 | **401** | 200 |
| `/api/creator/sync/meta` | 401 | 200 | **401** | 200 |
| `/api/creator/track-status` | 401 | 200 | **401** | 200 |
| `/api/creator/scrobble-seen-users` | 401 | 200 | **401** | 200 |

All 17 `/admin/*` endpoints return 401 (or the login page for `GET /admin`) with no
cookie. **No IDOR found.** The one cross-account effect in this report — A1 — does not go
through authorization at all; it is a `LIKE` pattern in a statement the attacker is
legitimately authorised to run against their own account.

---

## 8. State-machine failures

### Creator: NONEXISTENT → CREATED → ACTIVE → ROTATED → RESET → DELETED → RECLAIMED

| Transition | Result |
|---|---|
| CREATE, CREATE again | ✅ second is "already taken" |
| ROTATE (healthy) | ✅ old key 401s immediately, warm-isolate memo invalidated |
| ROTATE (D1 throws) | ❌ **A5** — old key lives, new key dead, unrepairable |
| RESET (account/reset) | ✅ data cleared, identity and key preserved |
| RESET (KV `list()` throws) | ❌ reports `lists:0` and `ok:true`, data survives |
| DELETE | ✅ zero owned keys remain (`t13_deletion.mjs`) |
| DELETE twice | ✅ second 401s |
| DELETE (D1 throws) | ❌ **A3** — still authenticates |
| DELETE (KV `list()` throws) | ❌ **A4** — data survives, username freed |
| RESET a deleted account | ✅ 401 |
| ROTATE during reset | ✅ both operate on the same KV record; no interleaving hazard found |
| RECLAIM after a clean delete | ✅ inherits nothing — dashboard empty, sync empty, shared watchlist 404, ledger gone |
| RECLAIM after a failed purge | ❌ **A4** — inherits public *and private* lists with full contents |
| Old key after username reuse | ✅ 401 (new hash) |

### List: NONEXISTENT → PRIVATE → PUBLIC → EDITED → RENAMED → PRIVATE → DELETED

After every transition I inspected KV, D1, the public index, the order key, the like
ledger and `/lists/:u/:s`.

| Transition | KV | D1 | Index | Order | Ledger | Public URL |
|---|---|---|---|---|---|---|
| create private | ✅ | ✅ | absent ✅ | ✅ | — | 404 ✅ |
| → public | ✅ | ✅ | added ✅ | ✅ | — | 200 ✅ |
| edit items | ✅ | ✅ | count updated ✅ | ✅ | — | ✅ |
| rename | ✅ | ✅ | ✅ | ✅ | — | URL unchanged ✅ |
| likes accrue | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| → private | ✅ | ✅ | removed ✅ | ✅ | kept ✅ | 404 ✅ |
| → private, index write fails | ✅ | ✅ | **stale ❌ A8** | ✅ | ✅ | 404 ✅ |
| → private during a rebuild | ✅ | ✅ | **re-added ❌ A7** | ✅ | ✅ | 404 ✅ |
| edit with the D1 row absent | ✅ | **likes→0 ❌ A2** | likes→0 ❌ | ✅ | intact | ✅ |
| delete | ✅ | ✅ | ✅ | ✅ | ✅ removed | 404 ✅ |
| delete then recreate the slug | ✅ | ✅ | ✅ | ✅ | fresh ✅ | ✅ |

### Likes (Phase 34)

`t19_stateful.mjs` drives like/unlike/repeat/interleaved-with-edit across 10 seeds with a
model check after every operation; `t20` adds D1 faults.

| Case | Result |
|---|---|
| anonymous like / repeated like | ✅ idempotent, count stays 1 |
| authenticated like | ✅ voter is `u:{username}`, one vote |
| unlike, repeated unlike | ✅ |
| like while the owner edits the list | ✅ the re-read-then-copy-only-`likes` fix holds |
| like a list that has become private | ✅ vote recorded; the list is not re-indexed |
| like a deleted list | ✅ 404, no ledger created |
| like a nonexistent user/slug | ✅ 404, no permanent key minted |
| username reclaimed / slug reused | ✅ ledger deleted with the account |
| after migrate-d1 | ✅ counts preserved |
| **D1 unavailable** | ❌ **A2** |
| KV unavailable | ✅ ledger retry then honest count |

### Sync

Guarded: `/sync/save` only, and imperfectly (**A9**). Unguarded: presets, channels,
tracking (**A10**). The cron's write to `creatorsynctracking` is correctly scoped — it
re-reads and writes only the two fields it computes, which is the right pattern and
should be the template for the client-facing endpoints too.

---

## 9. Test-suite blind spots

The suite is green: **186 pass / 0 fail / 1 skipped** (network-gated), and full
`verify.sh` passes including a byte-exact rebuild. Green is not the same as covering the
behaviour, so I mutation-tested it: twelve controlled, semantically real bugs, each
built and run through `node --test tests/*.test.mjs` (`mutate.sh`).

**7 of 12 survived.**

| # | Mutation | Result |
|---|---|---|
| m1 | `authenticateCreator` accepts a wrong key | killed (9 fail) |
| m2 | `isPublicListVisibility` inverted | killed (16 fail) |
| m3 | skip the KV write in `lists/save` | killed (13 fail) |
| m5 | remove the 409 conflict check | killed (1 fail) |
| m12 | `removeListsFromPublicIndex` becomes a no-op | killed (2 fail) |
| **m4** | **skip the D1 write in `lists/save` entirely** | **SURVIVED** |
| **m6** | **`listAllKeys` stops following the cursor after page 1** | **SURVIVED** |
| **m7** | **index-rebuild prefix `publishedlist:user:` → `publishedlist:usr:`** | **SURVIVED** |
| **m8** | **`/api/lists/like` writes `0` to D1 instead of the real count** | **SURVIVED** |
| **m9** | **account purge becomes `DELETE FROM creator_lists WHERE id LIKE '%'`** | **SURVIVED** |
| **m10** | **`pickFreeSlug` returns a taken slug when it runs out of attempts** | **SURVIVED** |
| **m11** | **`PUBLISHED_LIST_ITEMS_MAX` off by one** | **SURVIVED** |

The survivors are not random. They cluster in exactly three places, and each cluster
explains a finding above:

1. **Nothing asserts D1 *content*.** m4, m8 and m9 all survive because no test reads a
   row back. `tests/harness.mjs`'s `makeD1()` matches SQL with regexes and hardcodes
   `SELECT * FROM creator_lists WHERE id = ?` → `{results: []}`, so **`getCreatorList`'s
   D1 branch is never executed by any test in the suite**. That single line is why A2 and
   A6 were invisible. The mock also never throws, so no test covers state B of the
   failure matrix, which is where A3 and A5 live. And it cannot enforce a primary key,
   a `NOT NULL`, a `DEFAULT`, or a foreign key, so A20 is unreachable too.
2. **Nothing exercises the second page of anything.** m6 survives. The prior audit
   listed this as testing gap #1 and it is still open.
3. **Nothing tests a boundary or an exhaustion path.** m10 and m11 survive — and m10 is
   the exact bug the code's own comment describes as load-bearing ("publishing a 501st
   list called 'Movies' silently replaced the contents of movies-500").

Two more structural gaps, from reading the suite rather than mutating it:

* **KV's `list()` mock uses an integer offset cursor** over a freshly re-sorted key
  array. Real KV cursors are opaque and key-positioned; a traversal over a keyspace that
  changes mid-scan behaves differently. My harness models the real semantics, which is
  what let `t16_pagination.mjs` and `t17_rebuild_clobber.mjs` be meaningful.
* **KV eventual consistency is not modelled at all.** `applyLikeVote` has ~40 lines of
  comment reasoning about stale reads versus lost updates, and there is no test that can
  distinguish the two.

---

## 10. Performance / scale findings

`EXPLAIN QUERY PLAN` on every D1 statement (`phase31_plans.mjs`), against both schema
variants:

```
public directory : SEARCH creator_lists USING INDEX idx_creator_lists_visibility (visibility=?) | USE TEMP B-TREE FOR ORDER BY
creators list    : SCAN creators | USE TEMP B-TREE FOR ORDER BY
stats totals LIKE: SCAN stats | USE TEMP B-TREE FOR ORDER BY
stats per-kind   : SEARCH stats USING INDEX sqlite_autoindex_stats_1 (kind=?)
creator count    : SCAN creators USING COVERING INDEX sqlite_autoindex_creators_1
delete lists LIKE: SCAN creator_lists
```

Identical with and without `idx_creator_lists_likes` (see §16 F2).

| Query | 100 users | 10k | 100k | 1M |
|---|---|---|---|---|
| Community Lists panel (`03_…:865`) | fine | fine | temp B-tree over all public lists | slow but bounded at 100 rows out |
| `SELECT … FROM creators ORDER BY last_active DESC` (`03_…:1472`) | fine | full scan + sort | full scan + sort | **full scan + sort of 1M rows on every admin load** — wants `CREATE INDEX ON creators(last_active DESC, created_at DESC)` |
| `SELECT COUNT(*) FROM creators` | covering index scan; O(n) at every size | | | acceptable |
| `stats … WHERE day='total' AND kind LIKE ?` | full scan of `stats`; `stats` grows with days × kinds × `list_copy:{slug}` — i.e. **with the number of lists** | | | wants an index on `(day, kind)` |
| `DELETE … WHERE id LIKE 'u:%'` | **full table scan per account delete** | | | `WHERE username = ?` is indexed — the A1 fix is also the performance fix |

Storage and throughput:

* **`items_json` vs D1's 2 MB row limit.** A11 lets a list exceed it, at which point the
  D1 mirror stops working silently and A2 follows.
* **`/api/creator/lists` returns every list's full items.** Measured 21.8 MB for 8 large
  lists (`t24_scale.mjs`). The version-hash 304 helps repeat calls; the first call after
  any change still ships everything.
* **Public index rebuild is now correct at scale** — `t16_pagination.mjs` at
  1/399/400/401/799/800/801/1200 lists: no duplicates, nothing skipped, cursor advances,
  1200 lists in 2 chunks. The prior cliff is genuinely gone.
* **`authfail:` rows in `stats` are never swept** and are keyed by attacked account and
  by source IP. Documented as accepted; at 1M users under sustained attack it is
  unbounded growth in a table two admin queries scan.
* **`index:publiclists` is a single KV value** read on every directory load. At
  `PUBLIC_INDEX_MAX = 20,000` entries that is roughly 4 MB parsed per cold isolate.
  Correct and documented, but it is the next ceiling after the one that was just fixed.

---

## 11. Unconfirmed investigations

Things I could not demonstrate, recorded so they are not re-derived from scratch.

1. **Concurrent index writes losing each other.** `updatePublicListIndex` is a
   read-modify-write on one key and says so. My in-process harness serialises, so three
   concurrent publishes all landed (`t12_index_privacy.mjs`). Real KV would drop some.
   The daily rebuild is the backstop — but A7 shows that backstop can itself clobber a
   removal, so the two mitigations interact badly. Needs a real-KV test.
2. **Overlapping cron ticks.** `advancePublicListIndexBuild` acquires
   `lock:publiclistindex` with a non-atomic get-then-put. Two ticks can both acquire.
   I could not make this corrupt anything — both resume from the same state and converge
   — but it doubles TMDB spend in `checkForNewEpisodes`, whose cursor is unlocked entirely.
3. **`json_array_length(items_json)`** (`03_…:866`) throws `malformed JSON` on a
   non-JSON value, which would fail the whole Community Lists query. I could not find a
   write path that produces one — every writer goes through `JSON.stringify` — so this is
   hardening, not a defect. A `CHECK (json_valid(items_json))` would make it structural.
4. **`/api/lists/like`'s D1 `UPDATE` uses `listScopeId = "{user}:{slug}"`,** which for an
   anonymous list is `"user:{slug}"`. `user` is reserved so no creator can own that
   namespace and the statement matches zero rows. Correct today; it depends on the
   reserved-name list staying correct.
5. **Slugs containing `:`.** `getCreatorList`'s D1 branch derives the slug as
   `row.id.split(':')[1]`, which truncates for a slug with a colon.
   `slugifyServer` cannot produce one, and `lists/save` runs `body.slug` through it — so
   unreachable through the API. `lists/reorder` does allow `:` into the order key (A19),
   which is the one place the two disagree.
6. **`stampListVisibilityIfNeeded` writes during read paths.** It backfills a
   missing/garbage `visibility` to `public` on public read and rebuild paths. That is the
   documented legacy rule and writes now fail closed, so no new record can reach it — but
   it is a read path that writes, on a key KV rate-limits to 1 write/sec.

---

## 12. File-by-file punch list

### `02_http-and-creator-utils.js`

| Finding | Priority | Function / line | Defect | Minimal safe change | Tests |
|---|---|---|---|---|---|
| **A1** | **P0** | `purgeCreatorData` : 2206 | `LIKE` pattern built from a username that may contain `_` | `DELETE FROM creator_lists WHERE username = ?` | cross-account delete; `___` mass delete |
| **A3** | **P0** | `purgeCreatorData` : 2284-2290 | D1 identity delete swallowed; `getCreator` then serves the deleted account | fail the request on a throw | fault-injected delete → old key 401 |
| **A4** | **P0** | `purgeCreatorData` : 2199-2202, 2269 | list-sweep failure is logged and the identity is deleted anyway | flag the failure; gate `deleteIdentity`; return `ok:false` | injected `list()` throw → identity retained |
| **A2/A6** | **P1** | `getCreatorList` : 2331, `getCreator` : 2313 | D1 preferred over the authoritative store on read | merge D1 onto KV, or let KV decide existence | D1-absent-row like-count test |
| **A7** | **P2** | `rebuildPublicListIndex` : 2008 | final write clobbers removals made during the build | track removals in the build state and filter | unpublish mid-rebuild |
| **A8** | **P2** | `updatePublicListIndex` : 1800-1818 | removal failure swallowed inside `waitUntil` | `await` the removal direction; reflect failure | injected index-put failure |
| **A12** | **P2** | `json()` : 119-131 | default `max-age=3600` on every JSON response | default `no-store`; opt in per route | header assertions on 401s and key-returning routes |

### `26_api-creator-and-admin-routes.js`

| Finding | Priority | Function / line | Defect | Minimal safe change | Tests |
|---|---|---|---|---|---|
| **A5** | **P0** | `/api/creator/reset-key` : 1278-1296; `/admin/api/reset-creator-key` : 1354-1372 | D1 throw swallowed; `ok:true` with a dead key | on throw, delete the D1 row (or 500) before the KV write | injected throw → old key 401, new key works |
| **A2** | **P1** | `/api/creator/lists/save` : 1749; `save-tracking` : 2317 | upsert never binds `likes`; INSERT defaults it to 0 | add `likes` to the INSERT column list, not to `DO UPDATE` | D1-absent-row like-count test |
| **A2** | **P1** | `/api/creator/lists/save` : 1732 | prior `likes` read through `getCreatorList` (D1-first) and written into KV | read prior `likes` from KV | as above |
| **A5** | **P1** | `/admin/api/migrate-d1` : 3519 | `DO NOTHING` cannot repair a stale creators row | `DO UPDATE SET display_name, key_hash, recovery_answer_hash` | stale-hash repair test |
| **A9** | **P2** | `/api/creator/sync/save` : 1981, 1987 | guard fails open on a non-number; `>` admits same-ms writes | 400 on a malformed value; use `>=` | frozen-clock and string-typed tests |
| **A10** | **P2** | `save-tracking` : 2252; `save-presets` : 2360; `save-channels` : 2387 | no conflict guard; `watchlist` has no empty-guard either | empty-guard for `watchlist`; honour `watchlistUpdatedAt`; add `expectedUpdatedAt` to presets/channels | stale-device tests |
| **A11** | **P2** | `/api/creator/lists/save` : 1642 | no item, byte or name bound | apply the `00_constants.js` ceilings; keep the D1 payload under 2 MB | boundary tests at cap ±1 |
| **A13** | **P2** | `export default.fetch` : 4496 | no global exception boundary | wrap in try/catch → `json(safeErrorMessage(err), 500)` | injected KV throw → 500 JSON, not 1101 |
| **A14** | **P3** | `/admin/api/migrate-d1` : 3512-3524 | counters count attempts; skipped keys unreported | count only real writes; `noteError` on shape-check skips | migration counter test |
| **A19** | **P3** | `/api/creator/lists/reorder` : 1830 | unbounded, unvalidated order array | cap the length; drop `:` from the allowed set | fuzz test |

### `25_api-catalog-routes.js`

| Finding | Priority | Line | Defect | Change |
|---|---|---|---|---|
| **A2** | P1 | 5770-5776 | like's D1 update failure diverges the count with no repair | after a throw, delete the D1 row so reads fall back to KV |
| **A12** | P2 | 2186, 4222, 5107, 2890 | provider-list GETs carry a token in the URL and `max-age=3600` | `no-store` on all four |

### `07_source-fetchers-tmdb-simkl.js`

| Finding | Priority | Line | Defect | Change |
|---|---|---|---|---|
| **A13** | P2 | 1161, 1490 | `await findRes.json()` unguarded inside `if (findRes.ok)` | wrap in try/catch, treat as "not found" |
| **A17** | P3 | 1694-1697 | cursor written before the batch is processed | move the cursor write after the loop |

### `03_admin.js`

| Finding | Priority | Line | Defect | Change |
|---|---|---|---|---|
| **A16** | P3 | 66-84 | `bumpStat` writes D1 only when bound | dual-write, or document that counters are D1-only once migrated |
| scale | P3 | 1472 | `ORDER BY last_active` over an unindexed column | add `CREATE INDEX ON creators(last_active)` |
| A1-class | P3 | 1133 | `kind LIKE ?` with prefixes containing `_` | `GLOB`, or escape the pattern |

### `schema.sql`, `migrations/`

| Finding | Priority | Defect | Change |
|---|---|---|---|
| **A15** | P2 | `idx_creator_lists_likes` missing from `schema.sql` | add it (with `IF NOT EXISTS`) |
| hardening | P3 | no `CHECK` on `visibility` | `CHECK (visibility IN ('public','private'))` — makes the privacy invariant enforceable by the store |

### `tests/harness.mjs`

| Finding | Priority | Defect | Change |
|---|---|---|---|
| §9 | **P1** | `SELECT * FROM creator_lists WHERE id = ?` hardcoded to `{results: []}` — `getCreatorList`'s D1 branch is never executed | return the stored row |
| §9 | **P1** | D1 mock cannot throw | add a `failWhen(fn)` hook |
| §9 | P2 | D1 mock cannot enforce PK / NOT NULL / DEFAULT / FK | back it with `node:sqlite` and the real `schema.sql` (see `audit/adversarial-2026-09-06/kit.mjs`) |
| §9 | P2 | KV `list()` uses integer-offset cursors | opaque key-positioned cursors |

### `02_http-and-creator-utils.js` / documentation

| Priority | Item |
|---|---|
| P3 | `02_…:2300`'s "D1 is an optional accelerator in front of KV, never a replacement for it" is contradicted by the read preference — fix the code or the comment (§16 F1 explains why fixing the code is right) |
| P3 | `migrations/0001`'s "without this it is a full scan" is false — `EXPLAIN` is identical either way (§16 F2) |
| P3 | `AUDIT-2026-09-05-INDEPENDENT.md`'s "DO NOT TOUCH" entry saying `scheduled()` never populates the API-key globals is now stale — it calls `applyEnvApiKeys(env)` |

---

## 13. New tests to add

One per confirmed defect, each written so it fails on the current head.

1. **A1** — create `abc` and `a_c`, one list each; delete `a_c`'s account; assert `abc`'s
   D1 row still exists with its original `likes`. Second case: username `___`, three
   3-character victims, assert all survive.
2. **A2** — with D1 bound, seed `creatorlist:u:s` in KV with `likes:5`, no D1 row, a
   `creators` row present; POST `lists/save`; assert D1 `likes = 5`. Save again; assert KV
   `likes = 5`, dashboard `5`, directory `5`.
3. **A3** — inject a throw on `DELETE FROM creators`; `delete-account`; assert the
   response is not `ok:true` **and** `/api/creator/restore` with the old key returns 401.
4. **A4** — inject a `list()` throw scoped to `creatorlist:{u}:`; `delete-account`;
   assert `ok:false`, `creator:{u}` present, lists present, username not re-registrable.
   Second assertion: after a *healthy* delete, a reclaiming account's dashboard is empty.
5. **A5** — inject a throw on `UPDATE creators SET key_hash`; call both rotation
   endpoints; assert not `ok:true`, old key 401s, new key works. Then: leave D1 stale, run
   `migrate-d1` to `done`, assert D1's hash equals KV's.
6. **A6** — inject one D1 upsert failure during a visibility change; assert the
   dashboard's `visibility` matches whether `/lists/:u/:s.json` actually serves it.
7. **A7** — seed enough lists for a multi-chunk rebuild; run one chunk; unpublish a list
   from that chunk through the route; finish the rebuild; assert the list is absent from
   `/lists/public.json` and from `/api/search-published-lists`.
8. **A8** — inject a put failure on `index:publiclists`; unpublish; assert the response
   is not `ok:true`, or that the directory no longer lists it.
9. **A9** — (a) frozen `Date.now()`; A saves, B saves with the same `expectedUpdatedAt`;
   assert 409. (b) send `expectedUpdatedAt` as a string; assert 400, and that the stored
   blob is unchanged.
10. **A10** — device A saves presets `{keep}`; device B saves `{other}`; assert 409 (or
    that `keep` survives). Same for channels. For tracking: push a non-empty watchlist,
    then push `watchlist: []` without `intentionalRemoval`; assert the watchlist survives;
    then push `[]` **with** `intentionalRemoval`; assert it clears.
11. **A11** — `lists/save` at `PUBLISHED_LIST_ITEMS_MAX`, `+1`, and with a
    201-character name; assert accept / 413 / 400. Assert a list whose serialized items
    exceed the D1 ceiling is rejected rather than silently un-mirrored.
12. **A12** — assert `no-store` on: any `/admin/api/*` 401, `/api/creator/create`,
    `/api/creator/reset-key`, `/admin/api/reset-creator-key`, and the four provider-list
    GETs.
13. **A13** — inject a KV `put` throw during `lists/save`; assert a JSON 500 with
    security headers, not an escaped exception. Second: TMDB returns a 200 with a
    truncated body; assert `/api/details` returns a handled error.
14. **A14** — pre-seed D1 with a stale `creators` row; run `migrate-d1` to completion;
    assert the row now matches KV. Assert `results.creators` counts only rows written.
15. **A15** — build both schemas in `node:sqlite` and assert their
    `sqlite_master`-derived index sets are equal. This is `phase6_schema.mjs`; promote it
    into `tests/`.
16. **Harness first** — the four `tests/harness.mjs` changes in §12 are a prerequisite:
    tests 2, 3, 5, 6 and 14 cannot be written against the current D1 mock at all.

---

## 14. Top 10 remaining risks

1. **D1 reads are preferred over an authoritative store whose D1 writes are optional.**
   The single sentence behind A2, A3, A5 and A6. Until it is resolved structurally, every
   new D1-touching route reintroduces the class.
2. **Six mutation endpoints return `ok:true` after doing nothing.** Two of them are
   "delete my account" and "rotate my leaked key".
3. **The test suite cannot see D1.** `getCreatorList`'s D1 branch is unreachable from any
   test; the mock cannot throw or enforce a constraint. 7 of 12 mutations survive.
4. **Untrusted input inside SQL patterns.** A1 is one instance; `kind LIKE ?` is the same
   shape awaiting a user-controlled prefix.
5. **The public directory index has two mitigations that fight each other.** Incremental
   removal is best-effort inside `waitUntil` (A8); the daily rebuild that is supposed to
   repair it can re-publish an unpublished list (A7).
6. **Optimistic concurrency covers one of four synced blobs**, and the two it does not
   cover are the ones that hold the most irreplaceable work.
7. **No global exception boundary.** Any new unguarded `await res.json()` or KV write is
   one bad upstream response away from a Cloudflare error page with no CORS.
8. **The authenticated write path is unbounded** while the anonymous one is carefully
   bounded — inverted relative to where the reasoning was applied.
9. **`json()`'s cacheable default** puts the burden on every route to opt out of caching
   rather than opt in, and most do not.
10. **Counters exist only in D1 once it is bound**, contradicting the "D1 is optional and
    removable" promise in `wrangler.toml` and `00_constants.js`.

---

## 15. What I tried to break but could not

Recorded so this ground is not re-covered, and so the report is not read as uniformly
negative. All of these were executed.

* **Cross-creator authorization.** All 16 authenticated mutation routes × 4 roles
  (`t11_authz_vis.mjs`). Creator B against Creator A's resources: 401 every time, generic
  message. No IDOR. All 17 admin endpoints reject an absent cookie.
* **Private-list leakage.** A private list is unreachable via `/lists/:u/:s`,
  `.json`, `?format=object`, `/lists/public.json`, `/api/public-lists.json` and
  `/api/search-published-lists`. Visibility fails closed on write for `"PUBLIC"`, `1`,
  `true`, `"garbage"`, `""`, `null` and a missing field — all stored as `private`
  (`t15_fuzz.mjs`).
* **Account deletion on the healthy path.** An account populated through *every* write
  endpoint — two lists, sync blob, tracking, presets, channels, share opt-in, scrobble
  token, external like, list like, playback diagnostic, feedback — leaves **zero**
  account-owned KV keys and zero D1 rows. The scrobble token stops resolving, the
  directory drops the lists, the key 401s, and a reclaiming owner inherits nothing:
  empty dashboard, empty sync, 404 on the previously shared watchlist (`t13_deletion.mjs`).
* **Key rotation on the healthy path.** Old key 401s immediately, including from a warm
  isolate — `invalidateCreatorAuthMemo` plus the stored hash being part of the memo key.
* **KV-only vs KV+D1 differential.** 18 operations, both modes, normalised: **zero**
  observable differences (`t07_differential.mjs`).
* **Randomized stateful model check.** 10 seeds × 120 operations (create / edit /
  visibility / like / unlike / delete / reorder / rotate), comparing an independent model
  against KV, D1, the dashboard, the public directory and the list page **after every
  single operation**, in both storage modes: **no divergence** (`t19_stateful.mjs`).
* **Pagination correctness.** Index rebuild and directory paging at 1, 399, 400, 401,
  799, 800, 801 and 1200 lists: every item appears exactly once, no duplicates, cursor
  advances, empty and exhausted cursors handled (`t16_pagination.mjs`). The prior audit's
  ~500-list cliff is genuinely fixed.
* **Route contract fuzzing.** No body, `{}`, arrays for objects, strings for arrays,
  numbers for strings, nested arrays, 20,000-element arrays, 5,000-character names,
  path-traversal slugs, colons, newlines, NUL bytes, unicode, 500-character slugs. No
  corrupt persistent state; `slugifyServer` neutralises every key-name attack
  (`../../evil` → `evil`). **No prototype pollution** from a `__proto__` payload.
* **External provider contract mutation.** Malformed JSON, `{}`, an unexpected array,
  null fields, duplicates, 204, 301, 401, 403, 404, 429, 500 and a 5,000-item response,
  across seven routes: **persistent account state unchanged after every mutation**
  (`t23_providers.mjs`). Only `/api/details` throws (A13); nothing corrupts.
* **Clock attacks.** `easternDateKey` is correct through both DST transitions, the
  ambiguous 01:30 hour on fall-back, and the Dec 31 → Jan 1 boundary including the case
  where UTC has rolled over and Eastern has not (`t18_clock.mjs`).
* **Build differential.** `header.js` + the 27 numbered sources regenerate
  `worker_entry_combined.js` **byte for byte** — 2,757,210 bytes, identical, not merely
  CRLF-insensitively equal. `node --check` clean, `FUNCTION-MAP.md` current, the rendered
  builder page validates, all 186 tests pass.
* **Verification scripts.** `build.py`, `check_sync.py`, `gen_map.py`, `verify.sh`,
  `html_checks.py`, `render_check.js` all read correctly and do what they claim. One
  weakness worth noting rather than a bug: `verify.sh`'s drift check uses
  `--ignore-cr-at-eol`, so a pure line-ending change would pass — the byte comparison
  above shows there is none today.
* **Like-system state machine.** 12 adversarial cases (§8), all correct on the healthy
  path, including the "like landing while the owner saves" race the re-read-and-copy-only-
  `likes` fix was written for.
* **Migration replay.** `migrate-d1` run to completion repeatedly: valid data unchanged,
  no counters doubled, nothing rolled backward. The `stats` section's `DO NOTHING` and the
  lists section's KV-derived `DO UPDATE` are both genuinely idempotent.
* **Admin bulk-delete cap.** 60 slugs against a cap of 50 → `413`, correct boundary.

---

## 16. False positives in prior audits

Stated only where I can demonstrate it.

**F1 — `AUDIT-2026-09-05-INDEPENDENT.md`, "Verified Healthy":**

> *"Failed write reported as success." Searched every empty `catch` within 8 lines of a
> KV/D1 write followed by `ok: true`. One hit (`26_…:1147`), and it is a display-only
> counter.*

This all-clear is wrong, and the reason it is wrong is the method. A textual 8-line
window around an *empty* `catch` cannot see the six cases in §6, because none of them is
an empty catch and in most the `ok:true` is dozens of lines away:

| Endpoint | The catch | Distance to its `ok:true` |
|---|---|---|
| `/api/creator/reset-key` | `console.error` at `26_…:1290` | `ok:true` at `:1303` — **13 lines** |
| `/admin/api/reset-creator-key` | `console.error` at `26_…:1366` | `ok:true` at `:1379` — **13 lines** |
| `/api/creator/lists/save` | `console.error` at `26_…:1752` | `ok:true` at `:1786` — **34 lines** |
| `/api/lists/like` | `console.error` at `25_…:5775` | `ok:true` at `:5779` — 4 lines, but the catch is **not empty** |
| `/api/creator/delete-account` | inside `purgeCreatorData`, `02_…:2199` and `:2288` | **a different file** |
| unpublish | inside `updatePublicListIndex`, `02_…:1818` | **a different file, and inside `waitUntil`** |

Every one is a *logging* catch, not an empty one, and the invariant each abandons lives in
a different function. The right question is Phase 30's — "what invariant depends on the
operation inside this catch?" — not "is this catch empty?".

**F2 — `migrations/0001` and `docs/history/AUDIT-STATUS.md` item D** both claim the
likes index turns a full scan into an index scan:

> *"The public directory orders by popularity; without this it is a full scan."*

`EXPLAIN QUERY PLAN` on the actual statement (`03_…:866`), with and without the index:

```
without: SEARCH creator_lists USING INDEX idx_creator_lists_visibility (visibility=?) | USE TEMP B-TREE FOR ORDER BY
with:    SEARCH creator_lists USING INDEX idx_creator_lists_visibility (visibility=?) | USE TEMP B-TREE FOR ORDER BY
```

Identical. SQLite picks the `visibility` index for the `WHERE` and sorts in a temp
B-tree either way; a single-column index on `likes` cannot serve both. The index is
inert. (It should still be added to `schema.sql` for A15 — schemas that differ by
deployment path are a hazard regardless of whether the difference currently matters. The
index that *would* help is `(visibility, likes DESC, updated_at DESC)`.)

**F3 — stale, not wrong.** `AUDIT-2026-09-05-INDEPENDENT.md`'s "DO NOT TOUCH" section
says `scheduled()` never populates the module-level API-key globals, which made the
`(env && env.X) || X` pattern load-bearing. Finding 13 was subsequently fixed:
`scheduled()` now calls `applyEnvApiKeys(env)` (`26_…:4508`). The advice is still safe to
follow; its stated justification no longer holds.

---

## 17. Architecture map (built from source)

Derived from the code before any documentation was read, then checked against
`FUNCTION-MAP.md` and `README.md`.

**Entry point.** `worker_entry_combined.js`, a single ~2.76 MB ES module, `main` in
`wrangler.toml`. Its `export default` (`26_…:4494`) has two handlers: `fetch`, which
delegates to `handleFetch` (`25_…:35`) and wraps the result in `withSecurityHeaders`; and
`scheduled` (`26_…:4504`), which calls `applyEnvApiKeys(env)` and then `ctx.waitUntil` of
`checkForNewEpisodes` + `prewarmSharedCatalogs` + `refreshPublicListIndexIfStale`.

**Module ordering.** `build.py` concatenates `header.js` then `sorted(glob('[0-9][0-9]_*.js'))`
byte-for-byte, appending `\r\n` only where a file does not end in a newline. Ordering is
therefore lexical on the two-digit prefix, and load-bearing: `00_constants.js` declares
the `let` API-key globals every later module references by bare name. Verified byte-exact.

**Layering.** `00` constants → `01` icon asset → `02` HTTP/creator/storage utilities →
`03` admin rendering and counters → `04` config resolution → `05` catalog core →
`06`–`08` provider fetchers → `09`–`15` server-rendered page shell and tabs →
`16`–`24` the client bundle (emitted as template literals, split out at runtime by
`splitAppBundle`/`splitAppCss` and served from `/app.js` and `/app.css`) →
`25` the router and catalog routes → `26` creator/admin routes and the export.

**Bindings.** `CONFIGS` (KV, required — every stateful feature silently no-ops without
it); `DB` (D1, optional, commented out by default); `ADMIN_KEY` and nine provider secrets.
Cron `*/6 * * * *`.

**Authentication.** Three independent schemes. Creator Profiles: username + `MYL-XXXX-XXXX-XXXX`
key (~60 bits), PBKDF2-SHA256 ×100,000 with a per-credential salt, constant-time hex
compare, uniform anti-enumeration errors, and a per-isolate 5-minute memo of *successful*
verifications keyed on username+key+stored-hash. Admin: `ADMIN_KEY` → a signed HttpOnly /
Secure / SameSite=Strict cookie scoped to `/admin`. Scrobble webhooks: a separate
revocable token, stored both by token and by username.

**Comparison with `FUNCTION-MAP.md`.** Accurate. `gen_map.py` is deterministic, CI
enforces it, and `verify.sh` confirmed no drift. The route list it derives from
`path === "…"` misses the regex-matched routes (`/lists/:user/:slug`, `/channels/…`,
`/:config/catalog/…`), which is a limitation of the generator rather than an error — I
built the route inventory from the router itself for §7 and §6 rather than from the map,
as instructed.

---

*Every claim in this report is reproducible from `audit/adversarial-2026-09-06/`.
No production source was modified.*
