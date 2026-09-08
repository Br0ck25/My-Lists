# Historical audits and change archive

Finished documents, kept for provenance. Nothing here describes the code as it
is now — read `README.md` at the repository root for that, and `CHANGELOG.md` /
`Changes.md` for what has changed recently.

They were moved out of the repository root because ~500 KB of overlapping,
finished audit markdown sitting next to the source made it genuinely hard to
tell which document was current. That was itself a finding in the audit that
prompted the first move.

**Every finding in every audit below is closed.** As of 2026-09-07 there is no
open audit, which is why the root holds none: an audit lives at the root while
it still has work in it, and moves here when it does not. A few items are closed
as *decisions* rather than fixes — a `CHECK` constraint that would have
reintroduced schema drift, KV counters that cannot be made atomic without a
different storage primitive, no TTL on the two key spaces whose ids are URLs
people are still using. Each says so where it was decided, in the code, with a
test that keeps the reasoning there.

| File | What it is |
|---|---|
| `AUDIT-2026-09.md` | First production audit pass |
| `AUDIT-STATUS.md` | Its remediation tracker |
| `AUDIT-2026-09-05.md` | Second audit pass |
| `AUDIT-2026-09-05-STATUS.md` | Its remediation tracker |
| `AUDIT-2026-09-05-INDEPENDENT.md` | Independent full-repository pass (prior audits deliberately unread), 20 findings, with each resolution recorded inline |
| `AUDIT-2026-09-06-ADVERSARIAL.md` | First adversarial pass — data destruction and false success, 20 findings |
| `AUDIT-2026-09-06-FIX-STATUS.md` | Its remediation tracker, with the mutation re-run |
| `AUDIT-2026-09-06-ADVERSARIAL-II.md` | Second adversarial pass — cross-account disclosure, the cron, KV/D1 consistency |
| `AUDIT-2026-09-06-ADVERSARIAL-II-FIX-STATUS.md` | Its remediation tracker, including the three decorative tests it found |
| `AUDIT-2026-09-07-FRONTEND.md` | Frontend pass — the first to drive a real browser, 17 findings |
| `AUDIT-2026-09-07-FRONTEND-FIX-STATUS.md` | Its remediation tracker |
| `Changes - archive.md` | Older entries rotated out of `Changes.md` |

Relative links between these files still resolve: they only ever pointed at
each other, and they moved together. The executable probes for the last three
audits stayed where they are, under `audit/`, because they still run — their
READMEs point back here.
