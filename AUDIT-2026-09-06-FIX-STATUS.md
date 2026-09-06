# Adversarial audit — fix status

Live tracker for the 20 findings in [`AUDIT-2026-09-06-ADVERSARIAL.md`](AUDIT-2026-09-06-ADVERSARIAL.md).
Updated as each fix lands. Branch: `claude/full-audit-dzhmot`.

**Legend:** ✅ fixed & tested · 🔧 in progress · ⬜ not started

---

## Order of work, and why it is that order

1. **T0 — the harness first.** Not a finding, a prerequisite. The regression tests
   for A2, A3, A5, A6 and A14 cannot be written at all against the old D1 mock: it
   hardcoded `SELECT * FROM creator_lists WHERE id = ?` to return no rows, it could
   never throw, and it could not enforce a constraint. Fixing the code before the
   harness would mean landing five fixes nothing can prove.
2. **A1** — the only finding an unauthenticated stranger can trigger, and it destroys
   other people's data. Nothing else outranks it.
3. **A5, A3, A4** — the three `ok:true`-while-doing-nothing defects, in decreasing
   order of how bad the lie is: a leaked key that still works > a deleted account that
   still works > a deleted account whose data is inherited by a stranger.
4. **A2 + A6** — one commit, because they are one root cause (D1 preferred on read over
   the store that is actually authoritative). Fixing A2's `likes` binding without
   fixing the read preference would leave A6 live and A2 reachable by another route.
5. **P2 batch** — real defects, none of which silently destroys data.
6. **P3 batch** — hygiene, accuracy and documentation.

---

## Status

### Prerequisite

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **T0** | Test harness cannot see D1 (§9 blind spots) | — | ✅ | `tests/harness.mjs` |

### P0 — silent data destruction and false success

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A1** | Cross-account D1 delete via SQL `LIKE` wildcard | CRITICAL | ✅ | `02_…:2206` → `WHERE username = ?`; `escapeLikePrefix` for `03_…:1133` |
| **A5** | Key rotation reports success while rotating nothing | HIGH | ✅ | `rotateCreatorKeyHashInD1` (02_); both rotation routes; migrate-d1 `DO UPDATE` |
| **A3** | `delete-account` `ok:true`, account still authenticates | HIGH | ⬜ | |
| **A4** | Failed purge frees the username while data survives | HIGH | ⬜ | |

### P1 — the structural cause

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A2** | Ordinary edit zeroes a real like count in D1 then KV | HIGH | ⬜ | |
| **A6** | Dropped D1 write diverges the dashboard permanently | MED-HIGH | ⬜ | |

### P2 — real defects, no silent data loss

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A7** | In-flight rebuild re-publishes a list just made private | MEDIUM | ⬜ | |
| **A8** | Unpublish `ok:true` while the index removal fails silently | MEDIUM | ⬜ | |
| **A9** | Conflict guard: same-ms bypass + fails open on a non-number | MEDIUM | ⬜ | |
| **A10** | Presets/channels/tracking unguarded; watchlist has no merge | MEDIUM | ⬜ | |
| **A11** | No size bound on the authenticated list write | MEDIUM | ⬜ | |
| **A12** | `json()` cacheable default; admin 401s cached for an hour | MEDIUM | ⬜ | |
| **A13** | No global exception boundary | MEDIUM | ⬜ | |
| **A15** | `schema.sql` vs migrations index drift | LOW | ⬜ | |

### P3 — hygiene, accuracy, documentation

| | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| **A14** | migrate-d1 cannot repair a stale row; counters count attempts | LOW-MED | ⬜ | |
| **A16** | Counters are D1-only once bound, vs the "removable" promise | LOW | ⬜ | |
| **A17** | Cron cursor advances before the work is done | LOW | ⬜ | |
| **A18** | Daily seed rolls at UTC midnight, stats at Eastern midnight | LOW | ⬜ | |
| **A19** | Unbounded, unvalidated `lists/reorder` array | LOW | ⬜ | |
| **A20** | FK blocks list writes for a not-yet-migrated account | LOW-MED | ⬜ | |
| — | `CHECK (visibility IN …)` hardening | — | ⬜ | |
| — | Stale comments (§16 F1/F2/F3) | — | ⬜ | |

---

## Gate for every commit

`bash verify.sh` must pass: rebuild is byte-exact, `node --check` clean, the rendered
builder page validates, `FUNCTION-MAP.md` is current, and the whole suite is green.
Each fix also ships the regression test named for it in §13 of the audit, and that test
is confirmed to **fail against the pre-fix code** before the fix is applied.
