# Frontend audit — fix status

Companion to [`AUDIT-2026-09-07-FRONTEND.md`](AUDIT-2026-09-07-FRONTEND.md),
which describes the frontend as it stood at `be20b1b`. That document is left as
the audit record and is not rewritten to match the fixes — except for one
correction, noted below, where the audit itself was wrong.

All ten of the report's **Top 10 Fixes** are done. Every one was verified the
same way twice: the probe that demonstrated the defect now reports it gone, and
the defect reintroduced by mutation makes the suite fail.

Suite: **304 tests, 303 passing, 1 skipped** (network-gated), up from 286/285.
`verify.sh` passes, including the byte-exact rebuild and the new admin-page step.

---

## Status

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **FE-02** | Imported ids execute as script; Creator Key stolen | CRITICAL | ✅ | `2e4930b` |
| **FE-01** | `/admin` script fails to parse; every control dead | CRITICAL | ✅ | `bedd9e7` |
| **FE-03** | Double-clicked signup makes an unusable account | CRITICAL | ✅ | `4a2555b` |
| **FE-04** | Refused provider writes reported as success | HIGH | ✅ | `3d7b7a2` |
| **FE-05** | Main list-edit path loses another device's edit | HIGH | ✅ | `4e6be22` |
| **FE-09** | One account's data rendered under another's name | HIGH | ✅ | `4e6be22` |
| **FE-07** | Restored backup permanently kills Discover | MEDIUM | ✅ | `4e6be22` |
| **FE-06** | Obsolete search response overwrites a newer one | MEDIUM | ✅ | `4e6be22` |
| **FE-10** | No Escape, focus or ARIA on any modal | MEDIUM | ✅ | `53ac761` |
| **FE-11** | `role="tablist"` containing no tabs | MEDIUM | ✅ | `53ac761` |
| **FE-08** | Modal scroll lock has never worked | MEDIUM | ✅ | `53ac761` |
| **FE-12** | One modal exit leaks the scroll lock | LOW | ✅ | `53ac761` |
| **FE-13** | Non-array `dashboardListOrder` crashes the dashboard | LOW | ⬜ | not started |
| **FE-14** | "Settings" label clipped at 320px | LOW | ⬜ | not started |
| **FE-15** | No offline capability despite the README | MEDIUM | ⬜ | not started |
| **FE-16** | Dead `renderCustomListSearchResults` | LOW | ⬜ | not started |

The four left open are the ones the report ranked below the top ten. Notes on
each are at the end.

---

## What each fix actually changed

### FE-02 — the XSS, and why escaping was the delivery mechanism

`escapeAttr` is `escapeHtml`, which **emits** `&quot;`. Fifty-eight handler
sites delimited their JavaScript string with `&quot;`, and the HTML parser
decodes attribute entities before the JS parser runs — so the escaping
reconstituted the delimiter it was meant to neutralise.

`escapeJsAttr` escapes for both decodings in the order they happen: JS string
first, then HTML. `escapeAttr` is untouched and still correct for the `data-*`
and `title` attributes that use it — running the new one there would leave
visible backslashes.

Second layer: `dropUnsafeImportedIds` refuses ids that cannot have come from
this app (quote, angle bracket, backslash, control character — no slug, no
`ch_<time>_<rand>`, no `tt…` or `tmdb:…` contains one). It drops rather than
rewrites, because a catalog row references a channel *by key* and renaming one
would leave the row pointing at nothing. It runs inside
`validateAndRepairBackup` for the paste and upload paths, so it is reported the
way that function's other repairs are, and on both install-link paths, which
never went through it.

Verified surgical: a hostile channel in the same file as a good one drops the
hostile channel, keeps the good channel and the lists, and says which it
dropped and why.

**Side effect worth noting:** this also fixed a plain bug. A channel named
`O'Brien & Sons "Best"` produced `deleteLocalChannel("id", "O'Brien & Sons
"Best"")` — a syntax error, so its Delete button did nothing.

### FE-01 — the dead admin page, and the CI gap that let it ship

Seven escapes inside `renderAdminDashboard`'s template literal, which eats a
single backslash before the browser sees it. Four `\n` (a real newline inside a
single-quoted string — a `SyntaxError` that discarded all 60KB of the dashboard
script) and three `\s` (`/[\s,]+/` emitted as `/[s,]+/`, which splits slugs on
the letter *s* and is wrong quite independently of the syntax error).

The reason it shipped, twice — the second `confirm()` block arrived with
`4ba6e0a`, the previous audit's own fix commit — is that nothing ever rendered
this page. `verify.sh` step 4 does exactly the right thing for a page built from
a template literal, and only ever did it for the builder.

So `render_check.js` grew a `--admin` mode and `verify.sh` a step 4b. Confirmed
against the real defect: reintroducing one `\n\n` leaves `node --check` and the
builder-page check passing, exactly as they did in September, and fails the new
step.

