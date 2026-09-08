# Adversarial Audit III — remediation status

Tracker for [`AUDIT-2026-09-08-ADVERSARIAL-III.md`](./AUDIT-2026-09-08-ADVERSARIAL-III.md).
Baseline `932da34`. Branch `claude/my-lists-security-audit-3n895k`.

**Rating movement:** `CRITICAL — do not keep serving shared links` → **`CRITICAL CLOSED`** (round 1)

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

## 🔜 Remaining, in order

Next up is the rest of Phase 1 and Phase 2 — the two `/api/resolve` findings and the ghost-list
deletion race.

| # | Severity | Issue | Where |
|---|---|---|---|
| 4 | 🟠 | `/api/resolve` → `jsonPrivate()`, and add it to `isPrivateApiPath()` | `25_…:5606`, `02_…:48` |
| 5 | 🟠 | `/api/resolve` → https-only, public-host check, per-IP rate limit | `25_…:5591` |
| 6 | 🟠 | `purgeCreatorData`: re-sweep `creatorlist:` after the identity is removed | `02_…:2845` |
| 7 | 🟠 | `/lists/:user/:slug`: 404 a creator list whose creator record is gone | `26_…:3735` |
| 8 | 🟡 | `saveLocalCustomListEdit`: surface 401/409/500 instead of showing “saved” | `21_…:663` |
| 9 | 🟡 | Route the three slug-bearing `lists/save` call sites through `saveCreatorListWithBaseline` | `19_…:3109`, `21_…:663`, `21_…:1320` |
| 10 | 🟠 | `isShow` → `/lists/curated/:slug` | `25_…:485` |
| 11 | 🟡 | `clientId` → `TRAKT_CLIENT_ID` in the Trakt OAuth callback | `25_…:2575` |
| 12 | 🟡 | `listName` → `created[0].name`, so copy telemetry can fire | `18_…:232` |
| 13 | 🔴 | CI: a `no-undef` scope pass over the Worker **and** the rendered bundle — 10, 11 and 12 are the same defect | `.github/workflows/ci.yml` |
| 14 | 🟡 | Directory fallback: `/lists/user/<slug>`, not `/lists/Anonymous/…` | `25_…:452` |
| 15+ | 🟡🔵 | README free-plan note, `TextEncoder` byte guard, `/api/creator/lists` paging, dead code | see the audit’s fix order |
