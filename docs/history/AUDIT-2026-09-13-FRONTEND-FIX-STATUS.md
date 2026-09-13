# Frontend Audit 2026-09-13 — remediation status

**Report:** [`AUDIT-2026-09-13-FRONTEND.md`](./AUDIT-2026-09-13-FRONTEND.md)
**Probes:** [`../../audit/frontend-2026-09-13/`](../../audit/frontend-2026-09-13/)
**Rating movement:** `2 HIGH, 1 MEDIUM, 4 LOW, CI red` → **`EVERY FINDING CLOSED. CI GREEN.`**

Closed in one round, shipped in [#44](https://github.com/Br0ck25/My-Lists/pull/44) (`e10a3ea`) and
[#45](https://github.com/Br0ck25/My-Lists/pull/45). `bash verify.sh`: ALL CHECKS PASSED.

---

## ✅ FE2-01 — HIGH — a numeric list name in a backup destroyed the user's catalogs

`addRow` read `name` without coercing it — the one read in that function that did not — so
`{"name": 2024}` threw `(name || group || 'L').trim is not a function` mid-import. The throw
escaped `applyImportedConfig` *and* the click handler, so rows already cleared stayed cleared,
entries after the bad one were never added, and the report modal — which renders at the *end* of
`applyImportedConfig` — never appeared.

Measured before: **8 catalogs in, 1 row out, no message at all.**

Fixed in three places, because coercing at the sink alone only stops the crash:

- `16_client-row-core.js` — `String(name || group || 'L').trim()` at the sink every caller goes through.
- `24_client-backup-restore-presets.js` — `validateAndRepairBackup` now repairs a non-string
  `name`/`group` **and reports it** ("Repaired 1 row field(s) stored as a number or object instead
  of text"), so a subtly-wrong file is fixed loudly rather than papered over. An object or array is
  dropped rather than stringified to `[object Object]`, letting the usual `guessNameFromUrl`
  fallback supply a real name.
- `24_…` — both import entry points now go through `runImport()`, which catches and shows what went
  wrong. A restore that half-runs must say so.

**Reach, stated precisely.** Backup import only (paste box and file upload). *Not* reachable through
account sync: `creator_lists.name` is a D1 `TEXT` column, so a numeric name POSTed to
`/api/creator/lists/save` reads back as the string `"2024"` — verified against the live route rather
than assumed.

After: all three entries import, with the repair note shown.

## ✅ FE2-02 — HIGH — `markShowWatched` was raced by its own background job

`toggleBatchWatchStatus` kicked off `updateContinueWatchingForBatch` and dropped the promise;
`markShowWatched` then committed its own Continue Watching state. Both rewrite
`_fullyWatchedShowIds` and `continue-watching`, so a toggle starting before the previous one's
background work settled lost to it — show still flagged fully watched, phantom companion queued,
button reading the opposite, and `scheduleCreatorSyncSave` pushing that wrong state to the account.

The other call site (`addItemsToWatchHistory`) already awaited the same promise and its comment
names the fire-and-forget explicitly. The bulk path was made to wait; the interactive one was not.

- `21_client-custom-list-builder.js` — the promise is handed back as `result.cwUpdate` and awaited
  before the commit.
- The button now stays disabled for the whole async tail. It was re-enabled the moment the season
  fetches finished, which is the window the race opened in.

**This was also the failing test on `main`.** `73f2dd8` shipped with `client.test.mjs:3086` red, so
`node --test tests/*.test.mjs` exited 1 and CI's own test step was failing on the default branch.

## ✅ FE2-03 — MEDIUM — the "Update Link" call-to-action was clipped at ≤390 px

The banner is a `white-space: nowrap` flex row capped at `calc(100vw - 24px)`, and the label's
default `min-width: auto` would not let it shrink below its full sentence — so the line overflowed
the banner's own box and pushed the button (`flex-shrink: 0`) past the viewport, with `.page`'s
`overflow-x: hidden` leaving no way to reach it.

At 320 px only **37 px of the 111 px button** was on screen; the remaining tap target was under the
44 px minimum. `09_page-shell.js` now lets the label shrink and ellipsise. Measured after:
`visibleW: 111` at 320 / 375 / 412 / 768 / 1280.

Two things this was *not*, both checked because the first measurement suggested them: the button was
never unreachable (the visible strip was hittable), and the bottom nav never covered it — that
reading was taken mid-`translateY` transition.

## ✅ FE2-04 — LOW — scroll-lock depth asymmetry on modal re-open

`openSelectListModal` / `openCreateListModal` locked background scroll unconditionally while their
close paths early-return when already hidden and therefore never unlock twice. Two opens and one
close left `_scrollLockDepth` above zero: **page permanently unscrollable with no modal on screen,
refresh-only.**

Both now lock only on a real closed→open transition, so open and close agree about what a transition
is. Randomized invariant probe (`t03`, 400 sequences of *"no modal open ⇒ page not locked"*):
**6 violations → 0.**

Reported as *latent*, and it was: reached in code but not through the UI — a mouse double-click is
swallowed because the modal covers the trigger, and keyboard double-Enter because
`openCreateListModal` moves focus into an input. Fixed anyway; it is one line each.

## ✅ FE2-05 — LOW — a dialog over a static modal released that modal's scroll lock

`closeModal` called `lockBackgroundScroll(false)` whether or not a dynamic overlay existed, spending
a lock it never took. Since `showModal` opens with a `closeModal()`, raising any dialog over one of
the four `STATIC_MODALS` consumed *that* modal's lock, and dismissing the dialog let the page scroll
away behind a modal still sitting open on top of it.

`16_client-row-core.js` now early-returns when there is no `#activeModalOverlay`. The inverse — a
stray `closeModal()` underflowing the counter — was already guarded and still is.

## ✅ FE2-06 — LOW — three inputs labelled only by a placeholder

`listFilterInput`, `channelMergeNameInput`, `catalogSearchInput`. A placeholder is not an accessible
name: it disappears on the first keystroke and is announced inconsistently. `aria-label` added to
each. All six tabs now report zero unlabelled inputs; Settings' 22 inputs were already fine.

## ✅ FE2-07 — LOW — `check_sync.py` failed on a clean checkout

It compared raw bytes while `verify.sh` and CI compare with `git diff --ignore-cr-at-eol`.
`worker_entry_combined.js` was committed CRLF and the numbered sources LF, so on an unmodified tree
it reported a 3.3 MB mismatch and told you to run `build.py` — which would have committed nothing
but line-ending churn, and flipped the file straight back for the next person on the other platform.

Closed in two steps, deliberately split across two PRs so the fix PR stayed reviewable:

1. **#44** — `check_sync.py` normalises line endings the same way the other two checks do, so the
   only mismatch it reports is a real one.
2. **#45** — the split itself is gone. `.gitattributes` pins the whole repository to LF *including
   the working tree* (`eol=lf`, not `text=auto` alone — the build reads the working tree, so
   normalising only in the repository would still have left it platform-dependent), and
   `worker_entry_combined.js` is normalised once.

That second step also caught a one-byte version of the same bug that the audit had missed: `build.py`
appended a **CRLF** separator for a source not ending in a newline, putting a stray CRLF into an
otherwise-LF file — invisible to both CR-insensitive checks, but enough to break a byte-exact
compare on a clean checkout. `build.py`, `check_sync.py` and `build.ps1` (whose `WriteLine()`
defaults to `Environment.NewLine`, CRLF on Windows) now all emit LF, and
`23_client-list-management.js` — the one source without a trailing newline — has one.

`python3 check_sync.py` is now byte-exact in practice: **0 CRLF bytes in the built Worker.**

---

## Regression tests

Six added to `tests/client.test.mjs`, in the suite's existing idiom:

- `addRow` survives a non-string name (number, object, and a numeric `group`)
- entries *after* a bad one still reach `addRow` — the reachability that actually regressed
- `validateAndRepairBackup` coerces in place **and** says so in the report
- an object name is dropped rather than stringified to `[object Object]`
- watched → unwatched back to back leaves no fully-watched flag and no queued companion, and the
  button agrees with stored state
- the button stays disabled for the whole async tail

**Mutation-tested,** because a test that cannot fail is worse than no test. Reverting the `addRow`
coercion fails 1; reverting the awaited reconciliation fails 2; both green when restored.

One test had to be rewritten during the work: the first version asserted on `collectEntries()`, which
returns nothing under the DOM stub because it does not build a tree. It passed for the wrong reason
and was replaced with a spy on `addRow`.

## What the audit found working

Recorded because it is most of the surface, and because a report that is only a list of problems
invites the next audit to re-test the same ground. Each was **executed**, not read:

stored XSS through the real publish API (inert, and checked against a benign control so the test
cannot pass vacuously) · hostile API data through all six tabs (1,053 tainted attributes, zero
breakouts) · the shared `/app.js` bundle byte-identical across six render variants, so no
per-request OAuth token can leak into a globally-cached asset · account switching (clean across
localStorage, sessionStorage, DOM and in-memory sets) · 9/9 injected API failure modes recover ·
120 modal open/close cycles leak nothing · offline works, including across a simulated deploy on two
real builds · no page-level horizontal scroll at any width from 320 to 1920 · zero clickable
non-buttons, zero images without `alt`, zero unnamed buttons.

## Three claims the audit retracted

Kept here on purpose — knowing what a probe got *wrong* is what stops the next one repeating it:

- **"27 duplicate requests on load."** They were `fetchListPreviewWithRetry`'s single retry, firing
  only because the first stub returned empty lists. An artifact of the harness, not the app. The
  mock layer now returns realistic data for exactly this reason.
- **"The bottom nav covers the install banner's button."** Measured mid-transition, while the banner
  was still 30 px lower. After it settles, `overlapsNav: false` at every width.
- **FE2-04 reachable by double-click.** It is not, by mouse or keyboard. Filed latent rather than
  live, and fixed on its own merits.

---

## 🔜 Remaining

Nothing. Every finding in [`AUDIT-2026-09-13-FRONTEND.md`](./AUDIT-2026-09-13-FRONTEND.md) is
closed, including the one item the report left to the maintainer — the CRLF/LF split — which has
been decided (`eol=lf`, repository-wide) and actioned.

Three items the report logged as **POTENTIAL / NEEDS VALIDATION** remain exactly that. None is a
confirmed bug and none was fixed, which is the honest outcome for a finding that could not be
reproduced:

| Item | Why it is still open, and why that is fine |
|---|---|
| Cross-mode stale search response | The two sequence counters genuinely do not interlock and both write `#catalogSearchResult`, but no visible clobber could be produced — the captured element appears to be detached by the time the stale response lands. Cheap to close if it ever surfaces: bump both counters on entry, or check `currentCatalogSearchType` before each `resEl.innerHTML` write. |
| Stale shell + pruned bundle offline | Mechanically possible from the two service-worker rules; did not occur in an end-to-end deploy test, because the HTTP cache (`immutable`, 1 year) and the shell refresh both covered it. |
| `poster` URL into `<img src>` / `data-poster` | Not exploitable: `javascript:` in `img src` is not a navigable context and did not fire, and every navigation sink in the client is `ORIGIN`-prefixed. A `^https?:` check at the render helper would make it stay that way. |