### FE-03 — and why it is a D1 regression, not an old bug

Two clicks sent two `POST /api/creator/create`. Both succeeded and returned
different keys: KV is written unconditionally so it holds the last, D1's INSERT
violates the primary key on the second and is swallowed as non-fatal so it holds
the first, and reads prefer D1. The browser keeps whichever lands last.

Measured with the binding toggled and nothing else changed:

```
D1 bound   : over 5 double-creates -> first response's key valid 4/5
D1 UNbound : over 5 double-creates -> first response's key valid 0/5
```

KV-only, the last write won in the only store there was, so the key the browser
kept was always the valid one. The guard cost nothing to omit until D1 arrived.

`beginSubmit` keys the guard by name rather than holding it on the button,
because these modals rebuild their own markup and a disabled button does not
survive a re-render. Armed after form validation so a rejected form does not
latch it; released in a `finally` so a failed request does not either.

**Released early, deliberately.** The first version held the guard across
`loadCreatorSync`, which meant a slow sign-in left the Login button disabled for
the whole sync and blocked signing into a different account — found by the
FE-09 probe, which stopped being able to switch accounts. The guard exists to
stop a duplicate *request*, so it is released once the credential answer is in
hand.

Before: 6/6 double-clicks produced an account whose key 401s. After: 0/6, and
three rapid clicks send one request.

### FE-04 — reading the answer

All seven `item-mutate` call sites discarded the response and then reported
success. `externalMutateError` reads it once; each path recovers in the way it
honestly can:

- `removeSingleExternalItemDirect` no longer applies the change optimistically
  at all. It used to uncheck the box, drop the badge, hide the button and write
  the membership index before the request left. Doing that work *after* the
  answer is smaller than unwinding it, and the button already says
  "Removing…" in the meantime.
- The Add/Remove-from-Lists modal collects per-provider failures instead of
  throwing away `allSettled`'s results, and names them. The custom-list half is
  local and did land, so it is a partial result and says so.
- `removeListItemFromDetails` reports rather than reverts — the tile has already
  gone and putting it back afterwards reads worse than saying what happened.
- The three background mirror-writes keep the local change (it is the user's own
  edit) and surface which provider refused it.

The membership index is the important half: recording a removal that did not
happen hid the item from the next attempt.

### FE-05 / FE-09 / FE-07 / FE-06 — four shapes of the same mistake

Something asynchronous wrote to shared state without checking it was still the
thing that should be writing.

- **FE-05** `saveCreatorListEdit` cites `expectedUpdatedAt` and advances it from
  the reply. On 409 it does **not** retry: the remove-one-item paths can
  re-apply their change to whatever the other device saved because the change is
  a function of the list; this one is a whole replacement array from the
  builder, so only the person can choose. It pulls what is stored, says the list
  changed elsewhere, and leaves the draft alone.
- **FE-09** `loadCreatorSync` remembers who it is loading for and drops the
  answer if that changed.
- **FE-07** `likedLists` filtered to strings at both writers *and* at the read,
  so a browser already poisoned heals on next load rather than needing its site
  data cleared by hand.
- **FE-06** `runCatalogSearch` takes a sequence number, and
  `renderDefaultCatalogSearch` shares it — so clearing the box supersedes an
  in-flight search the way any other search would.

### FE-10 / FE-11 / FE-08 / FE-12 — the keyboard, and a lock that never locked

There was no `Escape` handler anywhere in the bundle. `showModal` now closes on
Escape, traps Tab, moves focus to the dialog's heading and returns it on close,
and carries `role="dialog"` / `aria-modal`. The four static dialogs in the page
shell never went through `showModal`, so they get the same three behaviours from
the outside rather than being rebuilt.

The scroll lock had never worked: `html { overflow-x: hidden }` gives the root
an explicit `overflow-y: auto`, and once `<html>` has its own overflow the
body's stops propagating to the viewport. With a modal open and
`body.style.overflow === 'hidden'`, a wheel event over the backdrop scrolled the
page 900px. `lockBackgroundScroll` locks the element that actually scrolls,
compensates for the scrollbar, restores position, and **counts** rather than
toggles so a dialog raised from a dialog does not unlock the page underneath.

Fixing that made FE-12 real rather than latent, so it is fixed in the same
commit: the select-list modal had four exits that disagreed, and one of them
would now have left a page that cannot be scrolled until reloaded.

Both nav bars became real tab widgets — `role="tab"`, `aria-selected`,
`aria-controls`, `role="tabpanel"`, `aria-labelledby`, roving `tabindex`, and
arrow/Home/End movement. The admin page's bar is a different case and got a
different answer: its three buttons do not reveal panels, they choose which row
of sub-tabs is shown, so it is a labelled group of `aria-pressed` toggle
buttons, which is what it is.

