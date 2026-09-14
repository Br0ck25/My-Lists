# Storage Architecture Plan — Workers KV vs. D1

**Status:** Completed. All phases (0 through 4) implemented.
**Scope:** Every KV and D1 read/write in the Worker.
**Premise change:** The Cloudflare **free plan is no longer a constraint**. Every storage
decision in this codebase that was made to survive 1,000 KV writes/day or 50 subrequests
per invocation is now open for reconsideration.

---

## 1. Executive summary

The app currently runs on an inverted model:

> **KV is authoritative for everything. D1 is an optional, removable mirror.**

That model was correct under the free plan — KV was the only always-present store, and
D1 was documented as an accelerator you could bind, unbind, or rebuild from `schema.sql`
without data loss. It is documented that way in `wrangler.toml`, `README.md` Step 4, and
in roughly a dozen accessor comments.

It is the wrong model now, and it is costing real correctness, not just speed. The
codebase contains a large amount of machinery whose only purpose is to work around
things KV cannot do:

| Workaround in the code | What it exists to replace |
| --- | --- |
| `index:publiclists:s0..s31` — a 32-shard, ~4.45 MB materialized view rebuilt by cron in resumable chunks with an op budget, a write lock, a 10-second like-write cooldown, and a removal-tombstone key | `SELECT … WHERE visibility='public' ORDER BY likes DESC` |
| `authoritativeKeyHash()` — a second, D1-only read on every auth because edge-cached KV serves pre-rotation key hashes | A strongly-consistent read of one row |
| `evtdayindex:` / `searchquerydayindex:` — hand-maintained per-day key indexes | `WHERE day BETWEEN ? AND ?` |
| `list({prefix:"creatorlist:", limit:80})` + a get per key + in-memory substring match | An indexed `WHERE`/`LIKE` query |
| `readLikeVoters` / `applyLikeVote` — read-modify-write of one JSON ledger key per list | One row per vote, `COUNT(*)` |
| The KV branch of `bumpStat` — measured at **20 concurrent requests recording as 1** | `ON CONFLICT … n = n + excluded.n` (already built, already correct) |

The counters case is the precedent worth reading carefully, because the team already
made this exact call once and it worked: `migrations/0002` moved every counter to D1
*alone*, accepting that unbinding D1 loses them, because KV genuinely could not count.
The proposal below is to finish that reasoning across the rest of the data model.

**The target model:**

> **D1 is authoritative for records, relationships, counters, and anything queried.
> KV is a cache, a hot get-by-key path, and the store for ephemeral/TTL data.**

**Headline numbers for the current state:** 301 KV operations across 10 source files
(165 `get`, 94 `put`, 25 `delete`, 17 `list`) against **~40 distinct key namespaces**;
38 D1 statements against **5 tables**. Roughly three quarters of the KV namespaces hold
data that is queried, filtered, sorted, counted, or related to another record.

---

## 2. Current state — full inventory

### 2.1 Bindings

| Binding | Type | Declared in | Status |
| --- | --- | --- | --- |
| `CONFIGS` | KV namespace | `wrangler.toml` | **Required.** Every stateful feature no-ops silently without it. |
| `DB` | D1 database | `wrangler.toml` (commented out) | **Optional.** Not bound by default. |

Cron: `*/6 * * * *` drives `checkForNewEpisodes()` + `prewarmSharedCatalogs()` +
the public-index rebuild chunk.

### 2.2 D1 today — 5 tables, 38 statements

| Table | Columns | Written by | Read by |
| --- | --- | --- | --- |
| `creators` | username PK, display_name, key_hash, recovery_answer_hash, created_at, last_active | register, migrate-d1, key rotation, `touchCreatorLastSeen`, `backfillCreatorRowInD1` | `getCreator` (fallback only), `authoritativeKeyHash`, admin dashboard |
| `creator_lists` | id PK (`user:slug`), username FK, name, type, visibility, items_json, likes, created_at, updated_at | list save, watchlist save, like, migrate-d1 | `getCreatorList` (fallback only), admin Community Lists |
| `stats` | (kind, day) PK, n | `d1BumpStat`, `bumpStatBy`, migrate-d1 | `readStatCount`, `d1CountsByKindPrefix`, leaderboards |
| `source_groups` | id PK, name, install_count | `bumpStatBy` | admin dashboard |
| `creator_tombstones` | username PK, until | delete-account, register (clears) | `isCreatorTombstoned` |

Indexes: `idx_creator_lists_username`, `idx_creator_lists_visibility`,
`idx_creator_lists_likes`, `idx_creators_last_active`, `idx_creator_lists_vis_likes`,
`idx_stats_day_totals`.

**Hard limit that shapes everything below:** D1's maximum string/row size is
**2,000,000 bytes**. `CREATOR_LIST_BYTES_MAX = 1_800_000` exists precisely because a
list over that ceiling silently stops being mirrored.

