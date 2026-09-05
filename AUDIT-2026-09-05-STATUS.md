# Audit 2026-09-05 — Remediation Tracker

Live status for every finding in [`AUDIT-2026-09-05.md`](AUDIT-2026-09-05.md).
**The audit report is the point-in-time record and is not edited as things get
fixed — this file is the one that changes.** Update it in the same commit as the
fix, so "what is still open" is always answerable from `main` alone.

| Legend | Meaning |
|---|---|
| ✅ FIXED | Landed, with a regression test that fails against the pre-fix code |
| 🚧 IN PROGRESS | Being worked on now |
| ⬜ OPEN | Not started |
| 🔎 ACCEPTED | Understood and deliberately not changing — reason recorded |

**Progress: 9 of 16 findings closed** (all 4 production blockers, the client-bundle
duplicate-declaration class, the shared-key fan-out endpoints, the admin Community Lists
panel, the undocumented secret, and the build-header fragility).

---

## ✅ Fixed

| # | Finding | Severity | Fixed | Commit | Regression test |
|---|---|---|---|---|---|
| 1 | `/api/track-event` minted unbounded attacker-named permanent KV keys; admin analytics panel read them 1:1 and broke past the subrequest cap | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 1` (5 tests) |
| 2 | `/api/lists/like` wrote a stale whole-record snapshot, silently reverting a concurrent creator save | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 2` (1 test) |
| 3 | `checkForNewEpisodes` cron wrote a stale whole tracking blob, silently destroying user watch history | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 3` (1 test) |
| 4 | `/api/publish-list` + `/api/save`: unauthenticated, uncapped, permanent KV writes | 🔴 High | 2026-09-05 | `ff9cbfe` | `audit fix 4` (4 tests) |
| 16 | `build.py` recovered its header from its own previous output, so editing `00_constants.js` made the build unrunnable | 🟡 Low | 2026-09-05 | `ff9cbfe` | `verify.sh` step 2 (header now in `header.js`, proven byte-identical) |
| 8 | Duplicate `handlePosterImgError` in the client bundle; the losing definition was the one most call sites were written for | 🟠 Medium | 2026-09-05 | `ae5c52d` | `audit fix 8` (4 tests) + `html_checks.py` duplicate-declaration guard |
| 5 | Unauthenticated endpoints spending the Worker owner's shared provider quota were unbounded; `/api/bulk-resolve` also had no cap on `items` at all | 🟠 Medium | 2026-09-05 | `f2aea3a` | `audit fix 5` (6 tests) |
| 10 | Admin "Top Community Lists" was permanently **empty** without D1, and mis-ranked when it wasn't | 🟠 Medium | 2026-09-05 | `cab9aab` | `audit fix 10` (3 tests) |
| 14 | `MDBLIST_CLIENT_SECRET` required but documented nowhere | 🟠 Medium | 2026-09-05 | `cab9aab` | `audit fix 14` (2 tests, incl. an all-env-vars guard) |

### What changed, per fix

**1 — `/api/track-event`** (`25_api-catalog-routes.js`, `03_admin.js`, `02_http-and-creator-utils.js`)
- `list-copy` now records only lists on this add-on, keyed by slug via `recordListCopySlug`. Side effect: this also *fixes* the counts, which previously never matched anything the panel could display — the client sends `listUrl || listName`, never a slug, so `stats:list_copy:` was write-only.
- `catalog-add` branch removed — no client has ever sent it (`/api/track-install` → `stats:sourcegroup:` is the real path), so it was reachable only by an attacker.
- `watched`/`list-add` ids constrained to real title-id shapes before becoming key names.
- Per-IP rate limit (30/min) on `/api/track-event` and `/api/track-search`.
- `STAT_KEY_SCAN_CAP` / `STAT_TOTALS_READ_CAP` bound the admin panel's fan-out; `listAllKeys` gained an optional `maxKeys`. Truncates to a partial panel rather than throwing.

**2 — `/api/lists/like`** — re-reads the record after `applyLikeVote` and copies only `likes` onto it. The public-index update is fed from the fresh record, so indexed name/type/itemCount now match what is stored.

**3 — `checkForNewEpisodes`** — re-reads the tracking blob before writing and sets only `continueWatching`, `fullyWatchedShowIds`, `updatedAt`.

**4 — `/api/publish-list` + `/api/save`** — bounds in `00_constants.js` (`PUBLISHED_LIST_ITEMS_MAX` 10,000; `PUBLISHED_LIST_BYTES_MAX` 2 MB; `SAVED_CONFIG_ENTRIES_MAX` 500; `SAVED_CONFIG_BYTES_MAX` 512 KB) plus per-IP rate limits. Ceilings are ~8× the largest real list observed. **Rejects, never truncates.**

**8 — duplicate top-level declarations in the client bundle** (`16_`, `22_`, `23_`, `html_checks.py`)
- `handlePosterImgError`: the two definitions implemented different DOM contracts, and `23_`'s won (later in build order). It revealed `img.nextElementSibling`, which is a real placeholder at only one of the five call sites. Now routed through `showPosterPlaceholderFor`, which reveals a placeholder when one exists and creates one when it does not, and never touches a non-placeholder sibling. `16_`'s copy deleted.
- Also removed the other three shadowed duplicates: `escapeHtml`/`escapeAttr` (`16_`, superseded by `19_`'s — which differ: `String(s || '')` turns a legitimate `0` into `''`, `String(s == null ? '' : s)` renders `"0"`) and `showModal`/`closeModal` (`22_`, byte-identical to `16_`'s).
- `html_checks.py` now fails the build on any duplicate top-level `function` declaration in the served client script. Verified by reintroducing one: it exits 1 and names the symbol.

> **Correction to the audit report's description of this finding.** The report said the
> old code "force-shows the ✕ remove button / count overlay in place of the poster."
> That overstates it: `.cw-remove-btn` and `.poster-add-overlay` are already
> `display:flex` in CSS, so setting it again was a no-op for them. The real symptoms
> were (a) **no "No poster" placeholder was ever created** at four of the five call
> sites — just an empty gap — and (b) on `.list-card-count-overlay`, which *is*
> shown/hidden per breakpoint by a media query, the inline `display:flex` overrode
> that query and put the badge on screen at both widths at once. The fix and its
> priority are unchanged.

**5 — shared-key fan-out endpoints** (`00_`, `02_`, `18_`, `25_`, `26_`)
- `/api/bulk-resolve` was the real problem, and worse than a missing rate limit: no per-user key override at all (always the owner's TMDB key) and **no cap on `items`**. At ~2 TMDB calls per item, a few thousand titles exceeded Cloudflare's per-invocation subrequest limit — so large Letterboxd imports were *already failing*, after spending the quota. Now capped at `BULK_RESOLVE_ITEMS_MAX` (200) and rate-limited.
- The cap rejects rather than truncates, so the client chunks: `bulkResolveInChunks` (`18_`) sends any size as several bounded calls and merges results, using the same constant the server validates against. **An import that previously failed outright now completes.**
- `/api/details/batch` and `/api/recommendations` are limited **only when they fall back to the shared key** — a caller using their own TMDB key spends their own quota, and throttling them would penalise exactly the users who configured one.
- Added `consumeRateLimit` (`02_`), the shared version of the per-IP bucket that `/api/preview`, creator create/restore and `/admin/login` had each grown separately. Existing call sites left alone.

> **Deliberately not rate-limited**, with a test asserting they stay that way:
> `/api/external-list/*`, `/api/external-sync/history`, `/api/trakt-my-private-lists`,
> `/api/trakt-history-raw`, `/api/mdblist-history-raw`. Each returns 400 without a
> caller-supplied provider token, so they spend the **caller's** quota, not the
> owner's. A limit there would only break large legitimate history syncs.

**10 — admin Community Lists** (`03_admin.js`, `26_`)
Two bugs, and the worse one was not the one originally reported.

> **Correction to the audit report.** The report said this panel "ranks the
> alphabetically-first 100". True — but without D1 bound it was actually
> **permanently empty**. The KV path dropped any candidate lacking a `creatorName`
> field, and `/api/creator/lists/save` has never written one: the record is
> `{ name, slug, type, items, visibility, likes, createdAt, updatedAt }` and the
> creator lives in the **key**. The audit's own fixture fabricated that field,
> which hid it. Verified against records written by the real save route.

- Both are fixed by ranking from `index:publiclists` (already carries likes, itemCount and the creator display name; already sorted by likes).
- Fan-out collapses from one KV get per candidate to **one get total** — measured 223 → 1 on a 120-list fixture.
- Cold index: falls back to a bounded scan for that one request while the rebuild runs in the background, exactly as `/api/search-published-lists` does; correct from the next load. The fallback now derives the creator from the key rather than the never-written field.

**14 — `MDBLIST_CLIENT_SECRET`** (`README.md`, `wrangler.toml`)
Required by `/api/mdblist/oauth/callback`, absent from both setup docs, so following them exactly still produced "not configured". Now documented in both — and a test asserts **every** `env.*` var the Worker reads is named in the docs, closing the class rather than the instance.

---

## ⬜ Open — next up, in recommended order

| # | Finding | Severity | File / location | Why it matters |
|---|---|---|---|---|
| 9 | Stat counters are non-atomic read-modify-writes | 🟠 Med-High | `03_admin.js` `bumpStat`/`bumpStatBy`/`recordTrackedEvent`/`recordSearchQuery` | 20 concurrent requests recorded as 1. Worsens with traffic (KV edge-cached reads + 1 write/sec/key). Fix = shard hot keys, or move counters to D1, or label the panels approximate. Needs a migration — the largest of the remaining items. |
| 13 | No timeout on any of ~135 outbound fetches | 🟠 Medium | `02_` `fetchWithPerUserCacheUncoalesced`, `fetchTraktWithRetry` | A hung upstream stalls the request; the stale-fallback tiers only trigger on rejection. Fix = `AbortSignal.timeout` at the two shared helpers, not 135 call sites. |
| 11 | N+1 KV reads on every playback ping | 🟠 Medium | `26_:~410` | Enumerates and reads every one of the creator's lists to find the watchlist; also has no cursor, so it truncates at 1,000. Fix = read `creatorlist:{u}:watchlist` directly, scan only as fallback. |
| 12 | Orphaned KV on account deletion | 🟠 Low-Med | `02_` `purgeCreatorData` | `listlikevoters:{u}:*` and `scrobbleseenusers:{u}` survive deletion, so a recycled username inherits stale like counts. Also: the `creatortrack:` "legacy" comment is wrong — it is a live key. |
| 6 | Creator key travels in the `/api/scrobble` query string | 🟡 Low | `26_:~448` | Largely forced (Plex/Jellyfin webhooks can't set headers). Fix = document the trade and the rotation path, don't redesign. |
| 7 | ~40 handlers return raw `String(err.message)` | 🟡 Low | `25_`, `26_` | Leaks nothing today (all `throw`s are status-only) but contradicts the policy stated at `/api/bulk-resolve`. |
| 15 | `FUNCTION-MAP.md` line numbers 26% stale (211 of 811) | 🟡 Low | `FUNCTION-MAP.md`, `gen_map.py` | Nothing regenerates or validates it. Fix = add to `verify.sh`/CI, or drop line numbers. |
| — | Dead code: 4 unreferenced server functions | 🟡 Low | see audit "Dead Code" | `classifyTraktListContentType` (`04_`), `getPaddedChannelLogo` (`05_`), `fetchTrailerForImdb` (`07_`), `getProviderIconBadge` (`08_`). The 4 shadowed *client* duplicates were removed with finding 8. Deleting these makes `FUNCTION-MAP.md` staler, so pair it with finding 15. |

---

## Notes for whoever picks this up

- **Run `bash verify.sh` before and after every change.** It rebuilds the Worker, fails on drift, syntax-checks the combined file, renders and validates the client bundle, and runs the tests. Current baseline: **no drift, 70/70 passing**.
- **Editing any `[0-9][0-9]_*.js` file requires `python3 build.py`.** `worker_entry_combined.js` is generated and committed; CI fails if it drifts from source.
- **Write the regression test first and confirm it fails against the current code.** Every fix above was validated that way: stash the source change, keep the test, rebuild, watch it fail. A test that passes before the fix is not testing the fix.
- **Do not consult the audit report's "DO NOT TOUCH" list as optional.** It records twelve pieces of load-bearing compatibility code that look removable and are not — the D1-miss→KV fallback, the base64 config branch, the `Sec-Fetch-Mode`-only navigation check, and others.
- **Prefer rejecting over truncating.** Findings 1–4 were all silent-failure bugs; a fix that silently drops data replaces one with another.
