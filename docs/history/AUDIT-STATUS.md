# AUDIT REMEDIATION STATUS

Live tracker for the findings in [`AUDIT-2026-09.md`](./AUDIT-2026-09.md).
Baseline commit: `e3293d6a`. Branch: `arena/01a06973-my-lists` (PR #3 → `main`).

**Rating movement:** `NOT READY` → `READY WITH FIXES` (round 2) → **`READY`** (code; as of item J)

The three unauthenticated data-exposure paths and the non-functional account
deletion — the four things that made this unsafe for a second user — were
closed in rounds 1–2. Scale, fail-closed privacy, CORS, preview, IP limits,
display names, KV TTLs, and an authorization test suite with CI are now in
too. What remains is **production deploy work**, not more code.

---

## ✅ Completed

### Round 1 — commit `763e967` (PR #1)

| # | Severity | Issue | Verified by |
|---|---|---|---|
| 1 | 🔴 | **IDOR: private watch history public.** `/lists/:user/:slug` served `creatorsynctracking:` (private sync blob) for `watchlist` / `watch-history` / `continue-watching` with a synthesized `visibility:"public"`. Any username → full viewing history. Now opt-in per slug via `creatorshare:{username}`, strict `=== true`. Added `POST /api/creator/sync/share-tracking`. | Live: default 404 → opt-in 200 → opt-out 404; `shared:"yes"` (truthy, not `true`) correctly stays private |
| 2 | 🔴 | **`delete-account` deleted nothing.** Named 5 legacy prefixes no longer written; never removed `creator:` or any `creatorsync*`. Returned `ok:true` while the key kept authenticating and the username stayed locked forever. Both delete and reset now share `purgeCreatorData()`. Delete also drops identity + D1 row, requires `confirm:"DELETE"`. | Live: `cleared:{lists:2,keys:15}`, **0** leftover KV keys, key → 401, username reclaimable |
| 3 | 🔴 | **IDOR: support threads readable by username.** `/api/feedback/threads?creatorName=` needed no key and returned `message` + `contact`. Name lookup now requires the key; anonymous `threadIds` capability path preserved. | Live: no key → 401, wrong key → 401, correct key → 200 |
| 4 | 🟠 | **`wrangler.toml` missing required config.** `CONFIGS` KV binding commented out (every stateful feature silently no-ops); no cron trigger, so `scheduled()` never ran and Continue Watching never updated. Both added; D1 documented as optional; all 9 secrets listed. | Worker boots with binding; `checkForNewEpisodes` confirmed cursor-batched (25 accounts/150 shows per tick) so `*/6 * * * *` is safe |
| 5 | 🟠 | **D1 zero-row split-brain.** A D1 `UPDATE` matching 0 rows doesn't throw → `d1Success=true` → KV write skipped → **nothing rotated**. Caller got a new key that never worked while the old key kept working. Now checks `meta.changes` and always writes KV. | Live with D1 bound: new key works, old key 401; `D1 key rotation matched no row … KV updated` warning observed |
| 5b | 🔴 | **D1 lockout** *(found while testing 5)*. `getCreator`/`getCreatorList` returned `null` when `DB` bound and row absent instead of falling back to KV — locking out every account not yet migrated. Also, create wrote to D1 **instead of** KV, making one row the only copy of an account. | Live: dropped D1 row → account still authenticates via KV |
| 6 | 🟡 | **14 endpoints returned HTTP 200 on auth failure**, incl. `sync/save` — clients branching on status treated a rejected sync as success (silent data loss). All now 401 (500 for `no-kv`). | Live: 5 sampled endpoints all 401 |
| 7 | 🟡 | Removed false `No environment variables or bindings required` from build header. | grep |

### Round 2 — this commit

| # | Severity | Issue | Verified by |
|---|---|---|---|
| 8 | 🟠 | **Like counts were anonymous, unlimited, unauthenticated.** 11 curl POSTs took a list 0→11; `unlike` decremented just as freely, so a rival could be zeroed out. Replaced the blind read-modify-write counter with an **idempotent voter ledger** (`listlikevoters:` / `extlikevoters:`): one vote per identity (creator username when signed in, else hashed IP), so re-liking is a no-op. Count is derived from the ledger, not incremented. | Live: 12 rapid likes → count stays **1**; unlike → 0; distinct voters accumulate correctly |
| 9 | 🟠 | **`like-external` was an unbounded attacker-controlled KV keyspace.** Any string minted a new permanent key (storage/billing DoS). Now requires a well-formed `http(s)` URL, ≤ 300 chars, host on the known-provider allowlist, and normalizes before hashing. | Live: `evil.example` → 400; `javascript:` → 400; 2 KB URL → 400; trakt.tv → 200 |
| 10 | 🟡 | **`/api/bulk-resolve` leaked raw `SyntaxError` text** with the caller's malformed body at HTTP 500. Now the standard `{"ok":false,"error":"Invalid JSON body."}` + 400 used everywhere else. | Live: malformed body → 400, no internal detail |

### Round 3 — this commit

| # | Severity | Issue | Verified by |
|---|---|---|---|
| D | 🟠 | **`likes` column never existed, so likes were silently KV-only.** `UPDATE creator_lists SET likes = ?` threw on *every* like and the error was swallowed by a bare `catch {}` — a D1 restore would have lost every count. Added the column to `schema.sql` **and** a non-destructive `migrations/0001` for the already-deployed DB (`schema.sql` DROPs everything, so it can never be run against live data). Added an index for popularity sort. The swallowing catch now `console.error`s. | Live w/ D1: 3 likes → `likes=3` in D1; unlike → `2`; **editing a list keeps likes at 2** |
| 11 | 🔴 | **KV→D1 migration never migrated a single list** *(found while verifying D)*. `const [, , u, slug] = k.name.match(...)` skipped one capture group too many, so `slug` was always `undefined`, the `if (u && slug)` guard rejected every key, and the endpoint reported `{"ok":true, lists:0}` — a **silent** no-op that would look like a successful migration. | Live: before `lists: 0` → after `lists: 3`, likes carried across |
| 12 | 🟡 | Migration dropped like counts: `ON CONFLICT DO NOTHING` + no `likes` in the insert would have reset every list to 0 in D1. Now inserts `likes` and repairs it on re-run (`DO UPDATE SET likes=excluded.likes`), leaving all other columns untouched. | Live: wiped D1 rows, re-ran migrate → counts restored from KV |

**Action required on deploy:** run
`npx wrangler d1 execute my-lists-db --remote --file=./migrations/0001_add_likes_to_creator_lists.sql`
once, then POST `/admin/api/migrate-d1` to copy existing KV counts into D1.

### Round 4 — this commit

| # | Severity | Issue | Verified by |
|---|---|---|---|
| A | 🟠 | **Directory and search silently truncated at 150 keys.** Both did `list({prefix,limit:150})` with no cursor then `.slice(0,100)`; KV returns keys lexicographically, so past ~150 lists only the earliest-sorting usernames were ever visible — everyone else vanished with no error. Replaced with a maintained `index:publiclists` blob (one KV read, no per-list gets), rebuilt automatically when absent and updated incrementally on publish/save/unpublish/delete/like. Added `?limit`/`?offset` paging and a `total`. | Live w/ 400 lists: old logic surfaced only `list-0001..0100`; new returns **all 400**, `total:400`. Incremental index **byte-identical** to a forced full rebuild (402 entries) |
| 13 | 🟡 | Directory `.slice(0,100)` ran **before** the private-list filter, so private lists consumed public slots and the page could return fewer than 100 for no visible reason. Index only ever contains public lists. | Live: flipping a list to private removes it; count stays correct |
| 14 | 🟡 | Directory had **no sort at all** — order was whatever KV returned. Index is sorted by likes, then recency, so truncation drops the least popular rather than an arbitrary slice. | Live: 4 likes moved a list to position 1 |
| 15 | 🟡 | Search did a `getCreator` **per result**, so its subrequest count scaled with result size. Display name is denormalised into the index (cached per creator during rebuild). | Live: search returns from one KV read |

**Directory cost: ~102 KV subrequests/page-view → 1.** 402 lists serve in ~3 ms.

Cold-start is handled: the first request after the index is lost takes a 60 s
lock, rebuilds in the background via `waitUntil`, and serves the legacy scan
meanwhile. 20 concurrent cold requests → all HTTP 200, exactly one rebuild.

### Round 5 — PR #3 (`arena/01a06973-my-lists`)

Stacked onto the open PR so later items would not strand off `main`. Head at
merge: `605993c` plus this status update.

| # | Severity | Issue | Verified by |
|---|---|---|---|
| B | 🟠 | **Admin dashboard / leaderboard subrequest wall.** Creator Accounts did one KV `get` per account for `creatorlastseen:` (D1 only replaced enumeration). Past ~1,000 creators that exceeds Cloudflare's 1,000-subrequest cap and `/admin` stops loading. All-time Trending read count+meta for every tracked title. Community Lists read a likes key nothing writes, and `SELECT *` including `items_json` just for `.length`. | Seeded 1,200 creators: 1,215 subrequests → 115 mid-backfill, 14 steady-state. `last_active` mirrored on the 30-min throttle; lazy repair ≤100/load. Leaderboard candidate pool 400 (search all-time 1,000). Likes from D1 / list record; `json_array_length()` + `ORDER BY likes LIMIT 100`; copy counts from one bounded `stats:list_copy:` scan. Commit `84e8661` |
| C | 🟡 | **`visibility` fail-open.** Public exposure was `visibility !== "private"`, so a missing field or typo published a list. Writes now store only an explicit `"public"`; reads require `=== "public"`. Legacy unstamped lists that were already served as public are stamped on index rebuild, public GET, and migrate-d1 so inverted reads do not hide them. | Node tests + stamp on public GET/rebuild. Commit `1931939` |
| E | 🟡 | **CORS `*` on state-changing JSON.** `json()` spread `Access-Control-Allow-Origin: *` onto every JSON response, including POSTs. Simple cross-origin POST (`text/plain`) is not preflighted. `json()` is now CORS-free; catalog/manifest/meta/subtitles/public-list JSON still advertise `*` via `jsonPublic()` / `corsHeaders()`. OPTIONS limited to those public paths. | Commit `d4a232b` |
| F | 🟡 | **`/api/preview` SSRF-adjacent scan oracle.** Unauthenticated fetch of an attacker-named URL. Scheme + provider-host allowlist before `fetchCatalog`; one generic load error; IP rate-limit. | Tests: non-allowlisted URL → 400, no fetch. Commit `33fc481` |
| G | 🟡 | **Rate limits fail open on missing `CF-Connecting-IP`.** Shared `"unknown"` bucket + per-address IPv6. Reject rather than share a bucket; fold IPv6 to `/64`; README notes self-hosting outside Cloudflare has no real per-client limit. | Tests: create/restore/reset-key/feedback without the header fail closed. Commit `4534724` |
| H | 🟡 | **`displayName` silently discarded.** Create overwrote it with the username. Accept `body.displayName`, cap 40, strip controls, fall back to username; escape the early profile-bar render. | Tests: submitted display name stored when valid. Commit `b42f660` |
| I | 🔵 | **Unbounded KV growth.** `feedback:`, `evtcount:`, `searchquery:` never expired. Threads TTL 180 days from last write; day-scoped telemetry 120 days, all-time 400; unique search queries capped per day; admin inbox GETs newest 300 threads. | Commit `d52db9f` |
| J | 🔵 | **No tests, no CI.** Zero test files. Now: Node `node:test` harness vs combined Worker with in-memory KV/D1 — auth matrix, tracking IDOR, feedback threads, isolation, delete-account, key rotation w/ and w/o a D1 row, directory past the old 150-key cap, helper units. GitHub Actions rebuilds from source and fails on `worker_entry_combined.js` drift. `bash verify.sh` runs the same locally. | `node --test tests/*.test.mjs` — 21 pass, 0 fail. Commit `605993c` |

---

## 🔜 Remaining — production only

No further code items from the original remaining list.

1. **Deploy D1 likes column** (once, against live DB — do **not** run `schema.sql`, it DROPs):
   `npx wrangler d1 execute my-lists-db --remote --file=./migrations/0001_add_likes_to_creator_lists.sql`
2. **POST `/admin/api/migrate-d1`** so existing KV lists/counts land in D1 (also stamps visibility).
3. **Close empty PR #2** (`arena/01a068d9-my-lists` @ `3a8e7fe`) if it is still open.

Out of scope for this tracker (named in the original report, not scheduled):
`creatorsynctracking:` optimistic concurrency, provider `AbortSignal.timeout`,
and distinguishing empty catalogs from upstream failure.

---

## Do not "fix" these

Carried from the audit so nobody removes load-bearing code:

- **13 modules fail `node --check` individually** — concatenation fragments by design.
- **`let TMDB_API_KEY = ""`** etc. — reassigned from `env` per request; deleting breaks every provider.
- **`listAllKeys(env.CONFIGS, "creator:")`** — the trailing colon is what stops `creatorlist:`/`creatorsynctracking:` being swept in as accounts.
- **`verifyCreatorKeyMemoized`** — caches successes only, keyed on the stored hash so rotation self-invalidates. Correct as written.
- **`bumpStat`'s lost-update race** — documented, deliberate, fine for telemetry.
- **`/sw.js`'s narrow scope** — intercepts only `/app.js?v=…`; that is precisely why users can't get stuck on stale JS.
