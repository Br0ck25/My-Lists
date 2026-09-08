# Adversarial Audit III — executable probes (2026-09-08)

The findings these produce are written up in
[`../../AUDIT-2026-09-08-ADVERSARIAL-III.md`](../../AUDIT-2026-09-08-ADVERSARIAL-III.md).

Every probe drives the real `worker_entry_combined.js` export (or the real client bundle)
through the repo's own harnesses in `tests/`. Nothing here modifies the Worker. Run from this
directory with Node 22:

    node p03_curated.mjs

## Security

| Probe | Proves |
|---|---|
| `p12_xss_final.mjs` | the full `</script>`-breakout sink inventory (list name, item title, item poster, display name, `serverEntries`, four OAuth/key fields) |
| `p15_ctx.mjs` | which reflection context each `/{config}/configure` field lands in (script body vs. HTML attribute) |
| `p16_attr.mjs` | the four unescaped `value="${…}"` attributes |
| `p17_entries.mjs` | `serverEntries` breakout via both the base64 config and the short `/api/save` id |
| `p13_browser_xss.mjs` | **real Chromium**: anonymous `/api/publish-list` → shared page → attacker script reads the victim's Creator Key |
| `p14_browser_xss2.mjs` | **real Chromium**: the install-link (`/<config>/configure` and `/<config>/manifest.json`) variant |
| `p20_ssrf.mjs` | `/api/resolve?url=` fetches an attacker-named origin, echoes its body, no rate limit |
| `p31_installlink.mjs` | what an install link hands to anyone who has it |
| `p34_cache.mjs` | `/api/resolve` is the only per-account GET with `max-age=3600` |
| `p05_authmatrix.mjs` | 19 creator routes × {no auth, wrong key, **another creator's key**} — all 401 |
| `p06_adminmatrix.mjs` | 22 admin routes × {no cookie, forged signature, expired} — all 401 |
| `p07_fuzz.mjs` | 112 routes × 9 hostile payload shapes + query abuse; prototype-pollution check |
| `p08_pathfuzz.mjs` | the regex/parameterised routes, traversal and encoding abuse |
| `p35_misc.mjs` | `/admin/logout` accepts any method; the cookie survives logout; publish-list rate limit |

## Correctness

| Probe | Proves |
|---|---|
| `undef.mjs` | scope analysis (acorn + eslint-scope). `node undef.mjs ../../worker_entry_combined.js` → `isShow`, `clientId` |
| `triage.mjs` | separates `typeof`-guarded references from bare ones in the client bundle |
| `deadfn.mjs` | functions declared but never referenced |
| `handlers.py` | broader inline-handler resolution scan than `html_checks.py` (both quote styles, all `on*`) |
| `p03_curated.mjs` | `/lists/curated/:slug` returns 500 on every request |
| `p02_clientid.mjs` | the Trakt OAuth callback never issues its `/users/me` request |
| `p04b_listcopy_e2e.mjs` | copying a list sends **zero** `/api/track-event` requests |
| `p04c.mjs` | control: the same run with a `listName` binding sends exactly one |
| `p19_anonurl.mjs` | the cold-index directory advertises `/lists/Anonymous/<slug>`, which 404s |
| `p33_falsesuccess.mjs` | `saveLocalCustomListEdit` shows "saved" on 401, 409 and 500 |

## Data integrity and scale

| Probe | Proves |
|---|---|
| `p25_race.mjs` | 20 parallel saves / 20 parallel likes / 10 parallel tracking pushes — all clean |
| `p26_ghostpublic.mjs` | a write held across `delete-account` leaves a permanently-public, unremovable list |
| `p27_ghostnatural.mjs` | the same with **no** artificial stalling: 6/10 plain concurrent runs |
| `p28_rebuild_privacy.mjs` | making a list private *through the API* mid-rebuild is **not** republished (clean) |
| `p29_dashscale.mjs` | `/api/creator/lists` KV ops and response size at 10 / 100 / 500 / 1,200 lists |
| `p30_breakpoint.mjs` | the exact breakpoint: 990 lists → 1,001 KV ops, over Cloudflare's cap |
| `p21_scale_index.mjs` | cost of one public save at index sizes 100 → 20,000 (4.45 MB RMW) |
| `p22_kvops.mjs` | KV get/put/delete/list counts per request, with and without D1 |
| `p23_subrequests.mjs` | outbound `fetch()` per invocation vs. the free plan's 50 |
| `p24_cpu.mjs` | PBKDF2 and per-request CPU vs. the free plan's 10 ms |

`p13_browser_xss.mjs` and `p14_browser_xss2.mjs` need `npm i playwright` and a Chromium at
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`; adjust `executablePath` for your machine.
Everything else needs only Node 22 and this repository.
