# PRODUCTION AUDIT REPORT — My-Lists

**Date:** 2026-09-05
**Scope:** Full repository, independent pass. Prior `AUDIT-*.md` files were deliberately not read;
every finding below was rediscovered and re-verified from the source and by executing the Worker.
**Method:** repository inventory → build → static cross-referencing → live route execution against an
in-memory Worker harness with instrumented KV → targeted exploit probes.

---

## Executive Summary

**Overall rating: READY WITH FIXES** — both Phase 1 blockers have since been fixed and verified;
see the Resolution notes on findings 1 and 2. What remains is Phase 2 and below.

The codebase is in good shape and has clearly been engineered with care. Authentication is sound
(PBKDF2 with per-credential salt, constant-time compare, uniform anti-enumeration errors), cross-user
data isolation holds under direct attack, every admin endpoint is guarded, the build is reproducible
with a CI drift gate, and the 106-test suite passes. Several classes of bug that this kind of app
usually has — stored XSS in the admin panel, unresolved inline handlers, duplicate element IDs,
stale-JavaScript service-worker traps, source/generated drift, credential leakage in error messages —
were specifically tested for and are **not** present.

Two issues should be fixed before the user base grows, and both are *silent* failures:

1. **The public list directory permanently breaks itself at scale.** Past roughly 500 public lists the
   index rebuild exceeds Cloudflare's 1,000-subrequest-per-invocation limit, throws inside a
   `waitUntil`, never writes the index, and the directory falls back forever to a truncated
   lexicographic scan. No error surfaces anywhere. **Worse: an unauthenticated attacker can force this
   condition in about 90 minutes on a deployment with only 20 real lists**, because *private* junk
   lists still cost the rebuild one KV read each before the visibility filter runs.
2. **Creator accounts can be taken over by brute-forcing the recovery answer.** The only throttle is
   per-IP; there is no per-account counter, no lockout, and no minimum answer entropy. Rotating IPs
   defeats it entirely, and the endpoint hands back a working Creator Key.

Everything else is meaningful but not release-blocking.

---

## Critical Findings

### 1. Public list index rebuild dies past ~500 lists; directory silently truncates forever

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Confidence** | Confirmed by execution |
| **File** | `02_http-and-creator-utils.js` |
| **Function** | `rebuildPublicListIndex` (line 1480), reached via `getPublicListIndex` (`03_admin.js`) |
| **Status** | **FIXED** — see "Resolution" at the end of this finding |

**Problem.** `rebuildPublicListIndex` calls `listAllKeys(env.CONFIGS, "creatorlist:")` with **no
`maxKeys` cap**, then issues **one sequential `env.CONFIGS.get()` per list** (line 1508), plus one per
distinct creator for the display name, plus the same again for `publishedlist:user:` (line 1538).
Cloudflare caps a Worker invocation at 1,000 subrequests; KV reads count.

**Evidence.** Instrumented KV, measured directly:

| Public lists | KV ops for one `GET /lists/public.json` | Over the 1,000 limit? |
|---|---|---|
| 200 | 508 | no |
| 1,000 | **2,108** | **yes, 2.1×** |
| 3,000 | **6,110** | **yes, 6.1×** |

It is ~2 ops per list, so the cliff is at **≈500 lists**, not 1,000.

With the real 1,000-subrequest cap enforced in the harness, on a store of 1,000 lists:

```
attempt 1: HTTP 200  lists returned = 100  index written = NO
attempt 2: HTTP 200  lists returned = 100  index written = NO
attempt 3: HTTP 200  lists returned = 100  index written = NO

Directory permanently serves the legacy bounded scan.
  lists visible: 100 of 1000
  creators visible: user00000 .. user00099 (lexicographic head only)
```

The throw happens inside `ctx.waitUntil(rebuildPublicListIndex(env).catch(...))` (line 1591), so it is
caught and logged and nothing else. `getPublicListIndex` takes a 60-second lock and retries every
minute, failing identically every time. `scheduled()` calls it too, so the cron "self-heal" is also
dead. The user-visible result is a directory and a search that show only the alphabetically-first
100 creators, indefinitely, with **no error anywhere**.

**Impact — this is also an unauthenticated denial-of-service.** `rebuildPublicListIndex` reads each
record *before* testing visibility, so a list that never appears in the directory still costs a
subrequest. `/api/publish-list` is unauthenticated and allows 10 permanent keys per minute per IP, and
anonymously published lists default to `visibility: "private"` — invisible. Measured:

```
20 real public lists + 900 private junk keys
   KV ops for the rebuild: { get: 1042, put: 2, list: 4 }  TOTAL: 1048
   directory entries produced: 20
   *** rebuild would EXCEED the 1000-subrequest limit and never complete ***
```

≈90 minutes of traffic from one IP permanently breaks the directory of a 20-list deployment, and the
junk that caused it is invisible in every UI.

**Fix (smallest safe change).** Make the rebuild bounded and resumable instead of all-or-nothing:

1. Cap the scan per invocation — `listAllKeys(env.CONFIGS, "creatorlist:", REBUILD_KEYS_PER_RUN)`
   with `REBUILD_KEYS_PER_RUN ≈ 300` — and read the records in bounded-concurrency batches rather
   than one at a time.
2. Persist a rebuild cursor (`index:publiclists:cursor`) and accumulate entries across cron ticks,
   writing the completed index only when the cursor exhausts. The cron already runs every 6 minutes,
   so a 20,000-list index converges in a few hours instead of never.
3. Keep serving the previous index while a rebuild is in progress, rather than falling back to the
   truncated scan.
4. Independently: give `/api/save` and `/api/publish-list` keys an `expirationTtl`, or add a sweep,
   so unreferenced anonymous records cannot accumulate forever (see M4).

`updatePublicListIndex` already maintains the index incrementally on publish/unpublish, so the full
rebuild only needs to be a cold-start/repair path — it does not need to complete inside one request.

**Test.** Seed 1,200 public lists plus 900 private ones against a KV mock that throws after 1,000
operations; assert the index key is written and that `/lists/public.json?offset=1000` returns the tail.

### Resolution (applied)

The rebuild is now resumable and budget-bounded, in the same shape as the existing
`/admin/api/migrate-day-counts`: one page of keys per invocation, progress parked in
`index:publiclists:build`, and the finished index published only once the final page lands. Records
are fetched with bounded concurrency instead of one serialised round-trip each, and every KV call the
chunk makes is counted so the budget reflects what was actually spent.

- `PUBLIC_INDEX_BUILD_OPS_PER_RUN = 300` — a chunk usually shares its invocation with the cron, so it
  gets a minority of the 1,000. A chunk that throws saves no progress, so an over-generous budget
  would have reproduced the very failure being fixed.