**D1 platform limits** (verified against Cloudflare's docs, September 2026). These are
the numbers every decision below is checked against:

| Limit | Value | Where it bites |
| --- | --- | --- |
| Maximum database size | **10 GB** (Paid) / 500 MB (Free) | The real ceiling for the "keep everything" retention policy (§5.4) |
| Maximum string, BLOB, or row size | **2,000,000 bytes** | `items_json`; and why the 24 MB sync blobs cannot move wholesale (§4.4) |
| Queries per Worker invocation | **1,000** (Paid) / 50 (Free) | Was the binding constraint on the index rebuild; gone on Paid |
| Maximum bound parameters per query | **100** | Batch sizing for backfills — chunk at ≤100 params, not ≤100 rows |
| Maximum **LIKE or GLOB pattern: 50 bytes** | 50 bytes | **Decides §5.1's search.** A user-supplied query longer than 50 bytes cannot be a `LIKE` pattern at all |
| Maximum SQL statement length | 100 KB | Fine for everything here |
| Maximum SQL query duration | 30 seconds | Fine |
| Maximum columns per table | 100 | Fine |
| Maximum rows per table | Unlimited (within database size) | — |

Existing `LIKE` call sites are all short fixed prefixes — `catalog_add:%`,
`list_copy:%`, `sourcegroup:%`, `evt:{type}:%` — so none of them is near the 50-byte
pattern cap today. It is only a problem for search over user-supplied text, which is
exactly what §5.1 was undecided about.

### 2.3 KV today — complete namespace inventory

Grouped by what the data actually *is*, with the verdict from §4.

#### A. Identity and authentication

| Key | Contents | Access pattern | Mirrored to D1? | Verdict |
| --- | --- | --- | --- | --- |
| `creator:{username}` | displayName, keyHash, recoveryAnswerHash, createdAt | get by key; `list()`-scanned by admin | Yes (`creators`) | **D1 authoritative**, KV read-through cache |
| `creatorlastseen:{username}` | timestamp | get/put by key | Yes (`creators.last_active`) | **D1 only** |
| `creatordeleted:{username}` | tombstone, TTL 300s | get by key | Yes (`creator_tombstones`) | **Keep in KV** as cheap first check; D1 stays the authority |
| `creatorscrobbletoken:{username}` | token | get by key | No | **D1** — revocation is not safe on KV, see §4.3 |
| `scrobbletoken:{token}` | username (reverse index) | get by key | No | **D1** — same table, unique index |
| `creatorshare:{username}` | share/profile settings | get/put by key | No | **D1** — column(s) on `creators` |
| `authfail:{scope}:{day}` | int, TTL 86400 | get/put | Partial (D1 read at `02:1571`) | **Keep in KV** — approximate is fine, TTL-scoped |
| rate-limit keys (`feedbackrate:`, register/recovery/login limiters) | int, TTL 60/86400 | get/put | No | **Keep in KV** |

#### B. Lists

| Key | Contents | Access pattern | Mirrored to D1? | Verdict |
| --- | --- | --- | --- | --- |
| `creatorlist:{username}:{slug}` | full list incl. items (≤1.8 MB) | get by key; `list()`-scanned for directory, search, admin | Yes (`creator_lists`) | **D1 authoritative**; KV cache for the hot public read |
| `publishedlist:user:{slug}` | anonymous published list | get by key; `list()`-scanned | **No table at all** | **D1** — new `published_lists` table |
| `creatorlistorder:{username}` | ordering array | get/put by key | No | **D1** — `sort_order` column on `creator_lists` |
| `creatorliststamp:{username}` | change stamp for sync | get/put by key | No | **D1** — derived (`MAX(updated_at)`) or a column on `creators` |
| `creatorlistdeleted:{username}` | slug→timestamp tombstones, 30-day window | get/put by key | No | **D1** — new `list_tombstones` table |
| `listlikevoters:{listPath}` | JSON voter ledger, read-modify-write | get/put by key | No (only the derived count) | **D1** — new `list_likes` table, one row per vote |
| `creatorlistlikes:{username}`, `creatorlikes:{username}` | per-user like bookkeeping | get/put | No | **D1** — folded into `list_likes` |

#### C. The public directory index — a materialized view built by hand

| Key | Purpose |
| --- | --- |
| `index:publiclists` | Pre-shard single blob (legacy, still served during upgrade) |
| `index:publiclists:s0` … `:s31` | 32 shards, ~4.45 MB total at the entry cap |
| `index:publiclists:meta` | `builtAt` marker, so the cron can check staleness without merging 32 shards |
| `index:publiclists:build` | Resumable build cursor + cached display names |
| `index:publiclists:likecooldown` | 10s cooldown, because likes were being written faster than KV's ~1 write/sec/key |
| `index:publiclists:removed` | Removal tombstones, TTL 24h |
| `lock:publiclistindex` | Write lock |

Supporting constants: `PUBLIC_INDEX_SHARDS=32`, `PUBLIC_INDEX_BUILD_OPS_PER_RUN=300`,
`PUBLIC_INDEX_BUILD_OPS_ADMIN=800`, `PUBLIC_INDEX_BUILD_PAGE=400`,
`PUBLIC_INDEX_BUILD_CONCURRENCY=12`, `LIKE_INDEX_COOLDOWN_SEC=10`,
`PUBLIC_INDEX_REMOVED_TTL_SEC=86400`.

**Verdict: delete the entire family.** This is ~700 lines implementing one SQL query.

#### D. Per-user sync blobs — the hard case

| Key | Contents | Size guard |
| --- | --- | --- |
| `creatorsync:{username}` | config, keys, collapsedPanels, likedLists, hiddenLists, hiddenMyListsSections | 24 MB |
| `creatorsynctracking:{username}` | watchHistory, continueWatching, watchlist, airingNext | 24 MB |
| `creatorsyncpresets:{username}` | saved presets (incl. Channels with episode lists) | 24 MB |
| `creatorsyncchannels:{username}` | TV Channels | 24 MB |
| `creatorscrobblequeue:{username}` | pending scrobbles | — |
| `scrobbleseenusers:{username}` | seen-user set | — |
| `creatortrack:{username}` | tracking diagnostics | — |

These are whole-blob rewrites read by exact key, with an optimistic-concurrency
`updatedAt` version (`nextSyncVersion`) and a 409 conflict path. **They are the only
genuinely KV-shaped large data in the app** — and three of the four can exceed D1's
2 MB row limit. See §4.4 for the split recommendation: the *records inside them*
(likedLists, hiddenLists, watchHistory) are relational; the *envelope* is not.

#### E. Counters, telemetry, analytics

| Key | Status |
| --- | --- |
| `stats:{kind}:{total\|YYYY-MM-DD}` | **Already D1-only when bound** (`migrations/0002`). Correct. |
| `stats:creator_count` | **Never migrated** — still KV read-modify-write at register time |
| `stats:genres:alltime`, `stats:decades:alltime` | JSON blobs, explicitly excluded from migrate-d1 ("do not belong in an integer column") |
| `stats:sourcegroup:{name}:total` | → `source_groups`. Correct. |
| `evtcount:{type}:{id}:days`, `:alltime` | TTL 120d/400d; D1 path exists (`d1CountsByKindPrefix` reads `evt:{type}:{id}` out of `stats`) |
| `evtdayindex:{type}:{day}` | Hand-built day index — only exists because KV can't range-scan |
| `evtmeta:{type}:{id}` | title + mediaType, TTL 400d |
| `searchquery:{q}:days`, `:alltime` | Search analytics; `kind` dimension is unbounded |
| `searchquerydayindex:{day}` | Hand-built day index |
| `searchq:{q}` | Query bookkeeping |

#### F. Caches — correctly KV, leave alone

| Key | TTL | Note |
| --- | --- | --- |
| `cache:{kvKey}` | varies | Provider API response cache, with per-user cache + circuit breaker |
| `tmdbdetail:{kind}:{id}` | 2,592,000s (30d) | TMDB detail cache |
| **Saved addon configs** (bare 12-char short IDs, `SHORT_ID_LENGTH`) | none | ≤512 KB JSON, read by exact key on **every catalog request**. The single best KV use in the app. |

#### G. Cron cursors and migration state — correctly KV, leave alone

`cron:continuewatching:cursor`, `cron:prewarm:cursor`, `cron:last_warmed:mdblist`,
`backfilltrending:cursor`, `migrated1:state`, `migratedaycounts:state`.

Single-writer scalars, no concurrency, no querying.

#### H. Feedback

| Key | Contents | Access pattern | Verdict |
| --- | --- | --- | --- |
| `feedback:{threadId}` | thread JSON, TTL 180d | `list({prefix:"feedback:", limit:1000})` then get per key, then sort/filter in memory | **D1** — new `feedback` table |

---

## 3. What's actually wrong with the current split

### 3.1 Dual-write without a transaction

Every creator-list save writes D1 first, then KV unconditionally
(`26_api-creator-and-admin-routes.js:2088`–`2140`). A D1 failure is caught, logged, and
swallowed; a KV failure after a successful D1 write is not compensated at all. There is
one self-healing path — `backfillCreatorRowInD1` retries once after a foreign-key
failure — and nothing else. Divergence is repaired only by a human pressing
"Migrate KV → D1".

### 3.2 Authentication reads an eventually-consistent store

`getCreator` reads KV first and only falls back to D1 on a *miss*. Because KV reads are
edge-cached, a colo that did not serve a key rotation keeps authenticating the rotated-away
key — and rejecting the new one. `authoritativeKeyHash` is a second D1 read bolted on to
fix exactly this. With D1 authoritative, both the bug and the workaround disappear.

### 3.3 The public directory is a hand-rolled materialized view

Everything in §2.3.C exists so that `SELECT * FROM creator_lists WHERE visibility='public'
ORDER BY likes DESC LIMIT n` can be answered from a key-value store. The sharding exists
because the merged blob exceeds KV's value limit. The 10-second cooldown exists because
likes were written faster than KV's per-key write rate. The resumable chunked rebuild
exists because a full rebuild exceeded the 1,000-operations-per-invocation cap.
`idx_creator_lists_vis_likes` — the index that makes the SQL version a pure seek with no
sort — **already exists in the schema**.

### 3.4 "Search" is a bounded scan of arbitrary keys

`/api/search-published-lists` falls back to `list({prefix:"creatorlist:", limit:80})`,
gets each key, and substring-matches in memory. `limit: 80` is not "the 80 best matches";
it is the first 80 keys in KV's lexical order. Any deployment with more than 80 lists
returns results that are effectively arbitrary.

### 3.5 The likes ledger has the lost-update bug that was already fixed for counters

`applyLikeVote` is a read-modify-write of a single JSON key. This is the same race
`migrations/0002` documented and fixed for `stats` — measured there at 20 concurrent
requests recording as 1 — left in place for votes.

### 3.6 Anonymous published lists have no D1 representation

`publishedlist:user:{slug}` is KV-only. They appear in the same public directory and the
same search results as creator lists, which is why the index builder has to sweep two
prefixes and why `/admin/api/migrate-d1` phase 2 can only "stamp visibility" rather than
migrate anything.

### 3.7 Unbounded `kind` dimension in `stats`

`list_copy:{slug}`, `watch_type:{type}`, `evt:{type}:{id}` and search analytics all mint
new `kind` values. The table grows as (distinct kinds) × (days). `idx_stats_day_totals`
handles the totals query; the per-kind window scan is still on the primary key. Fine for
now, worth a retention policy (§5.4).

---

## 4. Target model

### 4.1 The rule

- **D1** owns anything with an identity, a relationship, an ordering, a count, or a query.
- **KV** owns caches, single-key hot reads of immutable-ish blobs, TTL'd ephemera, and
  single-writer cursors.
- **R2** owns nothing today — there are no stored large binaries. (`CHANNEL_LOGO_MAX_BYTES`
  bounds an in-memory fetch, not a stored object.) Revisit only if the sync blobs in §4.4
  are moved wholesale.

### 4.2 Records that move to D1 as the source of truth

`creators`, `creator_lists`, `published_lists` (new), `list_likes` (new),
`list_tombstones` (new), `feedback` (new), `scrobble_tokens` (new), `creator_tombstones`,
`stats`, `source_groups`, plus `event_meta` (new).

KV keeps a **read-through cache** for the two hottest public reads — `creator:{username}`
and `creatorlist:{username}:{slug}` — written on read-miss and invalidated on write, with
a TTL. That is a cache, not a mirror: it is never read as an authority and never needs
reconciling.

### 4.3 Records that stay in KV

- Saved addon configs (short IDs) — get-by-key on every catalog request, ≤512 KB, no query.
- `cache:*`, `tmdbdetail:*` — provider response caches.
- Rate limiters, `authfail:*`, `creatordeleted:*` — TTL'd, approximate-tolerant.
- Cron cursors and migration state — single-writer scalars.
**Scrobble tokens are the one thing that moves out of this list.** They look KV-shaped
— a bidirectional lookup on a hot path — but `getOrCreateScrobbleToken(env, username,
rotate)` makes them a *rotating credential*, and rotation on KV has the exact failure
`authoritativeKeyHash` was written to defeat: the write deleting the old token key is
edge-cached, so a colo that has not seen it keeps accepting a revoked token for the
length of that window. A revoked credential that still authenticates is not a
performance issue. D1 is strongly consistent and this is a primary-key lookup, so the
cost is one indexed read. **Do not put a KV cache in front of it** — that reintroduces
precisely the staleness being removed.

### 4.4 The sync blobs — split, don't move wholesale

Do **not** put a 24 MB blob in D1; it cannot hold one (2 MB row limit). Instead:

| Current blob field | Target |
| --- | --- |
| `likedLists`, `hiddenLists`, `hiddenMyListsSections` | **D1** — they are relationships between a user and lists, and `likedLists` duplicates what `list_likes` will already know |
| `watchHistory`, `continueWatching`, `airingNext` | **D1** — one row per (user, item); these are queried, sorted by date, and swept by cron. This is what makes `checkForNewEpisodes` stop rewriting a whole blob per account. |
| `watchlist` | **D1** — already mirrored into `creator_lists` as the `watchlist` slug |
| `presets`, `channels` | **KV**, unchanged — opaque client-owned configuration, only ever read whole by its owner |
| `config`, `keys`, `collapsedPanels` | **KV**, unchanged — per-user UI state, opaque, read whole |

This is the change with the largest blast radius and the least urgency. It should be
**phase 4**, after everything else has proven the model.

---

## 5. Concrete schema additions

```sql
-- Anonymous published lists (currently KV-only)
CREATE TABLE published_lists (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'private',
    items_json  TEXT NOT NULL DEFAULT '[]',
    likes       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_published_vis_likes ON published_lists(visibility, likes DESC, updated_at DESC);

-- One row per vote. Replaces listlikevoters:{listPath} read-modify-write.
CREATE TABLE list_likes (
    list_id   TEXT NOT NULL,   -- 'c:{user}:{slug}' or 'a:{slug}'
    voter_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, voter_id)
);
CREATE INDEX idx_list_likes_voter ON list_likes(voter_id);

-- Replaces creatorlistdeleted:{username}
CREATE TABLE list_tombstones (
    username TEXT NOT NULL,
    slug     TEXT NOT NULL,
    until    INTEGER NOT NULL,
    PRIMARY KEY (username, slug)
);

-- Replaces feedback:{threadId} + its list()-scan
CREATE TABLE feedback (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'open',
    subject     TEXT,
    body_json   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_feedback_status_updated ON feedback(status, updated_at DESC);

-- Replaces scrobbletoken:{token} + creatorscrobbletoken:{username}.
-- One row per issued token; rotation is a DELETE + INSERT in one batch, so a
-- revoked token stops working everywhere at once.
CREATE TABLE scrobble_tokens (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_scrobble_tokens_user ON scrobble_tokens(username);

-- Replaces evtmeta:{type}:{id}
CREATE TABLE event_meta (
    event_type TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    title      TEXT,
    media_type TEXT,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (event_type, item_id)
);
```

Search index — see §5.1 for why this is FTS5 and not `LIKE`:

```sql
-- Derived, fully rebuildable from the two base tables. Never a source of truth.
CREATE VIRTUAL TABLE lists_fts USING fts5(
    list_id UNINDEXED,
    name,
    creator_name,
    username,
    tokenize = 'unicode61 remove_diacritics 2'
);
```

Column additions:

```sql
ALTER TABLE creators      ADD COLUMN share_json  TEXT;      -- creatorshare:{username}
ALTER TABLE creators      ADD COLUMN lists_stamp INTEGER;   -- creatorliststamp:{username}
ALTER TABLE creator_lists ADD COLUMN sort_order  INTEGER;   -- creatorlistorder:{username}
```

### 5.1 Queries the new schema replaces

| Today | After |
| --- | --- |
| Merge 32 KV shards, sort in memory | `SELECT … FROM creator_lists WHERE visibility='public' ORDER BY likes DESC, updated_at DESC LIMIT ?` (uses `idx_creator_lists_vis_likes`, already present) |
| `list(prefix)` + get-per-key + substring match | `SELECT list_id FROM lists_fts WHERE lists_fts MATCH ? ORDER BY rank` joined back to the base tables — **FTS5, confirmed available** (§5.1a) |
| `readLikeVoters` → parse → mutate → put | `INSERT OR IGNORE INTO list_likes …` / `DELETE FROM list_likes …`; count is `SELECT COUNT(*)` |
| `feedback:` list-scan of up to 1,000 keys | `WHERE status=? ORDER BY updated_at DESC LIMIT ?` |
| `evtdayindex:` fan-out | `WHERE day BETWEEN ? AND ? GROUP BY kind` (already implemented in `d1CountsByKindPrefix`) |

### 5.1a Search: FTS5, with one operational string attached

**FTS5 is available on D1.** Cloudflare's SQL-support docs list "FTS5 module for
full-text search (including `fts5vocab`)" as supported, alongside the JSON extension and
math functions. Nothing account-specific gates it — if your database runs the migrations
in this repo today, it will accept a `CREATE VIRTUAL TABLE … USING fts5(…)`.

**Use it rather than `LIKE`, and the deciding factor is not speed.** D1 caps a `LIKE` or
`GLOB` pattern at **50 bytes**. A search box is user-supplied text, so a `LIKE`-based
search is not merely slow on long queries — it cannot express them. `LIKE` was never a
viable primary path here; it is at best a fallback for short queries, and FTS5 also gives
ranking (`ORDER BY rank`) that the current in-memory substring match has no equivalent for.

**The string attached — this is the one real cost, and it needs a decision recorded:**

> "Export is not supported for virtual tables, including databases with virtual tables."

So once `lists_fts` exists, `wrangler d1 export` and the dashboard's export button stop
working **for the whole database**, not just that table. Cloudflare's documented
workaround is to drop the virtual table, export, and recreate it.

That is acceptable here for one specific reason: `lists_fts` is **derived**. It is an
index over `creator_lists` and `published_lists` and contains no fact that is not in
those tables. Losing it costs a rebuild, never data. Concretely:

1. Populate it from the same write path that writes the base row (or a trigger), never
   independently — it must not be able to hold something the base tables do not.
2. Ship an admin **"Rebuild search index"** action: `DROP TABLE lists_fts; CREATE …;
   INSERT INTO lists_fts SELECT …`. This is the direct replacement for the
   "Rebuild public index" button Phase 1 deletes, and it is also the export procedure.
3. Document the backup sequence in README's D1 section: drop `lists_fts` → export →
   recreate via the admin action.

**If losing one-command export is unacceptable**, the fallback is a `search_text` column
on each base table (lowercased `name || ' ' || creator_name || ' ' || username`) with a
`LIKE ?` query, accepting the 50-byte pattern cap by truncating the query server-side.
It keeps export working and is strictly worse at its job. The recommendation is FTS5.

### 5.2 Counters still missing from D1

`stats:creator_count` → `SELECT COUNT(*) FROM creators` (drop the key entirely).
`stats:genres:alltime` / `stats:decades:alltime` → **normalize** into `stats` rows with
kinds `genre:{name}` and `decade:{n}`. **Decided.** Three reasons:

- They are rendered as a *ranked list*, which is a sort — the operation KV is worst at.
  Today the whole blob is read and sorted in memory on every dashboard load.
- They are written by `bumpJsonCounterBlob`, a read-modify-write of a single JSON key, and
  so carry the same lost-update race `migrations/0002` removed from every other counter.
  Normalizing puts them on the atomic `ON CONFLICT … n = n + excluded.n` upsert with
  everything else.
- `idx_stats_day_totals` is covering for `WHERE day='total' … ORDER BY n DESC`, so the
  ranked read becomes an index seek with no sort and no table access.

Note this makes them the *only* two kinds where an existing KV blob must be exploded into
many rows rather than copied one-for-one, so `/admin/api/migrate-d1` needs a small extra
branch (the current code explicitly skips them: "JSON blobs … none of them belong in an
integer column").

### 5.3 Make D1 required

`wrangler.toml` should uncomment `[[d1_databases]]` and README Step 4 should become
**Step 4 — (Required)**. The "D1 is optional and removable at any time" contract is what
forces every accessor into the KV-first-then-fallback shape, and it is what makes the
dual-write divergence unfixable. Dropping it is the precondition for most of the
simplification below.

### 5.4 Retention — keep everything

D1 has no TTL. Several of these namespaces get expiry for free from KV today
(`evtmeta:` 400 days, `evtcount:` 120/400 days, `feedback:` 180 days); once they move,
nothing expires unless something deletes it. **That is the desired outcome: no analytics,
telemetry or feedback prune. Keep the full history.**

What that commits you to:

- **The ceiling is the 10 GB database size limit** (Workers Paid). That is the number to
  watch — not a row count, and not an age.
- `stats` grows as (distinct `kind` values) × (days). The `kind` dimension is unbounded
  by construction: `list_copy:{slug}`, `watch_type:{type}`, `evt:{type}:{id}`, `genre:{…}`
  and the search-analytics kinds each mint new values. At roughly 40 bytes per row, a
  million rows is ~40 MB — the ceiling is a long way off, but it is not infinite.
- Growth is a **storage** question, not a latency one: `idx_stats_day_totals` is covering
  for the hot totals query, so reads do not degrade as the table fills.

**Add a size monitor, not a prune.** Surface row counts and database size on the admin
dashboard's existing diagnostics panel, so the ceiling is something you watch approaching
rather than discover. If it ever does come into view, the first move is **rollup, not
deletion** — fold daily buckets older than N months into monthly ones (`day = 'YYYY-MM'`),
which preserves every series at lower resolution. Deletion stays off the table.

**One exception: tombstones.** `creator_tombstones` and `list_tombstones` rows are
semantically spent once `until` has passed — `migrations/0004` already states a
deployment "can safely delete rows whose `until` has passed". Pruning those is not data
loss, and it keeps "a row means deleted, full stop" unambiguous. Prune those on the cron;
keep everything else indefinitely.

---

## 6. Migration plan

Each phase is independently shippable and independently revertible. Phases 1–3 are
strictly additive to D1 and leave KV writes in place, so a rollback is a code revert with
no data loss.

### Phase 0 — Make D1 required (prerequisite) — Completed

1. Uncomment the `[[d1_databases]]` block in `wrangler.toml`; rewrite its comment.
2. README Step 4 → Required; move it before Step 3's "every stateful feature" warning.
3. Run `schema.sql` + all migrations on the live database; run `/admin/api/migrate-d1`
   to convergence.
4. Add a boot-time assertion: no `DB` binding ⇒ a loud, visible admin banner (not a
   silent no-op — the current failure mode for a missing binding).

**Risk:** low. Nothing changes behaviourally; this only removes the "optional" contract.

### Phase 1 — Kill the public list index — Completed

The highest-value, lowest-risk change: it deletes the most code, removes the most
failure modes, and touches no write path that users can see.

1. Add `published_lists` (migration `0006`) and backfill from `publishedlist:user:*`.
2. Rewrite `/lists/public.json` and `getPublicListIndex` as a `UNION ALL` over
   `creator_lists` and `published_lists`, both filtered on `visibility` and ordered by
   `likes DESC, updated_at DESC`.
3. Rewrite `/api/search-published-lists` against `lists_fts` (§5.1a), populated from the
   same write path as the base rows, plus the admin "Rebuild search index" action that
   doubles as the export procedure.
4. Delete: `readPublicListIndex`, `readPublicListIndexMeta`, `writePublicListIndex`,
   `updatePublicListIndex`, `rebuildPublicListIndex`, `advancePublicListIndexBuild`,
   `refreshPublicListIndexIfStale`, `claimLikeIndexWrite`, `removeListsFromPublicIndex`,
   `readPublicIndexBuildState`, `emptyPublicIndexBuildState`, `sortPublicIndexEntries`,
   and all 7 `index:publiclists*` / `lock:publiclistindex` keys.
5. Drop the index-rebuild leg from `scheduled()`; the cron keeps only Continue Watching
   and chart pre-warming, freeing its whole op budget.
6. Optional: a short-TTL KV cache of the rendered directory JSON, keyed by page —
   a *cache* this time, with no rebuild machinery behind it.

**Verification:** the directory and search must return the same entries, in the same
order, before and after. Worth a fixture test that runs both paths against the same
dataset and diffs.

### Phase 2 — Identity and lists become D1-authoritative — Completed

1. Invert `getCreator` and `getCreatorList`: read D1 first, fall back to KV only for
   records not yet migrated, and populate the KV cache on the way out.
2. Delete `authoritativeKeyHash` — a D1-first read is already authoritative.
3. `creatorlastseen:{username}` → drop the KV key; `creators.last_active` is already
   written by `touchCreatorLastSeen`.
4. Add `sort_order`, `lists_stamp`, `share_json`; migrate `creatorlistorder:`,
   `creatorliststamp:`, `creatorshare:`.
5. Add `list_tombstones`; migrate `creatorlistdeleted:`.
6. Convert the KV writes in the save paths from "unconditional mirror" to
   "cache invalidate + repopulate".

**Risk:** this is the auth path. Ship behind a flag, with the KV fallback retained for
one full release cycle, and watch the `sync_conflict` / auth-failure counters.

### Phase 3 — Likes, feedback, telemetry — Completed

1. Add `list_likes`; backfill from `listlikevoters:*`. Rewrite `applyLikeVote` /
   `readLikeVoters` as insert/delete. Keep `creator_lists.likes` as a maintained
   denormalized count (updated in the same batch) so the directory ordering stays an
   index seek.
2. Add `feedback`; migrate `feedback:*`; rewrite the admin feedback panel's list-scan.
3. Add `event_meta`; migrate `evtmeta:*`. Route `evtcount:*` and `searchquery:*` writes
   through `d1BumpStat` (the read path already prefers D1). Delete `evtdayindex:*` and
   `searchquerydayindex:*`.
4. Migrate `stats:creator_count` (or drop it — it is `SELECT COUNT(*) FROM creators`),
   and explode `stats:genres:alltime` / `stats:decades:alltime` into `genre:{name}` /
   `decade:{n}` rows per §5.2. Route `bumpJsonCounterBlob` through `d1BumpStat`.
5. Add `scrobble_tokens`; migrate both token keys; make rotation a single D1 batch
   (`DELETE` old + `INSERT` new) so revocation takes effect everywhere at once.
6. Add the tombstone-only prune and the size monitor from §5.4. **No analytics prune.**

### Phase 4 — Sync blob split (largest, least urgent) — Completed

Per §4.4: move `watchHistory`, `continueWatching`, `airingNext`, `likedLists`,
`hiddenLists` into row-per-item tables; leave `config`, `keys`, `collapsedPanels`,
`presets`, `channels` in KV. Reconsider R2 only if any residual KV blob approaches
25 MB in practice.

**Precondition:** phases 1–3 shipped and stable. This one changes the client sync
protocol and its optimistic-concurrency contract (`nextSyncVersion`, the 409 path), so
it needs its own design pass.

---

## 7. What deliberately does not change

- Saved addon configs stay in KV. They are read by exact key on the hottest path in the
  app and never queried.
- `cache:*` and `tmdbdetail:*` stay in KV. Cached upstream responses are exactly what KV
  is for.
- Rate limiters and `authfail:*` stay in KV. TTL for free, and approximate is correct.
- Cron cursors stay in KV. Single writer, no query.
- `presets` / `channels` sync blobs stay in KV. Opaque, owner-only, whole-blob.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| D1 becomes a hard dependency; an outage is now user-visible rather than degraded | Keep the KV read-through cache warm with a TTL long enough to serve public reads through a short D1 outage. Accept that writes fail — they already do for the counters. |
| 2 MB row limit vs. `items_json` | Already enforced at 1.8 MB. Phase 1's `published_lists` needs the same guard, which the anonymous path does not currently have. |
| D1 row/read pricing at scale | Paid plan removes the free-tier cliff, but the directory query should still be capped and cached. |
| Backfill correctness | Every phase's backfill should be idempotent and resumable, following the existing `/admin/api/migrate-d1` pattern (phase cursor in KV, op budget, `ON CONFLICT DO UPDATE`). |
| Ordering drift between old and new directory | Fixture test diffing both paths, per Phase 1. |
| `lists_fts` disables `wrangler d1 export` for the whole database | The table is derived and rebuildable; ship the admin rebuild action *before* the FTS5 table exists, and document drop → export → recreate in README (§5.1a). |
| Unbounded `stats` growth under "keep everything" | 10 GB ceiling, a dashboard size monitor, and rollup-to-monthly as the escape hatch — never deletion (§5.4). |

---

## 9. Readiness — what exists, what is missing

**Everything needed to execute this plan already exists in the repo.** The gaps are
additive work, not prerequisites to go acquire.

### Already in place

| Need | Status |
| --- | --- |
| A D1 database with all migrations applied | Confirmed by the owner (`0001a`–`0005`) |
| A test harness that exercises D1 | `tests/harness.mjs` backs D1 with **real SQLite** (`node:sqlite`), loaded from the committed `schema.sql`, with `PRAGMA foreign_keys = ON` to match D1's documented default |
| Fault injection for partial-write paths | `makeD1().failWhen` / the matching KV hook already cover "KV healthy, D1 fails" — the exact class Phase 2 changes |
| Realistic KV semantics in tests | The harness models opaque, key-positioned cursors rather than offsets |
| Regression coverage | 405 worker tests, 95 client tests, 10 helper tests |
| Schema-drift protection | Test **A15** already asserts a fresh `schema.sql` and a migrated database end up the same shape — every new migration below must keep that green |
| FTS5 testability | **Verified:** `node:sqlite` on Node 22.22 supports `CREATE VIRTUAL TABLE … USING fts5` and `MATCH … ORDER BY rank`, so the Phase 1 search path is coverable by the existing harness |
| Build + CI | `build.py` (byte-exact concat), `verify.sh` (build-drift, `node --check`, `scope_check.mjs`), `.github/workflows/ci.yml` |

The test harness is the single most important asset here: a refactor that moves the
source of truth is exactly the kind of change that a KV/D1 mock would wave through and a
real-SQLite harness with fault injection will catch.

### Gaps to close as part of the work

1. **`wrangler.toml` still has `[[d1_databases]]` commented out.** If you deploy from the
   dashboard the binding is set there and this file is not read — but Phase 0 must
   uncomment it regardless, or a `wrangler` deploy silently ships without D1.
2. **Migrations `0006`+ do not exist yet** — one per new table (§5), each idempotent and
   each mirrored into `schema.sql` to keep test A15 green.
3. **No backfill jobs yet** for the new tables. Follow the existing
   `/admin/api/migrate-d1` pattern: phase cursor in KV, op budget, resumable,
   `ON CONFLICT DO UPDATE`.
4. **No "Rebuild search index" admin action** — required by §5.1a *before* `lists_fts`
   exists, since it doubles as the database-export procedure.
5. **No dashboard size monitor** — required by §5.4, because "keep everything" makes the
   10 GB ceiling the thing to watch.

### Does this actually end the inverted model?

**After Phases 0–3: yes, for every record.** Accounts, lists, anonymous published lists,
likes, list ordering, tombstones, feedback, scrobble tokens, counters and telemetry all
become D1-authoritative. What remains in KV — response caches, saved addon configs,
rate limiters, cron cursors — is there because it is genuinely key-value, not because KV
is standing in for a database. The read-through caches added in Phase 2 are caches: never
read as an authority, never reconciled.

**But the inversion is not fully gone until Phase 4.** The per-user sync blobs
(`creatorsync:`, `creatorsynctracking:`) stay KV-authoritative through Phase 3, and they
contain relational data — `watchHistory`, `continueWatching`, `airingNext`, `likedLists`,
`hiddenLists`. Those are queried, sorted by date, and swept by cron out of a whole-blob
rewrite. That is the same inversion, just confined to one place.

**One transitional hazard to plan for:** between Phase 3 and Phase 4 there are two
sources of truth for "which lists has this user liked" — the new `list_likes` table and
`likedLists` inside the sync blob. Phase 3 should make `list_likes` authoritative and
treat the blob's copy as a client-side cache the server ignores on read, rather than
leaving both live. Otherwise Phase 3 reintroduces, for one field, the divergence the
whole plan exists to remove.

So: **Phases 0–3 fix the model; Phase 4 finishes the job.** Phase 4 is deferred not
because it is optional but because it changes the client sync protocol and its
optimistic-concurrency contract (`nextSyncVersion`, the 409 path), and that deserves its
own design pass on a foundation that has already proven itself.

---

## 10. Decisions taken

The four questions this plan opened with are now closed. Recorded here with the reasoning,
because each one shapes a phase.

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 1 | FTS5 available? | **Yes — use it.** | Cloudflare's docs list FTS5 (incl. `fts5vocab`) as supported; nothing is account-gated. The deciding factor turned out not to be availability but D1's **50-byte cap on `LIKE`/`GLOB` patterns**, which makes `LIKE` unable to express a normal search query at all. Cost: virtual tables disable database export — accepted, because `lists_fts` is derived and rebuildable. See §5.1a. |
| 2 | Scrobble tokens → D1? | **Yes, move them.** | They are a *rotating credential*, not a static lookup. KV's edge cache lets a revoked token keep authenticating on colos that have not seen the delete — the same failure `authoritativeKeyHash` exists to defeat. No KV cache in front of it. See §4.3. |
| 3 | Genres/decades? | **Normalize into `stats` rows.** | They are rendered as a ranked list (a sort), and they are written by a read-modify-write of one JSON key, carrying the lost-update race every other counter had removed in `migrations/0002`. See §5.2. |
| 4 | Retention? | **Keep everything.** | No analytics, telemetry or feedback prune. The constraint becomes the 10 GB database ceiling rather than an age cutoff; manage it with a dashboard size monitor and, only if needed, rollup to monthly buckets rather than deletion. Expired tombstone rows are the sole exception. See §5.4. |
