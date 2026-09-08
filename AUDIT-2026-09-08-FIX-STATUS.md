# Adversarial Audit III — remediation status

Tracker for [`AUDIT-2026-09-08-ADVERSARIAL-III.md`](./AUDIT-2026-09-08-ADVERSARIAL-III.md).
Baseline `932da34`. Branch `claude/my-lists-security-audit-3n895k`.

**Rating movement:** `CRITICAL — do not keep serving shared links` → `CRITICAL CLOSED` (round 1) → **`ALL HIGH-SEVERITY SECURITY CLOSED`** (round 2)

---

## ✅ Round 1 — the critical XSS, closed

Items 1–3 of the recommended fix order. Together they are the whole of the CRITICAL finding:
the two escaping bugs, and the check that stops them coming back.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 1 | 🔴 | **`</script>` breakout in the inline preamble.** `JSON.stringify` escapes `"` and `\` — everything the JS parser needs and nothing the HTML parser does. An HTML tokenizer ends a script element at the first `</script`, so a published list's name, an item title, a creator display name, a config entry name, or an OAuth token ended the block and the rest was parsed as markup. | New `jsonForScript()` (`02_http-and-creator-utils.js`), applied at **all 21** stringify sites that land in a script element — not only the six a caller can reach today. Escapes `<`, `>`, U+2028, U+2029 as `\uXXXX`, which is valid in both grammars the output must satisfy. | Real Chromium: `p13`, `p14`, `p39` all now report the attacker script **did not run** |
| 2 | 🔴 | **Attribute breakout.** Five settings inputs interpolated straight into `value="${…}"` with no escaping, so a `"` in an install link's `tmdbKey` / `traktKey` / `traktUsername` / `mdblistKey` / `simklKey` ended the attribute and injected its own event handler. | `escapeHtmlServer()` at all five sites (`15_tab-settings-html.js`). | `p39_attr_browser.mjs`: handler does not fire, **and** the value still round-trips into the input unchanged |
| 3 | 🔴 | **Nothing could see either bug.** CI proved the page *parses* (`node --check`, the rendered-script check) and that inline handlers resolve. Nothing proved a hostile value came out inert — which is why two prior audits called this area clean: both tested the client-side render, where `escapeHtml` is applied correctly, and neither tested the server-rendered preamble. | `render_check.js --hostile` renders the builder page with every caller-supplied field set to a payload; `html_checks.py` asserts neither marker breaks out **and that both markers are present first**, so a render that quietly stopped including them cannot pass by proving nothing. Wired into `verify.sh` (step 4d) and `.github/workflows/ci.yml`. | Mutation-tested — see below |

### Mutation test of the new check

A check that cannot fail is worse than no check. Three mutations, each caught:

```
MUTATION 1  revert the script-preamble escape   -> FAIL: MYLXSSPROBE</script survived …            exit=1
MUTATION 2  revert one attribute escape         -> FAIL: MYLXSSATTR" survived …                    exit=1
MUTATION 3  hostile render stops injecting      -> FAIL: MYLXSSPROBE is absent -- the hostile
            the payloads (the trap)                      render did not reach the script preamble  exit=1
```

### Exploit re-tested, in a real browser

Every vector from the audit, re-run against the fixed build:

```
p13  stored, anonymous POST /api/publish-list -> /lists/user/<slug>
     attacker script executed in the victim's browser: false      (was: true)
     document.title after payload: unchanged                       (was: PWNED:MYL-VICT-IMSK-EY01)
     page errors: []

p14  reflected, install link
     A. /<config>/configure                       ran: false       (was: true)
     B. /<config>/manifest.json -> 302 -> configure  ran: false    (was: true)

p39  attribute injection via an install link's tmdbKey
     attribute-injected handler ran: false
     the key still round-trips: "x\" autofocus onfocus=\"…"        (escaping is lossless)
```

### The fix is lossless

The regression risk of `<` escaping is that it changes a parsed value. It does not —
it is a valid escape in JSON *and* in JavaScript source, so only the wire bytes change
(`p40_roundtrip.mjs`, real Chromium, on a list named
`Sci-Fi <3 & "Classics" — 2000s   top 10 > 8.0 ❤️ 日本語`):

```
list name round-trips exactly : true
item title round-trips exactly: true
serverEntries still an array  : true
chart tables still populated  : true
ld+json still parses as JSON  : true
page errors                   : []
```

`bash verify.sh` green: build reproduces byte-for-byte, `node --check` passes, all four render
checks pass including the new hostile one, FUNCTION-MAP.md has no drift, **356 tests pass**.

---

## ✅ Round 2 — both `/api/resolve` findings and the ghost-list race