- `PUBLIC_INDEX_BUILD_OPS_ADMIN = 800` — `/admin/api/rebuild-public-index` has the invocation to
  itself. It now returns `{ done, count, scanned }` and the admin UI loops it until done, matching
  `runMigrateDayCounts`.

Measured after the change, against a KV that enforces the real 1,000-subrequest limit:

| Scenario | Before | After |
|---|---|---|
| 20 lists | 1 tick, fine | 1 tick — unchanged |
| 20 real + 900 private junk | **never completes** | 31 ticks, all 20 listed |
| 1,000 public lists | **never completes**, 100 visible | 7 ticks, all 1,000 listed |
| 3,000 public lists | **never completes**, 100 visible | 20 ticks, all 3,000 listed |

Peak subrequests in any single invocation: **418** (was unbounded). Six regression tests were added
under `audit fix: the public list index rebuilds at any scale` covering scale, the invisible-record
attack, single-publication and state cleanup, recovery from corrupt/stale resume state, concurrent
chunk attempts, and the admin loop. **Verified they fail against the pre-fix code** (3 failures) and
pass after. Full suite: 112/112, `verify.sh` green.

**Same bug class, also now fixed:** `/admin/api/migrate-d1` did the identical unbounded
`listAllKeys` + per-key `get` sweep, across five prefixes in one invocation, with a D1 write per key
on top — and both KV reads and D1 statements count against the same 1,000. Verified: with 2,000
creators and 2,000 lists it died outright with `Too many subrequests`. That failure is worse than
merely incomplete, because per `wrangler.toml` an account left in KV but missing from D1 is precisely
the case the key-rotation endpoints get wrong (a D1 `UPDATE` matching zero rows still reports
success) — so the endpoint whose job is to prevent that state was the thing creating it.

It now chunks against `migrated1:state` the same way, with `MIGRATE_D1_OPS_PER_RUN = 700` (it has its
invocation to itself). Measured: 2,000 creators + 2,000 lists complete in 12 calls, peak **702**
subrequests, every account present in D1. Every write in the sweep was already idempotent
(`DO NOTHING`, or `DO UPDATE` to a value derived only from KV), which is what makes re-processing a
key across a chunk boundary safe. Two regression tests added, confirmed failing against the pre-fix
code.

---

### 2. Creator account takeover by brute-forcing the recovery answer

| | |
|---|---|
| **Severity** | 🔴 Critical |
| **Confidence** | Confirmed by execution |
| **File** | `26_api-creator-and-admin-routes.js` |
| **Function** | `/api/creator/reset-key` (line 1168); answer set at line 1111 |
| **Status** | **FIXED** — see "Resolution" at the end of this finding |

**Problem.** The endpoint accepts `{ username, recoveryAnswer }` and, on a match, returns a brand-new
working Creator Key — full account takeover. The only throttle is `resetkeyrate:{ip}:{day}`, **10 per
IP per day**. There is:

- no per-account attempt counter, so the account under attack has no protection at all;
- no lockout and no notification to the owner;
- no minimum length or complexity on the answer when it is set (line 1111);
- lowercasing on both set and check, further shrinking an already small space.

Recovery answers are inherently low-entropy ("first pet", "home town"). The per-IP limit throttles the
wrong dimension: IPs are cheap and rotate, a specific victim's account does not.

**Evidence.** Rotating the source IP per guess, against a user whose answer was `fluffy`:

```
### P1 TAKEOVER via recovery answer
{ "ok": true, "creatorName": "victim", "displayName": "victim",
  "creatorKey": "MYL-6HBE-SDRK-NPWZ" }

### P1 per-account throttle present?
NO - took over on guess #5 using rotating IPs
```

The returned key is immediately valid for every authenticated endpoint.

**Fix.** Add a per-account counter beside the per-IP one, and enforce answer entropy at creation:

```js
// alongside the existing resetkeyrate:{ip}:{day} check
const acctKey = `resetkeyacct:${v.normalized}:${statsToday()}`;
const acctCount = parseInt(await env.CONFIGS.get(acctKey), 10) || 0;
if (acctCount >= 5) return json({ ok: false, error: genericError });
await env.CONFIGS.put(acctKey, String(acctCount + 1), { expirationTtl: 86400 });
```

Increment it on *failure* only, so a legitimate owner is not locked out by their own success, and
count it *before* the answer comparison so it cannot be skipped. At `/api/creator/create`, reject a
`recoveryAnswer` shorter than ~8 characters rather than silently accepting `cat`. Because this
counter is the primary defence for a weak credential, it should not rely on KV alone (see M1) —
prefer the D1 atomic-upsert path already used by `d1BumpStat` when `env.DB` is bound.

**Test.** 6 failed resets against one username from 6 different IPs; assert the 6th is rejected even
with the correct answer, and that a different username is unaffected.

### Resolution (applied)

Two changes, of which the first is the load-bearing one:

1. **Per-account failure budget** (`RESET_KEY_ACCOUNT_MAX_FAILURES = 5`/day), on top of the existing
   per-IP counter. Counted on failures only, so answering correctly never spends the budget that
   protects you, and a locked account frees itself the next day without an admin. Checked *after* the
   profile is known to exist and to have a recovery answer — so a wrong or unknown username can never
   spend, or create, an account budget — and *before* the PBKDF2 verify, so a throttled attempt is
   free. The response is the same generic message as every other failure path, preserving the
   endpoint's anti-enumeration property.
2. **Entropy floor** (`RECOVERY_ANSWER_MIN_LENGTH = 8`) on newly set answers, enforced server-side
   and mirrored in the create-profile modal so the message lands next to the field. The answer stays
   optional. Existing short answers are untouched — the per-account budget is what protects those.

Uses D1's atomic upsert via the existing `d1BumpStat` when `env.DB` is bound, falling back to KV
otherwise, so the counter cannot be lost to a concurrent burst on deployments that have D1. Rows are
namespaced `authfail:reset:{username}` with a dated bucket, so they can never surface in the admin
dashboard (its only prefix query filters `day = 'total'`).

**A bug found by testing the fix, not by reading it.** The first version hand-wrote its D1 statement
as `... DO UPDATE SET n = n + 1` with the amount inlined rather than bound. That is a near-miss of the
shape every other counter uses, and it meant the throttle **counted nothing at all on D1-bound
deployments** — the takeover still succeeded on guess #21 — while passing on KV. Re-running the
original exploit against both stores caught it; it now calls `d1BumpStat` directly. The regression
suite runs the takeover against **both** stores for exactly this reason.

Verified after the change — the original attack, a new source IP on every guess:

