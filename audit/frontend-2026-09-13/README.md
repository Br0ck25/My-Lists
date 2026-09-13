# Frontend audit probes — 2026-09-13

Executable reproductions for every confirmed finding in
[`AUDIT-2026-09-13-FRONTEND.md`](../../AUDIT-2026-09-13-FRONTEND.md).

Like the 2026-09-07 set, these drive **real Chromium** against the **real
Worker**. Nothing here is a mock of the app: `server.mjs` runs
`worker_entry_combined.js` itself over HTTP, backed by the repo's own
in-memory KV and SQLite-backed D1 (`tests/harness.mjs`).

## Requirements

- Node 22 (for `node:sqlite`)
- `npm install --no-save playwright-core` (Chromium itself is expected at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; override with
  `CHROMIUM_PATH=/path/to/chrome`)

## Running

```bash
node audit/frontend-2026-09-13/server.mjs &      # real Worker on :8787 (control plane :8788)
node audit/frontend-2026-09-13/t07_import_dataloss.mjs
```

`server.mjs` also exposes a small control plane on **:8788** —
`/reqs` (every request the Worker served), `/reqs/clear`, `/upstream`
(outbound provider calls, which are stubbed), `/kv`, and
`/sql?<query>` to read D1 directly.

Two probes do not need the server: `t01_bundle_stability.mjs` evaluates the
Worker in a `vm`, and `t02_markshowwatched_race.mjs` uses
`tests/client-harness.mjs`.

`server-hotswap.mjs` (port **:8790**) serves two different builds of the
Worker on one origin so service-worker update behaviour can be tested across
a simulated deploy — `GET /__deploy/v1`, `/__deploy/v2`, `/__deploy/which`.
It needs a `worker_v2.js` beside it, built with:

```bash
python3 - <<'PY'
src = open('worker_entry_combined.js','rb').read()
m = b"<script>/*MYLISTS_APP_BUNDLE_START*/"
i = src.rindex(m) + len(m)            # rindex: the marker in the page, not the const in 02_
open('audit/frontend-2026-09-13/worker_v2.js','wb').write(src[:i] + b"\n/* DEPLOY_V2_MARKER */" + src[i:])
PY
```

## Probe index

| Probe | Backs | Result on this tree |
|---|---|---|
| `t01_bundle_stability.mjs` | shared `/app.js` carries no per-request data | PASS |
| `t02_markshowwatched_race.mjs` | **FE2-02** | FAILS at 0 ms gap |
| `t03_scrolllock_invariant.mjs` | **FE2-04** | 6/400 sequences violate |
| `t04_scrolllock_static.mjs` | **FE2-05** | lock released early |
| `t05_banner_320.mjs` | **FE2-03** | 37 px of 111 px visible at 320 px |
| `t06_backup_fuzz.mjs` | **FE2-01** (+ 13 clean cases) | 1 of 14 throws |
| `t07_import_dataloss.mjs` | **FE2-01** end-to-end | 8 rows → 1 row |
| `t08_fault_injection.mjs` | recoverability | 9/9 recover |
| `t09_stored_xss.mjs` | stored-XSS via publish → deep link | no execution |
| `t10_hostile_render.mjs` | hostile API data through every tab | no execution |
| `t11_account_switch.mjs` | cross-account contamination | clean |
| `t12_responsive.mjs` | 9 viewports × 6 tabs | no page h-scroll |
| `t13_sw_offline.mjs` | offline + offline across a deploy | works |
| `t14_a11y.mjs` | labels/roles/names per tab | **FE2-06** (3 inputs) |
| `t15_modal_lifecycle.mjs` | 120 open/close, Escape, focus restore | no leak |
| `t16_duplicate_requests.mjs` | load-time request fan-out | see report |

`mocks.mjs` supplies realistic (and optionally hostile) API responses so the
UI runs its **success** paths; without it every list is empty and the app sits
in its error/retry path, which is what makes a naive crawl report phantom
"duplicate requests".
