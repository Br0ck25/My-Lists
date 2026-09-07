# Frontend audit probes — 2026-09-07

Executable reproductions for every confirmed finding in
[`AUDIT-2026-09-07-FRONTEND.md`](../../AUDIT-2026-09-07-FRONTEND.md).

Unlike the two earlier `audit/` directories, these drive a **real browser**
against a **real Worker**, because every finding here lives in what the client
does with an answer rather than in the answer itself.

## Requirements

- Node 22 (for `node:sqlite`, which `tests/harness.mjs` uses for D1)
- Playwright with Chromium. `drive.mjs` imports it from
  `/opt/node22/lib/node_modules/playwright/index.mjs`; change that path, or
  `npm i -D playwright && npx playwright install chromium` and import
  `"playwright"` instead.

## Running

Start the rig, then run a probe against it:

```bash
node audit/frontend-2026-09-07/server.mjs &          # real Worker on :8787, KV + SQLite D1
node audit/frontend-2026-09-07/t34_adminbroken.mjs   # FE-01
```

`server.mjs` wraps `worker.fetch` in a `node:http` server. It:

- gives every request a **distinct `CF-Connecting-IP`**, or the shared 60-second
  rate limiter throttles the crawl and probes fail for the wrong reason;
- stubs the four upstream providers (TMDB / Trakt / MDBList / Simkl) so runs are
  deterministic and need no network;
- exposes `POST /__ctl` for fault injection — `{"faults":[{"match":"<regex on the
  request URL>","delayMs":N,"status":N,"body":"…","drop":true,"times":N}]}`,
  and `{"reset":true}` to clear. This is what produces the search race, the
  account-switch race and the seven fault scenarios.

For `t30_d1_vs_kv.mjs` a **second** instance with D1 unbound is needed:

```bash
sed 's/const d1 = makeD1();/const d1 = undefined;/' \
  audit/frontend-2026-09-07/server.mjs > /tmp/server_nod1.mjs
PORT=8788 node /tmp/server_nod1.mjs &
```

## Probe index

| Probe | Finding | What it demonstrates |
|---|---|---|
| `t34_adminbroken.mjs` | **FE-01** | Every admin global is `undefined`; clicks throw `ReferenceError` |
| `t05_xss_proof.mjs` | **FE-02** | The sink: `escapeAttr` output re-forms the `&quot;` delimiter and executes |
| `t36_xss_e2e.mjs` | **FE-02** | End-to-end via a pasted backup — steals the Creator Key |
| `t37_link_xss.mjs` + `evil.mjs` | **FE-02** | End-to-end via an install link from an attacker origin |
| `t28_create_race.mjs` | **FE-03** | Concurrent `creator/create`: N keys, one valid |
| `t29_double_rate.mjs` | **FE-03** | 6/6 double-clicks produce an account whose key 401s |
| `t30_d1_vs_kv.mjs` | **FE-03** | Which key survives, D1 bound vs unbound — the regression |
| `t24_falsesuccess.mjs` | **FE-04** | Server answers 400 `ok:false`; UI toasts "Removed from TRAKT." |
| `t19_lostupdate.mjs` | **FE-05** | Two devices, no `expectedUpdatedAt`, one edit silently lost |
| `t10_search_race.mjs` | **FE-06** | Obsolete search response wins; results for an erased query |
| `t09_likedlists.mjs` | **FE-07** | `likedLists` of objects → `u.split is not a function` |
| `t26_restore.mjs` | **FE-07** | Full path: restore reports success, Curated dies permanently |
| `t04c.mjs` | **FE-08** | Page scrolls behind an open modal |
| `t04_scrolllock.mjs` | **FE-12** | `body.style.overflow` left `hidden` with no modal open |
| `t12_syncrace.mjs` | **FE-09** | Alice's sync payload applied to Bob's signed-in session |
| `t16_a11y.mjs` | **FE-10, FE-11** | Escape, focus, focus trap, ARIA, labels, live regions |
| `t18b_resp.mjs` | **FE-14** | 9 viewports × 6 tabs; overflow and clipped-nav measurement |
| `t44_offline.mjs` | **FE-15** | Offline reload: error page before, app booted after |
| `t45_sw_freshness.mjs` | **FE-15** | Old cache dropped on activate; a deploy beats the cached page |
| `t31_nav320.mjs` | **FE-14** | Every bottom-nav label fits inside a 320px viewport |
| `t20_leaks.mjs` | — | 200 modals / 200 tab switches / 60 searches: no leak |
| `t23_fault.mjs` | — | 7 injected failures; every one recovers |
| `t25_storage.mjs` | — | Malformed JSON, wrong types, quota exhaustion |
| `t21_url.mjs` | — | 14 malformed and hostile deep links |
| `t46_background_resume.mjs` | **FE-17** | Backgrounded PWA resumed: which desktop changes reach it |
| `t47_stale_list_overwrite.mjs` | **FE-17** | The stale copy is never pushed over the desktop's — 409, warning, converge |
| `t48_resume_variants.mjs` | **FE-17** | Foreground poll vs. cold start vs. recovery after the refused save |