| | Before | After (KV) | After (D1) |
|---|---|---|---|
| Rotating-IP takeover | **succeeded, guess #5** | blocked | blocked |
| Legitimate owner, first try | works | works | works |
| Owner after 3 honest typos | works | works | works |
| Unrelated account | unaffected | unaffected | unaffected |
| 3-char answer at signup | accepted | rejected | rejected |

Seven regression tests added; the three that assert the fix were confirmed failing against the
pre-fix code. Full suite: 121/121, `verify.sh` green.

---

## Security Findings

### 3. Support-thread IDs are capability tokens minted with `Math.random()`

| | |
|---|---|
| **Severity** | 🟠 High |
| **Confidence** | Confirmed (code + execution) |
| **File** | `25_api-catalog-routes.js:4720` |

The code states the design intent explicitly at line 4776: *"a thread id is a capability (it is only
ever shown to the person who filed the report)"*. `/api/feedback/threads` is deliberately
unauthenticated for the `threadIds` path, so the id alone grants read access to a thread — which holds
free-text support messages and the `contact` field the form asks for (email or handle).

That capability is generated as:

```js
const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
```

`Math.random()` is a non-cryptographic PRNG (xorshift128+ in V8) whose internal state is recoverable
from a small number of observed outputs. An attacker who files a handful of their own reports observes
consecutive outputs from the isolate's stream and can derive ids minted around the same time by other
users. The `Date.now()` half is not a secret. `/api/feedback/threads` accepts 20 ids per request and
is not rate-limited, so verification is cheap.

Confirmed anonymously with only the id:

```
### P2 anonymous read of thread
{ "contact": "victim@example.com", "msgs": ["my private bug report"] }
```

**Fix (applied).** `generateShortId()` (`02_http-and-creator-utils.js:322`) already existed and uses
`crypto.getRandomValues`. Now:

```js
const id = `${Date.now()}:${generateShortId()}`;
```

Verified: the random half went from 6 chars of `Math.random` (~31 bits) to **12 chars / 72 bits** of
CSPRNG output. Old ids keep working — only newly minted ones change — and the `Date.now()` prefix
stays, because `/admin/api/feedback` relies on these keys sorting chronologically. A per-IP limit on
`/api/feedback/threads` is still outstanding.

---

### 4. Any anonymous caller can write into any support thread and spoof the sender

| | |
|---|---|
| **Severity** | 🟠 High |
| **Confidence** | Confirmed by execution |
| **File** | `25_api-catalog-routes.js:4684–4715` |

The `threadId` branch of `POST /api/feedback` performs **no ownership check whatsoever**. Given a
thread id (see finding 3), an unauthenticated caller can append messages, reset `completed` to
`false`, change `status`, and populate `contact`/`creatorName` if they are unset. `senderName` is
taken straight from the request body:

```
### P2 anonymous append
[ "user/victim: my private bug report",
  "user/Developer: injected by stranger" ]
```

The admin dashboard renders `senderName` (`03_admin.js:2512`), so a stranger can plant a message
attributed to "Developer" inside another user's support thread. The output is correctly HTML-escaped,
so this is impersonation, not XSS.

**Fix (applied).** A thread that belongs to an account now requires that account's key to append
(403 otherwise); a thread nobody owns keeps the id-capability model, which is the whole point for a
reporter with no account. `senderName` is derived and never read from the request. A claimed
`creatorName` is authenticated before it is stored or rendered anywhere.

One deliberate choice worth recording: an identity claim that **cannot** be proven is *dropped* — the
message is filed anonymously — rather than rejected with a 401. This is the support channel, and the
person whose key has stopped working is precisely the person who needs it; closing that door to
enforce attribution would be the wrong trade. Appending to an already-owned thread is the separate,
strict case and does hard-fail.

The admin panel's "Log something yourself" button is exempt: it posts `creatorName: "admin"` with
`fromAdminPanel: true` and no key, and `"admin"` is a marker `feedbackCardHtml` keys off rather than a
Creator Profile. Missing that would have broken admin self-logging.

| | Before | After |
|---|---|---|
| Stranger appends to an owned thread with just the id | succeeded | **403** |
| Sender name chosen by the caller (`"Developer"`) | rendered as sent | derived; spoof gone |
| Report filed in someone else's name, no key | stored and rendered | claim dropped, filed anonymously |
| Anonymous follow-up by thread id | worked | still works |
| Owner replying to their own thread | worked | still works |
| Admin self-log / admin reply | worked | still works |

Five regression tests; the four that assert the fix were confirmed failing against the pre-fix code.

---

### 5. TMDB fan-out rate limits are bypassed by sending any `tmdbKey`

| | |
|---|---|
| **Severity** | 🟠 High |
| **Confidence** | Confirmed by execution |
| **File** | `25_api-catalog-routes.js:1744` (`/api/recommendations`), `:5739` (`/api/details/batch`) |

Both endpoints skip their rate limit entirely when the request body contains a `tmdbKey`, and the
value is **never validated**:

```js
const tmdbKey = body.tmdbKey || TMDB_API_KEY;
if (!body.tmdbKey) {           // <-- rate limit only in this branch
  if (await consumeRateLimit(env, ctx, "recommendations", recIp, 30)) { ... }
}
```

Measured, 40 requests from one IP:

```
{ of40_blocked_without_tmdbKey: 10, of40_blocked_with_any_tmdbKey: 0 }
```

The stated rationale — a caller supplying their own key spends their own quota — is sound for *TMDB's*
quota but not for the *Worker's*. `/api/recommendations` issues up to 72 outbound subrequests per
call (24 ids × find + recommendations + similar); `/api/details/batch` up to 60. `tmdbKey: "x"` is
enough to unlock unlimited invocations of that fan-out against the deployment's own subrequest, CPU
and billing budget.

**Fix (applied).** Always rate-limited; only the ceiling varies —
`/api/recommendations` 30/min shared vs 120 with a key, `/api/details/batch` 60 vs 240. Power users
who set a real key keep their headroom; the Worker's own budget stops being unbounded.

A note on the test suite: an existing test asserted
`ownKeyLimited === 0, "callers using their own TMDB key must never be rate-limited"`. That was not an
incidental assumption — it encoded the vulnerability as intended behaviour, and it kept passing after
the fix only because its 70 iterations fell under the new 240 ceiling. It has been rewritten to
assert the property that was actually wanted: a *higher ceiling*, not the absence of one. Both
endpoints now have a test proving a bring-your-own-key caller clears the shared ceiling and still
hits a limit eventually; both were confirmed failing against the pre-fix code.

---

### 6. Third-party CDN script loaded without Subresource Integrity

| | |
|---|---|
| **Severity** | 🟠 High |
| **Confidence** | Confirmed |
| **File** | `09_page-shell.js:2982` |

```html
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"></script>
```

