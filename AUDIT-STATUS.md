# AUDIT REMEDIATION STATUS

Live tracker for the findings in [`AUDIT-2026-09.md`](./AUDIT-2026-09.md).
Baseline commit: `e3293d6a`. Branch: `arena/01a068d9-my-lists`.

**Rating movement:** `NOT READY` → **`READY WITH FIXES`** (as of round 2)

The three unauthenticated data-exposure paths and the non-functional account
deletion — the four things that made this unsafe for a second user — are all
closed and verified. What remains is scale and abuse-resistance work, which
degrades quality at growth rather than leaking data today.

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

---

## 🔜 Remaining — in priority order

### 🟠 B. Admin dashboard / leaderboard subrequest wall — *hard failure at scale*
`renderAdminDashboard` does 6 × `listAllKeys` + 2 KV gets per list + 1 per
creator. At ~1,000 creators that exceeds Cloudflare's 1,000-subrequest limit
and the page stops loading entirely. `computeLeaderboard("alltime")` has the
same shape (2 gets per title). Fix: server-side pagination, or render from a
cron-built snapshot.
*Note: when `DB` is bound the dashboard uses `SELECT * FROM creators`, which
sidesteps this for the creators half — this is the real argument for D1.*

### 🟡 C. `visibility` fail-open
Public exposure is decided by `visibility !== "private"` everywhere, and save
stores whatever string arrives. Missing/typo'd field ⇒ treated as **public**.
Fix: normalize to a two-value enum on write, then invert reads to
`=== "public"`. **Compat impact:** existing lists with no `visibility` flip
public→private, so backfill first.

### 🟡 E. CORS `*` on state-changing endpoints
Bounded (credentials are in the body, not cookies; admin is `SameSite=Strict`),
but it lets any page on the internet call the public write endpoints from every
visitor's browser. Drop CORS from creator/like routes; keep on catalog/manifest.

### 🟡 F. `/api/preview` SSRF-adjacent scan oracle
Unauthenticated, fetches an attacker-named URL. Workers' runtime blocks
RFC1918/metadata (probes to `127.0.0.1` and `169.254.169.254` both failed —
**no internal read demonstrated**), but distinct error strings make it a host
scanner and free outbound proxy. Fix: scheme + provider-host allowlist before
dispatch, single generic error.

### 🟡 G. Rate limits fail *open* on missing header
`CF-Connecting-IP || "unknown"` — unspoofable at the real CF edge, so **not
exploitable in production today**, but every header-less client shares one
global bucket, and IPv6 is per-address. Fix: reject rather than share a
bucket; normalize IPv6 to /64.

### 🟡 H. `displayName` silently discarded
`create` reads `body.creatorName` into `displayName`. Currently *load-bearing*:
it forces display names to the validated `[a-z0-9_-]` charset. **Fix the bug and
an XSS surface opens** — must ship with length/control-char validation and an
escaping audit of every render site.

### 🔵 I. Unbounded KV growth
`feedback:`, `evtcount:`, `searchquery:` have no TTL and nothing prunes them.

### 🔵 J. No tests, no CI
Zero test files. Highest value: an authorization matrix (would have caught
findings 1, 3, 6 mechanically), data-isolation, account lifecycle, key
rotation w/ and w/o D1, KV pagination, and a build-drift check.

---

## Do not "fix" these

Carried from the audit so nobody removes load-bearing code:

- **13 modules fail `node --check` individually** — concatenation fragments by design.
- **`let TMDB_API_KEY = ""`** etc. — reassigned from `env` per request; deleting breaks every provider.
- **`listAllKeys(env.CONFIGS, "creator:")`** — the trailing colon is what stops `creatorlist:`/`creatorsynctracking:` being swept in as accounts.
- **`verifyCreatorKeyMemoized`** — caches successes only, keyed on the stored hash so rotation self-invalidates. Correct as written.
- **`bumpStat`'s lost-update race** — documented, deliberate, fine for telemetry.
- **`/sw.js`'s narrow scope** — intercepts only `/app.js?v=…`; that is precisely why users can't get stuck on stale JS.
