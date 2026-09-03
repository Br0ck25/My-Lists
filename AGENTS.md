# Working notes

Read this first. It exists so a session can start work immediately instead of
spending its first twenty tool calls rediscovering things that don't change.

---

## Ground rules

1. **Never redirect a verification check to `/dev/null`.** This has cost a
   session's work once already: `check_sync.py` correctly reported that five
   split files were stale, the output was thrown away, and the rebuild baked
   the regression into the combined file.
2. **The split files are the source. `worker_entry_combined.js` is a build
   artifact** produced by `build.ps1` / `tools/build.py`. Never edit it by hand
   and never treat it as the thing to diff against.
3. **Deliver the complete set of changed split files, not just this session's.**
   Sessions layer on each other; handing back a patch that assumes the right
   base is how the stale-file incident happened.
4. **Behavioural tests over reading code.** Every real bug found in this project
   was found by running the code against a mock, not by reading it. Three
   examples: an airing-index rewrite that looked correct and disagreed with the
   original on 301 of 2,000 randomised cases; a chunked renderer that was
   silently deleted by an over-wide replacement and still passed `node --check`;
   an import validator whose regex was collapsed into broken syntax by the
   template literal.
5. **Run `bash tools/verify.sh` before handing anything back.**

---

## The hazard that dominates everything

`renderBuilder()` opens a single template literal in `09_page-shell.js` and
closes it at the end of `24_client-backup-restore-presets.js`. **Files 09–24
are inside a JavaScript string.**

- **A backtick anywhere in 09–24 ends the literal early** and breaks the build.
  Even inside a `//` comment. Check 6 in the pipeline guards this.
- **Escape sequences must be doubled.** A regex written `/^\d+$/` in files
  09–24 renders as `/^d+$/` in the browser. Write `/^\\d+$/`. Same for `'\\n'`
  in a string. This is not theoretical — it has broken a change already.
- Because of the above, **the behavioural suites slice the *rendered* script**
  (`rendered.html`), not the raw source. That is the code the browser actually
  runs. Slicing raw source hides exactly this class of bug.
- **New top-level server functions go after file 24**, not near 09.

Files 00–08 and 25–26 are plain server code with no such constraints.

---

## File map

| file | endings | zone | what lives there |
|---|---|---|---|
| `00_constants.js` | LF | server | constants |
| `01_icon-asset.js` | CRLF | server | base64 icon — never needs reading |
| `02_http-and-creator-utils.js` | CRLF | server | auth, per-user cache + circuit breaker, ETag/bundle/CSS splitting |
| `03_admin.js` | LF | server | admin dashboard |
| `04_config-resolution.js` | LF | server | `detectSource`, config parsing |
| `05_catalog-core.js` | LF | server | catalog assembly, `fetchCustomListCatalog` |
| `06_source-fetchers-mdblist-trakt.js` | CRLF | server | MDBList + Trakt fetchers |
| `07_source-fetchers-tmdb-simkl.js` | LF | server | TMDB + Simkl fetchers, cron |
| `08_quickadd-chart-data.js` | CRLF | server | chart definitions |
| `09_page-shell.js` | CRLF | **literal opens** | `<head>`, the `<style>` block |
| `10`–`15` | mixed | literal | tab HTML |
| `16_client-row-core.js` | CRLF | literal | **per-request preamble**, then the app bundle opens |
| `17`–`20` | mixed | literal | my-lists, copy/export, search/likes, channels |
| `21_client-custom-list-builder.js` | CRLF | literal | custom lists, watch tracking, badge index, Airing Next |
| `22_client-creator-profile.js` | CRLF | literal | accounts, sync, local storage, dashboard |
| `23_client-list-management.js` | LF | literal | poster rendering, See All, chunked grid |
| `24_client-backup-restore-presets.js` | LF | **literal closes** | backup/restore, presets |
| `25_api-catalog-routes.js` | LF | server | catalog + page routes, `/app.js`, `/app.css`, `/sw.js` |
| `26_api-creator-and-admin-routes.js` | LF | server | account routes, admin API |

**Line endings matter** because edits are applied as byte-exact replacements.
Match the file's existing endings or the replacement won't be found.

For anything more specific, use **`FUNCTION-MAP.md`** — 751 symbols and 103
routes with `file:line` for each. Regenerate with `python3 tools/gen_map.py`
after adding or moving functions. One read of that file replaces a dozen greps.

---

## Architecture notes worth knowing before changing things

- **A catalog row's `url` is not a pointer, it is the data.** A channel row can
  be 75KB because the full item array is embedded in the URL. This is
  deliberate: a self-hosted Worker with no KV binding has nowhere else to put
  it — the install link *is* the storage. Backups and presets store references
  instead (format 3.0); live rows still embed. Don't "fix" the live rows without
  deciding what happens to no-KV self-hosters.
- **`loadLocalCustomLists` reads memory → sessionStorage → localStorage.** The
  sessionStorage mirror is easy to forget and has caused a real bug (sign-out
  appearing not to work).
- **Signed-in accounts keep each Custom List as its own KV record**
  (`creatorlist:<user>:<slug>`), so there is no shared size ceiling server-side.
  localStorage is the cache; the account is the durable copy.
- **The client sends `creatorName` + `creatorKey` on every authenticated
  request.** There is no session token. Verification is PBKDF2 at 100k
  iterations, memoized per isolate after a *successful* check only.
- **`/api/creator/delete-account` targets old key names** (`creatorprofile:`,
  `creatortrack:`, `creatorpresets:`, `creatorchannels:`) that this codebase no
  longer writes. A "permanent" deletion currently leaves most data behind. Open
  issue, flagged not fixed — see `NEXT-STEPS.md`.

---

## Workflow that works

```
# 1. read the map, not the code
cat FUNCTION-MAP.md | grep -i <symbol>

# 2. read only the function you're changing
sed -n '<start>,<end>p' <file>

# 3. edit with a byte-exact Python replacement, asserting the match count
#    assert d.count(old) == 1   <- catches a moved/renamed anchor immediately

# 4. verify
bash tools/verify.sh
```

**Add a test for anything with a failure mode.** The suites in `tests/` are
named for what they cover; a new one costs little and pays for itself the first
time something regresses. Several checks in `verify.sh` exist specifically to
catch a *future* change: that every delete path records a tombstone, that every
push path honours the reset guard, that no per-poster history scan comes back.

---

## Cost notes

- Don't read `worker_entry_combined.js` or `01_icon-asset.js`. Ever.
- `Changes.md` is ~360KB across 149 entries and grows every session. Archive
  entries older than a few months to `Changes-archive.md` so the live file stays
  cheap to search.
- Prefer a fresh conversation per task. Long threads carry every earlier tool
  result forward.
