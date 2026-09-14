-- 0006_add_published_lists.sql
--
-- Anonymous published lists (publishedlist:user:{slug}) previously lived only in
-- KV, with no D1 representation. They appear in the public directory and in
-- search alongside creator lists.
--
-- Adding published_lists gives them a first-class D1 table so the public directory
-- (/lists/public.json) can be answered via a UNION ALL query over creator_lists
-- and published_lists directly, eliminating the hand-built 32-shard index.
--
-- Safe to run against a live database, and safe to run twice.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements
--   below (skip these comment lines).
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0006_add_published_lists.sql

CREATE TABLE IF NOT EXISTS published_lists (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'private',
    items_json  TEXT NOT NULL DEFAULT '[]',
    likes       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_published_vis_likes ON published_lists(visibility, likes DESC, updated_at DESC);