No `integrity`, no `crossorigin`. The CSP explicitly allows `https://cdn.jsdelivr.net` in
`script-src`, so a poisoned or compromised response executes with full page privileges. The page holds
these in `localStorage`, all readable by any script in it:

`myListAddon:creatorKey`, `myListAddon:mdblistAccessToken`, `myListAddon:simklAccessToken`,
`myListAddon:mdblistKey`, `myListAddon:simklKey`

The version is pinned, which is good, but pinning is not integrity checking.

**Fix (applied)** — hash recomputed from the live file and confirmed stable across fetches (32,665
bytes), with `crossorigin="anonymous"` because SRI is not enforced on a cross-origin script without
it (jsDelivr serves `access-control-allow-origin: *`):

```html
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"
        integrity="sha384-DT0Ls0mO7JmjTnT+oBuMhEJzYJO1zUqzuuMXNdnOmOQRIpN2BgSjvBV/j50NngIT"
        crossorigin="anonymous"></script>
```

The existing `typeof fflate === 'undefined'` guards (`18_client-copy-and-trakt-export.js:792`, `:1141`,
`:1424`) already produce a clear user-facing message if the script is blocked, so an integrity
mismatch degrades gracefully rather than breaking the page.

Two tests: a hermetic one asserting every external `<script>` in the rendered page carries an SRI
hash, `crossorigin`, and a pinned version (confirmed failing against the pre-fix page), and a
network-gated one (`NETWORK_TESTS=1`) that re-fetches the URL and checks the pinned hash still matches
what the CDN serves — the check to run when bumping the version. It is opt-in so CI cannot fail
because a CDN is briefly unreachable.

---

### 7. KV-backed rate limiters are advisory, not enforcing

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Confidence** | High (design-level) |
| **File** | `02_http-and-creator-utils.js:1234` (`consumeRateLimit`) and ~8 inline equivalents |

Every limiter is a KV read-modify-write:

```js
const used = parseInt((await env.CONFIGS.get(key)) || "0", 10) || 0;
if (used >= maxPerWindow) return true;
const write = env.CONFIGS.put(key, String(used + 1), { expirationTtl: windowSec });
if (ctx?.waitUntil) ctx.waitUntil(write);   // not awaited
```

KV is eventually consistent with a default 60-second edge read cache, and the window here is also 60
seconds — so a burst can read `0` for the whole window. The increment is additionally fire-and-forget.
Concurrent requests all observe the same pre-increment value, so the effective limit is closer to
"N concurrent" than "N per minute".

This affects `/admin/login` (10/min), `/api/creator/restore`, `/api/creator/reset-key`, `/api/save`,
`/api/publish-list`, `/api/feedback`, and the three `consumeRateLimit` buckets. For most of these the
credential behind them is strong enough that this is defence-in-depth. It is **not** acceptable for
finding 2, where the credential is weak — which is why that one is rated Critical.

**Fix.** Where a limiter is a real security control (reset-key, admin login, restore), back it with
D1's atomic upsert — the pattern already exists in `d1BumpStat` (`03_admin.js`) — or Durable Objects,
and `await` the write. Leave the KV version for abuse-shaping on the cheap endpoints.

---

### 8. Creator key travels in URL query parameters

| | |
|---|---|
| **Severity** | 🟡 Medium |
| **Confidence** | Confirmed |
| **File** | `26_api-creator-and-admin-routes.js:473–474` |

`/api/scrobble` accepts `?creator=X&key=Y`. That key is a long-lived, non-expiring, full-account
credential; a URL is the worst place for one (Cloudflare request logs, browser history, `Referer`
headers, media-server config files and their logs). There is no scoped or independently revocable
token, so a leaked webhook URL means rotating the key and re-pairing every device.

**Fix.** Mint a per-integration scrobble token (`creatorscrobbletoken:{token}` → username), revocable
from the dashboard without rotating the Creator Key. Keep accepting the current form for
compatibility, and prefer a header when one is present.

---

## Bugs

### 9. `applyLikeVote`'s post-write verification is unreliable on KV

**🟡 Medium · `02_http-and-creator-utils.js:1283`**

The function PUTs the ledger and then re-reads it to confirm the vote stuck, retrying up to 4 times if
not. The logic is correct against a store with read-your-writes; Cloudflare KV is not one. A stale
read — the default `cacheTtl` for a KV `get` is 60 seconds — makes it conclude another writer clobbered
it and PUT again, up to 4 times, against a key KV limits to **one write per second**. Under no
contention at all this can burn the write budget and still return a count that does not match storage.

**Fix.** Drop the verify-and-retry loop and accept last-write-wins for likes (they are already capped
and non-critical), or move the ledger to D1 where the write is atomic — the `creator_lists.likes`
column already exists and is maintained.

### 10. Double-escaped creator name in the admin reply placeholder

**🔵 Low · `03_admin.js:2545`**

`who` is already HTML-escaped at line 2494, then escaped again for the placeholder. A creator named
`A&B` renders as `Type reply to A&amp;B`. Cosmetic only — use the raw name for that one interpolation.

### 11. CSP comment cites a CI step that does not exist

**🔵 Low · `02_http-and-creator-utils.js:45`**

The comment justifies `'unsafe-inline'` by pointing at *"the verification pipeline's own
onclick/onchange handler resolution check"*. No such step exists in `html_checks.py`, `verify.sh`, or
`ci.yml`. I implemented and ran that check during this audit: of 103 distinct app functions referenced
from inline handlers in the rendered page, **all 103 resolve** — so the check would pass today and is
worth adding to `html_checks.py` to keep it that way, rather than deleting the comment.

### 12. `timingSafeEqualHex` leaks the compared value's length

**🔵 Low · `02_http-and-creator-utils.js:346`**

`if (a.length !== b.length) return false;` returns before the constant-time loop, revealing
`ADMIN_KEY`'s length via timing. Compare fixed-length digests of both inputs instead.

### 13. Latent: cron never populates the module-level API-key globals

**🔵 Low (no live defect) · `25_api-catalog-routes.js:44–51`, `26_…:4128`**

