# Adversarial audit harness — 2026-09-06

Reproduction scripts for `AUDIT-2026-09-06-ADVERSARIAL.md` (repo root). Every
finding in that report has a script here that demonstrates it. Nothing in this
directory is imported by the Worker, the build, `verify.sh` or CI — `build.py`
globs `[0-9][0-9]_*.js` at the repo root and CI runs `tests/*.test.mjs`, neither
of which reaches here.

Run from this directory with Node 22+ (`node:sqlite` is required):

```
cd audit/adversarial-2026-09-06
node t01_like_wildcard.mjs
```

`kit.mjs` is the harness. It differs from `tests/harness.mjs` in three ways that
matter, and those differences are what surfaced most of the report:

* **D1 is real SQLite** (`node:sqlite`) loaded from the actual `schema.sql`,
  with `PRAGMA foreign_keys = ON` to match D1's documented default. The
  project's own mock pattern-matches SQL with regexes and hardcodes
  `SELECT * FROM creator_lists WHERE id = ?` to return `[]`, so
  `getCreatorList`'s D1 branch is never taken in the existing suite.
* **Fault injection.** `DB.failWhen(fn)` makes chosen statements throw;
  `kv._hooks.beforePut/beforeGet/beforeDelete/beforeList` do the same for KV.
* **KV cursors are opaque and key-positioned**, not integer offsets, so a
  traversal over a keyspace that changes mid-scan behaves like the real thing.

| Script | What it shows | Finding |
|---|---|---|
| `t01_like_wildcard.mjs` | one creator's account delete removes another creator's D1 rows | A1 |
| `t04_wildcard_mass.mjs` | 23 self-service resets empty `creator_lists` for every account | A1 |
| `t05_chain.mjs` | A1 + A2 end to end: a stranger destroys a creator's like count | A1, A2 |
| `t02/t03_likes_reset*.mjs` | an ordinary edit zeroes a real like count in D1, then in KV | A2 |
| `t08/t09_*window.mjs` | the migrate-d1 chunk boundary that creates A2's precondition | A2 |
| `t21_delete_fail.mjs` | delete-account returning `ok:true` on three different partial failures | A3, A4, A13 |
| `t22_inherit.mjs` | the reclaimed username inheriting the previous owner's private list | A4 |
| `t06_rotation_split.mjs` | key rotation reporting success while rotating nothing | A5 |
| `t20_faultinject.mjs` | randomized D1 fault injection; dashboard/store divergence | A2, A6 |
| `t12_index_privacy.mjs` | unpublish reporting success while staying in the directory | A8 |
| `t17_rebuild_clobber.mjs` | an in-flight rebuild re-publishing a list that was just made private | A7 |
| `t14_concurrency.mjs` | same-millisecond and wrong-type bypasses; the three unguarded blobs | A9, A10 |
| `t15_fuzz.mjs` | route contract fuzzing; the missing bound on `lists/save` | A11 |
| `t24_scale.mjs` | 21.8 MB parked by one account; a 21.8 MB dashboard response | A11 |
| `t10_headers.mjs` | the cache-header table | A12 |
| `t23_providers.mjs` | provider contract mutation; the unguarded `res.json()` | A13 |
| `phase6_schema.mjs` | fresh `schema.sql` vs `old + 0001 + 0002` | A15 |
| `phase31_plans.mjs` | `EXPLAIN QUERY PLAN` for every D1 query | A15, scale |
| `t07_differential.mjs` | KV-only vs KV+D1 differential (clean) | — |
| `t11_authz_vis.mjs` | authorization matrix and private-list leak surface (clean) | — |
| `t16_pagination.mjs` | pagination correctness at 1/399/400/401/799/800/801/1200 (clean) | — |
| `t13_deletion.mjs` | account deletion proof on the happy path (clean) | — |
| `t18_clock.mjs` | DST / year-boundary / day-bucket behaviour | A18 |
| `t19_stateful.mjs` | randomized stateful model check, 10 seeds (clean) | — |
| `mutate.sh` | mutation testing: `bash mutate.sh <name> <file> <old> <new>` | §9 |
