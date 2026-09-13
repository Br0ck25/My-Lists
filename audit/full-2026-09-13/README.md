# Executable probes — full frontend + backend audit, 2026-09-13

Every finding in `COMPLETE_AUDIT_REPORT.md` marked **CONFIRMED** that needed a runtime
demonstration has one here. They run against the repo's own in-memory Worker harness
(`tests/harness.mjs`), which backs D1 with real SQLite loaded from the committed `schema.sql`,
so a constraint violation here is the same constraint violation D1 would raise.

Run from the repository root:

```bash
node audit/full-2026-09-13/p09_sec001_e2e.mjs
```

| Probe | Finding | What it demonstrates |
| --- | --- | --- |
| `p01_tracking_dup.mjs` | DB-001, BE-001 | A duplicate `showId` in `continueWatching` rolls back the whole D1 tracking batch; the route still answers `{ok:true}`; `/sync/load` then serves the stale D1 copy while KV holds the truth. |
| `p02_airing_dup.mjs` | DB-001 | The same via `airingNext`, on a first save — `continue_watching`, `airing_next`, `watch_history` and `creator_tracking_meta` all end up empty. |
| `p03_tmdb_basekey.mjs` | DB-002 | `sKey.split(':')[0]` is the literal `"tmdb"` for a `tmdb:`-prefixed show id, so one server-side entry drops every incoming one. 4 shows sent, 2 stored. |
| `p04_svg_xss.mjs` | (no defect) | `/api/channel-poster` and `/api/channel-logo` escape hostile `name`/`bg`/`path` correctly. Kept as a negative control. |
| `p05_resolve_leak.mjs` | SEC-001 | An attacker with no account mints a config naming a victim via `/api/save`, then reads the victim's history, watchlist and airing-next out of `/api/resolve`. |
| `p06_leak_variants.mjs` | SEC-001 | The same data through a hand-made base64 config on the Stremio catalog route. `/:config/configure` is clean. |
| `p07_preview_leak.mjs` | SEC-001 | All four personal shelves leak through one unauthenticated `/api/preview` GET. Private *custom lists* correctly do not. |
| `p08_idprefix.mjs` | PROTO-001 | Catalogs emit `tmdb:`-prefixed ids that the manifest's `idPrefixes` does not declare. |
| `p09_sec001_e2e.mjs` | SEC-001 | End to end: enumerate a username from `/lists/public.json`, watch the share gate correctly 404 at `/lists/:user/watch-history.json`, then get the same data from `/api/preview` with `ACAO: *`. |
| `p10_airing_crossmatch.mjs` | BE-002 | A `tmdb:`-prefixed Continue Watching row inherits an unrelated show's season-finale date. The `tt`-prefixed control stays clean. |
| `p11_scrobble_rotate.mjs` | BE-003 | With the D1 write failing, token rotation reports success, the new token 401s and the old (leaked) one still works. |

None of these write outside the in-memory harness, contact any external service, or modify
repository state.
