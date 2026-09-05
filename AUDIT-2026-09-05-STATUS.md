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

**Progress: 5 of 16 findings closed** (all 4 production blockers + 1 blocker-adjacent).

---

## ✅ Fixed

| # | Finding | Severity | Fixed | Commit | Regression test |
|---|---|---|---|---|---|
| 1 | `/api/track-event` minted unbounded attacker-named permanent KV keys; admin analytics panel read them 1:1 and broke past the subrequest cap | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 1` (5 tests) |
| 2 | `/api/lists/like` wrote a stale whole-record snapshot, silently reverting a concurrent creator save | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 2` (1 test) |
| 3 | `checkForNewEpisodes` cron wrote a stale whole tracking blob, silently destroying user watch history | 🔴 Critical | 2026-09-05 | `ff9cbfe` | `audit fix 3` (1 test) |
| 4 | `/api/publish-list` + `/api/save`: unauthenticated, uncapped, permanent KV writes | 🔴 High | 2026-09-05 | `ff9cbfe` | `audit fix 4` (4 tests) |
| 16 | `build.py` recovered its header from its own previous output, so editing `00_constants.js` made the build unrunnable | 🟡 Low | 2026-09-05 | `ff9cbfe` | `verify.sh` step 2 (header now in `header.js`, proven byte-identical) |

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

---

## ⬜ Open — next up, in recommended order

| # | Finding | Severity | File / location | Why it matters |
|---|---|---|---|---|
| 5 | Missing rate limits on the remaining unauthenticated write and shared-key fan-out endpoints | 🟠 Medium | `25_`: `/api/details/batch`, `/api/bulk-resolve`, `/api/recommendations`, `/api/external-list/*` | Anonymous callers can burn the operator's TMDB/Trakt/MDBList quota. Same per-IP pattern now used in four places. |
| 8 | Duplicate `handlePosterImgError`; the losing definition is the one 3 of 5 call sites were written for | 🟠 Medium | `16_:800` vs `23_:825` | A failed poster force-shows the ✕ remove button / count overlay in its place. Fix = delete `16_`'s + make `23_`'s branch class-check the sibling. Add the CI duplicate-declaration guard at the same time. |
| 10 | Admin "Top Community Lists" ranks the alphabetically-first 100 in KV-only mode | 🟠 Medium | `03_admin.js:~833` | Reports a lexicographic sample as "top". Fix = rank from `index:publiclists`, which already carries likes and is already sorted — also removes ~100 KV reads per dashboard load. |
| 9 | Stat counters are non-atomic read-modify-writes | 🟠 Med-High | `03_admin.js` `bumpStat`/`bumpStatBy`/`recordTrackedEvent`/`recordSearchQuery` | 20 concurrent requests recorded as 1. Worsens with traffic (KV edge-cached reads + 1 write/sec/key). Fix = shard hot keys, or move counters to D1, or label the panels approximate. Needs a migration — the largest of the remaining items. |
| 13 | No timeout on any of ~135 outbound fetches | 🟠 Medium | `02_` `fetchWithPerUserCacheUncoalesced`, `fetchTraktWithRetry` | A hung upstream stalls the request; the stale-fallback tiers only trigger on rejection. Fix = `AbortSignal.timeout` at the two shared helpers, not 135 call sites. |
| 11 | N+1 KV reads on every playback ping | 🟠 Medium | `26_:~410` | Enumerates and reads every one of the creator's lists to find the watchlist; also has no cursor, so it truncates at 1,000. Fix = read `creatorlist:{u}:watchlist` directly, scan only as fallback. |
| 12 | Orphaned KV on account deletion | 🟠 Low-Med | `02_` `purgeCreatorData` | `listlikevoters:{u}:*` and `scrobbleseenusers:{u}` survive deletion, so a recycled username inherits stale like counts. Also: the `creatortrack:` "legacy" comment is wrong — it is a live key. |
| 14 | `MDBLIST_CLIENT_SECRET` required but documented nowhere | 🟠 Medium | `wrangler.toml`, `README.md` | Operators follow the docs exactly and MDBList OAuth still fails "not configured". One-line docs fix. |
| 6 | Creator key travels in the `/api/scrobble` query string | 🟡 Low | `26_:~448` | Largely forced (Plex/Jellyfin webhooks can't set headers). Fix = document the trade and the rotation path, don't redesign. |
| 7 | ~40 handlers return raw `String(err.message)` | 🟡 Low | `25_`, `26_` | Leaks nothing today (all `throw`s are status-only) but contradicts the policy stated at `/api/bulk-resolve`. |
| 15 | `FUNCTION-MAP.md` line numbers 26% stale (211 of 811) | 🟡 Low | `FUNCTION-MAP.md`, `gen_map.py` | Nothing regenerates or validates it. Fix = add to `verify.sh`/CI, or drop line numbers. |
| — | Dead code: 4 unreferenced server functions + 4 shadowed client duplicates | 🟡 Low | see audit "Dead Code" | `classifyTraktListContentType`, `getPaddedChannelLogo`, `fetchTrailerForImdb`, `getProviderIconBadge`; `escapeHtml`/`escapeAttr` (`16_`), `showModal`/`closeModal` (`22_`). Do finding 8 first — they are the same edit. |

---

## Notes for whoever picks this up

- **Run `bash verify.sh` before and after every change.** It rebuilds the Worker, fails on drift, syntax-checks the combined file, renders and validates the client bundle, and runs the tests. Current baseline: **no drift, 70/70 passing**.
- **Editing any `[0-9][0-9]_*.js` file requires `python3 build.py`.** `worker_entry_combined.js` is generated and committed; CI fails if it drifts from source.
- **Write the regression test first and confirm it fails against the current code.** Every fix above was validated that way: stash the source change, keep the test, rebuild, watch it fail. A test that passes before the fix is not testing the fix.
- **Do not consult the audit report's "DO NOT TOUCH" list as optional.** It records twelve pieces of load-bearing compatibility code that look removable and are not — the D1-miss→KV fallback, the base64 config branch, the `Sec-Fetch-Mode`-only navigation check, and others.
- **Prefer rejecting over truncating.** Findings 1–4 were all silent-failure bugs; a fix that silently drops data replaces one with another.
