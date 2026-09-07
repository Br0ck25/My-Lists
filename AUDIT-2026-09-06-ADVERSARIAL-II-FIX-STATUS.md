# Adversarial audit II — fix status

Companion to `AUDIT-2026-09-06-ADVERSARIAL-II.md`, which describes the code as
it stood at `3d4c24f`. That document is left as the audit record and is not
edited to match the fixes; this one says what was done about it.

Every fix is verified twice: the probe that originally demonstrated the defect
now passes, and the defect reintroduced by mutation makes the test suite fail.
A fix whose mutation leaves the suite green is called out below rather than
counted as done — see "What the mutation run actually said", which is also
where the one case of a *correctly* surviving mutation is explained.

Suite: **273 tests, 272 passing, 1 skipped** (network-gated), up from 234/233.
`verify.sh` passes, including the byte-exact rebuild.

### What the mutation run actually said

Seventeen mutations, one per fix. Fifteen were caught. Two survived, and they
are two different things — which is the point of running it at all.

**N4's purge-on-create: a decorative test.** Reverting it left the suite green,
because the test asserted a clean slate after a *clean* delete, which is clean
with or without the purge. Replaced with one that seeds account-owned keys
under a username with no identity — the state a straggler leaves once the
tombstone has lapsed — and then registers it. Reverting the purge now fails.

**`invalidateCreatorAuthMemo`: redundant code, not a missing test.** Making it
a no-op also left the suite green, and that is correct. Measured with the clear
disabled entirely: a rotated key still 401s in both KV-only and KV+D1 mode, and
a deleted account still 401s. The memo key is a hash of username + presented
key + *stored hash*, so a rotation changes the key and the old entry becomes
unreachable on its own; a deleted account fails on the tombstone or the missing
record long before the memo is consulted. The clear is belt-and-braces, exactly
as its own comment says.

