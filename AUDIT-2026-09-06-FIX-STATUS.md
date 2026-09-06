# Adversarial audit — fix status

Live tracker for the 20 findings in [`AUDIT-2026-09-06-ADVERSARIAL.md`](AUDIT-2026-09-06-ADVERSARIAL.md).
All twenty landed in [#16](https://github.com/Br0ck25/My-Lists/pull/16); the two follow-ups
below are the second PR.

**Legend:** ✅ fixed & tested · 🔧 in progress · ⬜ not started

---

## Order of work, and why it is that order

1. **T0 — the harness first.** Not a finding, a prerequisite. The regression tests
   for A2, A3, A5, A6 and A14 cannot be written at all against the old D1 mock: it
   hardcoded `SELECT * FROM creator_lists WHERE id = ?` to return no rows, it could
   never throw, and it could not enforce a constraint. Fixing the code before the
   harness would mean landing five fixes nothing can prove.
2. **A1** — the only finding an unauthenticated stranger can trigger, and it destroys
   other people's data. Nothing else outranks it.
3. **A5, then A3 + A4 together** — the three `ok:true`-while-doing-nothing defects, in
   decreasing order of how bad the lie is: a leaked key that still works > a deleted
   account that still works > a deleted account whose data is inherited by a stranger.
   A3 and A4 landed in one commit rather than two: both are `purgeCreatorData`
   reporting success after failing, and splitting them would have left that one
   function half-converted between commits.
4. **A2 + A6** — one commit, because they are one root cause (D1 preferred on read over
   the store that is actually authoritative). Fixing A2's `likes` binding without
   fixing the read preference would leave A6 live and A2 reachable by another route.
5. **P2 batch** — real defects, none of which silently destroys data.
6. **P3 batch** — hygiene, accuracy and documentation.

---

## Status

### Prerequisite

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **T0** | Test harness cannot see D1 (§9 blind spots) | — | ✅ | `tests/harness.mjs` |

### P0 — silent data destruction and false success

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A1** | Cross-account D1 delete via SQL `LIKE` wildcard | CRITICAL | ✅ | `02_…:2206` → `WHERE username = ?`; `escapeLikePrefix` for `03_…:1133` |
| **A5** | Key rotation reports success while rotating nothing | HIGH | ✅ | `rotateCreatorKeyHashInD1` (02_); both rotation routes; migrate-d1 `DO UPDATE` |
| **A3** | `delete-account` `ok:true`, account still authenticates | HIGH | ✅ | `purgeCreatorData` identity: D1 before KV, abort on failure |
| **A4** | Failed purge frees the username while data survives | HIGH | ✅ | `purgeCreatorData` returns `ok`; both callers 500 on failure |

### P1 — the structural cause

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A2** | Ordinary edit zeroes a real like count in D1 then KV | HIGH | ✅ | `likes` bound on both INSERTs; KV-first reads |
| **A6** | Dropped D1 write diverges the dashboard permanently | MED-HIGH | ✅ | `getCreator`/`getCreatorList` read KV first, D1 as fallback |

### P2 — real defects, no silent data loss

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A7** | In-flight rebuild re-publishes a list just made private | MEDIUM | ✅ | removals recorded + re-verified before the rebuild publishes |
| **A8** | Unpublish `ok:true` while the index removal fails silently | MEDIUM | ✅ | removal is awaited and reported; adding stays fire-and-forget |
| **A9** | Conflict guard: same-ms bypass + fails open on a non-number | MEDIUM | ✅ | `parseExpectedUpdatedAt` + `nextSyncVersion` (02_) |
| **A10** | Presets/channels/tracking unguarded; watchlist has no merge | MEDIUM | ✅ | guards on save-presets/save-channels + client; watchlist empty-guard |
| **A11** | No size bound on the authenticated list write | MEDIUM | ✅ | `CREATOR_LIST_BYTES_MAX` + shared item/name caps |
| **A12** | `json()` cacheable default; admin 401s cached for an hour | MEDIUM | ✅ | errors (incl. `ok:false` 200s) → `no-store`; explicit on credential routes; **follow-up:** `isPrivateApiPath` choke point |
| **A13** | No global exception boundary | MEDIUM | ✅ | `export default.fetch` try/catch; two unguarded `res.json()` wrapped |
| **A15** | `schema.sql` vs migrations index drift | LOW | ✅ | index added; a test diffs both provisioning paths |

### P3 — hygiene, accuracy, documentation

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A14** | migrate-d1 cannot repair a stale row; counters count attempts | LOW-MED | ✅ | `DO UPDATE` (with A5) + `meta.changes` counters + a `skipped` tally |
| **A16** | Counters are D1-only once bound, vs the "removable" promise | LOW | ✅ | documented in `wrangler.toml` + `bumpStat`; behaviour deliberately kept |
| **A17** | Cron cursor advances before the work is done | LOW | ✅ | cursor committed after the batch |
| **A18** | Daily seed rolls at UTC midnight, stats at Eastern midnight | LOW | ✅ | `getDailySeed` uses `easternDateKey` |
| **A19** | Unbounded, unvalidated `lists/reorder` array | LOW | ✅ | `CREATOR_LIST_ORDER_MAX`, per-slug length, no `:` |
| **A20** | FK blocks list writes for a not-yet-migrated account | LOW-MED | ✅ | `backfillCreatorRowInD1` + one retry, on the failure path only |
| — | `CHECK (visibility IN …)` hardening | — | ⏸️ | **deliberately not done** — see below |
| — | Stale comments (§16 F1/F2/F3) | — | ✅ | F1/F2 corrected in code; F3 is in a historical audit, left as written |

---

## Follow-ups, after the first PR merged

Two things I flagged as judgment calls when the twenty landed, and then acted on.

**The A9 prescription in the audit report was wrong.** The report's *Minimal fix* said
"use `>=`". The shipped code does not, and should not: `expected === stored` is the
NORMAL case — my edits are built on exactly the version that is stored — so `>=` would
409 every legitimate save. A bare timestamp cannot be a version when two writes can
share a millisecond; the version has to change on every write, which is what
`nextSyncVersion` does. Corrected in the report rather than left to mislead whoever
reads it next, because a merged document that tells you to introduce a bug is worse
than no document.

**`/api/creator/*` and `/admin*` responses now say `no-store` at a choke point.** The
first pass fixed the demonstrated harms — cached 401s, the two responses carrying a
plaintext Creator Key, the four provider GETs whose URL contains an access token — and
left successful per-account POSTs on `json()`'s cacheable default. Those were safe only
because browsers do not cache a POST: protection by accident of HTTP method, not by
design, and it stops being true the day one of them gains a GET form. `isPrivateApiPath`
+ `withSecurityHeaders` now sets the header for both prefixes at the single point every
response funnels through, so a route added later cannot forget, and (because it *sets*
rather than defaults) cannot accidentally opt out either.

Still not doing the wholesale `json()` default flip. It would strip edge caching from
the catalog and provider endpoints this add-on leans on to stay inside upstream rate
limits, and with errors and both private prefixes now covered, what remains on the
default is exactly the public, cacheable traffic it was written for.

## Deliberately not done

**`CHECK (visibility IN ('public','private'))` on `creator_lists`.** SQLite cannot add
a constraint to an existing table without rebuilding it, so this could only go into
`schema.sql` — which would make a *fresh* database a different shape from a *migrated*
one, i.e. exactly the drift A15 just closed and now has a test forbidding. Doing it
properly means a table-rebuild migration against live data, and the value is small:
`normalizeListVisibility` already fails closed on every write and
`isPublicListVisibility` fails closed on every read, so nothing in the app can produce
a value the constraint would catch. Recorded rather than done, with the reasoning, so
the next person does not re-derive it.

## Mutation testing, re-run against the fixed code

The audit's headline test-suite finding was that 7 of 12 controlled bugs survived the
suite. Re-run after the P0/P1 fixes, with two new mutations aimed at the fixes
themselves:

**All twelve are now killed**, plus two new ones aimed at the fixes themselves.

| Mutation | Audit | Now |
|---|---|---|
| skip the D1 write in `lists/save` entirely | **survived** | killed |
| `/api/lists/like` writes `0` to D1 instead of the real count | **survived** | killed |
| account purge widened to every list row in the database | **survived** | killed |
| `listAllKeys` stops following the cursor after page 1 | **survived** | killed |
| index-rebuild prefix `publishedlist:user:` → `publishedlist:usr:` | **survived** | killed |
| `pickFreeSlug` returns a taken slug when it runs out | **survived** | killed |
| `PUBLISHED_LIST_ITEMS_MAX` off by one | **survived** | killed |
| `authenticateCreator` accepts a wrong key | killed | killed |
| `isPublicListVisibility` inverted | killed | killed |
| skip the KV write in `lists/save` | killed | killed |
| remove the 409 conflict check | killed | killed |
| `removeListsFromPublicIndex` becomes a no-op | killed | killed |
| *new:* rotation swallows an unrecoverable D1 failure and reports success | — | killed |
| *new:* `purgeCreatorData` always returns `ok: true` | — | killed |

`pickFreeSlug`'s is worth a note. Driving it through the API cannot reach the exhausted
branch — the random-suffix attempts essentially never collide, so it returns on the
first one every time — so that mutation survived an end-to-end test and is killed by a
direct test of the contract it documents instead. A mutation surviving is not always a
coverage hole; sometimes it means the mutated path is unreachable, and the honest answer
is to test the contract rather than contort a scenario.

## Verification against the audit's own reproductions

Re-run from `audit/adversarial-2026-09-06/` against the fixed tree:

| Check | Audit | Now |
|---|---|---|
| `t20_faultinject.mjs` — 120 random ops, D1 failing 15% and 40% | **5 of 6 seeds diverged** | **all 6 consistent** |
| `t19_stateful.mjs` — 10 seeds × 120 ops, model-checked after every op | clean | still clean |
| `t07_differential.mjs` — KV-only vs KV+D1 | 0 differences | 0 differences |
| `t01` cross-account delete | victim's rows destroyed | victim's row and like count intact |
| `t03` likes after an edit | 5 → 0 in both stores | 5 throughout |
| `t06` rotation with D1 failing | old key lives, new key dead | old key dead, new key works |
| `t17` unpublish during a rebuild | re-published to directory + search | stays unpublished |
| `t21`/`t22` failed deletes | `ok:true`, data inherited by a stranger | `ok:false`, nothing removed, name not reclaimable |

`m6` (KV pagination cursor), `m7` (index-rebuild prefix), `m10` (slug fallback) and
`m11` (cap off-by-one) are still open; they belong to the P2 batch.

## Gate for every commit

`bash verify.sh` must pass: rebuild is byte-exact, `node --check` clean, the rendered
builder page validates, `FUNCTION-MAP.md` is current, and the whole suite is green.
Each fix also ships the regression test named for it in §13 of the audit, and that test
is confirmed to **fail against the pre-fix code** before the fix is applied.
