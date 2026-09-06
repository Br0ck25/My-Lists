# Adversarial audit II — executable probes

Every probe backing `AUDIT-2026-09-06-ADVERSARIAL-II.md`. They import
`tests/harness.mjs` and run against the **committed
`worker_entry_combined.js`**, not against the numbered sources — so what they
exercise is what deploys.

```bash
cd audit/adversarial-II-2026-09-06
for f in p*.mjs; do echo "== $f"; node "$f"; done
```

Nothing here touches production or makes a real network call: `p19`–`p21` stub
`globalThis.fetch` entirely, and everything else is in-memory KV plus real
SQLite for D1.

| Script | Audit phase(s) | What it proves |
|---|---|---|
| `p01_deletion.mjs` | 33, 13 | account deletion leaves nothing; username reclaim inherits nothing; **N2** (index-write failure during delete reports success) |
| `p02_listdelete.mjs` | 5, 13, 14, 29 | **N1** (KV delete failure → `ok:true`, list still public); **N2** across `lists/delete`, `account/reset`, admin delete |
| `p03_visibility.mjs` | 14, 34 | private-list leak matrix; **N3** (like endpoint is an existence oracle and mutates private records) |
| `p04_kvd1.mjs` | 4, 5, 9 | the eight-state KV/D1 failure matrix; rotation and deletion under D1 outage; like-count survival across a D1 outage |
| `p05_concurrency.mjs` | 12, 25 | optimistic concurrency, cross-blob independence, frozen clock, backward clock |
| `p06_order_race.mjs` | 12 | `creatorlistorder:` loses entries under forced interleaving (§11.3) |
| `p07_headers.mjs` | 16 | cache-header table; **N10** |
| `p08_authz.mjs` | 17 | the full authorization matrix |
| `p09_adminpage.mjs` | 17 | `/admin` unauthenticated leaks nothing |
| `p10_schema.mjs` | 6, 7 | fresh vs migrated schema in real SQLite; migration idempotence; **N12**; FK/cascade proof |
| `p11_migrate.mjs` | 8 | adversarial `migrate-d1` over 23 ugly KV records; replay safety; **N9** |
| `p12_cron.mjs` | 22, 23 | **N6** (starvation), **N7** (wedged cursor), **N8** (no `scheduled()` boundary) |
| `p13_cron_poison.mjs` | 22 | **N7** (one failing account stops the sweep for everyone behind it) |
| `p14_pagination.mjs` | 20 | index rebuild + paging at 999/1000/1001/1999/2000/2001 |
| `p15_stateful.mjs` | 35 | 8 seeds × 120 random ops against an independent model |
| `p16_kv_eventual.mjs` | 27, 28 | **N5** (KV read-caching vs "the old key stops working immediately") |
| `p17_resurrect.mjs` | 5, 13, 33 | **N4** (in-flight write resurrects a deleted account; reclaim inherits it) |
| `p18_resurrect2.mjs` | 5, 33 | **N4** across all seven authenticated write paths |
| `p19_providers.mjs` | 24 | 14 upstream contract mutations through a full cron tick |
| `p20_emptycache.mjs` | 24, 15 | an empty-but-successful upstream writes 48 empty chart caches at 24h TTL (§11.1) |
| `p21_cachepoison.mjs` | 24 | **inconclusive** — see §11.1; kept so the next pass does not redo it |
| `p22_differential.mjs` | 10 | KV-only vs KV+D1, 18 operations, normalised |
| `p23_fuzz.mjs` | 18, 21, 32 | 286 fuzz calls; no corrupt persistent state |
| `p24_caps.mjs` | 21, 32 | every cap at CAP-1 / CAP / CAP+1 |
| `p25_bruteforce.mjs` | 17, 31 | **N11** (unthrottled PBKDF2 on every credentialed route) |
| `p26_verify.mjs` | — | precision checks for the exact numbers quoted in §1 |

## Mutation testing

`mutate2.sh` and `mutate3.sh` are destructive to whatever directory they run in
and restore the sources themselves when finished. Run them against a **copy**:

```bash
git archive HEAD | tar -x -C /tmp/mut
cp audit/adversarial-II-2026-09-06/mutate{2,3}.sh /tmp/mut/
cd /tmp/mut && bash mutate2.sh && bash mutate3.sh
```

Each mutation is applied to the numbered sources, rebuilt with `build.py`,
syntax-checked, and run through the full suite. `CAUGHT` means the suite failed
(good); `SURVIVED` means a real bug left it green (a coverage hole). Results are
in §9 of the report.

`mutate2.sh`'s M1 is a no-op edit and its "survival" is meaningless — `mutate3.sh`'s
M1b is the real version of that mutation.