## Multi-device resume (t46 / t47 / t48)

These three answer one question: a PWA left open in the background on a phone
while another device makes changes — does the phone see them, or overwrite them?

They need one seeded account each (they mutate its lists), created through the
running rig:

```bash
node -e '
const B="http://127.0.0.1:8787";const u=process.argv[1];
(async()=>{const r=await(await fetch(B+"/api/creator/create",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({creatorName:u})})).json();
await fetch(B+"/api/creator/sync/save",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({creatorName:u,creatorKey:r.creatorKey,
    config:[{name:"ORIGINAL-ROW",url:"https://mdblist.com/lists/"+u+"/x",type:"movie",enabled:true}]})});
await fetch(B+"/api/creator/lists/save",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({creatorName:u,creatorKey:r.creatorKey,name:"Shared List",type:"movie",
    visibility:"public",items:[{id:"tt0137523",type:"movie",title:"Fight Club",year:1999}]})});
console.log(u,r.creatorKey);})()' erin
node audit/frontend-2026-09-07/t46_background_resume.mjs erin <key>
```

Two things about how they work. Visibility is **emulated** — `document.visibilityState`
and `hidden` are overridden and `visibilitychange`/`focus`/`pageshow` dispatched —
because headless Chromium does not occlude a background tab, and `bringToFront()`
leaves `visibilityState` at `visible` (the first cut of `t46` measured nothing for
exactly that reason). The client only reads those two properties and those events,
so this is what it observes on a real resume.

Wall-clock time is **compressed**, and that is safe rather than assumed: nothing on
the resume path is time-based, and `t46` holds the phone hidden across a full 60s
poll interval and records that it makes zero requests the whole time. A 30-minute
background and a 70-second one run the same code.

`t46` and `t48` take ~90s each — most of it deliberate waiting.

## Seeding

`t12_syncrace.mjs` and `t19_lostupdate.mjs` need accounts. `t19` creates its own.
For `t12`, create two through the running rig and pass the keys as argv:

```bash
node -e '
const B="http://127.0.0.1:8787";
(async()=>{for(const u of["alice","bob"]){
  const r=await(await fetch(B+"/api/creator/create",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify({creatorName:u})})).json();
  await fetch(B+"/api/creator/sync/save",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({creatorName:u,creatorKey:r.creatorKey,
      config:[{name:u+"-ROW",url:"https://mdblist.com/lists/"+u+"/x",type:"movie",enabled:true}],
      likedLists:["https://mdblist.com/lists/"+u+"/liked"]})});
  console.log(u,r.creatorKey);}})()'
node audit/frontend-2026-09-07/t12_syncrace.mjs <alice-key> <bob-key>
```

## Note

These probes are diagnostic, not a test suite. The report's **Recommended Test
Suite** section says which of them should be turned into permanent tests in
`tests/client.test.mjs` and `html_checks.py` — starting with rendering `/admin`
and syntax-checking its inline scripts, which is the check that would have caught
the most serious finding here two days before this audit.
