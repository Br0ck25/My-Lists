-- 0002_add_stats_table.sql
--
-- Adds the `stats` table that makes the admin dashboard's counters correct.
--
-- Every counter behind that dashboard (page views, install links, playback
-- pings, per-provider API usage, catalog adds, list copies) was a KV
-- read-modify-write: GET the current value, add one, PUT it back. KV has no
-- atomic increment and no compare-and-swap, so two requests that overlap
-- both read the same number and both write the same number+1, and one of
-- them is silently lost. Measured on the real Worker: twenty concurrent
-- requests recorded as ONE.
--
-- It is worse in production than that measurement suggests, for two reasons
-- that compound with traffic:
--   * KV reads are edge-cached, so every request inside a cache window can
--     read the same stale value and write the same number back.
--   * KV allows roughly one write per second per key, and the hot keys here
--     (stats:pageviews:total, and each day bucket) are single keys.
-- So the busier the deployment, the further the dashboard drifts from
-- reality -- and it drifts DOWNWARD, silently, while still rendering a
-- confident, precise-looking number.
--
-- SQLite's upsert is atomic, which removes the whole class:
--   INSERT ... ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n
-- This is the same shape the source_groups counter has always used (see
-- bumpStatBy, 03_admin.js) -- this migration just makes every other counter
-- work the way that one already did.
--
-- Safe to run against a live database: it only CREATEs, and IF NOT EXISTS
-- makes it idempotent, so re-running it is harmless.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statement
--   below (skip these comment lines).
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0002_add_stats_table.sql
--
-- Existing counts live in KV. Until they are copied across, each counter
-- falls back to its KV value rather than reporting zero (a missing row means
-- "not migrated yet", not "never happened" -- the same rule getCreator
-- already applies to accounts). To copy them, use the "Migrate KV -> D1"
-- button under /admin's Management & Tools -> Maintenance tab, or POST
-- /admin/api/migrate-d1.

CREATE TABLE IF NOT EXISTS stats (
    kind TEXT NOT NULL,
    day  TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, day)
);