`handleFetch` assigns `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `SIMKL_CLIENT_ID`, `MDBLIST_API_KEY` and
friends from `env` on every request. `scheduled()` does **not**. On a cold isolate whose first event is
a cron tick, those globals are `""`.

I verified this is currently harmless: both `prewarmSharedCatalogs` (`07_…:1827–1831`) and
`checkForNewEpisodes` (`07_…:1682`) read `env.X` directly and thread it down explicitly. But 36 bare
references to those globals exist across `03_`, `05_`, `06_` and `07_`, and any future cron-reachable
call into one of them fails silently with an empty key. Assign the globals at the top of `scheduled()`
exactly as `handleFetch` does — three lines, removes the whole class.

### 14. Counter updates lost under concurrency on the KV path

**🔵 Low · `03_admin.js:66` (`bumpStat`), `26_…:1144` (`stats:creator_count`)**

Classic get-then-put; concurrent bumps lose increments. Only affects display statistics, and the D1
path is already atomic. Worth noting because the D1 binding is optional and commented out by default,
so the lossy path is the default one.

---

## Scalability Findings

Finding 1 is the dominant one. Behaviour by deployment size:

| Creators / public lists | Behaviour |
|---|---|
| 100 | Healthy. Rebuild ≈250 KV ops. |
| 500 | **Cliff.** Rebuild ≈1,000 ops — at the limit; intermittent failures begin. |
| 1,000 | Rebuild always fails (2,108 ops). Directory frozen at the first 100 creators alphabetically. Silent. |
| 10,000 | Same, permanently. `PUBLIC_INDEX_MAX` (20,000) is never reached because the rebuild that would populate it cannot finish. |
| 100,000 | Same. Note the index blob is bounded at 20,000 entries by design (~4 MB), so the tail is dropped least-liked-first — that part is correct and documented. |

Second-order effects of the same root cause: `/api/search-published-lists` (`26_…:2647`) and the admin
Community Lists panel (`03_admin.js:915`) both read the same index and inherit the same truncation,
each falling back to its own bounded scan.

Other prefixes were checked and are bounded correctly: `purgeCreatorData` pages with a cursor and a
50-page bound; `/admin/api/feedback` and `/api/feedback/threads` both walk every page while keeping
only a rolling newest-300 tail; `checkForNewEpisodes` is cursor-paginated at 25 accounts with a
150-show budget per tick. These are fine as written.

---

## Performance Findings

- **Cron tick cost — measured, and it fits.** One `scheduled()` tick issues **142 outbound subrequests**
  (120 TMDB, 9 Trakt, 7 Simkl, 6 MDBList) plus ~20 KV ops, and takes **~15 seconds** wall clock at a
  simulated 150 ms upstream latency, against a 360-second cron interval. Well inside limits. The
  200 ms inter-chart sleep is deliberate rate-limit courtesy. **No change recommended** — I measured
  this specifically because it looked expensive, and it is not a problem.
- **`/api/channel-logo` (`25_…:972`) is an unauthenticated CPU amplifier.** It fetches a TMDB image and
  base64-encodes the whole body per request, then returns `Cache-Control: no-cache, no-store,
  must-revalidate`, so Cloudflare never caches the Worker's own response and every hit repeats the
  encode. There is no size cap on the fetched image. `logoPath` is unvalidated; URL parsing confines
  it to `image.tmdb.org`, so this is an open image proxy for that one host rather than SSRF. **Fix:**
  cap the response size, and serve with a long `max-age` — the output is deterministic for a given
  path and format.
- **`rebuildPublicListIndex` is fully sequential** — `await get` per list in a `for` loop. Even below
  the subrequest cliff, 400 lists is 400 serialised round-trips. Batch it.

---

## Dead Code

Verified by searching the **built** `worker_entry_combined.js` — which contains all client modules and
all generated HTML as template literals — for every occurrence of each name. Each of these appears
**exactly once**: its own declaration. No call site, no string reference, no inline handler, no
`window.*` assignment.

**SAFE TO DELETE — 16 functions, 241 lines**

| File | Function | Lines |
|---|---|---|
| `16_client-row-core.js:1586` | `quickAddProvider` | 61 |
| `23_client-list-management.js:351` | `testAllSources` | 42 |
| `21_client-custom-list-builder.js:32` | `runCustomListSearch` | 29 |
| `17_client-my-lists-and-trakt-oauth.js:1200` | `testTmdbConnection` | 25 |
| `19_client-search-and-likes.js:1` | `setListSearchFilter` | 24 |
| `24_client-backup-restore-presets.js:132` | `unresolvedEntryNames` | 10 |
| `16_client-row-core.js:2103` | `addQuickAddRowsFromPairs` | 8 |
| `16_client-row-core.js:2112` | `addQuickAddRowsFromSimpleList` | 6 |
| `22_client-creator-profile.js:895` | `_refreshScrobbleWebhookInput` | 6 |
| `20_client-channel-builder.js:5132` | `reverseChannelDraft` | 5 |
| `23_client-list-management.js:282` | `toggleCompactView` | 5 |
| `24_client-backup-restore-presets.js:1991` | `openInNuvio` | 5 |
| `21_client-custom-list-builder.js:790` | `closeCreateListModal` | 4 |
| `21_client-custom-list-builder.js:2922` | `isMyListsSectionHidden` | 4 |
| `17_client-my-lists-and-trakt-oauth.js:826` | `scheduleMyPrivateTraktListsRefresh` | 4 |
| `03_admin.js:2026` | `switchAdminTab` | 3 |

Out of 770 top-level functions, that is a 2% dead rate — low, and no other candidates surfaced.

**Documentation bloat (not code):** the repository root carries `AUDIT-2026-09.md`,
`AUDIT-2026-09-05.md`, `AUDIT-STATUS.md`, `AUDIT-2026-09-05-STATUS.md`, `Changes.md` and
`Changes - archive.md` — roughly 570 KB of overlapping historical markdown. Consider a `docs/history/`
folder so the root shows current documentation only.

---

## Duplicate Code

No consolidation is recommended. The near-duplicates that exist are justified:

- `escapeHtml` (`19_…:171`), `escapeHtmlServer` (`02_…:589`), `escapeHtmlAdmin` (`03_…:2200`) and
  `escapeXml` (`05_…:233`) are identical in spirit but live in four different execution scopes (client
  bundle, Worker, admin page script, SVG output). They cannot share one definition without threading a
  helper through generated HTML strings. All four are correct. Leave them.
- `generateChannelPosterSvg` / `generateChannelBackdropSvg` share structure but differ in geometry and
  content. Merging them would take more parameters than it saves.
- The `/api/recommendations` movie and show branches (`25_…:1753`, `:1788`) are genuinely near-identical
  and *could* fold into one parameterised helper, but they diverge in endpoint names and result-field
  handling. Low value; only worth doing if the code is being touched anyway for finding 5.

`html_checks.py` already fails CI on duplicate top-level function declarations in the client bundle,
which is the duplication class that actually caused bugs here historically. That check is well placed.

---

## Broken Links

**None.** Every external URL in source, README and `wrangler.toml` was extracted (418 unique) and the
13 documentation/brand-facing ones were fetched. All returned HTTP 200:

`github.com/Br0ck25/My-Lists` (+ `/blob/main/schema.sql`, `/blob/main/worker_entry_combined.js`,
`/tree/main/migrations`), `mylistsaddon.com`, `nuvio.to`, `stremio.com`, `stremio-addons.net`,
`wako.app`, `buymeacoffee.com/brock25`, `cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js`,
`mdblist.com/toplists/`, `v3-cinemeta.strem.io/manifest.json`.

The remainder are API endpoints (`api.themoviedb.org`, `api.trakt.tv`, `api.mdblist.com`,
`api.simkl.com`), image hosts (`image.tmdb.org`, `images.metahub.space` ×221 in the icon asset), and
intentional placeholders (`your-worker-name.your-subdomain.workers.dev`, `example.com`, `localhost`).

---

## Documentation Problems

Documentation is in unusually good shape. Checked and **correct**:

- Every one of the 12 `env.*` references in code (`ADMIN_KEY`, `CONFIGS`, `DB`, `MDBLIST_API_KEY`,
  `MDBLIST_CLIENT_ID`, `MDBLIST_CLIENT_SECRET`, `MDBLIST_POPULAR_KEY`, `SIMKL_CLIENT_ID`,
  `SIMKL_CLIENT_SECRET`, `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`) is documented in
  both `wrangler.toml` and `README.md`. No undocumented variables, no documented-but-unused ones.
- The cron cadence, the KV binding requirement, and the optional-D1 fallback all match the code.

One inaccuracy: **finding 11** — the CSP comment cites a CI step that does not exist.

---

## Testing Gaps

`node --test tests/*.test.mjs` → **106 tests, 106 pass**, and the full `verify.sh` pipeline (rebuild,
drift check, `node --check`, render + HTML validation, FUNCTION-MAP drift, tests) passes end to end in
27 seconds. The harness is good: it stubs only KV, D1, caches and `waitUntil`, and exercises the real
Worker module.

Missing coverage, in priority order — each maps to a finding above:

1. **KV pagination / index rebuild at scale** (finding 1). Nothing seeds more than a handful of lists.
   A test with a KV mock that throws past 1,000 operations would have caught this.
2. **Per-account brute-force throttling** (finding 2). Existing tests check the per-IP limit; none
   rotate IPs against one account.
3. **Rate-limit bypass via caller-supplied keys** (finding 5).
4. **Feedback thread authorization** (finding 4) — appending to someone else's thread.
5. **Inline handler resolution** (finding 11) — add to `html_checks.py`; passes today.
6. **External API failure modes.** No test asserts behaviour when TMDB returns 500, Trakt returns
   malformed JSON, or a provider times out. The circuit-breaker/stale-fallback machinery in
   `fetchWithPerUserCacheAndCircuitBreaker` is substantial and untested.

---

## Complete Route Inventory

118 route branches: **74** in `25_api-catalog-routes.js`, **44** in
`26_api-creator-and-admin-routes.js`. Dispatch is a linear `if` chain on `url.pathname` inside
`handleFetch`, wrapped by `export default { fetch }` which applies `withSecurityHeaders` to every
response.

| Group | Count | Auth | Notes |
|---|---|---|---|
| Static / pages (`/`, `/configure`, `/icon.png`, `/app.css`, `/app.js`, `/sw.js`, `/robots.txt`, `/sitemap.xml`, `/guide`, `/app.webmanifest`) | 12 | none | `/app.js`+`/app.css` content-addressed with ETag + immutable caching |
| Stremio protocol (`/:config/manifest.json`, `/:config/catalog/…`, `/:config/meta/…`, `/:config/subtitles/…`) | 5 | config-embedded | Config is base64url in the path |
| Public list directory (`/lists/public.json`, `/lists/:user/:slug`, `/lists/{mdblist,trakt,tmdb,simkl,custom,curated}/…`) | 11 | none | **Finding 1** |
| Provider proxies (`/api/toplists`, `/api/title-search`, `/api/season`, `/api/show-*`, `/api/details*`, `/api/recommendations`, `/api/bulk-resolve`, …) | ~30 | none / per-IP limit | **Finding 5** on 2 of them |
| OAuth (Trakt, MDBList, Simkl, TMDB — start + callback, plus Trakt device flow) | 10 | CSRF `state` cookie, HttpOnly/Secure/SameSite=Lax, `crypto.getRandomValues` | Correct; MDBList uses PKCE |
| Creator profile (`/api/creator/*` — create, restore, reset-key, lists CRUD, sync save/load, delete-account) | 21 | `authenticateCreator` per request | **Finding 2** on reset-key |
| Scrobble (`/api/scrobble{,/webhook,/plex,/jellyfin,/emby}`) | 5 | creator key in query | **Finding 8** |
| Feedback (`/api/feedback`, `/api/feedback/threads`) | 2 | thread-id capability / creator key | **Findings 3, 4** |
| Telemetry (`/api/track-install`, `/api/track-search`, `/api/track-event`) | 3 | none, per-IP bucket | Fire-and-forget beacons |
| Admin (`/admin`, `/admin/login`, `/admin/logout`, `/admin/api/*`) | 19 | HMAC-signed cookie | **All verified guarded** |

---

## Complete KV Inventory

Single namespace, `CONFIGS`. D1 is optional; every accessor tries D1 first and falls back to KV.

| Key pattern | Purpose | Writers | Readers | Deleted by | Growth | Pagination risk | Consistency risk |
|---|---|---|---|---|---|---|---|
| `creator:{u}` | Account identity + `keyHash` + `recoveryAnswerHash` | create, reset-key, admin reset | `authenticateCreator`, cron | delete-account | 1/user | cursor-paged in cron ✓ | — |
| `creatorlist:{u}:{slug}` | A creator's list | lists/save | directory, index rebuild, catalog | delete, purge | 1/list | **CRITICAL — finding 1** | — |
| `publishedlist:user:{slug}` | Anonymous published list | `/api/publish-list` | index rebuild, catalog | **nothing** | unbounded | **CRITICAL — finding 1** | — |
| `index:publiclists` | Directory cache (≤20k entries) | `writePublicListIndex` | directory, search, admin | — | bounded ✓ | — | read-modify-write, rebuildable ✓ |
| `listlikevoters:{u}:{slug}` | Like ledger | `applyLikeVote` | like routes | purge | capped ✓ | — | **finding 9** |
| `creatorsync*:{u}` (5 variants) | Cloud sync blobs | sync/save* | sync/load, cron | purge | 1/user | — | last-write-wins |
| `feedback:{id}` | Support threads | `/api/feedback` | threads, admin | admin delete | unbounded | rolling-tail ✓ | **findings 3, 4** |
| `stats:*`, `evt*`, `searchquery*` | Telemetry | `bumpStat`, recorders | admin dashboard | day-count migration | day-bucketed | day-indexed ✓ | **finding 14** |
| `ratelimit:*`, `*rate:{ip}:{day}` | Rate limiters | limiters | limiters | TTL ✓ | bounded ✓ | — | **finding 7** |
| `cache:*`, `tmdbdetail:*`, `user_cache:*` | Provider caches | fetchers | fetchers | TTL ✓ | bounded ✓ | — | — |
| `lock:publiclistindex` | Rebuild mutex | `getPublicListIndex` | same | TTL 60s ✓ | 1 | — | advisory only |
| `cron:*:cursor` | Cron sweep cursors | `scheduled` | `scheduled` | — | 2 keys | — | — |

**Two prefixes have no delete path at all:** `publishedlist:user:` and `/api/save` config keys. Both
are written by unauthenticated endpoints. See M4 / finding 1.

---

## Dependency Map

```
Cloudflare edge
  └── export default { fetch, scheduled }        26_api-creator-and-admin-routes.js (tail)
        │
        ├── fetch → handleFetch()                25_api-catalog-routes.js:34  (body spans 25_ + 26_)
        │     ├── env → module-globals           00_constants.js   (TMDB/TRAKT/SIMKL/MDBLIST keys)
        │     ├── linear pathname if-chain       118 route branches
        │     │     ├── config decode            04_config-resolution.js
        │     │     ├── catalog assembly         05_catalog-core.js  (+ 08_ chart data)
        │     │     ├── source fetchers          06_ (mdblist/trakt), 07_ (tmdb/simkl)
        │     │     │     └── fetchWithPerUserCacheAndCircuitBreaker
        │     │     │           → memory cache → KV stale cache → provider HTTPS
        │     │     ├── creator auth             02_http-and-creator-utils.js (PBKDF2 + memo)
        │     │     ├── admin auth               03_admin.js (HMAC cookie)
        │     │     └── KV / D1 accessors        02_ (getCreator, listAllKeys, index, likes)
        │     └── withSecurityHeaders()          02_ (CSP, HSTS, frame-ancestors)
        │
        └── scheduled (*/6 * * * *)
              ├── checkForNewEpisodes()          07_:1681   cursor-paged, env-threaded ✓
              ├── prewarmSharedCatalogs()        07_:1824   142 subrequests, ~15 s ✓
              └── getPublicListIndex()           03_        ** fails past ~500 lists **

