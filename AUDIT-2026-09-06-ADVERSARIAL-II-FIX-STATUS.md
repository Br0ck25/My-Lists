# Adversarial audit II — fix status

Companion to `AUDIT-2026-09-06-ADVERSARIAL-II.md`, which describes the code as
it stood at `3d4c24f`. That document is left as the audit record and is not
edited to match the fixes; this one says what was done about it.

Every fix is verified twice: the probe that originally demonstrated the defect
now passes, and the defect reintroduced by mutation makes the test suite fail.
A fix whose mutation leaves the suite green does not have a real regression
test, and is called out as such below rather than counted as done.

Suite: **253 tests, 252 passing, 1 skipped** (network-gated), up from 234/233.
`verify.sh` passes, including the byte-exact rebuild.

One mutation did survive on the first pass — reverting N4's purge-on-create
left the suite green, because the test for it asserted a clean slate after a
*clean* delete, which is clean with or without the purge. Replaced with one
that seeds account-owned keys under a username with no identity and then
registers it; reverting the purge now fails. Recorded rather than quietly
corrected, because "the mutation survived" is the only signal that a
regression test is decorative.

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

## Deliberately not done

**§11.3 — `creatorlistorder:` lost updates.** A single-key read-modify-write
loses entries under concurrency (3 of 12 measured). The dashboard's orphan
sweep already masks it, so the visible symptom is only that a user's chosen
ordering loses positions. Fixing it properly means moving ordering off one key,
which is a data-model change, not a patch.

**§11.4 — no staleness guard on `/api/creator/lists/save`.** Two devices
editing the same list is last-write-wins. Extending `expectedUpdatedAt` to list
records is a client-and-server change with its own compatibility story, and it
was left out of the sync-blob work deliberately enough that it deserves its own
decision.

**Anonymous published lists cannot be deleted.** Already known and still open —
`publishedlist:user:*` has no delete path in any route. It needs an admin
endpoint and a decision about who may remove someone else's anonymous list.

**N5's deletion half.** The D1 preference closes the rotation window. A colo
that has seen neither the tombstone nor the deletion can still authenticate a
deleted account briefly, because a missing D1 row is indistinguishable from
"not migrated yet" by design. Closing it properly needs a deletion marker in
D1, which is a schema change.

---

## Verification

```bash
node --test tests/*.test.mjs        # 250 tests, 249 pass, 1 skipped
bash verify.sh                      # build drift, syntax, page render, map, tests
python3 check_sync.py               # byte-exact rebuild check on its own

for f in audit/adversarial-II-2026-09-06/p*.mjs; do node "$f"; done
```

Mutation testing, re-run against the fixed code: every fix above was reverted
one at a time and the suite re-run. See the audit's §9 for the method.