Also: every form control now has an accessible name (20 had none), and the
toast — how this app confirms nearly every action — is a polite live region.
The page had no live region at all.

---

## New CI checks

Three, all of which fail on the code as it stood.

1. **`verify.sh` step 4b / `ci.yml`** render `/admin` and syntax-check its inline
   scripts. This is the check whose absence let FE-01 ship.
2. **`html_checks.py`**: a `role="tablist"` must contain at least one
   `role="tab"`.
3. **`html_checks.py`**: every `aria-controls` / `aria-labelledby` /
   `aria-describedby` must resolve to an element that exists. This is what caught
   the admin page's empty tablist.

A fourth was written and then **removed**: a static accessible-name check. It
cannot see a control *wrapped* in a `<label>`, which is how most of this page
labels its checkboxes, so it reported 67 controls that a real DOM says are fine.
A check that is wrong 67 times is worse than no check; the browser probe answers
it correctly via `element.labels` and is committed alongside.

### Why the admin-page check in particular earns its place

The swallowed-backslash class is not a one-off. `git log` has it three times
before this audit:

```
7dea440  Fix See All overflow root cause + a backslash-escaping regression
c1e0829  ... the admin page's \n\n and /[\s,]+/          (FE-01, first half)
4ba6e0a  ... the second confirm() block                     (FE-01, second half)
```

It caught two more during this work: writing `.join('\n')` into
`19_client-search-and-likes.js` and a regex literal into
`24_client-backup-restore-presets.js`, both of which would have shipped broken
and both of which the checks failed on immediately.

That is the argument for the check rather than for care. Every one of these was
written by someone who knew the rule; the file is 35,000 lines of code living
inside a template literal, and the only reliable defence is a machine that reads
what the browser will actually receive.

---

## One correction to the audit itself

FE-11 originally claimed the six navigation items are announced twice because
both bars are in the DOM at once. **That is wrong**, and the report now says so
inline. Each bar is `display: none` at the other's breakpoint, which removes it
from the accessibility tree — measured after the fact: `bottom-nav` exposed at
390px, `tab-bar` at 1280px, one at a time. The empty-tablist half of the finding
stands.

(The report already carries one other correction, made during the audit: focus
visibility is fine. The first measurement used programmatic `.focus()`, which
does not trigger `:focus-visible`.)

---

## Not started, and why

| | Why it is below the line |
|---|---|
| **FE-13** — non-array `dashboardListOrder` crashes the dashboard | Same missing-type-check family as FE-07, but every writer is already `Array.isArray`-guarded, so it needs storage corrupted by hand rather than by any app path. A two-line `Array.isArray(parsed) ? parsed : []` at both sites when someone is next in that file. |
| **FE-14** — "Settings" clipped at 320px | Cosmetic, one viewport, and the control stays tappable (`elementFromPoint` at its centre still hits the button). No horizontal page scroll at any width. |
| **FE-15** — no offline capability | The largest of the four and the only one that is a feature rather than a defect: it needs the navigation response and `/app.css` cached under the same versioned scheme, plus a decision about what to serve when the shell is not cached. Worth doing deliberately, or correcting the README instead — a `standalone` PWA that cannot open offline is a poor experience either way. |
| **FE-16** — dead `renderCustomListSearchResults` | One unreferenced function out of 496. Deleting it is safe (zero references in the bundle, the rendered markup, or `tests/`) but it is tidying, not a fix. |

---

## Regression tests added

Eighteen, in `tests/client.test.mjs`, taking the client suite from 12 to 30.
Each was mutation-checked — the fix reverted, the test observed to fail, the fix
restored.

| Fix | Tests |
|---|---|
| FE-02 | escaped handler parses to one call with one argument; ordinary ids pass through byte-identical; a name containing quotes survives (it used to be a syntax error); a hostile id is dropped at import while the rest of the file is kept |
| FE-03 | three clicks produce one request; the guard re-arms for a later attempt; a form rejected before any request does not latch it |
| FE-04 | a refusal raises the server's own message and leaves the membership index untouched; a real removal still confirms and records; a network failure is treated as a refusal |
| FE-05 | cites `expectedUpdatedAt`; cites nothing for a legacy record; does not retry over a 409 and keeps the draft; advances its baseline |
| FE-09 | a sync load for the previous account never reaches the DOM |
| FE-07 | non-string entries ignored on read; only strings stored on restore |
| FE-06 | the older response landing later does not replace the newer results |

The keyboard, focus and scroll-lock behaviours are browser-level and are covered
by the committed probes rather than by the `vm` harness, which has no layout and
no real focus model. `tests/client-harness.mjs` did need extending —
`lockBackgroundScroll` reads and restores the scroll position around every
modal, so the stub now has the viewport and scrolling properties every browser
has.