Served page (one HTML document, built by renderBuilder)
  09_page-shell.js  (shell + CSS + <script src=fflate>)
    ├── 10_–15_  tab markup
    └── 16_–24_  client bundle, ONE shared script scope
                 (CI enforces no duplicate top-level declarations)
          └── fetch() → /api/*  back into handleFetch
```

Build: `header.js` + `[0-9][0-9]_*.js` in filename order → `worker_entry_combined.js` (2.68 MB),
byte-exact concatenation, CI-gated against drift.

---

## FILE-BY-FILE PUNCH LIST

### `02_http-and-creator-utils.js`
- ✅ `rebuildPublicListIndex:1480` — **DONE.** Chunked, resumable, budget-bounded; records read with bounded concurrency. **(Finding 1)**
- 🟡 `applyLikeVote:1283` — remove the PUT-then-verify retry loop; KV has no read-your-writes. **(9)**
- 🟡 `consumeRateLimit:1234` — `await` the write; move security-critical buckets to D1. **(7)**
- 🔵 `timingSafeEqualHex:346` — compare fixed-length digests, not raw lengths. **(12)**
- 🔵 comment at `:45` — the CI step it cites does not exist; add the check. **(11)**

### `25_api-catalog-routes.js`
- ✅ `:4720` — **DONE.** `generateShortId()` instead of `Math.random()` for thread ids. **(3)**
- ✅ `:4684` — **DONE.** Owned threads require the account key; `senderName` is derived. **(4)**
- ✅ `:1744` and `:5739` — **DONE.** Always rate-limited; higher ceiling for bring-your-own-key. **(5)**
- 🟡 `/api/channel-logo:972` — cap the fetched image size; serve with a long `max-age`.
- 🟡 `/api/save:5390`, `/api/publish-list:5463` — add `expirationTtl` or a sweep for records nothing references. **(M4)**

### `26_api-creator-and-admin-routes.js`
- ✅ `/api/creator/reset-key:1168` — **DONE.** Per-account failure budget (D1-atomic when bound) plus an entropy floor at `:1111`. **(2)**
- 🟡 `handleMediaServerScrobble:473` — introduce a scoped, revocable scrobble token. **(8)**
- 🔵 `scheduled:4128` — assign the API-key globals as `handleFetch` does. **(13)**
- 🔵 `:1144` — `stats:creator_count` loses increments on the KV path. **(14)**

### `09_page-shell.js`
- ✅ `:2982` — **DONE.** `integrity` + `crossorigin` on the fflate `<script>`. **(6)**

### `03_admin.js`
- 🔵 `feedbackCardHtml:2545` — remove the double escape on `who`. **(10)**
- 🔵 `switchAdminTab:2026` — dead, delete.

### `16_`, `17_`, `19_`, `20_`, `21_`, `22_`, `23_`, `24_`
- 🔵 Delete the 15 remaining dead functions listed above (241 lines total with `switchAdminTab`).

### `html_checks.py`
- 🔵 Add the inline-handler resolution check the CSP comment already promises. It passes today.

### Repository root
- 🔵 Move the 6 historical audit/changelog files (~570 KB) into `docs/history/`.

---

## Change Grouping

**🔴 PHASE 1 — MUST FIX BEFORE PRODUCTION**
1. ~~Bounded, resumable public-list index rebuild (finding 1)~~ — **DONE**
2. ~~Per-account throttle + answer entropy on `/api/creator/reset-key`~~ — **DONE**
3. ~~Apply the same chunking to `/admin/api/migrate-d1`~~ — **DONE**

**🟠 PHASE 2 — SHOULD FIX SOON**
~~3. CSPRNG thread ids (3)~~ — **DONE** · ~~4. Thread append authorization (4)~~ — **DONE** ·
~~5. Rate-limit bypass (5)~~ — **DONE** · ~~6. SRI on the CDN script (6)~~ — **DONE**

**🟡 PHASE 3 — RELIABILITY / CLEANUP**
7. D1-backed limiters (7) · 8. Scoped scrobble token (8) · 9. Like-ledger consistency (9) ·
10. `channel-logo` caching + size cap · 11. TTL/sweep for anonymous records

**🔵 PHASE 4 — OPTIONAL**
12. Delete 241 lines of dead code · 13. Handler-resolution CI check · 14. Cron global assignment ·
15. Double-escape fix · 16. Docs reorganisation

---

## DO NOT TOUCH

Code that looks suspicious or redundant but is required:

- **`prewarmSharedCatalogs` / `checkForNewEpisodes` reading `(env && env.X) || X`**
  (`07_…:1827–1831`, `:1682`). Looks like belt-and-braces duplication of the module globals. It is
  **load-bearing**: `scheduled()` never populates those globals, so the `env.` half is the only one
  that works on a cron tick. Do not "simplify" to the bare global. (See finding 13.)
- **`/sw.js` (`25_…:608`).** Deliberately minimal: intercepts only `/app.js?v=<hash>`, which is
  content-addressed, and keeps exactly one cache entry. It cannot strand a user on stale JavaScript.
  Do not "improve" it into a general offline cache.
- **The legacy bounded scan in `/lists/public.json` (`25_…:316–365`).** Looks like dead fallback code.
  It is the only thing keeping the directory alive while the index is cold — and, given finding 1, it
  is currently what large deployments run on permanently.
- **`authenticateCreator`'s identical error string on every failure path** (`26_…:14–29`). The
  duplication is deliberate anti-enumeration. Do not make the messages more helpful.
- **`verifyCreatorKeyMemoized` (`02_…:412`).** Caches only *successful* verifications, keyed on
  username + key + stored hash, in-isolate, 5-minute TTL. A wrong key still pays full PBKDF2. Not a
  weakening.
- **`isAllowedPosterUrl` (`25_…:24`).** The three-host allowlist is what stops `/api/poster-badge`
  being an open redirect and a server-side image proxy. Removing it reopens both.
- **`escapeXml` (`05_…:233`) in the SVG generators.** These outputs are served as `image/svg+xml` from
  the app's own origin; unescaped user text there would be genuine XSS.
- **`listAllKeys`'s `maxKeys` / `list_complete: false` contract (`02_…:1614`).** Callers are required to
  treat an early return as "there was more". Preserve that when fixing finding 1.
- **`PUBLIC_INDEX_MAX = 20000` and the likes-first sort.** Correct and documented: if anything
  truncates, it drops the least popular rather than an arbitrary alphabetical slice.

---

## Verified Healthy

Tested during this audit and found to have **no defect** — recorded so the same ground is not re-covered:

- **Cross-creator data isolation.** Creator B's key against Creator A's `sync/load` and `lists/delete`
  → HTTP 401, generic error. No IDOR found.
- **Admin authorization.** All 16 `/admin/api/*` endpoints plus `/admin` return 401 (or the login page)
  without a valid cookie. No unauthenticated leak.
- **Admin panel XSS.** Every dynamic sink checked (`s.query`, `c.name`, `l.name`, `l.creator`,
  `k.label`, `p.name`, feedback messages and sender names) passes through `escapeHtmlAdmin`, which
  escapes all five of `& < > " '`.
- **Rendered page markup.** 236 elements with `id`, **0 duplicates**.
- **Inline handlers.** 103 distinct app functions referenced from `on*=` attributes, **all resolve**.
- **Build integrity.** `python3 build.py` reproduces `worker_entry_combined.js` byte-for-byte; no
  source/generated drift; `node --check` clean; `FUNCTION-MAP.md` current.
- **Tests.** 106/106 pass; full `verify.sh` green.
- **Error messages.** `safeErrorMessage` (`02_…:157`) strips URLs, labelled secrets and long opaque
  tokens, and bounds length. No route returns a raw exception.
- **OAuth CSRF.** All four providers use a `crypto.getRandomValues` state in an HttpOnly/Secure/
  SameSite=Lax cookie scoped to the callback path; MDBList adds PKCE.
- **"Failed write reported as success."** Searched every empty `catch` within 8 lines of a KV/D1 write
  followed by `ok: true`. One hit (`26_…:1147`), and it is a display-only counter.
- **Documentation.** All 12 environment variables documented and consistent; all 13 external
  documentation links return HTTP 200.
- **Cron budget.** 142 subrequests, ~15 s wall clock, against a 360 s interval. Fits comfortably.

---

## TOP 10 FIXES

1. ~~**Bound and resume the public-list index rebuild**~~ — **DONE.** (Finding 1)
2. ~~**Per-account throttle on `/api/creator/reset-key`**~~ — **DONE.** (2)
3. ~~**Minimum entropy on recovery answers at creation**~~ — **DONE.**
4. ~~**`generateShortId()` for feedback thread ids**~~ — **DONE.** (3)
5. ~~**Authorize `threadId` appends and stop trusting `senderName`.**~~ — **DONE.** (4)
6. ~~**Always rate-limit `/api/recommendations` and `/api/details/batch`.**~~ — **DONE.** (5)
7. ~~**Add SRI to the fflate `<script>`.**~~ — **DONE.** (6)
8. **Move the reset-key and admin-login limiters onto D1's atomic upsert.** (7)
9. **Cap and cache `/api/channel-logo`; add TTL/sweep to `/api/save` + `/api/publish-list` keys.**
10. **Add the four regression tests** for findings 1, 2, 4 and 5, plus the handler-resolution check.

---

## FINAL VERDICT

**1. Is this production-ready?** Yes for its current size, with the two Phase 1 fixes. The
engineering quality is high and the things that are usually broken in an app like this are not broken
here. What is wrong is concentrated in two places, both of which fail *quietly*.

**2. What would you fix before another user touches it?** Findings 1 and 2. Finding 2 in particular
is a working account-takeover that takes minutes to exploit and days to detect.

**3. What can wait?** Everything in Phases 3 and 4. The dead code, the duplication, the documentation
sprawl and the counter races are all real but none of them harm a user.

**4. Biggest scalability risk?** The public list index rebuild. It is not a gradual degradation — it
is a cliff at ~500 lists, after which the directory is permanently and invisibly wrong, and no amount
of subsequent traffic repairs it.

**5. Biggest security risk?** The recovery-answer reset path. Everything else in the auth system is
strong — PBKDF2, ~60-bit keys, constant-time compare, uniform errors, real isolation — and this one
endpoint bypasses all of it with a guessable secret and no per-account defence.

**6. Biggest architectural risk?** Two sources of truth for provider API keys: module-level globals
populated only by `handleFetch`, and `env` read directly. Both cron functions currently take the safe
path, but 36 bare-global references mean the next cron-reachable helper fails silently with an empty
key. Three lines in `scheduled()` retires the whole class.

**7. Biggest piece of unnecessary code?** Not code — documentation. ~570 KB of overlapping historical
audit markdown at the repository root, against 241 lines of genuinely dead JavaScript out of ~50,000.

**8. Most likely to break as the user base grows?** The directory, at ~500 public lists (finding 1).
Second: KV read-modify-write contention — like counts, `stats:*` counters and the rate limiters all
degrade as concurrency rises, and the D1 path that fixes this is optional and commented out by
default in `wrangler.toml`.