Items 4–7. Three audit findings, four edits — the ghost-list finding has two halves and
shipping only the first leaves the window half-closed.

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 4 | 🟠 | **`/api/resolve` served one account's MDBList key and Trakt/MDBList OAuth tokens with `Cache-Control: max-age=3600`.** A GET, no `Vary`, so a browser or any shared cache in front of the Worker could store somebody's tokens for an hour. It was the only per-account GET in the app that was cacheable; the six siblings all answer `no-store`, and the page rendering the same secrets sets `no-store` deliberately. | `isPrivateApiPath()` now names it — the choke point whose whole purpose is that a route added later cannot forget — and both success paths return via `jsonPrivate()`. | `p34_cache.mjs`: now `no-store`, matching all six siblings |
| 5 | 🟠 | **`/api/resolve` was an unauthenticated request proxy.** Host, port and scheme came straight from the query string; the Worker fetched that origin and echoed the body back. No allowlist, no rate limit. `/api/preview` grew both for the same shape and this sibling was missed. | New `isRemoteResolveOrigin()`: https only, default port, DNS-named host with an **alphabetic TLD** — which rejects every IP literal in every encoding a URL parser accepts — minus explicit private suffixes. It cannot reuse `/api/preview`'s provider allowlist because the legitimate target is *another deployment of this add-on*, on whatever domain its owner chose. Outbound branch charged against a 20/min per-IP bucket. | `p20_ssrf.mjs`: **0** outbound requests, was 27. `p41`: 20 unit cases + 11 live variants blocked |
| 6 | 🟠 | **The purge's second pass stranded directory rows.** The first pass hands its ids to `removeListsFromPublicIndex`; the second deleted only the KV keys, so a list landing between the two passes lost its record and kept its index row — a directory entry advertising an item count that 404s on click. | Second pass collects `lateListIds` and drops them too. `updatePublicListIndex` additionally refuses an ADD for an account whose deletion tombstone is already written — and the tombstone is the *first* thing `purgeCreatorData` writes. | `p26`, `p27` |
| 7 | 🟠 | **An ownerless list stayed public and unremovable.** A save that authenticated a millisecond before its owner deleted the account keeps running and its KV put lands after both sweeps — 6 of 10 plain concurrent runs. The record is genuinely `public`, so it stayed readable, listed and searchable, and could never be removed: every authenticated route answers 401 for that username. | Fail closed on read. `/lists/:user/:slug` 404s a creator list with no creator record; the rebuild skips orphans; both cold-index fallbacks filter through one memoized `makeCreatorExistsMemo()`. Gated on `isCreatorList` so anonymous lists (no account, by design) are untouched; a *failed* read counts as present, so a KV blip cannot hide a live list. | `p26_ghostpublic.mjs`: page **404**, directory **empty**, search **empty** — was 200, listed, listed |

### A correction to this tracker

Item 6 above said "re-sweep `creatorlist:` after the identity is removed". That sweep
**already existed** — the audit said "after the *existing* post-identity sweep" and the
one-line restatement lost the word. A third sweep would only narrow the window again, since
nothing bounds how late a KV write may land, so none was added. The two gaps the audit actually
named — the second pass not cleaning the directory, and the read side not failing closed — are
what got fixed.

### Legitimate behaviour, checked rather than assumed

```
$ node p41_resolve_fixed.mjs
1. a link from a sibling deployment
   status 200 | entries: 1 | name: From the sibling deployment
   outbound: [ 'https://someone-else.workers.dev/api/resolve?config=…' ]
   Cache-Control: no-store
2. the SSRF cases                      11 variants, outbound=0 on every one
3. rate limit on the outbound branch   30 calls from one IP -> 20 allowed, 10 throttled
4. an ordinary import                  40 local resolves from the SAME throttled IP -> 40 succeeded
```

Three directory tests failed on the first run. They seeded `creatorlist:` keys with **no
`creator:` record** — a state no write path can produce, since every creator-list write goes
through `authenticateCreator`. The fixtures were unrealistic, not the check: they now seed the
account too, which also makes them catch a regression in the new filter. Three tests added pin
the behaviour; the half that only fires on a genuine race says so in a comment and points at the
two probes that cover it, rather than shipping a test that passes for the wrong reason.

`bash verify.sh` green — **358 tests pass**. Auth matrix, admin matrix, rebuild-privacy and the
XSS probes all re-run clean.

---

## 🔜 Remaining, in order

Next up is the rest of Phase 1 and Phase 2 — the two `/api/resolve` findings and the ghost-list
deletion race.

| # | Severity | Issue | Where |
|---|---|---|---|
| 8 | 🟡 | `saveLocalCustomListEdit`: surface 401/409/500 instead of showing “saved” | `21_…:663` |
| 9 | 🟡 | Route the three slug-bearing `lists/save` call sites through `saveCreatorListWithBaseline` | `19_…:3109`, `21_…:663`, `21_…:1320` |
| 10 | 🟠 | `isShow` → `/lists/curated/:slug` | `25_…:485` |
| 11 | 🟡 | `clientId` → `TRAKT_CLIENT_ID` in the Trakt OAuth callback | `25_…:2575` |
| 12 | 🟡 | `listName` → `created[0].name`, so copy telemetry can fire | `18_…:232` |
| 13 | 🔴 | CI: a `no-undef` scope pass over the Worker **and** the rendered bundle — 10, 11 and 12 are the same defect | `.github/workflows/ci.yml` |
| 14 | 🟡 | Directory fallback: `/lists/user/<slug>`, not `/lists/Anonymous/…` | `25_…:452` |
| 15+ | 🟡🔵 | README free-plan note, `TextEncoder` byte guard, `/api/creator/lists` paging, dead code | see the audit’s fix order |