So the test for it deliberately asserts the property ("the old key stops
working") rather than the mechanism. Writing one that fails when the clear is
removed would mean pinning a redundant line — describing the implementation
instead of the behaviour, which is the mistake the source-text cron test made.

A surviving mutation means either the test is decorative or the mutated code
was redundant. Telling those apart is the work; assuming the first and writing
a brittle test to make the red go away is how a suite stops being worth
running.

### A third decorative test, found by re-running the probes

Re-running every probe against the fixed code turned up one more, and it is the
subtlest of the three. **§11.1's behavioural test asserted nothing.** It ran the
cron once against a healthy provider, once against a provider answering 200 with
an empty body, and checked the cached chart was unchanged — and it passed with
the guard disabled.

The reason is per-isolate state. The Worker keeps a shared-chart memo
(`PER_USER_CACHE_MAP`) in module memory, and the whole suite runs in one Node
process, so the second cron tick was served from that memo and made **zero**
upstream calls. The KV copy was also still inside its ~10 minute freshness
window, so no refresh would have been attempted anyway. "The cache was not
damaged" and "nothing happened" are indistinguishable from outside, and the test
was measuring the second.

Two things fix it, and both are needed: make every KV copy stale, and run the
second tick on a *different* isolate. `tests/harness.mjs` now exports
`freshIsolate()`, which imports the Worker under a distinct URL to get a module
instance with empty memos over the same KV — what a request landing on a cold
colo actually looks like. The test now counts the upstream calls and asserts
there were some, so it can never silently go hollow again. Reverting
`refuseEmptyOverwrite` now fails it; before, it did not.

`p21_cachepoison.mjs` — recorded in the report as **inconclusive** — was
inconclusive for the same reason and is now decisive: 12/12 good chart entries
survive an empty-200 tick with the guard, 3/12 without it. `p20_emptycache.mjs`
had a broken detector of its own: it looked for `[]` and `"items":[]` while the
cache format is `{"data":…,"freshUntil":…}`, so it printed "empty payloads: 0"
over a KV holding 46 of them. Fixed, and it now also prints the freshness window
(592–3600s) next to the 24h KV TTL, because quoting the TTL alone makes a
ten-minute cold-start gap read like a day-long outage.

---

## Order of work, and why it is that order

Severity, with one exception. **N4** went first among the P0s despite N1 being
listed first in the report, because it is the only finding that hands one
person's data to another; everything else is a correctness or availability
problem within a single account. After that: the silent-success cluster
(N1/N2/N3), then the cron (N6/N7/N8) because a silently dead feature is worse
than a slow one, then the P1 correctness and cost items, then documentation.

---

## Status

### P0 — cross-account disclosure

| ID | Fix | Verified by |
|---|---|---|
| **N4** | Three parts, because no one of them is sufficient. A tombstone (`creatordeleted:{u}`, 5 min) is written **before** the purge sweep, so nothing that authenticates from then on can write; a second sweep runs after the identity is removed, catching what landed during the first; and `/api/creator/create` purges the username's key space before writing the new record, so a new account is empty **by construction** however a stray key got there. A failed delete clears the tombstone, so it cannot hold an account hostage. | `p17_resurrect.mjs` (8/8), `p18_resurrect2.mjs` (all 7 write paths), suite |

**Behaviour change worth knowing:** a deleted username cannot be
re-registered for five minutes. That hold is what stops a straggler's write
reaching a new owner. Three existing tests asserted immediate reuse and were
updated to assert the new contract.

**Residual, stated honestly.** A request that authenticated *before* the
tombstone and is still running *after* the pre-create purge can still leave a
key behind. It can no longer reach anyone: the name is held for far longer
than a request can run, and creation sweeps again. What is not eliminated is a
stray key existing at all.

### P0 — silent success

| ID | Fix | Verified by |
|---|---|---|
| **N1** | `deleteCreatorLists` returns `ok`; a failed KV delete sets it false. Both callers (`/api/creator/lists/delete`, `/admin/api/delete-creator-list`) return 500 instead of `ok:true`. | `p02_listdelete.mjs` (6/6), suite |
| **N2** | `purgeCreatorData` treats a failed directory removal as a failed sweep. Beyond what the report asked for: `getPublicListIndex` now filters the served index through the removal tombstones it already records, re-verifying against the authoritative record — so a removal is effective immediately even when the index write itself fails, rather than waiting up to a day for the rebuild. | `p01_deletion.mjs` (12/12), `p02_listdelete.mjs`, suite |
| **N3** | `/api/lists/like` rejects a non-public list with the **same** generic 404 as a missing one, closing the oracle as well as the write. | `p03_visibility.mjs` (8/8), suite |

### P1 — the cron

| ID | Fix | Verified by |
|---|---|---|
| **N6** | Sweep position is now a page cursor **plus an offset into that page**, so it advances over exactly the accounts processed. Holding the cursor instead — the obvious fix — would have been worse: an account with more shows than the budget would wedge its page and starve everything behind it forever. | `p12_cron.mjs` case A, suite |
| **N7** | Each account is isolated in its own try/catch, so one that fails costs itself and nothing else; a cursor the binding rejects is cleared so the next tick starts over instead of retrying it forever. | `p13_cron_poison.mjs`, `p12_cron.mjs` case B, suite |
| **N8** | `scheduled()` gets the boundary `fetch()` already had: each task guarded, the body wrapped. | `p12_cron.mjs` case D, suite |

### P1 — correctness and cost

| ID | Fix | Verified by |
|---|---|---|
| **N5** | Authentication prefers D1's `key_hash` when D1 is bound. `getCreator` reads KV first and falls back only on a miss — right for reading a profile, wrong for authenticating, because a colo serving a cached pre-rotation record never reaches the fallback. Every rotation writes D1 first precisely so the authoritative answer exists immediately. Missing row still means "not migrated yet"; D1 down still falls back to KV. | `p16_kv_eventual.mjs` (rotation half), suite |
| **N9** | `migrate-d1`'s lists upsert rewrites all six KV-derived columns, not two. `created_at` still excluded, for the reason the creators branch gives. | `p11_migrate.mjs`, suite |
| **N10** | Added `jsonPrivate()` and moved every account-scoped response onto it, rather than a note at each call site, so the next such endpoint inherits the property. `/api/search-published-lists` dropped from `max-age=3600` to 60. | `p07_headers.mjs`, suite |
| **N11** | Bounded inside `authenticateCreator` — the one function all sixteen routes go through — and charged only when the isolate memo cannot answer, so what is counted is real PBKDF2 runs rather than requests. A warm signed-in client never touches the bucket. | `p25_bruteforce.mjs`, suite |

Eighteen routes had the auth-failure ternary written out inline and every one
replaced `auth.error` with the generic string, so a throttled caller would
have been told their key was wrong. One `authFailureResponse` helper now keeps
storage-missing, throttled, and not-authenticated distinguishable.

### P2/P3 — migrations, indexes, documentation

| ID | Fix |
|---|---|
| **N12** | `0001` split into `0001a` (the non-idempotent ALTER) and `0001b` (the idempotent index). As one file an interrupted run could never be completed, because re-running stopped at the ALTER. |
| §10 | `migrations/0003` and `schema.sql` add `idx_creators_last_active` and `idx_creator_lists_vis_likes`. Both admin queries lose their `USE TEMP B-TREE FOR ORDER BY` entirely. The schema-drift test now reads the migrations directory rather than naming files, so a later migration cannot be left out by omission. |
| §12 | The stale comment above `/api/creator/account/reset` (claiming `delete-account` "leaves most of an account's data behind") removed — untrue since both callers were moved onto `purgeCreatorData`. |
| §12 | `gen_map.py` now matches prefix and regex routes, not only `path === "..."`. `FUNCTION-MAP.md` went from 108 routes to 131; `/lists/:user/:slug`, `/channels/…`, `/api/scrobble…`, `/:config/manifest.json` and `/:config/catalog/…` were all missing. |
| §12 | `check_sync.py` did a substring check that passes on modules out of order, duplicated, or with content appended, and nothing ran it. It now does the byte comparison itself. |
| §5 | `migrate-d1` clamps a negative like count rather than copying it into the mirror. |

---

### Confirmed after the report was written

| ID | Fix | Verified by |
|---|---|---|
| **§11.1** | The audit filed this unconfirmed because it could show empty chart caches being *written* but not that they *overwrote good data*. They do: the write gate is only "not null and not undefined", so an empty array or object counts as a successful refresh and lands on all three tiers — isolate memo, KV copy, edge copy. That destroys the last-known-good data those tiers exist to hold, at exactly the moment the circuit breaker needs it, so a provider blip stopped being "slightly stale rows" and became "empty rows". Now refused, **opt-in**: a trending chart is never legitimately empty, but someone's Trakt watchlist is, so the four shared chart/collection fetchers opt in and every per-user fetcher deliberately does not. | `/tmp` probe reproduced in the suite; two tests, one pinning the split |

## The remaining open items, closed in a second pass

Everything the report left for later, apart from the two noted below as still
open. Same verification standard: the probe that demonstrated it passes, and
reverting the fix by mutation fails the suite.

| ID | Was | Now | Verified by |
|---|---|---|---|
| **R1** | `publishedlist:user:{slug}` had **no delete path in any route**. Anyone could publish, unauthenticated, and nothing could remove it -- the admin creator-list endpoint could not be pointed at them either, because it validates the username and `user` is reserved. An operator facing abusive or infringing content had nothing but the Cloudflare KV dashboard. | `/admin/api/published-lists` (cursor-paged, so an unbounded keyspace can actually be walked) and `/admin/api/delete-published-list`, sharing the record + ledger + directory sweep and the same failure semantics as the creator path, plus an admin panel that browses and deletes them. | 12-assertion probe; suite |
| **R2** (§11.4) | Two devices editing one list was last-write-wins with both answering 200 -- the one wholesale write left out of the `expectedUpdatedAt` work. | The same guard the sync blobs have, additive so an older client is unaffected, with `nextSyncVersion` so a frozen clock cannot defeat it. `updatedAt` now comes back on save so a client can advance its baseline. | `p05`; suite |
| **R3** (N5's deletion half) | A colo whose KV cache predated both the tombstone and the `creator:` delete kept authenticating a deleted account. A missing `creators` row could not serve as proof, because that is the lazy-migration state. | `creator_tombstones` (migration 0004) -- a table whose rows mean one thing only. D1 is strongly consistent, so the marker is visible from anywhere on the next request. | probe; suite |
| **R4** | The dashboard's counter panels ran `WHERE day='total' AND kind LIKE ? ORDER BY n DESC` -> `SCAN stats` plus a sort, over a table whose `kind` dimension is unbounded (`list_copy:{slug}` mints one per list). | `idx_stats_day_totals (day, n DESC, kind)` (migration 0005) -> `SEARCH stats USING COVERING INDEX (day=?)`. The sort disappears entirely, so `LIMIT` stops early instead of ranking everything first. | `EXPLAIN QUERY PLAN` |
| **R5** (§11.3) | The list-order key is one key rewritten read-modify-write, and the handler wrote back the array it read at the top -- so entries added in between were dropped. Measured: 12 concurrent creations, 12 records, **9** order entries. | Re-read and union immediately before the write. Same measurement now: **12 of 12**. | `p06`; suite |

**R3 and R5 are narrowed, not eliminated, and the tests say so.** R3 is closed
only where D1 is bound; a KV-only deployment has no strongly-consistent store
to ask, and the test asserts that as a known limit rather than pretending
otherwise. R5 still has a window between its own get and put -- only moving
ordering off a single key removes that, which is a data-model change.

R5's residual window now has a number rather than a caveat. Under realistic
latency the merge takes twelve concurrent creations from nine order entries to
twelve. Replace that latency with a hard barrier -- all twelve blocked until
all twelve have read the key -- and the result is **one** entry with the merge
and one without it, because then every re-read happens before any write. The
test carries that measurement in a comment so it is not mistaken for a proof of
correctness under arbitrary interleaving.

**R1 needed a UI, not just two routes.** An endpoint an operator cannot reach
is not a fix: `/admin/api/published-lists` is cursor-paged over an unbounded
keyspace, and without something to walk it, finding an abusive list still meant
knowing its slug in advance. The admin page now has an "Anonymously published
lists" panel that browses (Load more follows the cursor until it goes null),
selects into the slug box rather than deleting on click, and batches the delete
the same way the creator-list panel does. The paging contract has its own test:
both of its failure modes -- a cursor that never goes null, and one that goes
null early and shows the operator a truncated list -- are silent.

## N10 finished properly: the rule moved to the boundary

N10 was fixed route by route with `jsonPrivate()`, and marking routes
individually is opt-in. Enumerating the whole surface afterwards found five
still opted out and answering **200 with `max-age=3600`**:

    /api/creator/sync/save
    /api/creator/sync/save-tracking
    /api/creator/sync/save-presets
    /api/creator/sync/save-channels
    /api/creator/lists/delete

Nothing was leaking: those are POSTs and browsers do not store a POST response.
But that is protection by accident of HTTP method rather than by design, it ends
the day one of them gains a GET form, and a route added tomorrow starts out
wrong the same way. So `isPrivateApiPath` now decides it once, where every
response funnels back through, for `/api/creator/*` and `/admin*` — the same
place `securityHeaders` already lives, and for the same reason: a route added
later cannot forget to opt in, and the header is *set* rather than defaulted, so
one cannot accidentally opt out either. A 404 under those prefixes is covered
too, since that is the shape a future route arrives in.

The narrowness is the other half of the fix, and is pinned by its own test. A
blanket `no-store` would be wrong: this add-on stays inside the upstream rate
limits by being cacheable where it can be. Both mutations are caught —
disabling the rule fails the private test, widening it to every response fails
the public one.

## R2 was half a fix, and the half that shipped was the unreachable one

The client-side coverage gap above was the acknowledged blind spot of both
audits, so the next pass built a way to run the browser bundle
(`tests/client-harness.mjs` -- renders the page through `renderBuilder`, pulls
out the inline scripts, evaluates them in a `vm` against a small DOM stub; no
new dependency, no CI change, ~300ms). The first thing it was pointed at was the
newest client/server contract, R2. That contract did not work.

**No client sent `expectedUpdatedAt` on a list save, and none could have.**
Twelve call sites POST to `/api/creator/lists/save`; none cited a baseline, and
`/api/creator/lists` did not report one -- the only version a browser could
name is a version the server told it, and nothing did. So the guard could never
fire, and two devices editing one list stayed last-write-wins in the product no
matter what the Worker was capable of. The server-side conflict test passed
throughout, because it sent a baseline the real client had no way to know.

Both halves now exist. `/api/creator/lists` reports `updatedAt` per list --
absent, not `0`, for a legacy record, since `parseExpectedUpdatedAt` reads
absent as "no opinion" and `0` is an opinion and a wrong one. The two removal
paths (`removeWatchlistItemDirect`, `removeCustomListItemDirect`) go through
`saveCreatorListWithBaseline`, which cites the version, advances it from the
save response, and on 409 **re-applies the edit** to what the other device
saved rather than re-sending the array computed from the stale copy. That
distinction is the fix: the edit is passed in as a function over items, not as
a finished array, so "remove tt1" composes with "someone else added tt9"
instead of silently undoing it. Retried once, then dropped.

Six mutations across both halves, all caught. One of them is worth recording:
naming the helper `saveCreatorListEdit` collided with an existing function of
that name in `21_client-custom-list-builder.js`, and `html_checks.py`'s
duplicate-declaration check caught it -- every client module shares one script
scope, so the later declaration would have silently won.

Writing those tests also surfaced a trap worth knowing about for the next
person: a top-level `let`/`const` in a classic script lives in the *script*
scope, not on `globalThis`, so setting `sandbox.lastCreatorListsData` from a
test sets an unrelated global the bundle never reads. `activeCreator` is a
`var` and does land on `globalThis`, which makes the difference easy to miss.
The harness exposes `get`/`set`/`call` that run inside the bundle's own scope
through a direct `eval`, appended by the harness and never by a shipped source.

## Deliberately not done

**Behavioural coverage of the client, beyond the contract below.** 35,225 of
the 59,240 source lines are the builder UI (09-24). `tests/client-harness.mjs`
now runs that bundle and `tests/client.test.mjs` exercises the list-edit
protocol through it, but that is one flow. Rendering, layout and the bulk of
the UI are still uncovered, and the harness's permissive DOM stub cannot reach
them -- that needs a real browser, which is a dependency decision, not a
test-writing one.

**Pruning `creator_tombstones`.** Rows are inert once `until` has passed, and
one row per deleted account is a rounding error next to the accounts
themselves, so nothing sweeps them. A deployment that wants to can delete
expired rows safely.

---

## Verification

```bash
node --test tests/*.test.mjs        # 273 tests, 272 pass, 1 skipped
bash verify.sh                      # build drift, syntax, page render, map, tests
python3 check_sync.py               # byte-exact rebuild check on its own

for f in audit/adversarial-II-2026-09-06/p*.mjs; do node "$f"; done
```

All 26 probes were re-run against the fixed code. Four needed changes, and none
of them because a fix regressed:

| Probe | Why it changed |
|---|---|
| `p04_kvd1.mjs` | asserted the D1 like count converges after a **rename**. It does not, deliberately — `/api/lists/like` owns that column, so `lists/save` binds `likes` on INSERT and leaves it out of the `DO UPDATE`. Now asserts what actually holds: no read path shows the stale count, and `migrate-d1` converges the mirror (0 → 3). That is the repair N9 restored, and it has a regression test now too. |
| `p10_schema.mjs` | reconstructs the pre-migration schema by stripping from `schema.sql`; migrations 0004 and 0005 added a table and an index it did not know to strip, so it crashed on `no such table: main.stats`. Now strips and applies both, and checks their reruns. |
| `p20_emptycache.mjs` | broken empty-payload detector, and TTL-vs-freshness (above). |
| `p21_cachepoison.mjs` | inconclusive → decisive (above). |
| `p26_verify.mjs` | its "nothing can delete an anonymous list" check is still true of `delete-creator-list` and still correct; it now also exercises the two routes R1 added. |

Mutation testing, re-run against the fixed code: seventeen mutations, one per
fix, each reverted alone and the suite re-run. **15 caught, 2 survived** — one
a decorative test since replaced, one a genuinely redundant line. Both are
explained above. See the audit's §9 for the method.

The second pass has its own set, `audit/adversarial-II-2026-09-06/mutate4.sh`:
eight mutations across R1, R2, R3, R5 and the paging cursor, **8 caught, 0
survived**. R4 is an index, so a mutation is meaningless there — it is verified
by `EXPLAIN QUERY PLAN` instead.

One caution learned from running it: a mutation whose search string contains a
backtick or `${...}` must be escaped, or the shell rewrites it, nothing matches,
and the run prints `SKIP` — which is easy to read past as a result. R5's
mutation did exactly that on the first run and was re-run by hand.
