-- 0007_add_lists_fts.sql
--
-- Derived full-text search index (FTS5) over public creator and published lists.
-- Never an authoritative store of truth. Fully rebuildable from creator_lists
-- and published_lists.
--
-- Replaces in-memory substring matching over a bounded 80-250 KV key scan
-- with indexed, ranked full-text queries.
--
-- NOTE ON D1 EXPORT:
-- D1 disables `wrangler d1 export` while virtual tables exist in the database.
-- To export: DROP TABLE lists_fts -> export -> rebuild via the Admin Maintenance
-- "Rebuild Search Index" action (/admin/api/rebuild-search-index).
--
-- Safe to run against a live database, and safe to run twice.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statement
--   below (skip these comment lines).
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0007_add_lists_fts.sql

CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
    list_id UNINDEXED,
    name,
    creator_name,
    username,
    tokenize = 'unicode61 remove_diacritics 2'
);
